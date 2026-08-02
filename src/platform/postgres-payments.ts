import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { hashPayload } from "../utils/idempotency.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { ensureLedgerAccount, JournalValidationError, postJournalInTransaction } from "./postgres-journal.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class PaymentStateError extends Error {}
export class PaymentIntentNotFoundError extends PaymentStateError {}
export class PaymentReceiptConflictError extends Error {}

export interface PaymentCommitmentInput {
  organizationId: string;
  investorIdentityId: string;
  offeringReference: string;
  currency: string;
  committedMinor: bigint | number;
  provider: string;
  providerReference: string;
  expiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface CreatedPaymentIntent {
  commitmentId: string;
  paymentIntentId: string;
}

export interface ProviderPaymentReceiptInput {
  provider: string;
  providerReference: string;
  providerEventId: string;
  amountMinor: bigint | number;
  currency: string;
  receivedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface RecordedPaymentReceipt {
  receiptId: string;
  paymentIntentId: string;
  commitmentId: string;
  status: "matched" | "amount_mismatch";
  journalId?: string;
  reconciliationCaseId?: string;
  replayed: boolean;
}

type PaymentIntentRow = {
  id: string;
  commitment_id: string;
  organization_id: string;
  investor_identity_id: string;
  expected_minor: string;
  currency: string;
  status: string;
  expires_at: Date;
};

function text(value: string, field: string): string {
  const result = value.trim();
  if (!result) throw new JournalValidationError(`${field} is required`);
  return result;
}

function currency(value: string): string {
  const result = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(result)) throw new JournalValidationError("Payment currency must be ISO 4217 alpha-3");
  return result;
}

function minor(value: bigint | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new JournalValidationError("Payment amount must be a safe integer minor unit");
  const result = typeof value === "bigint" ? value : BigInt(value);
  if (result <= 0n || result > 9_223_372_036_854_775_807n) throw new JournalValidationError("Payment amount is outside BIGINT range");
  return result;
}

function accountCode(prefix: "ASSET.PAYSTACK_CLEARING" | "LIABILITY.INVESTOR_ESCROW", value: string) {
  return `${prefix}.${value}`;
}

/** Provision the two accounts used by the initial Paystack collection flow. */
export async function ensureCollectionAccounts(client: PoolClient, organizationId: string, inputCurrency: string): Promise<void> {
  const value = currency(inputCurrency);
  await ensureLedgerAccount(client, {
    organizationId,
    code: accountCode("ASSET.PAYSTACK_CLEARING", value),
    name: `Paystack clearing (${value})`,
    accountType: "asset",
    normalBalance: "debit",
  });
  await ensureLedgerAccount(client, {
    organizationId,
    code: accountCode("LIABILITY.INVESTOR_ESCROW", value),
    name: `Investor escrow (${value})`,
    accountType: "liability",
    normalBalance: "credit",
  });
}

/** A commitment and provider payment instruction are created atomically. */
export async function createPaymentCommitmentInTransaction(client: PoolClient, input: PaymentCommitmentInput): Promise<CreatedPaymentIntent> {
  const committedMinor = minor(input.committedMinor);
  const inputCurrency = currency(input.currency);
  if (input.expiresAt <= new Date()) throw new PaymentStateError("Payment intent expiry must be in the future");
  const commitmentId = randomUUID();
  const paymentIntentId = randomUUID();
    await client.query(
      `INSERT INTO fractal.investment_commitments
         (id, organization_id, investor_identity_id, offering_reference, currency, committed_minor, status)
       VALUES ($1, $2, $3, $4, $5, $6, 'payment_pending')`,
      [commitmentId, input.organizationId, input.investorIdentityId, text(input.offeringReference, "offeringReference"), inputCurrency, committedMinor.toString()],
    );
    await client.query(
      `INSERT INTO fractal.payment_intents
         (id, commitment_id, provider, provider_reference, expected_minor, currency, status, expires_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7, $8)`,
      [paymentIntentId, commitmentId, text(input.provider, "provider"), text(input.providerReference, "providerReference"), committedMinor.toString(), inputCurrency, input.expiresAt, input.metadata ?? {}],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`,
      organizationId: input.organizationId,
      actorId: input.investorIdentityId,
      actorType: "user",
      action: "payment.intent.created",
      entityType: "payment_intent",
      entityId: paymentIntentId,
      payload: { commitmentId, offeringReference: input.offeringReference, provider: input.provider, amountMinor: committedMinor.toString(), currency: inputCurrency },
    });
    await appendOutboxEvent(client, {
      aggregateType: "payment_intent",
      aggregateId: paymentIntentId,
      eventType: "payment.intent.created",
      payload: { organizationId: input.organizationId, commitmentId, auditEventId: audit.id },
    });
  return { commitmentId, paymentIntentId };
}

export async function createPaymentCommitment(input: PaymentCommitmentInput): Promise<CreatedPaymentIntent> {
  return withPostgresTransaction((client) => createPaymentCommitmentInTransaction(client, input));
}

/**
 * Records one provider event. Exact, timely receipts create the accounting
 * posting and all lifecycle changes in the same PostgreSQL transaction; a
 * mismatch creates a case and never credits investor escrow automatically.
 */
export async function recordProviderPaymentReceipt(input: ProviderPaymentReceiptInput): Promise<RecordedPaymentReceipt> {
  const provider = text(input.provider, "provider");
  const providerReference = text(input.providerReference, "providerReference");
  const providerEventId = text(input.providerEventId, "providerEventId");
  const amountMinor = minor(input.amountMinor);
  const receiptCurrency = currency(input.currency);
  const payload = {
    provider,
    providerReference,
    providerEventId,
    amountMinor: amountMinor.toString(),
    currency: receiptCurrency,
    receivedAt: input.receivedAt.toISOString(),
    metadata: input.metadata ?? {},
  };
  const payloadHash = hashPayload(payload);

  return withPostgresTransaction(async (client) => {
    const intentResult = await client.query<PaymentIntentRow>(
      `SELECT intent.id, intent.commitment_id, commitment.organization_id, commitment.investor_identity_id,
              intent.expected_minor, intent.currency, intent.status, intent.expires_at
         FROM fractal.payment_intents intent
         JOIN fractal.investment_commitments commitment ON commitment.id = intent.commitment_id
        WHERE intent.provider = $1 AND intent.provider_reference = $2
        FOR UPDATE`,
      [provider, providerReference],
    );
    const intent = intentResult.rows[0];
    if (!intent) throw new PaymentIntentNotFoundError("Payment intent was not found");

    const existingReceipt = await client.query<{ id: string; payload_hash: string; status: "matched" | "amount_mismatch"; journal_id: string | null }>(
      `SELECT id, payload_hash, status, journal_id
         FROM fractal.payment_receipts
        WHERE provider = $1 AND provider_event_id = $2
        FOR UPDATE`,
      [provider, providerEventId],
    );
    const prior = existingReceipt.rows[0];
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new PaymentReceiptConflictError("Provider receipt event was reused with a different payload");
      return {
        receiptId: prior.id,
        paymentIntentId: intent.id,
        commitmentId: intent.commitment_id,
        status: prior.status,
        journalId: prior.journal_id ?? undefined,
        replayed: true,
      };
    }
    if (intent.status !== "pending") throw new PaymentStateError(`Payment intent is ${intent.status}`);

    const expectedMinor = BigInt(intent.expected_minor);
    const isExpired = intent.expires_at <= input.receivedAt;
    const isAmountMatch = expectedMinor === amountMinor;
    const isCurrencyMatch = intent.currency === receiptCurrency;
    const receiptId = randomUUID();

    if (!isExpired && isAmountMatch && isCurrencyMatch) {
      await ensureCollectionAccounts(client, intent.organization_id, intent.currency);
      const journal = await postJournalInTransaction(client, {
        scopeKey: `organization:${intent.organization_id}`,
        organizationId: intent.organization_id,
        idempotencyKey: `payment-receipt:${provider}:${providerEventId}`,
        currency: intent.currency,
        narrative: `Provider payment receipt ${providerEventId}`,
        externalRef: `${provider}:${providerReference}`,
        effectiveAt: input.receivedAt,
        metadata: { paymentIntentId: intent.id, commitmentId: intent.commitment_id, providerEventId },
        postings: [
          { accountCode: accountCode("ASSET.PAYSTACK_CLEARING", intent.currency), direction: "debit", amountMinor },
          { accountCode: accountCode("LIABILITY.INVESTOR_ESCROW", intent.currency), direction: "credit", amountMinor },
        ],
      });
      await client.query(
        `INSERT INTO fractal.payment_receipts
           (id, payment_intent_id, provider, provider_event_id, payload_hash, amount_minor, currency, status, journal_id, received_at, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'matched', $8, $9, $10)`,
        [receiptId, intent.id, provider, providerEventId, payloadHash, amountMinor.toString(), receiptCurrency, journal.journalId, input.receivedAt, input.metadata ?? {}],
      );
      await client.query("UPDATE fractal.payment_intents SET status = 'receipt_matched', updated_at = now() WHERE id = $1", [intent.id]);
      await client.query("UPDATE fractal.investment_commitments SET status = 'payment_received', updated_at = now() WHERE id = $1", [intent.commitment_id]);
      await client.query(
        `UPDATE fractal.investment_reservations
            SET status = 'confirmed', updated_at = now()
          WHERE commitment_id = $1 AND status = 'pending_payment'`,
        [intent.commitment_id],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${intent.organization_id}`,
        organizationId: intent.organization_id,
        actorType: "provider",
        action: "payment.receipt.matched",
        entityType: "payment_receipt",
        entityId: receiptId,
        payload: { paymentIntentId: intent.id, commitmentId: intent.commitment_id, journalId: journal.journalId, provider, providerEventId, amountMinor: amountMinor.toString(), currency: receiptCurrency },
      });
      await appendOutboxEvent(client, {
        aggregateType: "payment_receipt",
        aggregateId: receiptId,
        eventType: "payment.receipt.matched",
        payload: { organizationId: intent.organization_id, paymentIntentId: intent.id, commitmentId: intent.commitment_id, journalId: journal.journalId, auditEventId: audit.id },
      });
      return { receiptId, paymentIntentId: intent.id, commitmentId: intent.commitment_id, status: "matched", journalId: journal.journalId, replayed: false };
    }

    const caseType = isExpired ? "late_payment" : isCurrencyMatch ? "amount_mismatch" : "currency_mismatch";
    await client.query(
      `INSERT INTO fractal.payment_receipts
         (id, payment_intent_id, provider, provider_event_id, payload_hash, amount_minor, currency, status, received_at, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'amount_mismatch', $8, $9)`,
      [receiptId, intent.id, provider, providerEventId, payloadHash, amountMinor.toString(), receiptCurrency, input.receivedAt, input.metadata ?? {}],
    );
    const reconciliationCaseId = randomUUID();
    await client.query(
      `INSERT INTO fractal.payment_reconciliation_cases
         (id, receipt_id, organization_id, case_type, expected_minor, actual_minor, currency, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [reconciliationCaseId, receiptId, intent.organization_id, caseType, expectedMinor.toString(), amountMinor.toString(), intent.currency, { receivedCurrency: receiptCurrency, provider, providerEventId }],
    );
    await client.query("UPDATE fractal.payment_intents SET status = $2, updated_at = now() WHERE id = $1", [intent.id, isExpired ? "expired" : "amount_mismatch"]);
    await client.query(
      `UPDATE fractal.investment_reservations
          SET status = 'released', updated_at = now()
        WHERE commitment_id = $1 AND status = 'pending_payment'`,
      [intent.commitment_id],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${intent.organization_id}`,
      organizationId: intent.organization_id,
      actorType: "provider",
      action: "payment.receipt.reconciliation_required",
      entityType: "payment_reconciliation_case",
      entityId: reconciliationCaseId,
      payload: { paymentIntentId: intent.id, commitmentId: intent.commitment_id, receiptId, caseType, expectedMinor: expectedMinor.toString(), actualMinor: amountMinor.toString(), currency: intent.currency },
    });
    await appendOutboxEvent(client, {
      aggregateType: "payment_reconciliation_case",
      aggregateId: reconciliationCaseId,
      eventType: "payment.receipt.reconciliation_required",
      payload: { organizationId: intent.organization_id, paymentIntentId: intent.id, receiptId, auditEventId: audit.id },
    });
    return { receiptId, paymentIntentId: intent.id, commitmentId: intent.commitment_id, status: "amount_mismatch", reconciliationCaseId, replayed: false };
  });
}
