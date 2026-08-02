import type { PostgresMigration } from "./types.js";

/**
 * Provider callbacks are evidence, not a substitute for the governed
 * compliance decision. Keep only the correlation and integrity metadata here;
 * the signed raw body remains in the durable inbox for its controlled retention
 * lifecycle instead of being copied into every business record.
 */
export const providerIdentityVerificationEvidenceMigration: PostgresMigration = {
  version: "054-provider-identity-verification-evidence",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.provider_identity_verification_events (
      id UUID PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('sumsub')),
      external_event_id TEXT NOT NULL,
      identity_id UUID REFERENCES fractal.identities(id),
      external_user_id TEXT NOT NULL,
      applicant_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      review_status TEXT,
      review_answer TEXT CHECK (review_answer IS NULL OR review_answer IN ('GREEN', 'RED')),
      reject_labels JSONB NOT NULL DEFAULT '[]'::jsonb,
      provider_created_at TIMESTAMPTZ,
      payload_hash CHAR(64) NOT NULL,
      received_at TIMESTAMPTZ NOT NULL,
      recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, external_event_id)
    );
    CREATE INDEX IF NOT EXISTS provider_identity_verification_events_identity_idx
      ON fractal.provider_identity_verification_events (identity_id, received_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS provider_identity_verification_events_unmatched_idx
      ON fractal.provider_identity_verification_events (provider, received_at DESC, id DESC)
      WHERE identity_id IS NULL;

    CREATE OR REPLACE FUNCTION fractal.protect_provider_identity_verification_event()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.provider_identity_verification_events are append-only';
    END;
    $$;

    DROP TRIGGER IF EXISTS provider_identity_verification_events_immutable ON fractal.provider_identity_verification_events;
    CREATE TRIGGER provider_identity_verification_events_immutable
      BEFORE UPDATE OR DELETE ON fractal.provider_identity_verification_events
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_provider_identity_verification_event();
  `,
};
