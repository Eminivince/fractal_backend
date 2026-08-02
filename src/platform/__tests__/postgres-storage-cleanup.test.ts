import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn(), appendAudit: vi.fn(), appendOutbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));

import {
  claimStorageCleanupTasks,
  enqueueStorageCleanupTask,
  markStorageCleanupTaskCompleted,
  markStorageCleanupTaskCompletedInline,
  markStorageCleanupTaskForRetry,
} from "../postgres-storage-cleanup.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}

const taskLinks = {
  governed_disposition_id: "governed-1",
  organization_document_disposition_id: "organization-1",
  privacy_package_delivery_id: "package-1",
  privacy_external_collection_snapshot_id: "snapshot-1",
  privacy_external_provider_export_id: "export-1",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
});

describe("PostgreSQL storage cleanup tasks", () => {
  it("persists a cleanup intent with normalized metadata and rejects invalid input", async () => {
    const client = clientWith({});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    const id = await enqueueStorageCleanupTask({ storageKey: " local://evidence/file.pdf ", source: " upload-rollback ", metadataError: new Error("database rejected metadata") });
    expect(id).toEqual(expect.any(String));
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("storage_cleanup_tasks"), expect.arrayContaining([id, "local://evidence/file.pdf", "upload-rollback", "database rejected metadata"]));
    await expect(enqueueStorageCleanupTask({ storageKey: " ", source: "upload", metadataError: null })).rejects.toThrow("storageKey is invalid");
    await expect(enqueueStorageCleanupTask({ storageKey: "key", source: " ", metadataError: null })).rejects.toThrow("source is invalid");
  });

  it("claims ready tasks and maps every governed foreign key", async () => {
    await expect(claimStorageCleanupTasks({ workerId: "worker-a", limit: 0, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    const client = clientWith({ rows: [{ id: "task-1", storage_key: "local://file", source: "rollback", attempts: 2, ...taskLinks }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(claimStorageCleanupTasks({ workerId: "worker-a", limit: 2, claimTimeoutSeconds: 90 })).resolves.toEqual([{
      id: "task-1", storageKey: "local://file", source: "rollback", attempts: 2,
      governedDispositionId: "governed-1", organizationDocumentDispositionId: "organization-1", privacyPackageDeliveryId: "package-1", privacyExternalCollectionSnapshotId: "snapshot-1", privacyExternalProviderExportId: "export-1",
    }]);
    expect(client.query.mock.calls[0]?.[1]).toEqual([90, 2, "worker-a"]);
  });

  it("completes all governed cleanup records and emits their evidence", async () => {
    const client = clientWith(
      { rows: [taskLinks], rowCount: 1 },
      { rows: [{ attachment_id: "attachment-1", case_id: "case-1", content_sha256: "hash-1" }], rowCount: 1 },
      { rows: [{ document_id: "document-1", organization_id: "organization-1" }], rowCount: 1 },
      { rows: [{ privacy_request_id: "privacy-request-1" }], rowCount: 1 },
      { rows: [{ privacy_request_id: "privacy-request-1", source_key: "sumsub" }], rowCount: 1 },
      { rows: [{ privacy_request_id: "privacy-request-1", requester_identity_id: "identity-1", reference: "provider-export-ref" }], rowCount: 1 },
    );
    await markStorageCleanupTaskCompleted(client as any, "task-1", "worker-a");
    expect(mocks.appendAudit).toHaveBeenCalledTimes(5);
    expect(mocks.appendOutbox).toHaveBeenCalledTimes(5);
    expect(mocks.appendOutbox).toHaveBeenLastCalledWith(client, expect.objectContaining({
      eventType: "privacy.request.sumsub_provider_export_destroyed",
      privacy: { kind: "subjects", subjectIdentityIds: ["identity-1"] },
    }));
  });

  it("rejects a completion claim loss or a missing governed record", async () => {
    const lost = clientWith({ rows: [], rowCount: 0 });
    await expect(markStorageCleanupTaskCompleted(lost as any, "task-1", "worker-a")).rejects.toThrow("no longer claimed");
    const missing = clientWith({ rows: [{ ...taskLinks, organization_document_disposition_id: null, privacy_package_delivery_id: null, privacy_external_collection_snapshot_id: null, privacy_external_provider_export_id: null }], rowCount: 1 }, { rows: [], rowCount: 0 });
    await expect(markStorageCleanupTaskCompleted(missing as any, "task-1", "worker-a")).rejects.toThrow("cannot be completed");
  });

  it("marks an inline deletion only when no worker owns the task", async () => {
    const completed = clientWith({ rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(completed));
    await expect(markStorageCleanupTaskCompletedInline("task-1")).resolves.toBeUndefined();
    const unavailable = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unavailable));
    await expect(markStorageCleanupTaskCompletedInline("task-1")).rejects.toThrow("cannot be completed inline");
  });

  it("records non-terminal retry metadata without changing governed records", async () => {
    const client = clientWith({ rows: [{ governed_disposition_id: "governed-1", organization_document_disposition_id: null, privacy_package_delivery_id: null, privacy_external_collection_snapshot_id: null, privacy_external_provider_export_id: null }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await markStorageCleanupTaskForRetry({ taskId: "task-1", workerId: "worker-a", retryAt: new Date("2026-08-01"), error: "temporary failure", terminal: false });
    expect(client.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([false, "temporary failure"]));
    expect(mocks.appendAudit).not.toHaveBeenCalled();
  });

  it("marks all linked records failed after a terminal cleanup failure", async () => {
    const client = clientWith(
      { rows: [taskLinks], rowCount: 1 },
      { rows: [{ attachment_id: "attachment-1", case_id: "case-1", content_sha256: "hash-1" }], rowCount: 1 },
      { rows: [{ document_id: "document-1", organization_id: "organization-1" }], rowCount: 1 },
      { rows: [{ privacy_request_id: "privacy-request-1" }], rowCount: 1 },
      { rows: [{ privacy_request_id: "privacy-request-1", source_key: "sumsub" }], rowCount: 1 },
      { rows: [{ privacy_request_id: "privacy-request-1", requester_identity_id: "identity-1", reference: "provider-export-ref" }], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await markStorageCleanupTaskForRetry({ taskId: "task-1", workerId: "worker-a", retryAt: new Date(), error: new Error("permanent provider failure"), terminal: true });
    expect(mocks.appendAudit).toHaveBeenCalledTimes(5);
    expect(mocks.appendOutbox).toHaveBeenLastCalledWith(client, expect.objectContaining({ eventType: "privacy.request.sumsub_provider_export_cleanup_failed" }));
  });

  it("rejects a retry update when the task claim has changed", async () => {
    const client = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(markStorageCleanupTaskForRetry({ taskId: "task-1", workerId: "worker-a", retryAt: new Date(), error: null, terminal: true })).rejects.toThrow("no longer claimed");
  });
});
