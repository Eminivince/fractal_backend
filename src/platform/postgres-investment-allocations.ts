import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class InvestmentAllocationError extends Error {}

type AllocationRow = {
  id: string; organization_id: string; offering_id: string; issuance_terms_request_id: string; reservation_id: string;
  investor_identity_id: string; wallet_id: string; chain_id: number; wallet_address: string; invested_minor: string; currency: string;
  token_unit_price_minor: string; token_amount: string; allocation_policy_hash: string; compliance_snapshot: Record<string, unknown>;
  status: "submitted" | "approved" | "rejected"; submitted_by_identity_id: string; submitted_at: Date;
  decided_by_identity_id: string | null; decided_at: Date | null; decision_reason: string | null;
};

function map(row: AllocationRow) {
  return { id: row.id, organizationId: row.organization_id, offeringId: row.offering_id, issuanceTermsRequestId: row.issuance_terms_request_id,
    reservationId: row.reservation_id, investorIdentityId: row.investor_identity_id, walletId: row.wallet_id, chainId: row.chain_id,
    walletAddress: row.wallet_address, investedMinor: row.invested_minor, currency: row.currency, tokenUnitPriceMinor: row.token_unit_price_minor,
    tokenAmount: row.token_amount, allocationPolicyHash: row.allocation_policy_hash, complianceSnapshot: row.compliance_snapshot, status: row.status,
    submittedByIdentityId: row.submitted_by_identity_id, submittedAt: row.submitted_at.toISOString(), decidedByIdentityId: row.decided_by_identity_id,
    decidedAt: row.decided_at?.toISOString() ?? null, decisionReason: row.decision_reason };
}

function validChainId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new InvestmentAllocationError("chainId must be a positive safe integer");
  return value;
}

/**
 * Derives the only permissible token amount from a matched reservation and an
 * approved term. A residual currency amount is a reconciliation problem, not
 * a rounding opportunity.
 */
