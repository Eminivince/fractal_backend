import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgres: { query: vi.fn() }, transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn(), publish: vi.fn(), upsertCompliance: vi.fn(),
}));

vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../postgres-offering-checkout.js", () => ({
  CheckoutPolicyError: class CheckoutPolicyError extends Error {},
  publishOfferingInTransaction: mocks.publish,
  upsertInvestorComplianceProfileInTransaction: mocks.upsertCompliance,
}));

import {
  decideInvestorComplianceReview,
  decideOfferingPublicationRequest,
  getOfferingPublicationRequest,
  listInvestorComplianceReviewRequests,
  OfferingGovernanceError,
  submitInvestorComplianceReview,
  submitOfferingPublicationRequest,
} from "../postgres-offering-governance.js";

const now = new Date("2026-07-29T10:00:00.000Z");
const terms = {
  name: "Harbour Logistics", publicSlug: "harbour-logistics", minimumTicketMinor: 1000, assetClass: "logistics_industrial", summary: "Income property.", thesis: "Long-term contracted logistics income.", targetReturnBps: 1200, termMonths: 60, riskSummary: "Market and liquidity risk.", incomeSource: "Lease income.", structure: "SPV.", security: "Asset security.", feeSummary: "Management fee.", nextMilestone: "Closing review.",
} as const;
const eligibilityPolicy = { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"] } as const;
const publicationRequest = (overrides: Record<string, unknown> = {}) => ({
  id: "publication-1", organization_id: "organization-1", public_reference: "HARBOR-1", currency: "usd", capacity_minor: "100000", opens_at: now, closes_at: new Date("2026-08-29T10:00:00.000Z"), terms, eligibility_policy: eligibilityPolicy, agreement_document_hash: "a".repeat(64), disclosure_bundle_hash: "b".repeat(64), status: "submitted", submitted_by_identity_id: "maker-1", agreement_evidence_document_id: "agreement-1", disclosure_evidence_document_id: "disclosure-1", approved_asset_application_version_id: "application-version-1", ...overrides,
});
const complianceRequest = (overrides: Record<string, unknown> = {}) => ({
  id: "compliance-1", organization_id: "organization-1", investor_identity_id: "investor-1", kyc_status: "approved", investor_class: "retail", accreditation_status: "not_required", jurisdiction_code: "NG", reviewed_at: now, expires_at: null, evidence: { source: "manual" }, status: "submitted", submitted_by_identity_id: "maker-1", ...overrides,
});

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); mocks.publish.mockReset(); mocks.upsertCompliance.mockReset().mockResolvedValue(undefined);
});

