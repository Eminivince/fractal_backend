import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (operation: (client: { query: typeof query }) => Promise<unknown>) => operation({ query })));
const audit = vi.hoisted(() => vi.fn(async () => ({ id: "audit-1" })));
const outbox = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query }), withPostgresTransaction: transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: outbox }));

import { InvestmentAllocationError, decideInvestmentAllocation, getInvestmentAllocation, listInvestmentAllocations, submitInvestmentAllocation } from "../postgres-investment-allocations.js";

const now = new Date("2026-07-28T10:00:00.000Z");
const allocation = { id: "allocation-1", organization_id: "organization-1", offering_id: "offering-1", issuance_terms_request_id: "terms-1", reservation_id: "reservation-1", investor_identity_id: "investor-1", wallet_id: "wallet-1", chain_id: 1, wallet_address: `0x${"a".repeat(40)}`, invested_minor: "1000", currency: "NGN", token_unit_price_minor: "100", token_amount: "10", allocation_policy_hash: "policy", compliance_snapshot: { kycStatus: "approved" }, status: "submitted", submitted_by_identity_id: "issuer-1", submitted_at: now, decided_by_identity_id: null, decided_at: null, decision_reason: null } as any;
const input = { organizationId: "organization-1", offeringId: "offering-1", issuanceTermsRequestId: "terms-1", reservationId: "reservation-1", walletId: "wallet-1", chainId: 1, submittedByIdentityId: "issuer-1" };
const reservation = { investor_identity_id: "investor-1", amount_minor: "1000", currency: "NGN", offering_version_id: "version-1", status: "confirmed", commitment_id: "commitment-1" };
const terms = { organization_id: "organization-1", offering_id: "offering-1", offering_version_id: "version-1", currency: "NGN", token_unit_price_minor: "100", max_total_supply: "100", allocation_policy_hash: "policy", status: "approved" };
const wallet = { investor_identity_id: "investor-1", chain_id: 1, wallet_address: allocation.wallet_address, status: "active" };
const compliance = { kyc_status: "approved", investor_class: "professional", accreditation_status: "approved", jurisdiction_code: "NG", reviewed_at: now, expires_at: null, evidence: { provider: "test" } };

beforeEach(() => { query.mockReset(); transaction.mockClear(); audit.mockClear(); outbox.mockClear(); });

