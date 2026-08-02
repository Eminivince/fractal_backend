import type { PostgresMigration } from "./types.js";

/**
 * A step-up grant is an authorization proof, not just a convenient cache.
 * Bind its identity to the authenticated session in the database so future
 * callers cannot accidentally create a cross-identity proof.
 */
export const authStepUpSessionIdentityMigration: PostgresMigration = {
  version: "051-auth-step-up-session-identity",
  sql: `
    ALTER TABLE fractal.auth_sessions
      ADD CONSTRAINT auth_sessions_id_identity_unique UNIQUE (id, identity_id);

    ALTER TABLE fractal.auth_step_up_grants
      ADD CONSTRAINT auth_step_up_grants_session_identity_fk
      FOREIGN KEY (session_id, identity_id)
      REFERENCES fractal.auth_sessions (id, identity_id)
      ON DELETE CASCADE;
  `,
};
