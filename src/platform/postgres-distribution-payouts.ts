import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { createPaystackTransferRecipient, getAvailableBalanceKobo, resolvePaystackAccount } from "../services/paystack.js";
import { hashPayload } from "../utils/idempotency.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { ensureLedgerAccount, postJournalInTransaction } from "./postgres-journal.js";
import { bindDistributionLifecyclePolicy, DistributionLifecyclePolicyError } from "./postgres-distribution-lifecycle.js";

export class DistributionPayoutError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input" | "provider_unavailable") {
    super(message);
    this.name = "DistributionPayoutError";
  }
}

const lockKey = 4_182_901_522;
const maxMinor = 9_223_372_036_854_775_807n;
function bounded(value: string, label: string, min: number, max: number) { const result = value.trim(); if (result.length < min || result.length > max) throw new DistributionPayoutError(`${label} must contain ${min} to ${max} characters.`, "invalid_input"); return result; }
function sha(value: string, label: string) { const result = value.trim().toLowerCase(); if (!/^[a-f0-9]{64}$/.test(result)) throw new DistributionPayoutError(`${label} is invalid.`, "invalid_input"); return result; }
function commandReference(prefix: "DFR" | "DPI") { const token = randomUUID().replaceAll("-", "").toUpperCase(); return prefix === "DFR" ? `DFR-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${token.slice(0, 8)}` : `DPI-${token.slice(0, 24)}`; }
async function lock(client: PoolClient) { await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]); }

export type AccountResolver = typeof resolvePaystackAccount;
export type RecipientCreator = typeof createPaystackTransferRecipient;
export type BalanceReader = typeof getAvailableBalanceKobo;

export async function getInvestorDistributionPayoutProfile(investorIdentityId: string) {
  const result = await requirePostgres().query<{ id: string; version: number; currency: string; account_holder_name: string; account_last4: string; verified_at: Date }>(
    `SELECT id,version,currency,account_holder_name,account_last4,verified_at
       FROM fractal.investor_distribution_payout_profiles
      WHERE investor_identity_id=$1 AND status='verified' ORDER BY version DESC LIMIT 1`,
    [investorIdentityId],
  );
  const row = result.rows[0];
  return row ? { id: row.id, version: row.version, currency: row.currency, accountHolderName: row.account_holder_name, accountLast4: row.account_last4, verifiedAt: row.verified_at.toISOString() } : null;
}

/** Provider verification occurs before persistence; orphan recipients are recorded for controlled cleanup. */
export async function verifyInvestorDistributionPayoutProfile(input: { investorIdentityId: string; bankCode: string; accountNumber: string; resolve?: AccountResolver; createRecipient?: RecipientCreator }) {
  const accountNumber = input.accountNumber.replace(/\s/g, "");
  if (!/^\d{10}$/.test(accountNumber)) throw new DistributionPayoutError("A 10-digit Nigerian bank account number is required.", "invalid_input");
  const bankCode = bounded(input.bankCode, "Bank code", 2, 20);
  const identity = await requirePostgres().query("SELECT 1 FROM fractal.identities WHERE id=$1 AND status='active' AND email_verified_at IS NOT NULL", [input.investorIdentityId]);
  if (!identity.rowCount) throw new DistributionPayoutError("An active verified identity is required.", "forbidden");
  let resolved: Awaited<ReturnType<AccountResolver>>;
  let recipient: Awaited<ReturnType<RecipientCreator>>;
  try {
    resolved = await (input.resolve ?? resolvePaystackAccount)({ accountNumber, bankCode });
    if (resolved.account_number !== accountNumber || !resolved.account_name?.trim()) throw new DistributionPayoutError("The provider account resolution did not match the submitted account.", "conflict");
    recipient = await (input.createRecipient ?? createPaystackTransferRecipient)({ name: resolved.account_name, accountNumber, bankCode });
  } catch (error) {
    if (error instanceof DistributionPayoutError) throw error;
    throw new DistributionPayoutError("The payout destination could not be verified with the payment provider.", "provider_unavailable");
  }
  try {
    return await withPostgresTransaction(async (client) => {
      await lock(client);
      const next = await client.query<{ version: number }>("SELECT COALESCE(MAX(version),0)+1 AS version FROM fractal.investor_distribution_payout_profiles WHERE investor_identity_id=$1", [input.investorIdentityId]);
      await client.query("UPDATE fractal.investor_distribution_payout_profiles SET status='superseded',superseded_at=now() WHERE investor_identity_id=$1 AND status='verified'", [input.investorIdentityId]);
      const id = randomUUID();
      await client.query(`INSERT INTO fractal.investor_distribution_payout_profiles(id,investor_identity_id,version,provider,rail,currency,account_holder_name,account_last4,provider_recipient_reference,status,verified_by_identity_id)
        VALUES($1,$2,$3,'paystack','bank_transfer','NGN',$4,$5,$6,'verified',$2)`, [id, input.investorIdentityId, next.rows[0]!.version, bounded(resolved.account_name, "Account holder name", 2, 200), accountNumber.slice(-4), recipient.recipient_code]);
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `identity:${input.investorIdentityId}`, actorId: input.investorIdentityId, actorType: "user", action: "distribution_payout_profile.verified", entityType: "investor_distribution_payout_profile", entityId: id, payload: { currency: "NGN", accountLast4: accountNumber.slice(-4), version: next.rows[0]!.version } });
      await appendOutboxEvent(client, { aggregateType: "investor_distribution_payout_profile", aggregateId: id, eventType: "distribution_payout_profile.verified", payload: { investorIdentityId: input.investorIdentityId, auditEventId: audit.id } });
      return { payoutProfileVersionId: id, version: next.rows[0]!.version, currency: "NGN" as const, accountHolderName: resolved.account_name.trim(), accountLast4: accountNumber.slice(-4) };
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await requirePostgres().query(`INSERT INTO fractal.distribution_payout_recipient_recovery_cases(id,investor_identity_id,provider,provider_recipient_reference,failure_reason)
      VALUES($1,$2,'paystack',$3,$4) ON CONFLICT(provider_recipient_reference) DO NOTHING`, [randomUUID(), input.investorIdentityId, recipient.recipient_code, reason.slice(0, 2000)]).catch(() => undefined);
    throw error;
  }
}

