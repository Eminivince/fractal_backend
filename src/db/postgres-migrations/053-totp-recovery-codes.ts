import type { PostgresMigration } from "./types.js";

/**
 * Backup codes are intentionally only an authenticator-replacement factor.
 * They cannot directly create a financial/chain step-up grant.
 */
export const totpRecoveryCodesMigration: PostgresMigration = {
  version: "053-totp-recovery-codes",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.totp_recovery_codes (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id) ON DELETE CASCADE,
      code_digest CHAR(64) NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      used_at TIMESTAMPTZ,
      replaced_at TIMESTAMPTZ,
      CHECK (used_at IS NULL OR replaced_at IS NULL),
      UNIQUE (identity_id, code_digest)
    );
    CREATE INDEX IF NOT EXISTS totp_recovery_codes_active_idx
      ON fractal.totp_recovery_codes (identity_id)
      WHERE used_at IS NULL AND replaced_at IS NULL;
  `,
};
