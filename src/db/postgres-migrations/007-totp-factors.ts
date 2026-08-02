import type { PostgresMigration } from "./types.js";

export const totpFactorsMigration: PostgresMigration = {
  version: "007-totp-factors",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.totp_factors (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL UNIQUE REFERENCES fractal.identities(id),
      secret_ciphertext TEXT NOT NULL,
      confirmed_at TIMESTAMPTZ,
      last_used_counter BIGINT,
      disabled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (last_used_counter IS NULL OR last_used_counter >= 0)
    );
    CREATE INDEX IF NOT EXISTS totp_factors_confirmed_idx
      ON fractal.totp_factors (identity_id)
      WHERE confirmed_at IS NOT NULL AND disabled_at IS NULL;
  `,
};