type FundingRow = { id: string; reference: string; organization_id: string; declaration_request_id: string; provider: string; currency: string; amount_minor: string; funding_evidence_reference: string; funding_evidence_sha256: string; submission_observed_balance_minor: string; approval_observed_balance_minor: string | null; status: "submitted" | "approved" | "rejected"; submitted_by_identity_id: string; submitted_at: Date; reviewed_by_identity_id: string | null; reviewed_at: Date | null; decision_reason: string | null };
function mapFunding(row: FundingRow) { return { id: row.id, reference: row.reference, organizationId: row.organization_id, declarationRequestId: row.declaration_request_id, provider: row.provider, currency: row.currency, amountMinor: row.amount_minor, fundingEvidenceReference: row.funding_evidence_reference, fundingEvidenceSha256: row.funding_evidence_sha256, submissionObservedBalanceMinor: row.submission_observed_balance_minor, approvalObservedBalanceMinor: row.approval_observed_balance_minor, status: row.status, submittedByIdentityId: row.submitted_by_identity_id, submittedAt: row.submitted_at.toISOString(), reviewedByIdentityId: row.reviewed_by_identity_id, reviewedAt: row.reviewed_at?.toISOString() ?? null, decisionReason: row.decision_reason }; }
export async function getDistributionFundingRequest(requestId: string) { const result = await requirePostgres().query<FundingRow>("SELECT * FROM fractal.distribution_funding_requests WHERE id=$1", [requestId]); return result.rows[0] ? mapFunding(result.rows[0]) : null; }
export async function listDistributionFundingRequests(organizationId: string) { const result = await requirePostgres().query<FundingRow>("SELECT * FROM fractal.distribution_funding_requests WHERE organization_id=$1 ORDER BY submitted_at DESC,id DESC", [organizationId]); return result.rows.map(mapFunding); }

export async function submitDistributionFundingRequest(input: { organizationId: string; declarationRequestId: string; fundingEvidenceReference: string; fundingEvidenceSha256: string; actorIdentityId: string; commandKey: string; readBalance?: BalanceReader }) {
  const commandKey = bounded(input.commandKey, "Command key", 1, 200);
  const fundingEvidenceReference = bounded(input.fundingEvidenceReference, "Funding evidence reference", 4, 300);
  const fundingEvidenceSha256 = sha(input.fundingEvidenceSha256, "Funding evidence hash");
  const requestHash = hashPayload({ organizationId: input.organizationId, declarationRequestId: input.declarationRequestId, fundingEvidenceReference, fundingEvidenceSha256 });
  const replay = await requirePostgres().query<{ id: string; request_hash: string }>("SELECT id,request_hash FROM fractal.distribution_funding_requests WHERE submitted_by_identity_id=$1 AND command_key=$2", [input.actorIdentityId, commandKey]);
  if (replay.rows[0]) { if (replay.rows[0].request_hash !== requestHash) throw new DistributionPayoutError("This command key was already used with different funding facts.", "conflict"); return { requestId: replay.rows[0].id, replayed: true }; }
  const declarationResult = await requirePostgres().query<{ organization_id: string; currency: string; net_amount_minor: string; status: string }>("SELECT organization_id,currency,net_amount_minor,status FROM fractal.distribution_declaration_requests WHERE id=$1", [input.declarationRequestId]);
  const declaration = declarationResult.rows[0];
  if (!declaration) throw new DistributionPayoutError("Distribution declaration not found.", "not_found");
  if (declaration.organization_id !== input.organizationId) throw new DistributionPayoutError("Distribution declaration does not belong to this organization.", "forbidden");
  if (declaration.status !== "approved" || declaration.currency !== "NGN") throw new DistributionPayoutError("Only an approved NGN declaration can enter Paystack funding review.", "conflict");
  let observedBalance: number;
  try { observedBalance = await (input.readBalance ?? getAvailableBalanceKobo)(); } catch { throw new DistributionPayoutError("The provider balance could not be verified; no funding request was created.", "provider_unavailable"); }
  if (!Number.isSafeInteger(observedBalance) || observedBalance < 0) throw new DistributionPayoutError("The provider returned an invalid funding balance.", "provider_unavailable");
  if (BigInt(observedBalance) < BigInt(declaration.net_amount_minor)) throw new DistributionPayoutError("The verified provider balance is below the declaration net liability.", "conflict");
  return withPostgresTransaction(async (client) => {
    await lock(client);
    const repeated = await client.query<{ id: string; request_hash: string }>("SELECT id,request_hash FROM fractal.distribution_funding_requests WHERE submitted_by_identity_id=$1 AND command_key=$2", [input.actorIdentityId, commandKey]);
    if (repeated.rows[0]) { if (repeated.rows[0].request_hash !== requestHash) throw new DistributionPayoutError("This command key was already used with different funding facts.", "conflict"); return { requestId: repeated.rows[0].id, replayed: true }; }
    const id = randomUUID();
    await client.query(`INSERT INTO fractal.distribution_funding_requests(id,reference,organization_id,declaration_request_id,provider,currency,amount_minor,funding_evidence_reference,funding_evidence_sha256,submission_observed_balance_minor,status,command_key,request_hash,submitted_by_identity_id)
      VALUES($1,$2,$3,$4,'paystack','NGN',$5,$6,$7,$8,'submitted',$9,$10,$11)`, [id, commandReference("DFR"), input.organizationId, input.declarationRequestId, declaration.net_amount_minor, fundingEvidenceReference, fundingEvidenceSha256, observedBalance, commandKey, requestHash, input.actorIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.actorIdentityId, actorType: "user", action: "distribution_funding.submitted", entityType: "distribution_funding_request", entityId: id, payload: { declarationRequestId: input.declarationRequestId, amountMinor: declaration.net_amount_minor, currency: "NGN" } });
    await appendOutboxEvent(client, { aggregateType: "distribution_funding_request", aggregateId: id, eventType: "distribution_funding.submitted", payload: { organizationId: input.organizationId, declarationRequestId: input.declarationRequestId, auditEventId: audit.id } });
    return { requestId: id, replayed: false };
  });
}

