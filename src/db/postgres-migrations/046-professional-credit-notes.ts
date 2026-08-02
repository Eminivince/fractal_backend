import type { PostgresMigration } from "./types.js";

/** An approved exception may issue an immutable credit note; it never alters the original invoice or provider outcome. */
export const professionalCreditNotesMigration: PostgresMigration = {
  version: "046-professional-credit-notes",
  sql: `
    ALTER TABLE fractal.professional_finance_exception_cases
      ADD COLUMN IF NOT EXISTS resolution_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS executed_by_identity_id UUID REFERENCES fractal.identities(id);

    CREATE TABLE IF NOT EXISTS fractal.professional_invoice_credit_notes (
      id UUID PRIMARY KEY,
      finance_exception_case_id UUID NOT NULL UNIQUE REFERENCES fractal.professional_finance_exception_cases(id),
      invoice_id UUID NOT NULL REFERENCES fractal.professional_invoices(id),
      reference TEXT NOT NULL UNIQUE CHECK (length(reference) BETWEEN 3 AND 120),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      gross_minor BIGINT NOT NULL CHECK (gross_minor > 0),
      tax_minor BIGINT NOT NULL CHECK (tax_minor >= 0),
      withholding_tax_minor BIGINT NOT NULL CHECK (withholding_tax_minor >= 0),
      net_credit_minor BIGINT NOT NULL CHECK (net_credit_minor > 0),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 8 AND 2000),
      issued_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (net_credit_minor = gross_minor + tax_minor - withholding_tax_minor)
    );
    CREATE INDEX IF NOT EXISTS professional_invoice_credit_notes_invoice_idx
      ON fractal.professional_invoice_credit_notes (invoice_id, issued_at, id);

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_finance_exception_case_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payout_instruction_id IS DISTINCT FROM OLD.payout_instruction_id
        OR NEW.recipient_recovery_case_id IS DISTINCT FROM OLD.recipient_recovery_case_id
        OR NEW.issuer_organization_id IS DISTINCT FROM OLD.issuer_organization_id
        OR NEW.opened_by_identity_id IS DISTINCT FROM OLD.opened_by_identity_id
        OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional finance exception facts are immutable';
      END IF;
      IF OLD.status = 'open' AND NEW.status = 'evidence_submitted'
        AND NEW.resolution_type IS NULL AND NEW.resolution_reason IS NULL
        AND NEW.resolution_payload = '{}'::jsonb THEN RETURN NEW; END IF;
      IF OLD.status = 'evidence_submitted' AND NEW.status = 'decision_pending' AND NEW.prepared_by_identity_id IS NOT NULL
        AND NEW.resolution_type IS NOT NULL AND NEW.resolution_reason IS NOT NULL THEN RETURN NEW; END IF;
      IF OLD.status = 'decision_pending' AND NEW.status IN ('approved', 'rejected')
        AND NEW.reviewed_by_identity_id IS NOT NULL AND NEW.reviewed_by_identity_id <> OLD.prepared_by_identity_id
        AND NEW.resolution_type IS NOT DISTINCT FROM OLD.resolution_type
        AND NEW.resolution_reason IS NOT DISTINCT FROM OLD.resolution_reason
        AND NEW.resolution_payload IS NOT DISTINCT FROM OLD.resolution_payload THEN RETURN NEW; END IF;
      IF OLD.status = 'approved' AND NEW.status = 'executed' AND NEW.executed_by_identity_id IS NOT NULL
        AND NEW.executed_by_identity_id <> OLD.prepared_by_identity_id AND NEW.executed_by_identity_id <> OLD.reviewed_by_identity_id
        AND NEW.resolution_type IS NOT DISTINCT FROM OLD.resolution_type
        AND NEW.resolution_reason IS NOT DISTINCT FROM OLD.resolution_reason
        AND NEW.resolution_payload IS NOT DISTINCT FROM OLD.resolution_payload THEN RETURN NEW; END IF;
      IF OLD.status IN ('rejected', 'executed') AND NEW.status = 'closed'
        AND NEW.resolution_type IS NOT DISTINCT FROM OLD.resolution_type
        AND NEW.resolution_reason IS NOT DISTINCT FROM OLD.resolution_reason
        AND NEW.resolution_payload IS NOT DISTINCT FROM OLD.resolution_payload THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional finance exception transition';
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.protect_professional_invoice_credit_note()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'professional invoice credit notes are immutable'; END; $$;
    DROP TRIGGER IF EXISTS professional_invoice_credit_notes_immutable ON fractal.professional_invoice_credit_notes;
    CREATE TRIGGER professional_invoice_credit_notes_immutable BEFORE UPDATE OR DELETE ON fractal.professional_invoice_credit_notes
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_invoice_credit_note();
  `,
};
