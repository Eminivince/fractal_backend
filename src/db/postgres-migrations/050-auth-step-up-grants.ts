import type { PostgresMigration } from "./types.js";

export const authStepUpGrantsMigration: PostgresMigration = {
  version: "050-auth-step-up-grants",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.auth_step_up_grants (
      session_id UUID PRIMARY KEY REFERENCES fractal.auth_sessions(id) ON DELETE CASCADE,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      method TEXT NOT NULL CHECK (method IN ('totp')),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      CHECK (expires_at > granted_at)
    );
    CREATE INDEX IF NOT EXISTS auth_step_up_grants_active_idx
      ON fractal.auth_step_up_grants (identity_id, expires_at DESC);
  `,
};