export async function decideDistributionFundingRequest(input: { requestId: string; actorIdentityId: string; decision: "approve" | "reject"; decisionReason: string; readBalance?: BalanceReader }) {
  const reason = bounded(input.decisionReason, "Decision reason", 20, 2000);
  const preliminary = await requirePostgres().query<{ status: "submitted" | "approved" | "rejected"; submitted_by_identity_id: string }>("SELECT status,submitted_by_identity_id FROM fractal.distribution_funding_requests WHERE id=$1", [input.requestId]);
  const current = preliminary.rows[0], desired = input.decision === "approve" ? "approved" : "rejected";
  if (!current) throw new DistributionPayoutError("Distribution funding request not found.", "not_found");
  if (current.status !== "submitted") { if (current.status === desired) { const count = await requirePostgres().query<{ count: number }>("SELECT count(*)::integer AS count FROM fractal.distribution_payout_instructions WHERE funding_request_id=$1", [input.requestId]); return { requestId: input.requestId, status: current.status, instructionCount: count.rows[0]!.count, replayed: true }; } throw new DistributionPayoutError("The funding request already has a different terminal decision.", "conflict"); }
  if (current.submitted_by_identity_id === input.actorIdentityId) throw new DistributionPayoutError("The funding submitter cannot approve the same request.", "forbidden");
  let observedBalance: number | null = null;
  if (input.decision === "approve") {
    try { observedBalance = await (input.readBalance ?? getAvailableBalanceKobo)(); } catch { throw new DistributionPayoutError("The provider balance could not be reverified; funding was not approved.", "provider_unavailable"); }
    if (!Number.isSafeInteger(observedBalance) || observedBalance < 0) throw new DistributionPayoutError("The provider returned an invalid funding balance.", "provider_unavailable");
  }
  return withPostgresTransaction(async (client) => {
    await lock(client);
    const result = await client.query<FundingRow>("SELECT * FROM fractal.distribution_funding_requests WHERE id=$1 FOR UPDATE", [input.requestId]);
    const row = result.rows[0];
    if (!row) throw new DistributionPayoutError("Distribution funding request not found.", "not_found");
    const desired = input.decision === "approve" ? "approved" : "rejected";
    if (row.status !== "submitted") { if (row.status === desired) return { requestId: row.id, status: row.status, instructionCount: 0, replayed: true }; throw new DistributionPayoutError("The funding request already has a different terminal decision.", "conflict"); }
    if (row.submitted_by_identity_id === input.actorIdentityId) throw new DistributionPayoutError("The funding submitter cannot approve the same request.", "forbidden");
    let instructionCount = 0;
    if (desired === "approved") {
      const reserved = await client.query<{ amount: string }>(`SELECT COALESCE(sum(amount_minor),0) AS amount FROM fractal.distribution_payout_instructions WHERE status IN('authorized','dispatching','submitted','uncertain')`);
      if (BigInt(observedBalance!) < BigInt(row.amount_minor) + BigInt(reserved.rows[0]!.amount)) throw new DistributionPayoutError("The live provider balance does not cover this declaration and existing unsettled reservations.", "conflict");
      const entitlements = await client.query<{ id: string; investor_identity_id: string; net_amount_minor: string; profile_id: string | null; provider_recipient_reference: string | null }>(`SELECT entitlement.id,entitlement.investor_identity_id,entitlement.net_amount_minor,profile.id AS profile_id,profile.provider_recipient_reference
        FROM fractal.distribution_entitlements entitlement
        LEFT JOIN LATERAL(SELECT id,provider_recipient_reference FROM fractal.investor_distribution_payout_profiles WHERE investor_identity_id=entitlement.investor_identity_id AND currency=$2 AND status='verified' ORDER BY version DESC LIMIT 1) profile ON true
        WHERE entitlement.declaration_request_id=$1 ORDER BY entitlement.investor_identity_id FOR SHARE OF entitlement`, [row.declaration_request_id, row.currency]);
      if (!entitlements.rows.length || entitlements.rows.some((item) => !item.profile_id || !item.provider_recipient_reference)) throw new DistributionPayoutError("Every entitled investor must have a current verified payout destination before funding approval.", "conflict");
      for (const item of entitlements.rows) {
        await client.query(`INSERT INTO fractal.distribution_payout_instructions(id,reference,funding_request_id,declaration_request_id,entitlement_id,investor_identity_id,payout_profile_version_id,provider,provider_recipient_reference,currency,amount_minor,status,authorized_by_identity_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,'paystack',$8,$9,$10,'authorized',$11)`, [randomUUID(), commandReference("DPI"), row.id, row.declaration_request_id, item.id, item.investor_identity_id, item.profile_id, item.provider_recipient_reference, row.currency, item.net_amount_minor, input.actorIdentityId]);
      }
      instructionCount = entitlements.rows.length;
    }
    await client.query("UPDATE fractal.distribution_funding_requests SET status=$2,approval_observed_balance_minor=$3,reviewed_by_identity_id=$4,reviewed_at=now(),decision_reason=$5 WHERE id=$1", [row.id, desired, observedBalance, input.actorIdentityId, reason]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${row.organization_id}`, organizationId: row.organization_id, actorId: input.actorIdentityId, actorType: "user", action: `distribution_funding.${desired}`, entityType: "distribution_funding_request", entityId: row.id, reason, payload: { declarationRequestId: row.declaration_request_id, instructionCount } });
    await appendOutboxEvent(client, { aggregateType: "distribution_funding_request", aggregateId: row.id, eventType: `distribution_funding.${desired}`, payload: { organizationId: row.organization_id, declarationRequestId: row.declaration_request_id, instructionCount, auditEventId: audit.id } });
    return { requestId: row.id, status: desired, instructionCount, replayed: false };
  });
}

async function ensureSettlementAccounts(client: PoolClient, organizationId: string, currency: string) {
  await ensureLedgerAccount(client, { organizationId, code: `LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.${currency}`, name: `Investor distributions payable (${currency})`, accountType: "liability", normalBalance: "credit" });
  await ensureLedgerAccount(client, { organizationId, code: `ASSET.DISTRIBUTION_PAYOUT_CLEARING.${currency}`, name: `Distribution payout clearing (${currency})`, accountType: "asset", normalBalance: "debit" });
}

export async function recordDistributionPayoutProviderOutcome(input: { reference: string; outcome: "success" | "failed" | "reversed"; transferCode: string; amountMinor: number; currency: string; source: "verification" | "webhook"; occurredAt?: Date; reason?: string }) {
  if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0 || BigInt(input.amountMinor) > maxMinor) throw new DistributionPayoutError("Provider payout amount is invalid.", "invalid_input");
  const occurredAt = input.occurredAt ?? new Date();
  const evidenceSha256 = hashPayload({ reference: input.reference, outcome: input.outcome, transferCode: input.transferCode, amountMinor: input.amountMinor, currency: input.currency.toUpperCase(), source: input.source, occurredAt: occurredAt.toISOString(), reason: input.reason ?? null });
  return withPostgresTransaction(async (client) => {
    await lock(client);
    const result = await client.query<{ id: string; status: string; organization_id: string; declaration_request_id: string; reference: string; provider_transfer_code: string | null; currency: string; amount_minor: string; settlement_journal_id: string | null; confirmed_at: Date | null }>(`SELECT payout.id,payout.status,funding.organization_id,payout.declaration_request_id,payout.reference,payout.provider_transfer_code,payout.currency,payout.amount_minor,payout.settlement_journal_id,payout.confirmed_at
      FROM fractal.distribution_payout_instructions payout JOIN fractal.distribution_funding_requests funding ON funding.id=payout.funding_request_id WHERE payout.reference=$1 FOR UPDATE OF payout`, [input.reference]);
    const payout = result.rows[0];
    if (!payout) return { handled: false };
    if (payout.provider_transfer_code && payout.provider_transfer_code !== input.transferCode) throw new DistributionPayoutError("Provider transfer code does not match the governed payout.", "conflict");
    if (payout.amount_minor !== String(input.amountMinor) || payout.currency !== input.currency.toUpperCase()) throw new DistributionPayoutError("Provider amount or currency does not match the governed payout.", "conflict");
    await client.query(`INSERT INTO fractal.distribution_payout_provider_events(id,payout_instruction_id,provider,source,outcome,provider_transfer_code,amount_minor,currency,occurred_at,evidence_sha256)
      VALUES($1,$2,'paystack',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`, [randomUUID(), payout.id, input.source, input.outcome, input.transferCode, input.amountMinor, payout.currency, occurredAt, evidenceSha256]);
    if (payout.status === "reversed" || payout.status === "failed" || (payout.status === "confirmed" && input.outcome !== "reversed")) return { handled: true, payoutInstructionId: payout.id, status: payout.status };
    if (payout.status === "authorized") throw new DistributionPayoutError("A provider outcome exists before controlled dispatch; manual reconciliation is required.", "conflict");
    if (input.outcome === "success") {
      await ensureSettlementAccounts(client, payout.organization_id, payout.currency);
      const journal = await postJournalInTransaction(client, { scopeKey: `organization:${payout.organization_id}`, organizationId: payout.organization_id, idempotencyKey: `distribution-payout-settlement:${payout.id}`, currency: payout.currency, narrative: `Distribution payout settlement ${payout.reference}`, externalRef: payout.reference, effectiveAt: occurredAt, metadata: { distributionPayoutInstructionId: payout.id, distributionDeclarationRequestId: payout.declaration_request_id, accountingEvent: "distribution_payout_settlement" }, postings: [{ accountCode: `LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.${payout.currency}`, direction: "debit", amountMinor: BigInt(payout.amount_minor) }, { accountCode: `ASSET.DISTRIBUTION_PAYOUT_CLEARING.${payout.currency}`, direction: "credit", amountMinor: BigInt(payout.amount_minor) }] });
      await client.query("UPDATE fractal.distribution_payout_instructions SET status='confirmed',provider_transfer_code=COALESCE(provider_transfer_code,$2),submitted_at=COALESCE(submitted_at,$3),confirmed_at=$3,failed_at=NULL,failure_reason=NULL,settlement_journal_id=$4 WHERE id=$1 AND status IN('dispatching','submitted','uncertain')", [payout.id, input.transferCode, occurredAt, journal.journalId]);
    } else if (input.outcome === "failed") {
      const reason = bounded(input.reason?.trim() || "Transfer failed at payment provider", "Failure reason", 1, 2000);
      await client.query("UPDATE fractal.distribution_payout_instructions SET status='failed',provider_transfer_code=COALESCE(provider_transfer_code,$2),failed_at=$3,failure_reason=$4 WHERE id=$1 AND status IN('dispatching','submitted','uncertain')", [payout.id, input.transferCode, occurredAt, reason]);
    } else {
      if (payout.status !== "confirmed" || !payout.settlement_journal_id || !payout.confirmed_at) throw new DistributionPayoutError("Only a confirmed payout with settlement accounting can be reversed.", "conflict");
      await ensureSettlementAccounts(client, payout.organization_id, payout.currency);
      const reversal = await postJournalInTransaction(client, { scopeKey: `organization:${payout.organization_id}`, organizationId: payout.organization_id, idempotencyKey: `distribution-payout-reversal:${payout.id}`, currency: payout.currency, narrative: `Distribution payout reversal ${payout.reference}`, externalRef: payout.reference, effectiveAt: occurredAt, reversalOf: payout.settlement_journal_id, metadata: { distributionPayoutInstructionId: payout.id, accountingEvent: "distribution_payout_reversal" }, postings: [{ accountCode: `ASSET.DISTRIBUTION_PAYOUT_CLEARING.${payout.currency}`, direction: "debit", amountMinor: BigInt(payout.amount_minor) }, { accountCode: `LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.${payout.currency}`, direction: "credit", amountMinor: BigInt(payout.amount_minor) }] });
      await client.query("UPDATE fractal.distribution_payout_instructions SET status='reversed',failed_at=$2,failure_reason=$3,reversal_journal_id=$4 WHERE id=$1 AND status='confirmed'", [payout.id, occurredAt, bounded(input.reason?.trim() || "Transfer reversed by payment provider", "Reversal reason", 1, 2000), reversal.journalId]);
    }
    const status = input.outcome === "success" ? "confirmed" : input.outcome;
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${payout.organization_id}`, organizationId: payout.organization_id, actorType: "provider", action: `distribution_payout.${status}`, entityType: "distribution_payout_instruction", entityId: payout.id, reason: input.outcome === "success" ? undefined : input.reason, payload: { declarationRequestId: payout.declaration_request_id, reference: payout.reference, source: input.source }, occurredAt });
    await appendOutboxEvent(client, { aggregateType: "distribution_payout_instruction", aggregateId: payout.id, eventType: `distribution_payout.${status}`, payload: { organizationId: payout.organization_id, declarationRequestId: payout.declaration_request_id, auditEventId: audit.id } });
    return { handled: true, payoutInstructionId: payout.id, status };
  });
}

