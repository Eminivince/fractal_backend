import type { PostgresMigration } from "./types.js";

export const platformKernelMigration: PostgresMigration = {
  version: "001-platform-kernel",
  sql: `
    CREATE SCHEMA IF NOT EXISTS fractal;

    CREATE TABLE IF NOT EXISTS fractal.idempotency_commands (
      id UUID PRIMARY KEY,
      scope_key TEXT NOT NULL,
      route TEXT NOT NULL,
      command_key TEXT NOT NULL,
      request_hash CHAR(64) NOT NULL,
      response_body JSONB,
      response_status INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      UNIQUE (scope_key, route, command_key)
    );
    CREATE INDEX IF NOT EXISTS idempotency_commands_expires_at_idx
      ON fractal.idempotency_commands (expires_at);

    CREATE TABLE IF NOT EXISTS fractal.inbox_events (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL,
      external_event_id TEXT NOT NULL,
      payload JSONB NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      processed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT,
      UNIQUE (provider, external_event_id)
    );
    CREATE INDEX IF NOT EXISTS inbox_events_pending_idx
      ON fractal.inbox_events (received_at)
      WHERE processed_at IS NULL AND failed_at IS NULL;

    CREATE TABLE IF NOT EXISTS fractal.outbox_events (
      id UUID PRIMARY KEY,
      aggregate_type TEXT NOT NULL,
      aggregate_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload JSONB NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ,
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      last_error TEXT
    );
    CREATE INDEX IF NOT EXISTS outbox_events_pending_idx
      ON fractal.outbox_events (occurred_at)
      WHERE published_at IS NULL;

    CREATE TABLE IF NOT EXISTS fractal.audit_events (
      sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id UUID NOT NULL UNIQUE,
      organization_id UUID,
      actor_id UUID,
      actor_type TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      reason TEXT,
      payload JSONB NOT NULL,
      parent_hash CHAR(64),
      canonical_hash CHAR(64) NOT NULL UNIQUE,
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS audit_events_entity_idx
      ON fractal.audit_events (entity_type, entity_id, sequence);
    CREATE INDEX IF NOT EXISTS audit_events_organization_idx
      ON fractal.audit_events (organization_id, sequence);

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_audit_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.audit_events is append-only';
    END;
    $$;

    DROP TRIGGER IF EXISTS audit_events_immutable ON fractal.audit_events;
    CREATE TRIGGER audit_events_immutable
      BEFORE UPDATE OR DELETE ON fractal.audit_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_audit_mutation();
  `,
};
