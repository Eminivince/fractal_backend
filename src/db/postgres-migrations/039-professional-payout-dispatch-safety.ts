import type { PostgresMigration } from "./types.js";

/** A provider call may be ambiguous after timeout; preserve that state for reconciliation instead of retrying a transfer. */
export const professionalPayoutDispatchSafetyMigration: PostgresMigration = {
  version: "039-professional-payout-dispatch-safety",
  sql: `
    ALTER TABLE fractal.professional_payout_instructions ADD COLUMN IF NOT EXISTS dispatch_started_at TIMESTAMPTZ;
    ALTER TABLE fractal.professional_payout_instructions ADD COLUMN IF NOT EXISTS dispatch_worker_id TEXT;
    ALTER TABLE fractal.professional_payout_instructions DROP CONSTRAINT IF EXISTS professional_payout_instructions_status_check;
    ALTER TABLE fractal.professional_payout_instructions ADD CONSTRAINT professional_payout_instructions_status_check CHECK (status IN ('authorized', 'dispatching', 'submitted', 'confirmed', 'failed', 'reversed', 'uncertain'));
    ALTER TABLE fractal.professional_payout_instructions DROP CONSTRAINT IF EXISTS professional_payout_instructions_check;
    ALTER TABLE fractal.professional_payout_instructions ADD CONSTRAINT professional_payout_instructions_dispatch_state_check CHECK (
      (status = 'authorized' AND submitted_at IS NULL AND confirmed_at IS NULL AND failed_at IS NULL AND failure_reason IS NULL)
      OR (status = 'dispatching' AND dispatch_started_at IS NOT NULL AND submitted_at IS NULL AND confirmed_at IS NULL AND failed_at IS NULL AND failure_reason IS NULL)
      OR (status = 'submitted' AND dispatch_started_at IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NULL AND failed_at IS NULL)
      OR (status = 'confirmed' AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL)
      OR (status IN ('failed', 'reversed', 'uncertain') AND failed_at IS NOT NULL AND failure_reason IS NOT NULL)
    );
    DROP TRIGGER IF EXISTS professional_payout_instructions_transition ON fractal.professional_payout_instructions;
    CREATE OR REPLACE FUNCTION fractal.enforce_professional_payout_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_recipient_reference IS DISTINCT FROM OLD.provider_recipient_reference OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.authorized_by_identity_id IS DISTINCT FROM OLD.authorized_by_identity_id OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'professional payout instruction facts are immutable'; END IF;
      IF (OLD.status = 'authorized' AND NEW.status IN ('dispatching','failed')) OR (OLD.status = 'dispatching' AND NEW.status IN ('submitted','uncertain','failed')) OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed','failed','reversed','uncertain')) THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional payout instruction transition';
    END; $$;
    CREATE TRIGGER professional_payout_instructions_transition BEFORE UPDATE OR DELETE ON fractal.professional_payout_instructions FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_payout_transition();
  `,
};
