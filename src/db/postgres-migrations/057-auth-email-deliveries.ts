import type { PostgresMigration } from "./types.js";

/**
 * Authentication email commands must survive a process or provider failure.
 * Bearer tokens are deliberately not stored here: the worker creates a fresh,
 * short-lived token immediately before delivery and persists only its hash on
 * the identity record.
 */
export const authEmailDeliveriesMigration: PostgresMigration = {
  version: "057-auth-email-deliveries",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.auth_email_deliveries (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      delivery_type TEXT NOT NULL CHECK (delivery_type IN ('email_verification', 'password_reset')),
      status TEXT NOT NULL CHECK (status IN ('requested', 'failed', 'sent', 'terminal')),
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      sent_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
      CHECK ((status = 'terminal') = (terminal_at IS NOT NULL)),
      CHECK (status NOT IN ('sent', 'terminal') OR claimed_at IS NULL)
    );

    CREATE INDEX IF NOT EXISTS auth_email_deliveries_claimable_idx
      ON fractal.auth_email_deliveries (next_attempt_at, requested_at, id)
      WHERE status IN ('requested', 'failed');

    CREATE INDEX IF NOT EXISTS auth_email_deliveries_identity_idx
      ON fractal.auth_email_deliveries (identity_id, requested_at DESC, id DESC);

    CREATE UNIQUE INDEX IF NOT EXISTS auth_email_deliveries_open_identity_type_idx
      ON fractal.auth_email_deliveries (identity_id, delivery_type)
      WHERE status IN ('requested', 'failed');
  `,
};