export async function listDistributionPayoutReconciliation() {
  const result = await requirePostgres().query<{ id: string; reference: string; organization_id: string; declaration_request_id: string; investor_identity_id: string; currency: string; amount_minor: string; status: string; authorized_at: Date; dispatch_started_at: Date | null; submitted_at: Date | null; failed_at: Date | null; failure_reason: string | null; exception_case_id: string | null; exception_reference: string | null; exception_status: string | null; hold_status: string | null; resolution_type: string | null }>(`SELECT payout.id,payout.reference,funding.organization_id,payout.declaration_request_id,payout.investor_identity_id,payout.currency,payout.amount_minor,payout.status,payout.authorized_at,payout.dispatch_started_at,payout.submitted_at,payout.failed_at,payout.failure_reason,exception.id AS exception_case_id,exception.reference AS exception_reference,exception.status AS exception_status,exception.hold_status,exception.resolution_type FROM fractal.distribution_payout_instructions payout JOIN fractal.distribution_funding_requests funding ON funding.id=payout.funding_request_id LEFT JOIN LATERAL(SELECT * FROM fractal.distribution_payout_exception_cases item WHERE item.payout_instruction_id=payout.id ORDER BY item.opened_at DESC LIMIT 1) exception ON true WHERE payout.status IN('uncertain','failed','reversed') ORDER BY COALESCE(payout.failed_at,payout.submitted_at,payout.authorized_at) DESC,payout.id DESC`);
  return result.rows.map((row) => ({ id: row.id, reference: row.reference, organizationId: row.organization_id, declarationRequestId: row.declaration_request_id, investorIdentityId: row.investor_identity_id, currency: row.currency, amountMinor: row.amount_minor, status: row.status, authorizedAt: row.authorized_at.toISOString(), dispatchStartedAt: row.dispatch_started_at?.toISOString() ?? null, submittedAt: row.submitted_at?.toISOString() ?? null, failedAt: row.failed_at?.toISOString() ?? null, failureReason: row.failure_reason, exceptionCaseId: row.exception_case_id, exceptionReference: row.exception_reference, exceptionStatus: row.exception_status, holdStatus: row.hold_status, resolutionType: row.resolution_type }));
}

