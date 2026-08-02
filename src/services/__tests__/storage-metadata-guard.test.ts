import { beforeEach, describe, expect, it, vi } from "vitest";

const enqueue = vi.hoisted(() => vi.fn());
const markCompleted = vi.hoisted(() => vi.fn());
const deleteStoredFile = vi.hoisted(() => vi.fn());

vi.mock("../../platform/postgres-storage-cleanup.js", () => ({
  enqueueStorageCleanupTask: enqueue,
  markStorageCleanupTaskCompletedInline: markCompleted,
}));
vi.mock("../storage.js", () => ({ deleteStoredFile }));

import { recordStoredDocument } from "../storage-metadata-guard.js";

const logger = { error: vi.fn() } as any;

beforeEach(() => vi.clearAllMocks());

describe("storage metadata guard", () => {
  it("returns a committed metadata record without cleanup", async () => {
    await expect(recordStoredDocument({ storageKey: "documents/one", source: "test", record: vi.fn().mockResolvedValue({ id: "record-1" }), logger })).resolves.toEqual({ id: "record-1" });
    expect(enqueue).not.toHaveBeenCalled();
    expect(deleteStoredFile).not.toHaveBeenCalled();
  });

  it("queues and completes cleanup after metadata rejection", async () => {
    const metadataError = new Error("Database rejected metadata");
    enqueue.mockResolvedValue("cleanup-1");
    deleteStoredFile.mockResolvedValue(undefined);
    markCompleted.mockResolvedValue(undefined);
    await expect(recordStoredDocument({ storageKey: "documents/one", source: "test", record: vi.fn().mockRejectedValue(metadataError), logger })).rejects.toBe(metadataError);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ storageKey: "documents/one", source: "test", metadataError }));
    expect(deleteStoredFile).toHaveBeenCalledWith("documents/one");
    expect(markCompleted).toHaveBeenCalledWith("cleanup-1");
  });

  it("logs queue and inline-cleanup failures but preserves the metadata failure", async () => {
    const metadataError = new Error("Database rejected metadata");
    const queueError = new Error("Queue unavailable");
    const cleanupError = new Error("Object store unavailable");
    enqueue.mockRejectedValue(queueError);
    deleteStoredFile.mockRejectedValue(cleanupError);
    await expect(recordStoredDocument({ storageKey: "documents/one", source: "test", record: vi.fn().mockRejectedValue(metadataError), logger })).rejects.toBe(metadataError);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: queueError }), expect.stringContaining("durably queued"));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: cleanupError, taskId: undefined }), expect.stringContaining("Inline storage cleanup failed"));
  });
});
