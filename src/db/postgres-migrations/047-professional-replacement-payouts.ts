import type { PostgresMigration } from "./types.js";

/** A replacement payment is a new, separately authorized financial instruction; it is never a retry of the original provider transfer. */
export const professionalReplacementPayoutsMigration: PostgresMigration = {
  version: "047-professional-replacement-payouts",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_replacement_payout_requests (
      id UUID PRIMARY KEY,
      finance_exception_case_id UUID NOT NULL UNIQUE REFERENCES fractal.professional_finance_exception_cases(id),
      original_payout_instruction_id UUID NOT NULL REFERENCES fractal.professional_payout_instructions(id),
      payout_profile_version_id UUID NOT NULL REFERENCES fractal.professional_payout_profile_versions(id),
      provider TEXT NOT NULL CHECK (provider IN ('paystack')),
      provider_recipient_reference TEXT NOT NULL CHECK (length(provider_recipient_reference) BETWEEN 4 AND 500),
      reference TEXT NOT NULL UNIQUE CHECK (length(reference) BETWEEN 8 AND 200),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
      status TEXT NOT NULL CHECK (status IN ('authorized')),
      authorized_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS professional_replacement_payout_requests_authorized_idx
      ON fractal.professional_replacement_payout_requests (authorized_at, id) WHERE status = 'authorized';

    CREATE OR REPLACE FUNCTION fractal.validate_professional_replacement_payout_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exception_case fractal.professional_finance_exception_cases%ROWTYPE;
    DECLARE original_payout fractal.professional_payout_instructions%ROWTYPE;
    DECLARE source_invoice fractal.professional_invoices%ROWTYPE;
    DECLARE payout_profile fractal.professional_payout_profile_versions%ROWTYPE;
    BEGIN
      SELECT * INTO exception_case FROM fractal.professional_finance_exception_cases WHERE id = NEW.finance_exception_case_id;
      SELECT * INTO original_payout FROM fractal.professional_payout_instructions WHERE id = NEW.original_payout_instruction_id;
      SELECT * INTO source_invoice FROM fractal.professional_invoices WHERE id = original_payout.invoice_id;
      SELECT * INTO payout_profile FROM fractal.professional_payout_profile_versions WHERE id = NEW.payout_profile_version_id;
      IF exception_case.status <> 'approved' OR exception_case.resolution_type <> 'replacement_payout'
        OR exception_case.payout_instruction_id <> NEW.original_payout_instruction_id THEN
        RAISE EXCEPTION 'replacement payout must bind an approved matching finance exception';
      END IF;
      IF NOT FOUND OR payout_profile.firm_organization_id <> source_invoice.professional_firm_organization_id
        OR payout_profile.status <> 'verified'
        OR EXISTS (SELECT 1 FROM fractal.professional_payout_profile_versions newer WHERE newer.firm_organization_id = payout_profile.firm_organization_id AND newer.version > payout_profile.version AND newer.status = 'verified')
        OR NEW.provider_recipient_reference <> payout_profile.provider_recipient_reference
        OR NEW.currency <> original_payout.currency OR NEW.amount_minor > original_payout.amount_minor THEN
        RAISE EXCEPTION 'replacement payout must use the current verified profile and cannot exceed the original governed payout';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_replacement_payout_requests_guard ON fractal.professional_replacement_payout_requests;
    CREATE TRIGGER professional_replacement_payout_requests_guard BEFORE INSERT ON fractal.professional_replacement_payout_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_replacement_payout_request();

    CREATE OR REPLACE FUNCTION fractal.protect_professional_replacement_payout_request()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'professional replacement payout requests are immutable'; END; $$;
    DROP TRIGGER IF EXISTS professional_replacement_payout_requests_immutable ON fractal.professional_replacement_payout_requests;
    CREATE TRIGGER professional_replacement_payout_requests_immutable BEFORE UPDATE OR DELETE ON fractal.professional_replacement_payout_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_replacement_payout_request();
  `,
};