export type DistributionExceptionResolution = "replacement_payout" | "manual_settlement" | "write_off" | "close_no_action";

export async function createDistributionPayoutExceptionPolicy(input: { organizationId: string; resolutionType: Exclude<DistributionExceptionResolution, "close_no_action">; currency: string; maximumAmountMinor: number; effectiveFrom: Date; effectiveUntil?: Date; policyReference: string; actorIdentityId: string }) {
  if (!Number.isSafeInteger(input.maximumAmountMinor) || input.maximumAmountMinor <= 0) throw new DistributionPayoutError("Policy limit is invalid.", "invalid_input");
  return withPostgresTransaction(async (client) => {
    await lock(client);
    const version = await client.query<{ version: number }>("SELECT COALESCE(max(version),0)+1 AS version FROM fractal.distribution_payout_exception_policies WHERE organization_id=$1", [input.organizationId]);
    const id = randomUUID();
    await client.query(`INSERT INTO fractal.distribution_payout_exception_policies(id,organization_id,version,resolution_type,currency,maximum_amount_minor,effective_from,effective_until,policy_reference,status,prepared_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'draft',$10)`, [id, input.organizationId, version.rows[0]!.version, input.resolutionType, input.currency.toUpperCase(), input.maximumAmountMinor, input.effectiveFrom, input.effectiveUntil ?? null, bounded(input.policyReference, "Policy reference", 8, 1000), input.actorIdentityId]);
    return { policyId: id, version: version.rows[0]!.version };
  });
}

