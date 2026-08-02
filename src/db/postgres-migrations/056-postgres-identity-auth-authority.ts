import type { PostgresMigration } from "./types.js";

/**
 * Completes the data boundary needed for PostgreSQL to own an account's
 * credentials and password/email-verification lifecycle. Token values remain
 * SHA-256 hashes; neither a reset nor verification bearer token is stored.
 */
export const postgresIdentityAuthAuthorityMigration: PostgresMigration = {
  version: "056-postgres-identity-auth-authority",
  sql: `
    ALTER TABLE fractal.identities
      ADD COLUMN IF NOT EXISTS password_reset_token_hash TEXT,
      ADD COLUMN IF NOT EXISTS password_reset_expires_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS email_verification_token_hash TEXT,
      ADD COLUMN IF NOT EXISTS email_verification_expires_at TIMESTAMPTZ;

    CREATE UNIQUE INDEX IF NOT EXISTS identities_password_reset_token_hash_unique_idx
      ON fractal.identities (password_reset_token_hash)
      WHERE password_reset_token_hash IS NOT NULL;

    CREATE UNIQUE INDEX IF NOT EXISTS identities_email_verification_token_hash_unique_idx
      ON fractal.identities (email_verification_token_hash)
      WHERE email_verification_token_hash IS NOT NULL;

    CREATE INDEX IF NOT EXISTS identities_password_reset_expiry_idx
      ON fractal.identities (password_reset_expires_at)
      WHERE password_reset_token_hash IS NOT NULL;

    CREATE INDEX IF NOT EXISTS identities_email_verification_expiry_idx
      ON fractal.identities (email_verification_expires_at)
      WHERE email_verification_token_hash IS NOT NULL;
  `,
};
