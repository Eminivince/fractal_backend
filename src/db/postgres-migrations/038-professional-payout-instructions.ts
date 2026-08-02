import type { PostgresMigration } from "./types.js";

/** Separates financial authorization from provider dispatch and settlement confirmation. */
export const professionalPayoutInstructionsMigration: PostgresMigration = {
  version: "038-professional-payout-instructions",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_payout_instructions (
      id UUID PRIMARY KEY,
      invoice_id UUID NOT NULL UNIQUE REFERENCES fractal.professional_invoices(id),
      provider TEXT NOT NULL CHECK (provider IN ('paystack')),
      provider_recipient_reference TEXT NOT NULL CHECK (length(provider_recipient_reference) BETWEEN 4 AND 500),
      provider_transfer_code TEXT UNIQUE,
      reference TEXT NOT NULL UNIQUE CHECK (length(reference) BETWEEN 8 AND 200),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
      status TEXT NOT NULL CHECK (status IN ('authorized', 'submitted', 'confirmed', 'failed', 'reversed')),
      authorized_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      submitted_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'authorized' AND submitted_at IS NULL AND confirmed_at IS NULL AND failed_at IS NULL AND failure_reason IS NULL)
        OR (status = 'submitted' AND submitted_at IS NOT NULL AND confirmed_at IS NULL AND failed_at IS NULL)
        OR (status = 'confirmed' AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL)
        OR (status IN ('failed', 'reversed') AND failed_at IS NOT NULL AND failure_reason IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS professional_payout_instructions_status_idx ON fractal.professional_payout_instructions (status, created_at, id);
    CREATE OR REPLACE FUNCTION fractal.validate_professional_payout_instruction()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE invoice fractal.professional_invoices%ROWTYPE;
    DECLARE profile fractal.professional_payout_profile_versions%ROWTYPE;
    BEGIN
      SELECT * INTO invoice FROM fractal.professional_invoices WHERE id = NEW.invoice_id;
      SELECT * INTO profile FROM fractal.professional_payout_profile_versions WHERE id = invoice.payout_profile_version_id;
      IF NOT FOUND OR invoice.status <> 'approved' OR NEW.amount_minor <> invoice.net_payable_minor OR NEW.currency <> invoice.currency
        OR NEW.provider_recipient_reference <> profile.provider_recipient_reference THEN RAISE EXCEPTION 'professional payout instruction must exactly bind an approved invoice and its payout profile'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS professional_payout_instructions_guard ON fractal.professional_payout_instructions;
    CREATE TRIGGER professional_payout_instructions_guard BEFORE INSERT ON fractal.professional_payout_instructions FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_payout_instruction();
    CREATE OR REPLACE FUNCTION fractal.enforce_professional_payout_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id OR NEW.provider IS DISTINCT FROM OLD.provider OR NEW.provider_recipient_reference IS DISTINCT FROM OLD.provider_recipient_reference OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.amount_minor IS DISTINCT FROM OLD.amount_minor OR NEW.authorized_by_identity_id IS DISTINCT FROM OLD.authorized_by_identity_id OR NEW.authorized_at IS DISTINCT FROM OLD.authorized_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'professional payout instruction facts are immutable'; END IF;
      IF (OLD.status = 'authorized' AND NEW.status IN ('submitted','failed')) OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed','failed','reversed')) THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional payout instruction transition';
    END; $$;
    DROP TRIGGER IF EXISTS professional_payout_instructions_transition ON fractal.professional_payout_instructions;
    CREATE TRIGGER professional_payout_instructions_transition BEFORE UPDATE OR DELETE ON fractal.professional_payout_instructions FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_payout_transition();
  `,
};
