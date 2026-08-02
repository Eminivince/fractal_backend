import type { PostgresMigration } from "./types.js";

/** Durable provider-event retry scheduling for the PostgreSQL inbox. */
export const inboxRetryLeasesMigration: PostgresMigration = {
  version: "010-inbox-retry-leases",
  sql: `
    ALTER TABLE fractal.inbox_events
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();

    CREATE INDEX IF NOT EXISTS inbox_events_claimable_idx
      ON fractal.inbox_events (provider, next_attempt_at, received_at, id)
      WHERE processed_at IS NULL AND failed_at IS NULL;
  `,
};
