import type { PostgresMigration } from "./types.js";

/**
 * A provider applicant is created asynchronously.  The external user ID is
 * the immutable PostgreSQL identity UUID, which lets a retry recover a remote
 * applicant even if a process died between the provider response and the
 * local state transition.
 */
export const providerIdentityVerificationApplicationsMigration: PostgresMigration = {
  version: "055-provider-identity-verification-applications",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.provider_identity_verification_applications (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      provider TEXT NOT NULL CHECK (provider IN ('sumsub')),
      external_user_id TEXT NOT NULL,
      applicant_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('requested', 'ready', 'failed', 'terminal')),
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_error TEXT,
      ready_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (identity_id, provider),
      UNIQUE (provider, external_user_id),
      CHECK ((status = 'ready') = (applicant_id IS NOT NULL AND ready_at IS NOT NULL)),
      CHECK ((status = 'terminal') = (terminal_at IS NOT NULL)),
      CHECK (status <> 'terminal' OR claimed_at IS NULL),
      CHECK (status <> 'ready' OR claimed_at IS NULL)
    );
    CREATE INDEX IF NOT EXISTS provider_identity_verification_applications_claimable_idx
      ON fractal.provider_identity_verification_applications (provider, next_attempt_at, created_at, id)
      WHERE status IN ('requested', 'failed') AND terminal_at IS NULL;
    CREATE INDEX IF NOT EXISTS provider_identity_verification_applications_identity_idx
      ON fractal.provider_identity_verification_applications (identity_id, created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS provider_identity_verification_applications_applicant_idx
      ON fractal.provider_identity_verification_applications (provider, applicant_id)
      WHERE applicant_id IS NOT NULL;
  `,
};
