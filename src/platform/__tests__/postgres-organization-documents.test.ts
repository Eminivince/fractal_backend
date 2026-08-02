import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), database: { query: vi.fn() }, binding: vi.fn(), lifecycleLock: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.database, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: mocks.binding }));
vi.mock("../postgres-data-lifecycle-lock.js", () => ({ lockDataLifecycleAuthority: mocks.lifecycleLock }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  OrganizationDocumentError,
  addOrganizationDocumentVersion,
  archiveOrganizationDocument,
  createOrganizationDocument,
  getOrganizationDocumentRetentionOptions,
  getOrganizationDocumentVersion,
  listOrganizationDocumentAccessEvents,
  listOrganizationDocuments,
  recordOrganizationDocumentDownload,
} from "../postgres-organization-documents.js";

const categories = ["corporate", "finance", "operations", "compliance", "governance", "other"];
const bases = ["legal_requirement", "contractual_record", "corporate_record", "operational_record"];
const policy = { policyReference: "ORG-RETENTION-NG-01", policyName: "Approved organization document retention policy", schemaVersion: "organization-document-retention-v1" as const, jurisdictions: { NG: { legalBasisReference: "Applicable Nigerian corporate records retention authority", rules: Object.fromEntries(categories.map((category) => [category, Object.fromEntries(bases.map((basis) => [basis, { retentionDays: 365 }]))])) } } };
const binding = { configurationKey: "organization.document.retention_policy", versionId: "policy-version-1", versionNumber: 3, projectionVersion: 4, valueSha256: "b".repeat(64), value: policy };
const timestamp = new Date("2026-07-01T10:00:00.000Z");

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query;
}
const documentRow = (overrides: Record<string, unknown> = {}) => ({
  document_id: "document-1", organization_id: "organization-1", title: "Board resolution", category: "governance", reference: "BR-1", status: "active", current_version_number: 1, retention_basis: "corporate_record", retain_until: new Date("2027-07-01T10:00:00.000Z"), document_created_at: timestamp, archived_at: null, archive_reason: null, retention_binding_status: "governed", retention_policy_version_id: "policy-version-1", retention_policy_version_number: 3, retention_policy_reference: policy.policyReference, retention_policy_name: policy.policyName, retention_policy_schema_version: policy.schemaVersion, retention_policy_jurisdiction_code: "NG", retention_policy_legal_basis_reference: policy.jurisdictions.NG.legalBasisReference, retention_days: 365, disposition_status: null, version_id: "version-1", version_number: 1, filename: "board.pdf", mime_type: "application/pdf", storage_key: "documents/board.pdf", content_sha256: "a".repeat(64), bytes: "100", version_retain_until: new Date("2027-07-01T10:00:00.000Z"), version_created_at: timestamp, download_count: "1", last_downloaded_at: timestamp, ...overrides,
});

