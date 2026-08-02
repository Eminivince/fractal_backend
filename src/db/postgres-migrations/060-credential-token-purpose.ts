import type { PostgresMigration } from "./types.js";

/**
 * A normal password reset must not bypass the OTP-only email verification
 * boundary. Administrator activation intentionally proves mailbox possession
 * while creating the initially absent credential, so the token purpose is
 * persisted with the hash and consumed atomically.
 */
export const credentialTokenPurposeMigration: PostgresMigration = {
  version: "060-credential-token-purpose",
  sql: `
    ALTER TABLE fractal.identities
      ADD COLUMN IF NOT EXISTS password_reset_purpose TEXT;

    -- Existing deployments can have an outstanding pre-migration reset
    -- token. Preserve a well-formed token as an ordinary password reset, but
    -- fail closed by invalidating any partial tuple before enforcing the
    -- all-or-none shape below.
    UPDATE fractal.identities
       SET password_reset_token_hash = NULL,
           password_reset_expires_at = NULL,
           password_reset_purpose = NULL,
           updated_at = now()
     WHERE (password_reset_token_hash IS NULL) <> (password_reset_expires_at IS NULL);

    UPDATE fractal.identities
       SET password_reset_purpose = 'password_reset',
           updated_at = now()
     WHERE password_reset_token_hash IS NOT NULL
       AND password_reset_expires_at IS NOT NULL
       AND password_reset_purpose IS NULL;

    ALTER TABLE fractal.identities
      DROP CONSTRAINT IF EXISTS identities_password_reset_purpose_check;
    ALTER TABLE fractal.identities
      ADD CONSTRAINT identities_password_reset_purpose_check
      CHECK (password_reset_purpose IS NULL OR password_reset_purpose IN ('password_reset', 'administrator_activation'));

    ALTER TABLE fractal.identities
      DROP CONSTRAINT IF EXISTS identities_password_reset_token_shape;
    ALTER TABLE fractal.identities
      ADD CONSTRAINT identities_password_reset_token_shape CHECK (
        (password_reset_token_hash IS NULL AND password_reset_expires_at IS NULL AND password_reset_purpose IS NULL)
        OR (password_reset_token_hash IS NOT NULL AND password_reset_expires_at IS NOT NULL AND password_reset_purpose IS NOT NULL)
      );
  `,
};
