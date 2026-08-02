import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query: mocks.query }), withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { getOfferingPublicationEvidence, listOfferingPublicationEvidence, OfferingPublicationEvidenceError, recordOfferingPublicationEvidence } from "../postgres-offering-publication-evidence.js";

beforeEach(() => { mocks.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("offering publication evidence", () => {
  it("validates file metadata before it starts a transaction", async () => {
    await expect(recordOfferingPublicationEvidence({ organizationId: "org-1", evidenceKind: "agreement", uploadedByIdentityId: "admin-1", filename: "", mimeType: "application/pdf", storageKey: "private/file.pdf", contentSha256: "a".repeat(64), bytes: 1 })).rejects.toBeInstanceOf(OfferingPublicationEvidenceError);
    await expect(recordOfferingPublicationEvidence({ organizationId: "org-1", evidenceKind: "agreement", uploadedByIdentityId: "admin-1", filename: "file.pdf", mimeType: "application/pdf", storageKey: "private/file.pdf", contentSha256: "invalid", bytes: 1 })).rejects.toThrow("SHA-256");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("records normalized immutable evidence with audit and outbox records", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
    const result = await recordOfferingPublicationEvidence({ organizationId: "org-1", evidenceKind: "agreement", uploadedByIdentityId: "admin-1", filename: "  Agreement.pdf ", mimeType: " Application/PDF ", storageKey: " private/file.pdf ", contentSha256: "A".repeat(64), bytes: 1024 });
    expect(result.contentSha256).toBe("a".repeat(64));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO fractal.offering_publication_evidence_documents"), expect.arrayContaining(["Agreement.pdf", "application/pdf", "private/file.pdf", "a".repeat(64), 1024]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.publication_evidence.recorded" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "offering.publication_evidence.recorded" }));
  });

  it("maps single and filtered evidence reads", async () => {
    const row = { id: "evidence-1", organization_id: "org-1", evidence_kind: "disclosure_bundle", filename: "disclosure.pdf", mime_type: "application/pdf", storage_key: "private/disclosure.pdf", content_sha256: "a".repeat(64), bytes: "1024", uploaded_by_identity_id: "admin-1", created_at: new Date("2026-07-29T10:00:00.000Z") };
    mocks.query.mockResolvedValueOnce({ rows: [row] });
    await expect(getOfferingPublicationEvidence("evidence-1")).resolves.toEqual(expect.objectContaining({ evidenceKind: "disclosure_bundle", createdAt: "2026-07-29T10:00:00.000Z" }));
    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(getOfferingPublicationEvidence("missing")).resolves.toBeNull();
    mocks.query.mockResolvedValueOnce({ rows: [row] });
    await expect(listOfferingPublicationEvidence({ organizationId: "org-1", evidenceKind: "disclosure_bundle" })).resolves.toHaveLength(1);
    expect(mocks.query).toHaveBeenLastCalledWith(expect.stringContaining("evidence_kind = $2"), ["org-1", "disclosure_bundle"]);
  });
});