export async function approveDistributionPayoutExceptionPolicy(input: { policyId: string; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const policy = await client.query<{ organization_id: string; prepared_by_identity_id: string; status: string; resolution_type: string; currency: string }>("SELECT organization_id,prepared_by_identity_id,status,resolution_type,currency FROM fractal.distribution_payout_exception_policies WHERE id=$1 FOR UPDATE", [input.policyId]);
    const row = policy.rows[0];
    if (!row) throw new DistributionPayoutError("Distribution exception policy was not found.", "not_found");
    if (row.status !== "draft") throw new DistributionPayoutError("Only a draft policy can be approved.", "conflict");
    if (row.prepared_by_identity_id === input.actorIdentityId) throw new DistributionPayoutError("A different person must approve this policy.", "forbidden");
    await client.query("UPDATE fractal.distribution_payout_exception_policies SET status='superseded' WHERE organization_id=$1 AND resolution_type=$2 AND currency=$3 AND status='active'", [row.organization_id, row.resolution_type, row.currency]);
    await client.query("UPDATE fractal.distribution_payout_exception_policies SET status='active',approved_by_identity_id=$2,approved_at=now() WHERE id=$1", [input.policyId, input.actorIdentityId]);
    return { policyId: input.policyId, status: "active" as const };
  });
}

