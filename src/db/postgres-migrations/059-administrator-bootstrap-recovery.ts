import type { PostgresMigration } from "./types.js";

/**
 * Seals initial administrator creation after one cohort and provides a
 * two-person, time-bounded recovery record for a previously authorised
 * administrator. Neither path is exposed over HTTP.
 */
export const administratorBootstrapRecoveryMigration: PostgresMigration = {
  version: "059-administrator-bootstrap-recovery",
  sql: `
    ALTER TABLE fractal.auth_email_deliveries
      DROP CONSTRAINT IF EXISTS auth_email_deliveries_delivery_type_check;
    ALTER TABLE fractal.auth_email_deliveries
      ADD CONSTRAINT auth_email_deliveries_delivery_type_check
      CHECK (delivery_type IN ('email_verification', 'password_reset', 'administrator_activation'));

    CREATE TABLE IF NOT EXISTS fractal.administrator_bootstrap_state (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      cohort_id UUID NOT NULL UNIQUE,
      cohort_size INTEGER NOT NULL CHECK (cohort_size BETWEEN 3 AND 5),
      cohort_fingerprint CHAR(64) NOT NULL UNIQUE CHECK (cohort_fingerprint ~ '^[0-9a-f]{64}$'),
      initiated_by TEXT NOT NULL CHECK (length(initiated_by) BETWEEN 3 AND 200),
      sealed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION fractal.reject_administrator_bootstrap_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.administrator_bootstrap_state is sealed';
    END;
    $$;

    DROP TRIGGER IF EXISTS administrator_bootstrap_state_sealed
      ON fractal.administrator_bootstrap_state;
    CREATE TRIGGER administrator_bootstrap_state_sealed
      BEFORE UPDATE OR DELETE ON fractal.administrator_bootstrap_state
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_administrator_bootstrap_mutation();

    CREATE TABLE IF NOT EXISTS fractal.administrator_recovery_requests (
      id UUID PRIMARY KEY,
      target_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      incident_reference TEXT NOT NULL CHECK (length(incident_reference) BETWEEN 6 AND 200),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 20 AND 2000),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'expired')),
      requested_by TEXT NOT NULL CHECK (length(requested_by) BETWEEN 3 AND 200),
      requester_key_fingerprint CHAR(64) NOT NULL CHECK (requester_key_fingerprint ~ '^[0-9a-f]{64}$'),
      approved_by TEXT CHECK (approved_by IS NULL OR length(approved_by) BETWEEN 3 AND 200),
      approver_key_fingerprint CHAR(64) CHECK (approver_key_fingerprint IS NULL OR approver_key_fingerprint ~ '^[0-9a-f]{64}$'),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL,
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT administrator_recovery_expiry_after_request CHECK (expires_at > requested_at),
      CONSTRAINT administrator_recovery_maximum_window CHECK (expires_at <= requested_at + interval '30 minutes'),
      CONSTRAINT administrator_recovery_status_shape CHECK (
        (status = 'pending' AND approved_by IS NULL AND approver_key_fingerprint IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status = 'applied' AND approved_by IS NOT NULL AND approver_key_fingerprint IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
        OR (status = 'expired' AND approved_by IS NULL AND approver_key_fingerprint IS NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
      ),
      CONSTRAINT administrator_recovery_independent_operator CHECK (
        approved_by IS NULL OR approved_by <> requested_by
      ),
      CONSTRAINT administrator_recovery_independent_key CHECK (
        approver_key_fingerprint IS NULL OR approver_key_fingerprint <> requester_key_fingerprint
      )
    );

    CREATE OR REPLACE FUNCTION fractal.enforce_administrator_recovery_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fractal.administrator_recovery_requests is append-only';
      END IF;
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'terminal administrator recovery requests are immutable';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.target_identity_id IS DISTINCT FROM OLD.target_identity_id
         OR NEW.incident_reference IS DISTINCT FROM OLD.incident_reference
         OR NEW.reason IS DISTINCT FROM OLD.reason
         OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
         OR NEW.requester_key_fingerprint IS DISTINCT FROM OLD.requester_key_fingerprint
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
         OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
        RAISE EXCEPTION 'administrator recovery request facts are immutable';
      END IF;
      IF NEW.status NOT IN ('applied', 'expired') THEN
        RAISE EXCEPTION 'administrator recovery request transition is invalid';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS administrator_recovery_request_transition
      ON fractal.administrator_recovery_requests;
    CREATE TRIGGER administrator_recovery_request_transition
      BEFORE UPDATE OR DELETE ON fractal.administrator_recovery_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_administrator_recovery_transition();

    CREATE UNIQUE INDEX IF NOT EXISTS administrator_recovery_target_pending_unique_idx
      ON fractal.administrator_recovery_requests (target_identity_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS administrator_recovery_pending_expiry_idx
      ON fractal.administrator_recovery_requests (expires_at, requested_at, id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS administrator_recovery_history_idx
      ON fractal.administrator_recovery_requests (target_identity_id, requested_at DESC, id DESC);
  `,
};
