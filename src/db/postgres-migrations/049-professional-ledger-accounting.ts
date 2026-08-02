import type { PostgresMigration } from "./types.js";

/** Every governed professional-money state change has a balanced, immutable accounting consequence. */
export const professionalLedgerAccountingMigration: PostgresMigration = {
  version: "049-professional-ledger-accounting",
  sql: `
    ALTER TABLE fractal.professional_invoices
      ADD COLUMN IF NOT EXISTS accrual_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id);
    ALTER TABLE fractal.professional_payout_instructions
      ADD COLUMN IF NOT EXISTS settlement_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      ADD COLUMN IF NOT EXISTS reversal_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id);
    ALTER TABLE fractal.professional_invoice_credit_notes
      ADD COLUMN IF NOT EXISTS journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id);

    ALTER TABLE fractal.professional_invoices DROP CONSTRAINT IF EXISTS professional_invoices_status_check;
    ALTER TABLE fractal.professional_invoices
      ADD CONSTRAINT professional_invoices_status_check CHECK (status IN ('submitted', 'approved', 'rejected', 'disputed', 'payment_instructed', 'paid', 'payment_failed', 'payment_reversed', 'cancelled'));
    ALTER TABLE fractal.professional_invoices DROP CONSTRAINT IF EXISTS professional_invoices_check;
    ALTER TABLE fractal.professional_invoices DROP CONSTRAINT IF EXISTS professional_invoices_check1;
    ALTER TABLE fractal.professional_invoices
      ADD CONSTRAINT professional_invoices_review_state_check CHECK ((status = 'submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND review_notes IS NULL)
        OR (status IN ('approved', 'rejected', 'disputed', 'payment_instructed', 'paid', 'payment_failed', 'payment_reversed', 'cancelled') AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL));

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_invoice_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE journal_org UUID; journal_currency CHAR(3); journal_invoice_id TEXT;
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id
        OR NEW.deliverable_version_id IS DISTINCT FROM OLD.deliverable_version_id OR NEW.professional_firm_organization_id IS DISTINCT FROM OLD.professional_firm_organization_id
        OR NEW.payout_profile_version_id IS DISTINCT FROM OLD.payout_profile_version_id OR NEW.tax_treatment_id IS DISTINCT FROM OLD.tax_treatment_id
        OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.gross_minor IS DISTINCT FROM OLD.gross_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
        OR NEW.withholding_tax_minor IS DISTINCT FROM OLD.withholding_tax_minor OR NEW.net_payable_minor IS DISTINCT FROM OLD.net_payable_minor
        OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional invoice facts are immutable';
      END IF;
      IF OLD.status = 'submitted' AND NEW.status = 'approved' THEN
        IF OLD.accrual_journal_id IS NOT NULL OR NEW.accrual_journal_id IS NULL THEN RAISE EXCEPTION 'approved professional invoice requires an immutable accrual journal'; END IF;
        SELECT organization_id, currency, metadata ->> 'professionalInvoiceId' INTO journal_org, journal_currency, journal_invoice_id FROM fractal.journal_entries WHERE id = NEW.accrual_journal_id;
        IF NOT FOUND OR journal_org IS DISTINCT FROM (SELECT issuer_organization_id FROM fractal.professional_work_orders WHERE id = NEW.work_order_id)
          OR journal_currency <> NEW.currency OR journal_invoice_id <> NEW.id::text THEN RAISE EXCEPTION 'professional invoice accrual journal does not bind this invoice'; END IF;
        RETURN NEW;
      END IF;
      IF NEW.accrual_journal_id IS DISTINCT FROM OLD.accrual_journal_id THEN RAISE EXCEPTION 'professional invoice accrual journal is immutable'; END IF;
      IF OLD.status = 'submitted' AND NEW.status IN ('rejected', 'disputed', 'cancelled') THEN RETURN NEW; END IF;
      IF OLD.status = 'approved' AND NEW.status = 'payment_instructed' THEN RETURN NEW; END IF;
      IF OLD.status = 'payment_instructed' AND NEW.status IN ('paid', 'payment_failed') THEN RETURN NEW; END IF;
      IF OLD.status = 'paid' AND NEW.status = 'payment_reversed' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional invoice transition';
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_payout_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE journal_org UUID; journal_currency CHAR(3); journal_payout_id TEXT; invoice_org UUID;
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
      SELECT work_order.issuer_organization_id INTO invoice_org FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE invoice.id = NEW.invoice_id;
      IF NEW.settlement_journal_id IS DISTINCT FROM OLD.settlement_journal_id THEN
        IF OLD.settlement_journal_id IS NOT NULL OR NEW.settlement_journal_id IS NULL OR NEW.status <> 'confirmed' THEN RAISE EXCEPTION 'professional payout settlement journal is immutable'; END IF;
        SELECT organization_id, currency, metadata ->> 'professionalPayoutInstructionId' INTO journal_org, journal_currency, journal_payout_id FROM fractal.journal_entries WHERE id = NEW.settlement_journal_id;
        IF NOT FOUND OR journal_org IS DISTINCT FROM invoice_org OR journal_currency <> NEW.currency OR journal_payout_id <> NEW.id::text THEN RAISE EXCEPTION 'professional payout settlement journal does not bind this payout'; END IF;
      END IF;
      IF NEW.reversal_journal_id IS DISTINCT FROM OLD.reversal_journal_id THEN
        IF OLD.reversal_journal_id IS NOT NULL OR NEW.reversal_journal_id IS NULL OR OLD.status <> 'confirmed' OR NEW.status <> 'reversed' THEN RAISE EXCEPTION 'professional payout reversal journal is immutable'; END IF;
        SELECT organization_id, currency, metadata ->> 'professionalPayoutInstructionId' INTO journal_org, journal_currency, journal_payout_id FROM fractal.journal_entries WHERE id = NEW.reversal_journal_id;
        IF NOT FOUND OR journal_org IS DISTINCT FROM invoice_org OR journal_currency <> NEW.currency OR journal_payout_id <> NEW.id::text
          OR (SELECT reversal_of FROM fractal.journal_entries WHERE id = NEW.reversal_journal_id) IS DISTINCT FROM NEW.settlement_journal_id THEN RAISE EXCEPTION 'professional payout reversal journal does not compensate its settlement'; END IF;
      END IF;
      IF (OLD.status = 'authorized' AND NEW.status IN ('dispatching', 'failed', 'uncertain'))
        OR (OLD.status = 'dispatching' AND NEW.status IN ('submitted', 'confirmed', 'uncertain', 'failed', 'reversed'))
        OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'reversed', 'uncertain'))
        OR (OLD.status = 'uncertain' AND NEW.status IN ('confirmed', 'failed', 'reversed'))
        OR (OLD.status = 'confirmed' AND NEW.status = 'reversed') THEN
        IF NEW.status = 'confirmed' AND NEW.settlement_journal_id IS NULL THEN RAISE EXCEPTION 'confirmed professional payout requires an immutable settlement journal'; END IF;
        IF OLD.status = 'confirmed' AND NEW.status = 'reversed' AND NEW.reversal_journal_id IS NULL THEN RAISE EXCEPTION 'reversed professional payout requires an immutable reversal journal'; END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid professional payout instruction transition';
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.validate_professional_invoice_credit_note_journal()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE invoice_org UUID; journal_org UUID; journal_currency CHAR(3); journal_credit_note_id TEXT;
    BEGIN
      IF NEW.journal_id IS NULL THEN RAISE EXCEPTION 'professional invoice credit note requires an immutable journal'; END IF;
      SELECT work_order.issuer_organization_id INTO invoice_org FROM fractal.professional_invoices invoice JOIN fractal.professional_work_orders work_order ON work_order.id = invoice.work_order_id WHERE invoice.id = NEW.invoice_id;
      SELECT organization_id, currency, metadata ->> 'professionalCreditNoteId' INTO journal_org, journal_currency, journal_credit_note_id FROM fractal.journal_entries WHERE id = NEW.journal_id;
      IF NOT FOUND OR journal_org IS DISTINCT FROM invoice_org OR journal_currency <> NEW.currency OR journal_credit_note_id <> NEW.id::text THEN RAISE EXCEPTION 'professional invoice credit-note journal does not bind this credit note'; END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_invoice_credit_notes_journal_guard ON fractal.professional_invoice_credit_notes;
    CREATE TRIGGER professional_invoice_credit_notes_journal_guard BEFORE INSERT ON fractal.professional_invoice_credit_notes
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_invoice_credit_note_journal();
  `,
};
