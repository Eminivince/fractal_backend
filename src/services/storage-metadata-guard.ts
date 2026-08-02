import { enqueueStorageCleanupTask, markStorageCleanupTaskCompletedInline } from "../platform/postgres-storage-cleanup.js";
import { deleteStoredFile } from "./storage.js";
import type { StorageCleanupLogger } from "./postgres-storage-cleanup-worker.js";

/**
 * A binary is not a valid product document until its governed metadata commits.
 * If that write rejects, queue deletion first, then try to remove the object
 * inline. A surviving task is retried by the leased worker.
 */
export async function recordStoredDocument<T>(input: {
  storageKey: string;
  source: string;
  record: () => Promise<T>;
  logger: StorageCleanupLogger;
}): Promise<T> {
  try {
    return await input.record();
  } catch (metadataError) {
    let taskId: string | undefined;
    try {
      taskId = await enqueueStorageCleanupTask({
        storageKey: input.storageKey,
        source: input.source,
        metadataError,
      });
    } catch (queueError) {
      input.logger.error(
        { err: queueError, storageKey: input.storageKey, source: input.source },
        "Storage cleanup could not be durably queued after metadata rejection",
      );
    }

    try {
      await deleteStoredFile(input.storageKey);
      if (taskId) {
        await markStorageCleanupTaskCompletedInline(taskId);
      }
    } catch (cleanupError) {
      input.logger.error(
        { err: cleanupError, storageKey: input.storageKey, source: input.source, taskId },
        "Inline storage cleanup failed; leased cleanup worker will retry when queued",
      );
    }
    throw metadataError;
  }
}