export async function submitInvestmentAllocation(input: {
  organizationId: string; offeringId: string; issuanceTermsRequestId: string; reservationId: string;
  walletId: string; chainId: number; submittedByIdentityId: string;
}): Promise<{ requestId: string; tokenAmount: string }> {
  const chainId = validChainId(input.chainId);
  const requestId = randomUUID();
  return withPostgresTransaction(async (client) => {
    const reservationResult = await client.query<{
      investor_identity_id: string; amount_minor: string; currency: string; offering_version_id: string; status: string; commitment_id: string | null;
    }>("SELECT investor_identity_id, amount_minor, currency, offering_version_id, status, commitment_id FROM fractal.investment_reservations WHERE id = $1 AND offering_id = $2 FOR UPDATE", [input.reservationId, input.offeringId]);
    const reservation = reservationResult.rows[0];
    if (!reservation || reservation.status !== "confirmed" || !reservation.commitment_id) throw new InvestmentAllocationError("Allocation requires a confirmed investment reservation");
    const matched = await client.query<{ id: string }>(
      `SELECT receipt.id FROM fractal.payment_receipts receipt
       JOIN fractal.payment_intents intent ON intent.id = receipt.payment_intent_id
       WHERE intent.commitment_id = $1 AND receipt.status = 'matched' LIMIT 1 FOR SHARE`, [reservation.commitment_id],
    );
    if (!matched.rows[0]) throw new InvestmentAllocationError("Allocation requires a matched payment receipt");
    const termsResult = await client.query<{
      organization_id: string; offering_id: string; offering_version_id: string; currency: string; token_unit_price_minor: string; max_total_supply: string; allocation_policy_hash: string; status: string;
    }>("SELECT organization_id, offering_id, offering_version_id, currency, token_unit_price_minor, max_total_supply, allocation_policy_hash, status FROM fractal.offering_issuance_term_requests WHERE id = $1 FOR SHARE", [input.issuanceTermsRequestId]);
    const terms = termsResult.rows[0];
    if (!terms || terms.status !== "approved" || terms.organization_id !== input.organizationId || terms.offering_id !== input.offeringId || terms.offering_version_id !== reservation.offering_version_id || terms.currency !== reservation.currency) throw new InvestmentAllocationError("Allocation terms do not match the confirmed offering reservation");
    const walletResult = await client.query<{ investor_identity_id: string; chain_id: number; wallet_address: string; status: string }>("SELECT investor_identity_id, chain_id, wallet_address, status FROM fractal.investor_wallets WHERE id = $1 FOR SHARE", [input.walletId]);
    const wallet = walletResult.rows[0];
    if (!wallet || wallet.status !== "active" || wallet.investor_identity_id !== reservation.investor_identity_id || wallet.chain_id !== chainId) throw new InvestmentAllocationError("Allocation requires the investor's active verified wallet for the selected chain");
    const complianceResult = await client.query<{ kyc_status: string; investor_class: string; accreditation_status: string; jurisdiction_code: string; reviewed_at: Date; expires_at: Date | null; evidence: Record<string, unknown> }>("SELECT kyc_status, investor_class, accreditation_status, jurisdiction_code, reviewed_at, expires_at, evidence FROM fractal.investor_compliance_profiles WHERE identity_id = $1 FOR SHARE", [reservation.investor_identity_id]);
    const compliance = complianceResult.rows[0];
    if (!compliance || compliance.kyc_status !== "approved" || (compliance.expires_at && compliance.expires_at <= new Date())) throw new InvestmentAllocationError("Allocation requires an active approved investor compliance profile");
    const investedMinor = BigInt(reservation.amount_minor);
    const unitPrice = BigInt(terms.token_unit_price_minor);
    if (investedMinor % unitPrice !== 0n) throw new InvestmentAllocationError("Confirmed payment does not divide exactly into the approved token unit price");
    const tokenAmount = investedMinor / unitPrice;
    if (tokenAmount <= 0n) throw new InvestmentAllocationError("Derived token allocation must be positive");
    const reservedSupply = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(token_amount), 0)::text AS total FROM fractal.investment_allocation_requests
       WHERE issuance_terms_request_id = $1 AND status IN ('submitted', 'approved')`, [input.issuanceTermsRequestId],
    );
    if (BigInt(reservedSupply.rows[0]?.total ?? "0") + tokenAmount > BigInt(terms.max_total_supply)) throw new InvestmentAllocationError("Approved issuance supply is unavailable");
    const complianceSnapshot = { kycStatus: compliance.kyc_status, investorClass: compliance.investor_class, accreditationStatus: compliance.accreditation_status, jurisdictionCode: compliance.jurisdiction_code, reviewedAt: compliance.reviewed_at.toISOString(), expiresAt: compliance.expires_at?.toISOString() ?? null, evidence: compliance.evidence };
    await client.query(
      `INSERT INTO fractal.investment_allocation_requests
       (id, organization_id, offering_id, issuance_terms_request_id, reservation_id, investor_identity_id, wallet_id, chain_id, wallet_address, invested_minor, currency, token_unit_price_minor, token_amount, allocation_policy_hash, compliance_snapshot, status, submitted_by_identity_id, submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'submitted',$16,now())`,
      [requestId, input.organizationId, input.offeringId, input.issuanceTermsRequestId, input.reservationId, reservation.investor_identity_id, input.walletId, chainId, wallet.wallet_address, investedMinor.toString(), reservation.currency, unitPrice.toString(), tokenAmount.toString(), terms.allocation_policy_hash, complianceSnapshot, input.submittedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.submittedByIdentityId, actorType: "user", action: "investment.allocation.submitted", entityType: "investment_allocation_request", entityId: requestId, payload: { offeringId: input.offeringId, reservationId: input.reservationId, issuanceTermsRequestId: input.issuanceTermsRequestId, walletId: input.walletId, chainId, tokenAmount: tokenAmount.toString(), investedMinor: investedMinor.toString(), currency: reservation.currency } });
    await appendOutboxEvent(client, { aggregateType: "investment_allocation_request", aggregateId: requestId, eventType: "investment.allocation.submitted", payload: { organizationId: input.organizationId, auditEventId: audit.id } });
    return { requestId, tokenAmount: tokenAmount.toString() };
  });
}

export async function decideInvestmentAllocation(input: { requestId: string; decidedByIdentityId: string; approve: boolean; reason?: string }): Promise<{ requestId: string; status: "approved" | "rejected" }> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<AllocationRow>("SELECT * FROM fractal.investment_allocation_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
    const request = result.rows[0];
    if (!request) throw new InvestmentAllocationError("Investment allocation request not found");
    if (request.status !== "submitted") throw new InvestmentAllocationError("Investment allocation request has already been decided");
    if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new InvestmentAllocationError("A different person must approve or reject this request");
    const reason = input.reason?.trim();
    if (!input.approve && !reason) throw new InvestmentAllocationError("A rejection reason is required");
    const status = input.approve ? "approved" : "rejected";
    await client.query("UPDATE fractal.investment_allocation_requests SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4 WHERE id = $1", [request.id, status, input.decidedByIdentityId, input.approve ? reason ?? null : reason]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${request.organization_id}`, organizationId: request.organization_id, actorId: input.decidedByIdentityId, actorType: "user", action: `investment.allocation.${status}`, entityType: "investment_allocation_request", entityId: request.id, reason: reason ?? undefined, payload: { offeringId: request.offering_id, reservationId: request.reservation_id, tokenAmount: request.token_amount, walletAddress: request.wallet_address } });
    await appendOutboxEvent(client, { aggregateType: "investment_allocation_request", aggregateId: request.id, eventType: `investment.allocation.${status}`, payload: { organizationId: request.organization_id, auditEventId: audit.id } });
    return { requestId: request.id, status };
  });
}

export async function getInvestmentAllocation(requestId: string) {
  const row = (await requirePostgres().query<AllocationRow>("SELECT * FROM fractal.investment_allocation_requests WHERE id = $1", [requestId])).rows[0];
  return row ? map(row) : null;
}

export async function listInvestmentAllocations(input: { organizationId: string; status?: "submitted" | "approved" | "rejected" }) {
  const rows = await requirePostgres().query<AllocationRow>("SELECT * FROM fractal.investment_allocation_requests WHERE organization_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY submitted_at DESC, id DESC", [input.organizationId, input.status ?? null]);
  return rows.rows.map(map);
}
