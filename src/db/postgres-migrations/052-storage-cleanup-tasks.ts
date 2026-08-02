import type { PostgresMigration } from "./types.js";

/**
 * Records deletion work for an object that was persisted but never became a
 * governed document. This is deliberately separate from the business outbox:
 * it has no customer-visible effect and must not be discarded with a domain
 * event after a metadata write rolls back.
 */
export const storageCleanupTasksMigration: PostgresMigration = {
  version: "052-storage-cleanup-tasks",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.storage_cleanup_tasks (
      id UUID PRIMARY KEY,
      storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 2000),
      source TEXT NOT NULL CHECK (length(source) BETWEEN 1 AND 120),
      metadata_error TEXT NOT NULL CHECK (length(metadata_error) BETWEEN 1 AND 2000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      CHECK (NOT (completed_at IS NOT NULL AND failed_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS storage_cleanup_tasks_claimable_idx
      ON fractal.storage_cleanup_tasks (next_attempt_at, created_at, id)
      WHERE completed_at IS NULL AND failed_at IS NULL;
  `,
};
