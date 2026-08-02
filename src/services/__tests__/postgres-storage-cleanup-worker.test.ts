import { beforeEach, describe, expect, it, vi } from "vitest";

const withTransaction = vi.hoisted(() => vi.fn());
const claimTasks = vi.hoisted(() => vi.fn());
const markCompleted = vi.hoisted(() => vi.fn());
const markForRetry = vi.hoisted(() => vi.fn());
const expireProviderExports = vi.hoisted(() => vi.fn());
const deleteStoredFile = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  STORAGE_CLEANUP_BATCH_SIZE: 20,
  STORAGE_CLEANUP_CLAIM_TIMEOUT_SECONDS: 300,
  STORAGE_CLEANUP_MAX_ATTEMPTS: 3,
  STORAGE_CLEANUP_RETRY_BASE_SECONDS: 10,
  STORAGE_CLEANUP_INTERVAL_MS: 1_000,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: withTransaction }));
vi.mock("../../platform/postgres-storage-cleanup.js", () => ({
  claimStorageCleanupTasks: claimTasks,
  markStorageCleanupTaskCompleted: markCompleted,
  markStorageCleanupTaskForRetry: markForRetry,
}));
vi.mock("../../platform/postgres-sumsub-privacy-exports.js", () => ({
  expireAndQueueSumsubPrivacyExportCleanup: expireProviderExports,
}));
vi.mock("../storage.js", () => ({ deleteStoredFile }));

import { dispatchPendingStorageCleanupTasks, startPostgresStorageCleanupWorker } from "../postgres-storage-cleanup-worker.js";

const logger = { info: vi.fn(), error: vi.fn() };
const task = {
  id: "task-1", storageKey: "private/document.pdf", source: "privacy_package", attempts: 1,
  governedDispositionId: "disposition-1", organizationDocumentDispositionId: null,
  privacyPackageDeliveryId: null, privacyExternalCollectionSnapshotId: null, privacyExternalProviderExportId: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  expireProviderExports.mockResolvedValue(0);
  claimTasks.mockResolvedValue([]);
  withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({}));
});

describe("Postgres storage cleanup worker", () => {
  it("deletes a governed object, completes its task, and records the disposition", async () => {
    claimTasks.mockResolvedValue([task]);
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchPendingStorageCleanupTasks({ logger, workerId: "cleanup-worker", remove })).resolves.toBe(1);

    expect(expireProviderExports).toHaveBeenCalledWith(20);
    expect(claimTasks).toHaveBeenCalledWith({ workerId: "cleanup-worker", limit: 20, claimTimeoutSeconds: 300 });
    expect(remove).toHaveBeenCalledWith("private/document.pdf");
    expect(markCompleted).toHaveBeenCalledWith({}, "task-1", "cleanup-worker");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", governedDispositionId: "disposition-1" }),
      "Governed storage disposition completed",
    );
  });

  it("uses the configured storage adapter and records unreferenced object cleanup", async () => {
    claimTasks.mockResolvedValue([{ ...task, governedDispositionId: null, source: "temporary_upload" }]);
    deleteStoredFile.mockResolvedValue(undefined);

    await expect(dispatchPendingStorageCleanupTasks({ logger, workerId: "cleanup-worker" })).resolves.toBe(1);

    expect(deleteStoredFile).toHaveBeenCalledWith("private/document.pdf");
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: "temporary_upload" }),
      "Unreferenced storage object removed",
    );
  });

  it("recognizes every governed disposition reference", async () => {
    claimTasks.mockResolvedValue([
      { ...task, governedDispositionId: null, organizationDocumentDispositionId: "document-1" },
      { ...task, id: "task-2", governedDispositionId: null, organizationDocumentDispositionId: null, privacyPackageDeliveryId: "delivery-1" },
      { ...task, id: "task-3", governedDispositionId: null, organizationDocumentDispositionId: null, privacyPackageDeliveryId: null, privacyExternalCollectionSnapshotId: "snapshot-1" },
      { ...task, id: "task-4", governedDispositionId: null, organizationDocumentDispositionId: null, privacyPackageDeliveryId: null, privacyExternalCollectionSnapshotId: null, privacyExternalProviderExportId: "export-1" },
    ]);
    const remove = vi.fn().mockResolvedValue(undefined);

    await expect(dispatchPendingStorageCleanupTasks({ logger, workerId: "cleanup-worker", remove })).resolves.toBe(4);

    expect(logger.info).toHaveBeenCalledTimes(4);
    expect(logger.info).toHaveBeenNthCalledWith(4, expect.objectContaining({ privacyExternalProviderExportId: "export-1" }), "Governed storage disposition completed");
  });

  it("queues a non-terminal retry when storage deletion fails", async () => {
    claimTasks.mockResolvedValue([task]);
    const remove = vi.fn().mockRejectedValue(new Error("storage unavailable"));
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await expect(dispatchPendingStorageCleanupTasks({ logger, workerId: "cleanup-worker", remove })).resolves.toBe(1);
    } finally {
      now.mockRestore();
    }

    expect(markForRetry).toHaveBeenCalledWith(expect.objectContaining({
      taskId: "task-1", workerId: "cleanup-worker", terminal: false,
      retryAt: new Date(1_010_000), error: expect.any(Error),
    }));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: "task-1", terminal: false, delaySeconds: 10 }),
      "Governed storage disposition failed",
    );
  });

  it("marks the final failed attempt terminal and identifies an unreferenced object", async () => {
    claimTasks.mockResolvedValue([{ ...task, attempts: 3, governedDispositionId: null }]);
    const remove = vi.fn().mockRejectedValue(new Error("storage unavailable"));

    await dispatchPendingStorageCleanupTasks({ logger, workerId: "cleanup-worker", remove });

    expect(markForRetry).toHaveBeenCalledWith(expect.objectContaining({ terminal: true }));
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ terminal: true, delaySeconds: 40 }),
      "Unreferenced storage-object cleanup failed",
    );
  });

  it("reports provider exports queued for governed deletion", async () => {
    expireProviderExports.mockResolvedValue(2);

    await expect(dispatchPendingStorageCleanupTasks({ logger, workerId: "cleanup-worker" })).resolves.toBe(0);

    expect(logger.info).toHaveBeenCalledWith(
      { workerId: "cleanup-worker", providerExportsQueued: 2 },
      "Expired Sumsub privacy exports were queued for governed deletion",
    );
  });

  it("creates a worker ID when the caller does not provide one", async () => {
    await dispatchPendingStorageCleanupTasks({ logger });
    expect(claimTasks).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.any(String) }));
  });

  it("contains polling failures and stops future polls", async () => {
    vi.useFakeTimers();
    try {
      expireProviderExports.mockRejectedValue(new Error("database unavailable"));
      const worker = startPostgresStorageCleanupWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Storage cleanup worker polling failed");
      expect(expireProviderExports).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run two polls while a cleanup dispatch is pending", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((value: number) => void) | undefined;
      expireProviderExports.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const worker = startPostgresStorageCleanupWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(expireProviderExports).toHaveBeenCalledOnce();
      finish?.(0);
      await Promise.resolve();
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
