import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { decideOfferingIssuanceTerms, getOfferingIssuanceTerms, listOfferingIssuanceTerms, OfferingIssuanceTermsError, submitOfferingIssuanceTerms } from "../postgres-offering-issuance-terms.js";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const request = (overrides: Record<string, unknown> = {}) => ({ id: "terms-1", organization_id: "organization-1", offering_id: "offering-1", offering_version_id: "version-1", currency: "USD", token_unit_price_minor: "100", max_total_supply: "1000", allocation_policy_hash: "a".repeat(64), allocation_policy_evidence_document_id: evidenceId, status: "submitted", submitted_by_identity_id: "maker-1", submitted_at: new Date("2026-07-29T10:00:00.000Z"), decided_by_identity_id: null, decided_at: null, decision_reason: null, ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[] }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("offering issuance terms", () => {
  it("rejects invalid economic amounts and evidence identifiers before a transaction", async () => {
    const base = { organizationId: "organization-1", offeringId: "offering-1", submittedByIdentityId: "maker-1", tokenUnitPriceMinor: 100, maxTotalSupply: 1000, allocationPolicyEvidenceDocumentId: evidenceId };
    await expect(submitOfferingIssuanceTerms({ ...base, tokenUnitPriceMinor: 0 })).rejects.toBeInstanceOf(OfferingIssuanceTermsError);
    await expect(submitOfferingIssuanceTerms({ ...base, tokenUnitPriceMinor: Number.MAX_SAFE_INTEGER + 1 })).rejects.toThrow("safe integer");
    await expect(submitOfferingIssuanceTerms({ ...base, allocationPolicyEvidenceDocumentId: "invalid" })).rejects.toThrow("must be a UUID");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("submits bounded terms only for a published offering with recorded evidence", async () => {
    transactionWithResponses({ rows: [{ currency: "USD", capacity_minor: "100000", version_id: "version-1" }] }, { rows: [{ content_sha256: "a".repeat(64) }] }, {});
    await expect(submitOfferingIssuanceTerms({ organizationId: "organization-1", offeringId: "offering-1", submittedByIdentityId: "maker-1", tokenUnitPriceMinor: 100, maxTotalSupply: 1000, allocationPolicyEvidenceDocumentId: evidenceId })).resolves.toMatchObject({ requestId: expect.any(String) });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.issuance_terms.submitted" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "offering.issuance_terms.submitted" }));
  });

  it("does not allow issuance capacity or missing evidence", async () => {
    transactionWithResponses({ rows: [{ currency: "USD", capacity_minor: "100", version_id: "version-1" }] });
    await expect(submitOfferingIssuanceTerms({ organizationId: "organization-1", offeringId: "offering-1", submittedByIdentityId: "maker-1", tokenUnitPriceMinor: 100, maxTotalSupply: 2, allocationPolicyEvidenceDocumentId: evidenceId })).rejects.toThrow("exceeds offering capacity");
    transactionWithResponses({ rows: [{ currency: "USD", capacity_minor: "100000", version_id: "version-1" }] }, { rows: [] });
    await expect(submitOfferingIssuanceTerms({ organizationId: "organization-1", offeringId: "offering-1", submittedByIdentityId: "maker-1", tokenUnitPriceMinor: 100, maxTotalSupply: 2, allocationPolicyEvidenceDocumentId: evidenceId })).rejects.toThrow("allocation-policy evidence");
  });

  it("requires independent review and a reason for rejection", async () => {
    transactionWithResponses({ rows: [request()] });
    await expect(decideOfferingIssuanceTerms({ requestId: "terms-1", decidedByIdentityId: "maker-1", approve: true })).rejects.toThrow("different person");
    transactionWithResponses({ rows: [request()] });
    await expect(decideOfferingIssuanceTerms({ requestId: "terms-1", decidedByIdentityId: "reviewer-1", approve: false })).rejects.toThrow("rejection reason");
  });

  it("records an independent terms approval and maps read models", async () => {
    transactionWithResponses({ rows: [request()] }, {});
    await expect(decideOfferingIssuanceTerms({ requestId: "terms-1", decidedByIdentityId: "reviewer-1", approve: true, reason: "Evidence reviewed" })).resolves.toEqual({ requestId: "terms-1", status: "approved" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.issuance_terms.approved" }));
    mocks.postgres.query.mockResolvedValueOnce({ rows: [request({ status: "approved", decided_at: new Date("2026-07-30T10:00:00.000Z"), decided_by_identity_id: "reviewer-1" })] }).mockResolvedValueOnce({ rows: [request()] });
    await expect(getOfferingIssuanceTerms("terms-1")).resolves.toMatchObject({ id: "terms-1", submittedAt: "2026-07-29T10:00:00.000Z", status: "approved" });
    await expect(listOfferingIssuanceTerms({ organizationId: "organization-1", status: "submitted" })).resolves.toHaveLength(1);
  });
});
