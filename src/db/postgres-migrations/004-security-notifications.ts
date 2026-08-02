import type { PostgresMigration } from "./types.js";

export const securityNotificationsMigration: PostgresMigration = {
  version: "004-security-notifications",
  sql: `
    ALTER TABLE fractal.outbox_events
      ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
    CREATE INDEX IF NOT EXISTS outbox_events_ready_idx
      ON fractal.outbox_events (next_attempt_at, occurred_at)
      WHERE published_at IS NULL;

    CREATE TABLE IF NOT EXISTS fractal.security_notifications (
      id UUID PRIMARY KEY,
      outbox_event_id UUID NOT NULL UNIQUE REFERENCES fractal.outbox_events(id),
      audit_event_id UUID NOT NULL REFERENCES fractal.audit_events(id),
      subject_id TEXT NOT NULL,
      session_id UUID NOT NULL REFERENCES fractal.auth_sessions(id),
      event_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      read_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS security_notifications_subject_created_idx
      ON fractal.security_notifications (subject_id, created_at DESC);
  `,
};
