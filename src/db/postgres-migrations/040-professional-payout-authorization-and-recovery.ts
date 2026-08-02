import type { PostgresMigration } from "./types.js";

/**
 * A payout is a separate financial decision from invoice approval. Ambiguous
 * provider outcomes must be reconciled, never sent again automatically.
 */
export const professionalPayoutAuthorizationAndRecoveryMigration: PostgresMigration = {
  version: "040-professional-payout-authorization-and-recovery",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.validate_professional_payout_instruction()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE invoice fractal.professional_invoices%ROWTYPE;
    DECLARE profile fractal.professional_payout_profile_versions%ROWTYPE;
    BEGIN
      SELECT * INTO invoice FROM fractal.professional_invoices WHERE id = NEW.invoice_id;
      SELECT * INTO profile FROM fractal.professional_payout_profile_versions WHERE id = invoice.payout_profile_version_id;
      IF NOT FOUND OR invoice.status <> 'approved' OR invoice.reviewed_by_identity_id IS NULL
        OR NEW.authorized_by_identity_id = invoice.reviewed_by_identity_id
        OR NEW.amount_minor <> invoice.net_payable_minor OR NEW.currency <> invoice.currency
        OR NEW.provider_recipient_reference <> profile.provider_recipient_reference THEN
        RAISE EXCEPTION 'professional payout instruction must bind an independently approved invoice and its payout profile';
      END IF;
      RETURN NEW;
    END; $$;

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
