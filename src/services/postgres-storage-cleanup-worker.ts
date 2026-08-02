import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { withPostgresTransaction } from "../db/postgres.js";
import {
  claimStorageCleanupTasks,
  markStorageCleanupTaskCompleted,
  markStorageCleanupTaskForRetry,
} from "../platform/postgres-storage-cleanup.js";
import { expireAndQueueSumsubPrivacyExportCleanup } from "../platform/postgres-sumsub-privacy-exports.js";
import { deleteStoredFile } from "./storage.js";

export interface StorageCleanupLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export async function dispatchPendingStorageCleanupTasks(input: {
  logger: StorageCleanupLogger;
  workerId?: string;
  remove?: (storageKey: string) => Promise<void>;
}): Promise<number> {
  const workerId = input.workerId ?? randomUUID();
  const providerExportsQueued = await expireAndQueueSumsubPrivacyExportCleanup(
    env.STORAGE_CLEANUP_BATCH_SIZE,
  );
  const tasks = await claimStorageCleanupTasks({
    workerId,
    limit: env.STORAGE_CLEANUP_BATCH_SIZE,
    claimTimeoutSeconds: env.STORAGE_CLEANUP_CLAIM_TIMEOUT_SECONDS,
  });
  const remove = input.remove ?? deleteStoredFile;

  for (const task of tasks) {
    try {
      await remove(task.storageKey);
      await withPostgresTransaction((client) => markStorageCleanupTaskCompleted(client, task.id, workerId));
      const governed = Boolean(task.governedDispositionId || task.organizationDocumentDispositionId
        || task.privacyPackageDeliveryId || task.privacyExternalCollectionSnapshotId
        || task.privacyExternalProviderExportId);
      input.logger.info({
        taskId: task.id, source: task.source, governedDispositionId: task.governedDispositionId,
        organizationDocumentDispositionId: task.organizationDocumentDispositionId,
        privacyPackageDeliveryId: task.privacyPackageDeliveryId,
        privacyExternalCollectionSnapshotId: task.privacyExternalCollectionSnapshotId,
        privacyExternalProviderExportId: task.privacyExternalProviderExportId,
      }, governed ? "Governed storage disposition completed" : "Unreferenced storage object removed");
    } catch (error) {
      const terminal = task.attempts >= env.STORAGE_CLEANUP_MAX_ATTEMPTS;
      const delaySeconds = Math.min(60 * 60, env.STORAGE_CLEANUP_RETRY_BASE_SECONDS * 2 ** Math.max(0, task.attempts - 1));
      await markStorageCleanupTaskForRetry({
        taskId: task.id,
        workerId,
        retryAt: new Date(Date.now() + delaySeconds * 1_000),
        error,
        terminal,
      });
      input.logger.error(
        { err: error, taskId: task.id, source: task.source, terminal, delaySeconds },
        task.governedDispositionId || task.organizationDocumentDispositionId
          || task.privacyPackageDeliveryId || task.privacyExternalCollectionSnapshotId
          || task.privacyExternalProviderExportId
          ? "Governed storage disposition failed"
          : "Unreferenced storage-object cleanup failed",
      );
    }
  }
  if (providerExportsQueued > 0) {
    input.logger.info(
      { workerId, providerExportsQueued },
      "Expired Sumsub privacy exports were queued for governed deletion",
    );
  }
  return tasks.length;
}

export function startPostgresStorageCleanupWorker(input: { logger: StorageCleanupLogger }): { stop: () => void } {
  const workerId = randomUUID();
  let running = false;
  let stopped = false;
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchPendingStorageCleanupTasks({ ...input, workerId });
    } catch (error) {
      input.logger.error({ err: error }, "Storage cleanup worker polling failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void dispatch(), env.STORAGE_CLEANUP_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
