import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import {
  createPaymentCommitment,
  PaymentReceiptConflictError,
  recordProviderPaymentReceipt,
} from "../postgres-payments.js";
import { processPaystackInboxEvent } from "../../modules/webhooks/routes/paystack-webhook.routes.js";

let organizationId = "";
let investorIdentityId = "";

async function createPendingPayment(reference: string, amountMinor = 125_050) {
  return createPaymentCommitment({
    organizationId,
    investorIdentityId,
    offeringReference: "offering:payment-test",
    currency: "NGN",
    committedMinor: amountMinor,
    provider: "paystack",
    providerReference: reference,
    expiresAt: new Date(Date.now() + 60 * 60 * 1_000),
  });
}

describe("PostgreSQL payment/accounting slice", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.payment_provider_instructions, fractal.investment_reservations, fractal.payment_reconciliation_cases, fractal.payment_receipts, fractal.payment_intents, fractal.investment_commitments, fractal.journal_postings, fractal.journal_entries, fractal.ledger_accounts, fractal.security_notifications, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events CASCADE");
    organizationId = randomUUID();
    investorIdentityId = randomUUID();
    await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, $2, 'active')", [organizationId, `Payment org ${organizationId}`]);
    await postgresQuery("INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Payment investor', 'active')", [investorIdentityId, `payment-${investorIdentityId}@example.test`]);
  });

  afterAll(async () => { await disconnectPostgres(); });

  it("matches a provider receipt once and atomically creates the escrow journal", async () => {
    const created = await createPendingPayment("reference-1");
    const receipt = await recordProviderPaymentReceipt({
      provider: "paystack", providerReference: "reference-1", providerEventId: "charge-success-1",
      amountMinor: 125_050, currency: "NGN", receivedAt: new Date(), metadata: { source: "test" },
    });
    expect(receipt).toMatchObject({ paymentIntentId: created.paymentIntentId, commitmentId: created.commitmentId, status: "matched", replayed: false });
    expect(receipt.journalId).toBeTruthy();
    const lines = await postgresQuery<{ direction: string; amount_minor: string }>(
      "SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number", [receipt.journalId],
    );
    expect(lines.rows).toEqual([{ direction: "debit", amount_minor: "125050" }, { direction: "credit", amount_minor: "125050" }]);
    const states = await postgresQuery<{ intent: string; commitment: string }>(
      `SELECT intent.status AS intent, commitment.status AS commitment
         FROM fractal.payment_intents intent JOIN fractal.investment_commitments commitment ON commitment.id = intent.commitment_id
        WHERE intent.id = $1`, [created.paymentIntentId],
    );
    expect(states.rows[0]).toEqual({ intent: "receipt_matched", commitment: "payment_received" });
    expect((await postgresQuery("SELECT * FROM fractal.outbox_events WHERE event_type = 'payment.receipt.matched'")).rowCount).toBe(1);
  });

  it("replays identical provider evidence without creating a second journal", async () => {
    await createPendingPayment("reference-2");
    const input = { provider: "paystack", providerReference: "reference-2", providerEventId: "charge-success-2", amountMinor: 125_050, currency: "NGN", receivedAt: new Date("2026-07-18T10:00:00.000Z") };
    const first = await recordProviderPaymentReceipt(input);
    const replay = await recordProviderPaymentReceipt(input);
    expect(replay).toMatchObject({ receiptId: first.receiptId, journalId: first.journalId, replayed: true });
    expect((await postgresQuery("SELECT * FROM fractal.journal_entries")).rowCount).toBe(1);
    await expect(recordProviderPaymentReceipt({ ...input, amountMinor: 125_051 })).rejects.toBeInstanceOf(PaymentReceiptConflictError);
  });

  it("opens a reconciliation case and does not credit escrow on an amount mismatch", async () => {
    const created = await createPendingPayment("reference-3");
    const receipt = await recordProviderPaymentReceipt({
      provider: "paystack", providerReference: "reference-3", providerEventId: "charge-success-3",
      amountMinor: 125_049, currency: "NGN", receivedAt: new Date(),
    });
    expect(receipt).toMatchObject({ status: "amount_mismatch", replayed: false });
    expect(receipt.journalId).toBeUndefined();
    expect(receipt.reconciliationCaseId).toBeTruthy();
    expect((await postgresQuery("SELECT * FROM fractal.journal_entries")).rowCount).toBe(0);
    const row = await postgresQuery<{ status: string; case_type: string }>(
      "SELECT intent.status, reconciliation.case_type FROM fractal.payment_intents intent JOIN fractal.payment_reconciliation_cases reconciliation ON reconciliation.receipt_id = (SELECT id FROM fractal.payment_receipts WHERE payment_intent_id = intent.id) WHERE intent.id = $1",
      [created.paymentIntentId],
    );
    expect(row.rows[0]).toEqual({ status: "amount_mismatch", case_type: "amount_mismatch" });
  });

  it("routes a queued Paystack charge for a new payment reference to PostgreSQL only", async () => {
    const created = await createPendingPayment("reference-4");
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    await processPaystackInboxEvent(
      { log } as any,
      "charge.success",
      { reference: "reference-4", amount: 125_050, currency: "NGN", metadata: {} },
      "charge.success:reference-4",
      new Date(),
    );
    const row = await postgresQuery<{ status: string }>("SELECT status FROM fractal.payment_intents WHERE id = $1", [created.paymentIntentId]);
    expect(row.rows[0]?.status).toBe("receipt_matched");
    expect((await postgresQuery("SELECT * FROM fractal.journal_entries")).rowCount).toBe(1);
  });
});
