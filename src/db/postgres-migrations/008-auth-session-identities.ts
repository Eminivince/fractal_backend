import type { PostgresMigration } from "./types.js";

/**
 * Bridges existing session subjects to the imported PostgreSQL identity. The
 * column remains nullable until the explicit identity-authority cutover; no
 * route starts reading it merely because this migration has run.
 */
export const authSessionIdentitiesMigration: PostgresMigration = {
  version: "008-auth-session-identities",
  sql: `
    ALTER TABLE fractal.auth_sessions
      ADD COLUMN IF NOT EXISTS identity_id UUID REFERENCES fractal.identities(id);

    CREATE INDEX IF NOT EXISTS auth_sessions_identity_active_idx
      ON fractal.auth_sessions (identity_id, expires_at DESC)
      WHERE revoked_at IS NULL;

    UPDATE fractal.auth_sessions AS session
       SET identity_id = identity.id
      FROM fractal.identities AS identity
     WHERE session.identity_id IS NULL
       AND identity.legacy_mongo_id = session.subject_id;
  `,
};
