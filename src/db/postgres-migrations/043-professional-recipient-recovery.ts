import type { PostgresMigration } from "./types.js";

/** Holds possibly orphaned provider recipient references for human verification; it never authorizes automatic deletion. */
export const professionalRecipientRecoveryMigration: PostgresMigration = {
  version: "043-professional-recipient-recovery",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_payout_recipient_recovery_cases (
      id UUID PRIMARY KEY,
      firm_organization_id UUID NOT NULL REFERENCES fractal.professional_firm_profiles(organization_id),
      provider TEXT NOT NULL CHECK (provider IN ('paystack')),
      provider_recipient_reference TEXT NOT NULL UNIQUE CHECK (length(provider_recipient_reference) BETWEEN 4 AND 500),
      failure_reason TEXT NOT NULL CHECK (length(failure_reason) BETWEEN 1 AND 2000),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'retained', 'deactivated')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      resolved_by_identity_id UUID REFERENCES fractal.identities(id),
      resolution_notes TEXT,
      CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by_identity_id IS NULL AND resolution_notes IS NULL)
        OR (status IN ('retained', 'deactivated') AND resolved_at IS NOT NULL AND resolved_by_identity_id IS NOT NULL AND resolution_notes IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS professional_payout_recipient_recovery_cases_open_idx
      ON fractal.professional_payout_recipient_recovery_cases (created_at, id) WHERE status = 'open';
  `,
};