describe("PostgreSQL investment allocations", () => {
  it("derives an exact token allocation from a controlled reservation, receipt, wallet, terms, and compliance snapshot", async () => {
    query.mockResolvedValueOnce({ rows: [reservation] }).mockResolvedValueOnce({ rows: [{ id: "receipt-1" }] }).mockResolvedValueOnce({ rows: [terms] }).mockResolvedValueOnce({ rows: [wallet] }).mockResolvedValueOnce({ rows: [compliance] }).mockResolvedValueOnce({ rows: [{ total: "20" }] }).mockResolvedValueOnce({ rows: [] });
    await expect(submitInvestmentAllocation(input)).resolves.toEqual({ requestId: expect.any(String), tokenAmount: "10" });
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO fractal.investment_allocation_requests"), expect.arrayContaining(["organization-1", "offering-1", "reservation-1", "investor-1", "1000", "100", "10", "policy"]));
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "investment.allocation.submitted" }));
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "investment.allocation.submitted" }));
  });

  it("rejects malformed input and every prerequisite that fails closed", async () => {
    await expect(submitInvestmentAllocation({ ...input, chainId: 0 })).rejects.toBeInstanceOf(InvestmentAllocationError);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("confirmed investment reservation");
    query.mockResolvedValueOnce({ rows: [reservation] }).mockResolvedValueOnce({ rows: [] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("matched payment receipt");
    query.mockResolvedValueOnce({ rows: [reservation] }).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [{ ...terms, status: "submitted" }] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("terms do not match");
    query.mockResolvedValueOnce({ rows: [reservation] }).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [terms] }).mockResolvedValueOnce({ rows: [{ ...wallet, status: "revoked" }] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("active verified wallet");
    query.mockResolvedValueOnce({ rows: [reservation] }).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [terms] }).mockResolvedValueOnce({ rows: [wallet] }).mockResolvedValueOnce({ rows: [{ ...compliance, kyc_status: "pending" }] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("active approved investor compliance");
  });

  it("rejects residual token amounts, zero allocations, and unavailable issuance supply", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...reservation, amount_minor: "1001" }] }).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [terms] }).mockResolvedValueOnce({ rows: [wallet] }).mockResolvedValueOnce({ rows: [compliance] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("does not divide exactly");
    query.mockResolvedValueOnce({ rows: [{ ...reservation, amount_minor: "0" }] }).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [terms] }).mockResolvedValueOnce({ rows: [wallet] }).mockResolvedValueOnce({ rows: [compliance] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("must be positive");
    query.mockResolvedValueOnce({ rows: [reservation] }).mockResolvedValueOnce({ rows: [{}] }).mockResolvedValueOnce({ rows: [terms] }).mockResolvedValueOnce({ rows: [wallet] }).mockResolvedValueOnce({ rows: [compliance] }).mockResolvedValueOnce({ rows: [{ total: "95" }] });
    await expect(submitInvestmentAllocation(input)).rejects.toThrow("supply is unavailable");
  });

  it("uses independent approval or a stated rejection reason for allocation decisions", async () => {
    query.mockResolvedValueOnce({ rows: [allocation] }).mockResolvedValueOnce({ rows: [] });
    await expect(decideInvestmentAllocation({ requestId: "allocation-1", decidedByIdentityId: "reviewer-1", approve: true, reason: "Approved" })).resolves.toEqual({ requestId: "allocation-1", status: "approved" });
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "investment.allocation.approved" }));
    query.mockResolvedValueOnce({ rows: [] });
    await expect(decideInvestmentAllocation({ requestId: "missing", decidedByIdentityId: "reviewer", approve: true })).rejects.toThrow("not found");
    query.mockResolvedValueOnce({ rows: [{ ...allocation, status: "approved" }] });
    await expect(decideInvestmentAllocation({ requestId: "allocation-1", decidedByIdentityId: "reviewer", approve: true })).rejects.toThrow("already been decided");
    query.mockResolvedValueOnce({ rows: [allocation] });
    await expect(decideInvestmentAllocation({ requestId: "allocation-1", decidedByIdentityId: "issuer-1", approve: true })).rejects.toThrow("different person");
    query.mockResolvedValueOnce({ rows: [allocation] });
    await expect(decideInvestmentAllocation({ requestId: "allocation-1", decidedByIdentityId: "reviewer", approve: false })).rejects.toThrow("reason is required");
    query.mockResolvedValueOnce({ rows: [allocation] }).mockResolvedValueOnce({ rows: [] });
    await expect(decideInvestmentAllocation({ requestId: "allocation-1", decidedByIdentityId: "reviewer", approve: false, reason: "Terms are incomplete." })).resolves.toEqual({ requestId: "allocation-1", status: "rejected" });
  });

  it("maps single and filtered allocation read models", async () => {
    query.mockResolvedValueOnce({ rows: [allocation] }).mockResolvedValueOnce({ rows: [allocation] }).mockResolvedValueOnce({ rows: [] });
    await expect(getInvestmentAllocation("allocation-1")).resolves.toMatchObject({ tokenAmount: "10", submittedAt: now.toISOString(), decidedAt: null });
    await expect(listInvestmentAllocations({ organizationId: "organization-1", status: "submitted" })).resolves.toHaveLength(1);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("($2::text IS NULL OR status = $2)"), ["organization-1", "submitted"]);
    await expect(getInvestmentAllocation("missing")).resolves.toBeNull();
  });
});
