import type { PostgresMigration } from "./types.js";

export const authSessionsMigration: PostgresMigration = {
  version: "003-auth-sessions",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.auth_sessions (
      id UUID PRIMARY KEY,
      token_family_id UUID NOT NULL,
      subject_id TEXT NOT NULL,
      role TEXT NOT NULL,
      business_id TEXT,
      refresh_token_hash CHAR(64) NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      revoked_reason TEXT,
      replaced_by_session_id UUID,
      ip_hash CHAR(64),
      user_agent_hash CHAR(64)
    );
    CREATE INDEX IF NOT EXISTS auth_sessions_subject_active_idx
      ON fractal.auth_sessions (subject_id, expires_at DESC)
      WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS auth_sessions_family_active_idx
      ON fractal.auth_sessions (token_family_id)
      WHERE revoked_at IS NULL;
  `,
};
