import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { getGovernanceEvidenceDocument, GovernanceEvidenceError, listAllocationPolicyEvidence, recordAllocationPolicyEvidence } from "../postgres-governance-evidence.js";

const row = (overrides: Record<string, unknown> = {}) => ({ id: "evidence-1", organization_id: "organization-1", offering_id: "offering-1", evidence_kind: "allocation_policy", filename: "Allocation.pdf", mime_type: "application/pdf", storage_key: "governance-evidence/1.pdf", content_sha256: "a".repeat(64), bytes: "1024", uploaded_by_identity_id: "issuer-1", created_at: new Date("2026-07-29T10:00:00.000Z"), ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[] }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("governance evidence", () => {
  it("validates bounded immutable evidence metadata before a transaction", async () => {
    const input = { organizationId: "organization-1", offeringId: "offering-1", uploadedByIdentityId: "issuer-1", filename: "Allocation.pdf", mimeType: "application/pdf", storageKey: "key", contentSha256: "a".repeat(64), bytes: 1024 };
    await expect(recordAllocationPolicyEvidence({ ...input, filename: " " })).rejects.toBeInstanceOf(GovernanceEvidenceError);
    await expect(recordAllocationPolicyEvidence({ ...input, contentSha256: "invalid" })).rejects.toThrow("SHA-256");
    await expect(recordAllocationPolicyEvidence({ ...input, bytes: 0 })).rejects.toThrow("positive safe integer");
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("requires the offering to be published before it records allocation evidence", async () => {
    transactionWithResponses({ rows: [] });
    await expect(recordAllocationPolicyEvidence({ organizationId: "organization-1", offeringId: "offering-1", uploadedByIdentityId: "issuer-1", filename: "Allocation.pdf", mimeType: "Application/PDF", storageKey: "key", contentSha256: "A".repeat(64), bytes: 1024 })).rejects.toThrow("published offering");
  });

  it("records normalized immutable evidence with audit and outbox events", async () => {
    transactionWithResponses({ rows: [{ id: "offering-1" }] }, {});
    await expect(recordAllocationPolicyEvidence({ organizationId: "organization-1", offeringId: "offering-1", uploadedByIdentityId: "issuer-1", filename: " Allocation.pdf ", mimeType: "Application/PDF", storageKey: " evidence/key ", contentSha256: "A".repeat(64), bytes: 1024 })).resolves.toMatchObject({ evidenceDocumentId: expect.any(String), contentSha256: "a".repeat(64) });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.allocation_policy_evidence.recorded" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "offering.allocation_policy_evidence.recorded" }));
  });

  it("maps evidence detail and filtered lists", async () => {
    mocks.postgres.query.mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({ rows: [row()] });
    await expect(getGovernanceEvidenceDocument("evidence-1")).resolves.toMatchObject({ id: "evidence-1", bytes: "1024", createdAt: "2026-07-29T10:00:00.000Z" });
    await expect(listAllocationPolicyEvidence({ organizationId: "organization-1", offeringId: "offering-1" })).resolves.toHaveLength(1);
  });
});
