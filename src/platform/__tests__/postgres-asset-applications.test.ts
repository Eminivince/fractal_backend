import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (operation: (client: { query: typeof query }) => Promise<unknown>) => operation({ query })));
const audit = vi.hoisted(() => vi.fn(async () => ({ id: "audit-1" })));
const outbox = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query }), withPostgresTransaction: transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: outbox }));

import {
  AssetApplicationError,
  createAssetApplicationReviewItem,
  decideAssetApplicationRequest,
  decideAssetApplicationReviewItem,
  getAssetApplicationEvidence,
  getAssetApplicationRequest,
  listApprovedAssetApplicationVersions,
  listAssetApplicationRequests,
  listAssetApplicationReviewItems,
  recordAssetApplicationEvidence,
  respondToAssetApplicationReviewItem,
  submitAssetApplicationRequest,
} from "../postgres-asset-applications.js";

const now = new Date("2026-07-28T10:00:00.000Z");
const sha256 = "a".repeat(64);
const request = {
  id: "request-1", organization_id: "organization-1", application_reference: "ASSET-001", application_version: 2,
  asset_name: "Lagos Warehouse", asset_type: "Commercial property", country_code: "NG", state: "Lagos", city: "Lagos",
  summary: "A sufficiently detailed commercial warehouse application summary for testing.", material_change_summary: "The lease schedule has changed since the first submitted application.",
  requested_capacity_minor: "10000000", currency: "NGN", dossier_evidence_document_id: "evidence-1", dossier_hash: sha256,
  status: "submitted", submitted_by_identity_id: "issuer-1", submitted_at: now, decided_by_identity_id: null,
  decided_at: null, decision_reason: null, approved_application_version_id: null,
} as any;
const reviewItem = {
  id: "review-1", organization_id: "organization-1", application_request_id: "request-1", category: "Legal", title: "Title evidence",
  request_message: "Please provide the current title document.", required: true, status: "responded", response_message: "The current title evidence is attached.",
  response_evidence_document_id: "evidence-2", responded_by_identity_id: "issuer-1", responded_at: now, reviewed_by_identity_id: null,
  reviewed_at: null, review_notes: null, opened_by_identity_id: "reviewer-1", opened_at: now,
} as any;

beforeEach(() => { query.mockReset(); transaction.mockClear(); audit.mockClear(); outbox.mockClear(); });