describe("offering governance", () => {
  it("requires distinct agreement and disclosure evidence before a publication request", async () => {
    transactionWithResponses();
    await expect(submitOfferingPublicationRequest({ organizationId: "organization-1", submittedByIdentityId: "maker-1", publicReference: "HARBOR-1", currency: "USD", capacityMinor: 100000, opensAt: now, closesAt: new Date("2026-08-29"), terms, eligibilityPolicy, agreementEvidenceDocumentId: "same", disclosureEvidenceDocumentId: "same", approvedAssetApplicationVersionId: "application-version-1" })).rejects.toBeInstanceOf(OfferingGovernanceError);
  });

  it("validates public offering terms and writes a governed submission", async () => {
    transactionWithResponses(
      { rows: [{ id: "agreement-1", evidence_kind: "agreement", content_sha256: "a".repeat(64) }, { id: "disclosure-1", evidence_kind: "disclosure_bundle", content_sha256: "b".repeat(64) }] }, {},
    );
    await expect(submitOfferingPublicationRequest({ organizationId: "organization-1", submittedByIdentityId: "maker-1", publicReference: "HARBOR-1", currency: "usd", capacityMinor: 100000, opensAt: now, closesAt: new Date("2026-08-29"), terms, eligibilityPolicy, agreementEvidenceDocumentId: "agreement-1", disclosureEvidenceDocumentId: "disclosure-1", approvedAssetApplicationVersionId: "application-version-1" })).resolves.toMatchObject({ requestId: expect.any(String) });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.publication.submitted" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "offering.publication.submitted" }));
  });

  it("does not accept a malformed public slug", async () => {
    transactionWithResponses({ rows: [{ id: "agreement-1", evidence_kind: "agreement", content_sha256: "a".repeat(64) }, { id: "disclosure-1", evidence_kind: "disclosure_bundle", content_sha256: "b".repeat(64) }] });
    await expect(submitOfferingPublicationRequest({ organizationId: "organization-1", submittedByIdentityId: "maker-1", publicReference: "HARBOR-1", currency: "USD", capacityMinor: 100000, opensAt: now, closesAt: new Date("2026-08-29"), terms: { ...terms, publicSlug: "Not A Slug" }, eligibilityPolicy, agreementEvidenceDocumentId: "agreement-1", disclosureEvidenceDocumentId: "disclosure-1", approvedAssetApplicationVersionId: "application-version-1" })).rejects.toThrow("lowercase URL slug");
  });

  it("requires a reason for rejection and an independent decision maker", async () => {
    transactionWithResponses({ rows: [publicationRequest()] });
    await expect(decideOfferingPublicationRequest({ requestId: "publication-1", decidedByIdentityId: "reviewer-1", approve: false })).rejects.toThrow("rejection reason");
    transactionWithResponses({ rows: [publicationRequest()] });
    await expect(decideOfferingPublicationRequest({ requestId: "publication-1", decidedByIdentityId: "maker-1", approve: true })).rejects.toThrow("different person");
  });

  it("publishes only after the origin remains current and records approval", async () => {
    mocks.publish.mockResolvedValueOnce({ offeringId: "offering-1", offeringVersionId: "version-1" });
    transactionWithResponses(
      { rows: [publicationRequest()] }, { rows: [{ organization_id: "organization-1", application_reference: "application-1" }] }, {}, { rows: [], rowCount: 0 }, {},
    );
    await expect(decideOfferingPublicationRequest({ requestId: "publication-1", decidedByIdentityId: "reviewer-1", approve: true, reason: "Evidence verified" })).resolves.toEqual({ requestId: "publication-1", status: "approved", offeringId: "offering-1", offeringVersionId: "version-1" });
    expect(mocks.publish).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.publication.approved" }));
  });

  it("validates compliance review dates before it starts a transaction", async () => {
    await expect(submitInvestorComplianceReview({ organizationId: "organization-1", submittedByIdentityId: "maker-1", identityId: "investor-1", kycStatus: "approved", investorClass: "retail", accreditationStatus: "not_required", jurisdictionCode: "NG", reviewedAt: now, expiresAt: new Date("2026-07-28"), evidence: {} })).rejects.toThrow("expiresAt must follow");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("applies an approved compliance review to the investor profile", async () => {
    transactionWithResponses({ rows: [complianceRequest()] }, {}, {});
    await expect(decideInvestorComplianceReview({ requestId: "compliance-1", decidedByIdentityId: "reviewer-1", approve: true })).resolves.toEqual({ requestId: "compliance-1", status: "approved" });
    expect(mocks.upsertCompliance).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ identityId: "investor-1", jurisdictionCode: "NG" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "investor.compliance.approved" }));
  });

  it("returns the raw publication record and maps compliance review lists", async () => {
    mocks.postgres.query.mockResolvedValueOnce({ rows: [publicationRequest()] }).mockResolvedValueOnce({ rows: [{ ...complianceRequest(), submitted_at: now, decided_at: null, decided_by_identity_id: null, decision_reason: null }] });
    await expect(getOfferingPublicationRequest("publication-1")).resolves.toEqual(publicationRequest());
    await expect(listInvestorComplianceReviewRequests({ organizationId: "organization-1" })).resolves.toEqual([expect.objectContaining({ id: "compliance-1", reviewedAt: now.toISOString(), expiresAt: null })]);
  });
});