beforeEach(() => { mocks.transaction.mockReset(); mocks.database.query.mockReset(); mocks.binding.mockReset().mockResolvedValue(binding); mocks.lifecycleLock.mockReset().mockResolvedValue(undefined); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("organization documents", () => {
  it("rejects an invalid document hash before it writes any record", async () => {
    await expect(createOrganizationDocument({ organizationId: "organization-1", actorIdentityId: "owner-1", title: "Board resolution", category: "governance", retentionBasis: "corporate_record", filename: "board.pdf", mimeType: "application/pdf", storageKey: "documents/board.pdf", contentSha256: "invalid", bytes: 100 })).rejects.toBeInstanceOf(OrganizationDocumentError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("returns all governed retention choices for the organization's jurisdiction", async () => {
    transactionWithResponses({ rows: [{ jurisdiction_code: "NG" }] });
    const result = await getOrganizationDocumentRetentionOptions("organization-1");
    expect(result.policy).toMatchObject({ versionId: "policy-version-1", jurisdictionCode: "NG" });
    expect(result.rules).toHaveLength(24);
    expect(result.rules).toContainEqual({ category: "governance", retentionBasis: "corporate_record", retentionDays: 365 });
  });

  it("does not allow creation without an active approved retention policy", async () => {
    mocks.binding.mockResolvedValueOnce(null);
    transactionWithResponses({ rows: [{ jurisdiction_code: "NG" }] });
    await expect(createOrganizationDocument({ organizationId: "organization-1", actorIdentityId: "owner-1", title: "Board resolution", category: "governance", retentionBasis: "corporate_record", filename: "board.pdf", mimeType: "application/pdf", storageKey: "documents/board.pdf", contentSha256: "a".repeat(64), bytes: 100 })).rejects.toThrow("approved organization-document retention policy");
  });

  it("creates a governed immutable document with an audit and outbox record", async () => {
    const query = transactionWithResponses({ rows: [{ jurisdiction_code: "NG" }] }, {}, {}, {}, {});
    await expect(createOrganizationDocument({ documentId: "document-1", organizationId: "organization-1", actorIdentityId: "owner-1", title: " Board resolution ", category: "governance", reference: " BR-1 ", retentionBasis: "corporate_record", filename: "board.pdf", mimeType: "Application/PDF", storageKey: "documents/board.pdf", contentSha256: "A".repeat(64), bytes: 100 })).resolves.toMatchObject({ documentId: "document-1", versionNumber: 1, contentSha256: "a".repeat(64) });
    expect(query).toHaveBeenCalledTimes(5);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "organization.document.created" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "organization.document.created" }));
  });

  it("does not add a version to a legacy or archived document", async () => {
    transactionWithResponses({ rows: [{ current_version_number: 1, retain_until: timestamp, status: "active", retention_binding_status: "legacy_declared", retention_days: null }] });
    await expect(addOrganizationDocumentVersion({ documentId: "document-1", organizationId: "organization-1", actorIdentityId: "owner-1", filename: "board-v2.pdf", mimeType: "application/pdf", storageKey: "documents/board-v2.pdf", contentSha256: "a".repeat(64), bytes: 100, reason: "A corrected board resolution supersedes the previous document." })).rejects.toThrow("Legacy-declared");
  });

  it("archives an active document and prevents a repeated archive", async () => {
    const query = transactionWithResponses({ rows: [{ status: "active" }] }, {}, {});
    await expect(archiveOrganizationDocument({ documentId: "document-1", organizationId: "organization-1", actorIdentityId: "owner-1", reason: "The board superseded this resolution with a later record." })).resolves.toEqual({ documentId: "document-1", status: "archived" });
    expect(query).toHaveBeenCalledTimes(3);
    transactionWithResponses({ rows: [{ status: "archived" }] });
    await expect(archiveOrganizationDocument({ documentId: "document-1", organizationId: "organization-1", actorIdentityId: "owner-1", reason: "The board superseded this resolution with a later record." })).rejects.toThrow("already archived");
  });

  it("maps every document version and its controlled access history", async () => {
    mocks.database.query.mockResolvedValueOnce({ rows: [documentRow(), documentRow({ version_id: "version-2", version_number: 2, filename: "board-v2.pdf", download_count: "0", last_downloaded_at: null })] });
    await expect(listOrganizationDocuments("organization-1")).resolves.toEqual([expect.objectContaining({ id: "document-1", versions: [expect.objectContaining({ id: "version-1", bytes: "100" }), expect.objectContaining({ id: "version-2", downloadCount: 0 })] })]);
    mocks.database.query.mockResolvedValueOnce({ rows: [{ id: "access-1", document_version_id: "version-1", version_number: 1, accessed_by_identity_id: "owner-1", legal_name: "Owner One", content_sha256: "a".repeat(64), occurred_at: timestamp }] });
    await expect(listOrganizationDocumentAccessEvents({ documentId: "document-1", organizationId: "organization-1" })).resolves.toEqual([expect.objectContaining({ accessedBy: { id: "owner-1", legalName: "Owner One" }, occurredAt: "2026-07-01T10:00:00.000Z" })]);
  });

  it("blocks download logging when a governed disposition has begun", async () => {
    transactionWithResponses({ rowCount: 0 });
    await expect(recordOrganizationDocumentDownload({ documentId: "document-1", versionId: "version-1", organizationId: "organization-1", actorIdentityId: "owner-1", contentSha256: "a".repeat(64) })).rejects.toThrow("governed disposition has begun");
    expect(mocks.lifecycleLock).toHaveBeenCalled();
    mocks.database.query.mockResolvedValueOnce({ rows: [] });
    await expect(getOrganizationDocumentVersion({ documentId: "document-1", versionId: "version-1", organizationId: "organization-1" })).resolves.toBeNull();
  });
});