describe("PostgreSQL asset applications", () => {
  it("validates and records immutable dossier evidence with its audit and outbox events", async () => {
    await expect(recordAssetApplicationEvidence({ organizationId: "organization-1", uploadedByIdentityId: "issuer-1", filename: "  dossier.pdf ", mimeType: " Application/PDF ", storageKey: "evidence/dossier.pdf", contentSha256: sha256.toUpperCase(), bytes: 12 })).resolves.toEqual({ evidenceDocumentId: expect.any(String), contentSha256: sha256 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO fractal.asset_application_evidence_documents"), [expect.any(String), "organization-1", "dossier.pdf", "application/pdf", "evidence/dossier.pdf", sha256, 12, "issuer-1"]);
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "asset_application.evidence.recorded" }));
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "asset_application.evidence.recorded" }));
    await expect(recordAssetApplicationEvidence({ organizationId: "org", uploadedByIdentityId: "user", filename: "x", mimeType: "pdf", storageKey: "key", contentSha256: "bad", bytes: 1 })).rejects.toBeInstanceOf(AssetApplicationError);
    await expect(recordAssetApplicationEvidence({ organizationId: "org", uploadedByIdentityId: "user", filename: "x", mimeType: "pdf", storageKey: "key", contentSha256: sha256, bytes: 15 * 1024 * 1024 + 1 })).rejects.toThrow("no greater than 15MB");
  });

  it("submits a verified organization application and rejects invalid or unverified input", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }).mockResolvedValueOnce({ rows: [{ content_sha256: sha256 }] }).mockResolvedValueOnce({ rows: [] });
    await expect(submitAssetApplicationRequest({ organizationId: "organization-1", submittedByIdentityId: "issuer-1", applicationReference: " ASSET-001 ", applicationVersion: 2, assetName: " Lagos Warehouse ", assetType: " Commercial property ", countryCode: "ng", state: "Lagos", city: "Lagos", summary: request.summary, materialChangeSummary: request.material_change_summary, requestedCapacityMinor: 10000000, currency: "ngn", dossierEvidenceDocumentId: "evidence-1" })).resolves.toEqual({ requestId: expect.any(String) });
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("INSERT INTO fractal.asset_application_requests"), expect.arrayContaining(["ASSET-001", 2, "Lagos Warehouse", "NG", "NGN", sha256]));
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "asset_application.submitted" }));
    await expect(submitAssetApplicationRequest({ organizationId: "org", submittedByIdentityId: "user", applicationReference: "ref", applicationVersion: 1, assetName: "Asset", assetType: "Type", countryCode: "NG", state: "Lagos", city: "Lagos", summary: request.summary, materialChangeSummary: "not allowed", requestedCapacityMinor: 1, currency: "NGN", dossierEvidenceDocumentId: "doc" })).rejects.toThrow("only allowed");
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(submitAssetApplicationRequest({ organizationId: "org", submittedByIdentityId: "user", applicationReference: "ref", applicationVersion: 1, assetName: "Asset", assetType: "Type", countryCode: "NG", state: "Lagos", city: "Lagos", summary: request.summary, requestedCapacityMinor: 1, currency: "NGN", dossierEvidenceDocumentId: "doc" })).rejects.toThrow("verification must be current");
  });

  it("approves only a submitted application with verified diligence and an independent reviewer", async () => {
    query.mockResolvedValueOnce({ rows: [request] }).mockResolvedValueOnce({ rows: [{ count: "0" }] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(decideAssetApplicationRequest({ requestId: "request-1", decidedByIdentityId: "reviewer-1", approve: true, reason: "Approved after review" })).resolves.toEqual({ requestId: "request-1", status: "approved", approvedApplicationVersionId: expect.any(String) });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("approved_asset_application_versions"), expect.arrayContaining(["request-1", "organization-1", "reviewer-1"]));
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "asset_application.approved" }));
    query.mockResolvedValueOnce({ rows: [{ ...request, submitted_by_identity_id: "reviewer-1" }] });
    await expect(decideAssetApplicationRequest({ requestId: "request-1", decidedByIdentityId: "reviewer-1", approve: true })).rejects.toThrow("different person");
    query.mockResolvedValueOnce({ rows: [request] }).mockResolvedValueOnce({ rows: [{ count: "1" }] });
    await expect(decideAssetApplicationRequest({ requestId: "request-1", decidedByIdentityId: "reviewer-1", approve: true })).rejects.toThrow("must be verified");
  });

  it("requires a reason when it rejects an application and fails closed for missing or decided requests", async () => {
    query.mockResolvedValueOnce({ rows: [] });
    await expect(decideAssetApplicationRequest({ requestId: "missing", decidedByIdentityId: "reviewer", approve: true })).rejects.toThrow("not found");
    query.mockResolvedValueOnce({ rows: [{ ...request, status: "approved" }] });
    await expect(decideAssetApplicationRequest({ requestId: "request-1", decidedByIdentityId: "reviewer", approve: false, reason: "no" })).rejects.toThrow("already been decided");
    query.mockResolvedValueOnce({ rows: [request] });
    await expect(decideAssetApplicationRequest({ requestId: "request-1", decidedByIdentityId: "reviewer", approve: false })).rejects.toThrow("reason is required");
    query.mockResolvedValueOnce({ rows: [request] }).mockResolvedValueOnce({ rows: [{ count: "0" }] }).mockResolvedValueOnce({ rows: [] });
    await expect(decideAssetApplicationRequest({ requestId: "request-1", decidedByIdentityId: "reviewer", approve: false, reason: "The evidence is incomplete." })).resolves.toEqual({ requestId: "request-1", status: "rejected" });
  });

  it("maps request, evidence, approved-version, and review-item read models", async () => {
    const evidence = { id: "evidence-1", organization_id: "organization-1", filename: "dossier.pdf", mime_type: "application/pdf", storage_key: "evidence/dossier.pdf", content_sha256: sha256, bytes: "12", uploaded_by_identity_id: "issuer-1", created_at: now };
    query.mockResolvedValueOnce({ rows: [request] }).mockResolvedValueOnce({ rows: [request] }).mockResolvedValueOnce({ rows: [{ id: "version-1", application_reference: "ASSET-001", application_version: 2, asset_name: "Lagos Warehouse", requested_capacity_minor: "10000000", currency: "NGN", approved_at: now, is_current: true }] }).mockResolvedValueOnce({ rows: [evidence] }).mockResolvedValueOnce({ rows: [reviewItem] });
    await expect(getAssetApplicationRequest("request-1")).resolves.toMatchObject({ applicationReference: "ASSET-001", submittedAt: now.toISOString(), decidedAt: null });
    await expect(listAssetApplicationRequests("organization-1")).resolves.toHaveLength(1);
    await expect(listApprovedAssetApplicationVersions("organization-1")).resolves.toEqual([expect.objectContaining({ approvedAt: now.toISOString(), isCurrent: true })]);
    await expect(getAssetApplicationEvidence("evidence-1")).resolves.toMatchObject({ contentSha256: sha256, createdAt: now.toISOString() });
    await expect(listAssetApplicationReviewItems({ organizationId: "organization-1", applicationRequestId: "request-1" })).resolves.toEqual([expect.objectContaining({ status: "responded", respondedAt: now.toISOString() })]);
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(getAssetApplicationRequest("missing")).resolves.toBeNull();
    await expect(getAssetApplicationEvidence("missing")).resolves.toBeNull();
  });

  it("opens only valid diligence items on a submitted application", async () => {
    query.mockResolvedValueOnce({ rows: [request] }).mockResolvedValueOnce({ rows: [] });
    await expect(createAssetApplicationReviewItem({ organizationId: "organization-1", applicationRequestId: "request-1", openedByIdentityId: "reviewer-1", category: " Legal ", title: " Title evidence ", requestMessage: " Please provide title evidence. " })).resolves.toEqual({ reviewItemId: expect.any(String) });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO fractal.asset_application_review_items"), expect.arrayContaining(["Legal", "Title evidence", "Please provide title evidence.", true]));
    query.mockResolvedValueOnce({ rows: [{ ...request, status: "rejected" }] });
    await expect(createAssetApplicationReviewItem({ organizationId: "organization-1", applicationRequestId: "request-1", openedByIdentityId: "reviewer-1", category: "Legal", title: "Title", requestMessage: "Evidence" })).rejects.toThrow("only be opened");
  });

  it("accepts an issuer response only when it has organization-owned evidence", async () => {
    query.mockResolvedValueOnce({ rows: [{ ...reviewItem, status: "open" }] }).mockResolvedValueOnce({ rows: [{ id: "evidence-2" }] }).mockResolvedValueOnce({ rows: [] });
    await expect(respondToAssetApplicationReviewItem({ reviewItemId: "review-1", respondedByIdentityId: "issuer-1", responseMessage: " The title evidence is attached. ", responseEvidenceDocumentId: "evidence-2" })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'responded'"), expect.arrayContaining(["review-1", "The title evidence is attached.", "evidence-2", "issuer-1"]));
    query.mockResolvedValueOnce({ rows: [{ ...reviewItem, status: "verified" }] });
    await expect(respondToAssetApplicationReviewItem({ reviewItemId: "review-1", respondedByIdentityId: "issuer-1", responseMessage: "Evidence", responseEvidenceDocumentId: "evidence-2" })).rejects.toThrow("not awaiting");
    query.mockResolvedValueOnce({ rows: [{ ...reviewItem, status: "open" }] }).mockResolvedValueOnce({ rows: [] });
    await expect(respondToAssetApplicationReviewItem({ reviewItemId: "review-1", respondedByIdentityId: "issuer-1", responseMessage: "Evidence", responseEvidenceDocumentId: "missing" })).rejects.toThrow("must belong");
  });

  it("requires an independent reviewer and a note for rejected diligence responses", async () => {
    query.mockResolvedValueOnce({ rows: [reviewItem] }).mockResolvedValueOnce({ rows: [] });
    await expect(decideAssetApplicationReviewItem({ reviewItemId: "review-1", reviewedByIdentityId: "reviewer-1", verify: true, notes: "Valid title." })).resolves.toBeUndefined();
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "asset_application.review_item.verified" }));
    query.mockResolvedValueOnce({ rows: [{ ...reviewItem, responded_by_identity_id: "reviewer-1" }] });
    await expect(decideAssetApplicationReviewItem({ reviewItemId: "review-1", reviewedByIdentityId: "reviewer-1", verify: true })).rejects.toThrow("different person");
    query.mockResolvedValueOnce({ rows: [reviewItem] });
    await expect(decideAssetApplicationReviewItem({ reviewItemId: "review-1", reviewedByIdentityId: "reviewer-1", verify: false })).rejects.toThrow("rejection note");
    query.mockResolvedValueOnce({ rows: [reviewItem] }).mockResolvedValueOnce({ rows: [] });
    await expect(decideAssetApplicationReviewItem({ reviewItemId: "review-1", reviewedByIdentityId: "reviewer-1", verify: false, notes: "The document is out of date." })).resolves.toBeUndefined();
    query.mockResolvedValueOnce({ rows: [] });
    await expect(decideAssetApplicationReviewItem({ reviewItemId: "missing", reviewedByIdentityId: "reviewer-1", verify: true })).rejects.toThrow("not found");
  });
});