export async function openDistributionPayoutException(input: { payoutInstructionId: string; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const payout = await client.query<{ organization_id: string; status: string }>(`SELECT funding.organization_id,payout.status FROM fractal.distribution_payout_instructions payout JOIN fractal.distribution_funding_requests funding ON funding.id=payout.funding_request_id WHERE payout.id=$1 FOR SHARE OF payout`, [input.payoutInstructionId]);
    const row = payout.rows[0];
    if (!row) throw new DistributionPayoutError("Distribution payout was not found.", "not_found");
    if (!["uncertain", "failed", "reversed"].includes(row.status)) throw new DistributionPayoutError("Only uncertain, failed, or reversed payouts may enter exception handling.", "conflict");
    const existing = await client.query<{ id: string }>("SELECT id FROM fractal.distribution_payout_exception_cases WHERE payout_instruction_id=$1 AND status<>'closed'", [input.payoutInstructionId]);
    if (existing.rows[0]) return { exceptionCaseId: existing.rows[0].id, replayed: true };
    const id = randomUUID(), reference = `DPE-${randomUUID().replaceAll("-", "").toUpperCase().slice(0, 20)}`, openedAt = new Date();
    await client.query("INSERT INTO fractal.distribution_payout_exception_cases(id,reference,payout_instruction_id,organization_id,status,opened_by_identity_id,opened_at) VALUES($1,$2,$3,$4,'open',$5,$6)", [id, reference, input.payoutInstructionId, row.organization_id, input.actorIdentityId, openedAt]);
    try { await bindDistributionLifecyclePolicy(client, { targetType: "distribution_payout_exception", targetId: id, organizationId: row.organization_id, retentionStartedAt: openedAt }); }
    catch (error) { if (error instanceof DistributionLifecyclePolicyError) throw new DistributionPayoutError(error.message, "conflict"); throw error; }
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${row.organization_id}`, organizationId: row.organization_id, actorId: input.actorIdentityId, actorType: "user", action: "distribution_payout_exception.opened", entityType: "distribution_payout_exception", entityId: id, payload: { payoutInstructionId: input.payoutInstructionId, reference } });
    await appendOutboxEvent(client, { aggregateType: "distribution_payout_exception", aggregateId: id, eventType: "distribution_payout_exception.opened", payload: { organizationId: row.organization_id, auditEventId: audit.id } });
    return { exceptionCaseId: id, replayed: false };
  });
}

export async function addDistributionPayoutExceptionEvidence(input: { exceptionCaseId: string; evidenceType: string; contentSha256: string; storageKey: string; filename: string; mimeType: string; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ organization_id: string; status: string }>("SELECT organization_id,status FROM fractal.distribution_payout_exception_cases WHERE id=$1 FOR UPDATE", [input.exceptionCaseId]);
    const row = result.rows[0];
    if (!row) throw new DistributionPayoutError("Distribution exception was not found.", "not_found");
    if (!["open", "evidence_submitted"].includes(row.status)) throw new DistributionPayoutError("This exception is not accepting evidence.", "conflict");
    const id = randomUUID();
    await client.query("INSERT INTO fractal.distribution_payout_exception_evidence(id,case_id,evidence_type,content_sha256,storage_key,filename,mime_type,uploaded_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id, input.exceptionCaseId, input.evidenceType, sha(input.contentSha256, "Evidence hash"), bounded(input.storageKey, "Storage key", 1, 1000), bounded(input.filename, "Filename", 1, 240), bounded(input.mimeType, "MIME type", 3, 120), input.actorIdentityId]);
    if (row.status === "open") await client.query("UPDATE fractal.distribution_payout_exception_cases SET status='evidence_submitted' WHERE id=$1", [input.exceptionCaseId]);
    return { evidenceId: id };
  });
}

export async function proposeDistributionPayoutExceptionResolution(input: { exceptionCaseId: string; resolutionType: DistributionExceptionResolution; resolutionReason: string; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ status: string; payout_status: string }>(`SELECT exception.status,payout.status AS payout_status FROM fractal.distribution_payout_exception_cases exception JOIN fractal.distribution_payout_instructions payout ON payout.id=exception.payout_instruction_id WHERE exception.id=$1 FOR UPDATE OF exception`, [input.exceptionCaseId]);
    const row = result.rows[0];
    if (!row || row.status !== "evidence_submitted") throw new DistributionPayoutError("Exception evidence must be recorded before proposing a resolution.", "conflict");
    if (input.resolutionType === "replacement_payout" && !["failed", "reversed"].includes(row.payout_status)) throw new DistributionPayoutError("An uncertain payout cannot be replaced without provider-confirmed failure or reversal.", "conflict");
    if (input.resolutionType === "write_off" && row.payout_status === "uncertain") throw new DistributionPayoutError("An uncertain payout cannot be written off.", "conflict");
    await client.query("UPDATE fractal.distribution_payout_exception_cases SET status='decision_pending',resolution_type=$2,resolution_reason=$3,prepared_by_identity_id=$4,prepared_at=now() WHERE id=$1", [input.exceptionCaseId, input.resolutionType, bounded(input.resolutionReason, "Resolution reason", 20, 2000), input.actorIdentityId]);
    return { exceptionCaseId: input.exceptionCaseId, status: "decision_pending" as const };
  });
}

export async function decideDistributionPayoutExceptionResolution(input: { exceptionCaseId: string; approve: boolean; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ status: string; prepared_by_identity_id: string }>("SELECT status,prepared_by_identity_id FROM fractal.distribution_payout_exception_cases WHERE id=$1 FOR UPDATE", [input.exceptionCaseId]);
    const row = result.rows[0];
    if (!row || row.status !== "decision_pending") throw new DistributionPayoutError("Exception is not awaiting an independent decision.", "conflict");
    if (row.prepared_by_identity_id === input.actorIdentityId) throw new DistributionPayoutError("A different person must decide this resolution.", "forbidden");
    const status = input.approve ? "approved" : "rejected";
    await client.query("UPDATE fractal.distribution_payout_exception_cases SET status=$2,reviewed_by_identity_id=$3,reviewed_at=now() WHERE id=$1", [input.exceptionCaseId, status, input.actorIdentityId]);
    return { exceptionCaseId: input.exceptionCaseId, status };
  });
}

export async function proposeDistributionPayoutExceptionHold(input: { exceptionCaseId: string; action: "place" | "release"; reason: string; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ status: string; hold_status: string }>("SELECT status,hold_status FROM fractal.distribution_payout_exception_cases WHERE id=$1 FOR SHARE", [input.exceptionCaseId]);
    const row = result.rows[0];
    if (!row || !["open", "evidence_submitted", "decision_pending", "approved"].includes(row.status)) throw new DistributionPayoutError("This exception cannot receive a hold request.", "conflict");
    if ((input.action === "place") === (row.hold_status === "active")) throw new DistributionPayoutError(`The fraud hold is already ${row.hold_status}.`, "conflict");
    const id = randomUUID();
    await client.query("INSERT INTO fractal.distribution_payout_exception_hold_requests(id,case_id,action,reason,status,prepared_by_identity_id) VALUES($1,$2,$3,$4,'pending',$5)", [id, input.exceptionCaseId, input.action, bounded(input.reason, "Hold reason", 20, 2000), input.actorIdentityId]);
    return { holdRequestId: id, status: "pending" as const };
  });
}

export async function decideDistributionPayoutExceptionHold(input: { holdRequestId: string; approve: boolean; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ case_id: string; action: "place" | "release"; status: string; prepared_by_identity_id: string }>("SELECT case_id,action,status,prepared_by_identity_id FROM fractal.distribution_payout_exception_hold_requests WHERE id=$1 FOR UPDATE", [input.holdRequestId]);
    const row = result.rows[0];
    if (!row || row.status !== "pending") throw new DistributionPayoutError("Hold request is not awaiting decision.", "conflict");
    if (row.prepared_by_identity_id === input.actorIdentityId) throw new DistributionPayoutError("A different person must decide this hold request.", "forbidden");
    const status = input.approve ? "approved" : "rejected";
    await client.query("UPDATE fractal.distribution_payout_exception_hold_requests SET status=$2,reviewed_by_identity_id=$3,reviewed_at=now() WHERE id=$1", [input.holdRequestId, status, input.actorIdentityId]);
    if (input.approve) await client.query("UPDATE fractal.distribution_payout_exception_cases SET hold_status=$2 WHERE id=$1", [row.case_id, row.action === "place" ? "active" : "clear"]);
    return { holdRequestId: input.holdRequestId, status, holdStatus: input.approve ? row.action === "place" ? "active" : "clear" : undefined };
  });
}

async function requireExceptionPolicy(client: PoolClient, input: { organizationId: string; resolutionType: string; currency: string; amountMinor: string }) {
  const result = await client.query<{ id: string }>(`SELECT id FROM fractal.distribution_payout_exception_policies WHERE organization_id=$1 AND resolution_type=$2 AND currency=$3 AND status='active' AND effective_from<=now() AND (effective_until IS NULL OR effective_until>now()) AND maximum_amount_minor>=$4 ORDER BY effective_from DESC,version DESC LIMIT 1 FOR SHARE`, [input.organizationId, input.resolutionType, input.currency, input.amountMinor]);
  if (!result.rows[0]) throw new DistributionPayoutError("No active approval policy authorizes this corrective execution.", "conflict");
  return result.rows[0].id;
}

export async function executeDistributionPayoutException(input: { exceptionCaseId: string; evidenceReference?: string; actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client);
    const result = await client.query<{ organization_id: string; status: string; hold_status: string; resolution_type: DistributionExceptionResolution; prepared_by_identity_id: string; payout_instruction_id: string; funding_request_id: string; declaration_request_id: string; entitlement_id: string; investor_identity_id: string; currency: string; amount_minor: string; payout_status: string }>(`SELECT exception.organization_id,exception.status,exception.hold_status,exception.resolution_type,exception.prepared_by_identity_id,exception.payout_instruction_id,payout.funding_request_id,payout.declaration_request_id,payout.entitlement_id,payout.investor_identity_id,payout.currency,payout.amount_minor,payout.status AS payout_status FROM fractal.distribution_payout_exception_cases exception JOIN fractal.distribution_payout_instructions payout ON payout.id=exception.payout_instruction_id WHERE exception.id=$1 FOR UPDATE OF exception,payout`, [input.exceptionCaseId]);
    const row = result.rows[0];
    if (!row || row.status !== "approved" || row.hold_status !== "clear") throw new DistributionPayoutError("Only an approved, unheld exception can be executed.", "conflict");
    if (row.prepared_by_identity_id === input.actorIdentityId) throw new DistributionPayoutError("The resolution maker cannot execute the correction.", "forbidden");
    let policyId: string | null = null, replacementId: string | null = null, journalId: string | null = null;
    if (row.resolution_type !== "close_no_action") policyId = await requireExceptionPolicy(client, { organizationId: row.organization_id, resolutionType: row.resolution_type, currency: row.currency, amountMinor: row.amount_minor });
    if (row.resolution_type === "replacement_payout") {
      if (!["failed", "reversed"].includes(row.payout_status)) throw new DistributionPayoutError("The source payout is not terminally failed or reversed.", "conflict");
      const profile = await client.query<{ id: string; provider_recipient_reference: string }>("SELECT id,provider_recipient_reference FROM fractal.investor_distribution_payout_profiles WHERE investor_identity_id=$1 AND currency=$2 AND status='verified' ORDER BY version DESC LIMIT 1 FOR SHARE", [row.investor_identity_id, row.currency]);
      if (!profile.rows[0]) throw new DistributionPayoutError("A current verified investor destination is required.", "conflict");
      replacementId = randomUUID();
      await client.query(`INSERT INTO fractal.distribution_payout_instructions(id,reference,funding_request_id,declaration_request_id,entitlement_id,investor_identity_id,payout_profile_version_id,provider,provider_recipient_reference,currency,amount_minor,status,authorized_by_identity_id,instruction_kind,replaces_instruction_id,exception_case_id) VALUES($1,$2,$3,$4,$5,$6,$7,'paystack',$8,$9,$10,'authorized',$11,'replacement',$12,$13)`, [replacementId, commandReference("DPI"), row.funding_request_id, row.declaration_request_id, row.entitlement_id, row.investor_identity_id, profile.rows[0].id, profile.rows[0].provider_recipient_reference, row.currency, row.amount_minor, input.actorIdentityId, row.payout_instruction_id, input.exceptionCaseId]);
    } else if (row.resolution_type === "manual_settlement" || row.resolution_type === "write_off") {
      const evidenceReference = bounded(input.evidenceReference ?? "", "Evidence reference", 8, 500);
      await ensureSettlementAccounts(client, row.organization_id, row.currency);
      const creditCode = row.resolution_type === "manual_settlement" ? `ASSET.DISTRIBUTION_MANUAL_SETTLEMENT_CLEARING.${row.currency}` : `REVENUE.DISTRIBUTION_PAYABLE_RELEASE.${row.currency}`;
      await ensureLedgerAccount(client, { organizationId: row.organization_id, code: creditCode, name: row.resolution_type === "manual_settlement" ? `Distribution manual settlement clearing (${row.currency})` : `Distribution payable release (${row.currency})`, accountType: row.resolution_type === "manual_settlement" ? "asset" : "revenue", normalBalance: row.resolution_type === "manual_settlement" ? "debit" : "credit" });
      const journal = await postJournalInTransaction(client, { scopeKey: `organization:${row.organization_id}`, organizationId: row.organization_id, idempotencyKey: `distribution-exception:${input.exceptionCaseId}`, currency: row.currency, narrative: `Distribution payout ${row.resolution_type.replaceAll("_", " ")}`, externalRef: evidenceReference, effectiveAt: new Date(), metadata: { distributionPayoutInstructionId: row.payout_instruction_id, distributionPayoutExceptionCaseId: input.exceptionCaseId, accountingEvent: row.resolution_type }, postings: [{ accountCode: `LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.${row.currency}`, direction: "debit", amountMinor: BigInt(row.amount_minor) }, { accountCode: creditCode, direction: "credit", amountMinor: BigInt(row.amount_minor) }] });
      journalId = journal.journalId;
    }
    const executionId = randomUUID();
    await client.query("INSERT INTO fractal.distribution_payout_exception_executions(id,case_id,resolution_type,approval_policy_id,replacement_payout_instruction_id,correction_journal_id,evidence_reference,executed_by_identity_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [executionId, input.exceptionCaseId, row.resolution_type, policyId, replacementId, journalId, input.evidenceReference ?? null, input.actorIdentityId]);
    await client.query("UPDATE fractal.distribution_payout_exception_cases SET status='executed',executed_by_identity_id=$2,executed_at=now() WHERE id=$1", [input.exceptionCaseId, input.actorIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${row.organization_id}`, organizationId: row.organization_id, actorId: input.actorIdentityId, actorType: "user", action: `distribution_payout_exception.${row.resolution_type}.executed`, entityType: "distribution_payout_exception_execution", entityId: executionId, payload: { exceptionCaseId: input.exceptionCaseId, payoutInstructionId: row.payout_instruction_id, replacementPayoutInstructionId: replacementId, correctionJournalId: journalId, approvalPolicyId: policyId } });
    await appendOutboxEvent(client, { aggregateType: "distribution_payout_exception", aggregateId: input.exceptionCaseId, eventType: "distribution_payout_exception.executed", payload: { organizationId: row.organization_id, auditEventId: audit.id } });
    return { exceptionCaseId: input.exceptionCaseId, executionId, resolutionType: row.resolution_type, replacementPayoutInstructionId: replacementId, correctionJournalId: journalId };
  });
}
