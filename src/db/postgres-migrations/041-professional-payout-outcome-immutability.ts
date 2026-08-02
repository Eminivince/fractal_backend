import type { PostgresMigration } from "./types.js";

/** Provider outcome metadata is append-only in effect: reconciliation can correct uncertainty, not rewrite history. */
export const professionalPayoutOutcomeImmutabilityMigration: PostgresMigration = {
  version: "041-professional-payout-outcome-immutability",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.enforce_professional_payout_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.provider_recipient_reference IS DISTINCT FROM OLD.provider_recipient_reference
        OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor
        OR NEW.authorized_by_identity_id IS DISTINCT FROM OLD.authorized_by_identity_id
        OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional payout instruction facts are immutable';
      END IF;
      IF (OLD.provider_transfer_code IS NOT NULL AND NEW.provider_transfer_code IS DISTINCT FROM OLD.provider_transfer_code)
        OR (OLD.dispatch_started_at IS NOT NULL AND NEW.dispatch_started_at IS DISTINCT FROM OLD.dispatch_started_at)
        OR (OLD.dispatch_worker_id IS NOT NULL AND NEW.dispatch_worker_id IS DISTINCT FROM OLD.dispatch_worker_id)
        OR (OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at)
        OR (OLD.confirmed_at IS NOT NULL AND NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at) THEN
        RAISE EXCEPTION 'professional payout provider evidence is immutable once recorded';
      END IF;
      IF (OLD.failed_at IS NOT NULL AND NEW.failed_at IS DISTINCT FROM OLD.failed_at
            AND NOT (OLD.status = 'uncertain' AND NEW.status = 'confirmed' AND NEW.failed_at IS NULL))
        OR (OLD.failure_reason IS NOT NULL AND NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
            AND NOT (OLD.status = 'uncertain' AND NEW.status = 'confirmed' AND NEW.failure_reason IS NULL)) THEN
        RAISE EXCEPTION 'professional payout failure evidence is immutable outside uncertainty reconciliation';
      END IF;
      IF (OLD.status = 'authorized' AND NEW.status IN ('dispatching', 'failed'))
        OR (OLD.status = 'dispatching' AND NEW.status IN ('submitted', 'confirmed', 'uncertain', 'failed', 'reversed'))
        OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'reversed', 'uncertain'))
        OR (OLD.status = 'uncertain' AND NEW.status IN ('confirmed', 'failed', 'reversed'))
        OR (OLD.status = 'confirmed' AND NEW.status = 'reversed') THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid professional payout instruction transition';
    END; $$;
  `,
};
