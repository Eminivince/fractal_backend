import type { PostgresMigration } from "./types.js";

/** Finance-owned tax policy versions. Invoice facts retain the approved policy snapshot by id. */
export const professionalInvoiceTaxTreatmentMigration: PostgresMigration = {
  version: "044-professional-invoice-tax-treatment",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_invoice_tax_treatments (
      id UUID PRIMARY KEY,
      issuer_organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      version INTEGER NOT NULL CHECK (version > 0),
      jurisdiction_code TEXT NOT NULL CHECK (jurisdiction_code ~ '^[A-Z]{2,3}(-[A-Z0-9]{1,12})?$'),
      service_class TEXT NOT NULL CHECK (length(service_class) BETWEEN 2 AND 120),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      indirect_tax_rate_bps INTEGER NOT NULL CHECK (indirect_tax_rate_bps BETWEEN 0 AND 10000),
      withholding_tax_rate_bps INTEGER NOT NULL CHECK (withholding_tax_rate_bps BETWEEN 0 AND 10000),
      effective_from TIMESTAMPTZ NOT NULL,
      effective_until TIMESTAMPTZ,
      legal_source_reference TEXT NOT NULL CHECK (length(legal_source_reference) BETWEEN 4 AND 1000),
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
      prepared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      approved_by_identity_id UUID REFERENCES fractal.identities(id),
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (issuer_organization_id, version),
      CHECK (effective_until IS NULL OR effective_until > effective_from),
      CHECK ((status = 'draft' AND approved_by_identity_id IS NULL AND approved_at IS NULL)
        OR (status IN ('active', 'superseded') AND approved_by_identity_id IS NOT NULL AND approved_at IS NOT NULL)),
      CHECK (approved_by_identity_id IS NULL OR approved_by_identity_id <> prepared_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS professional_invoice_tax_treatments_active_idx
      ON fractal.professional_invoice_tax_treatments (issuer_organization_id, currency, effective_from DESC, id)
      WHERE status = 'active';

    ALTER TABLE fractal.professional_invoices
      ADD COLUMN IF NOT EXISTS tax_treatment_id UUID REFERENCES fractal.professional_invoice_tax_treatments(id);

    CREATE OR REPLACE FUNCTION fractal.validate_professional_invoice_submission()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE work_order fractal.professional_work_orders%ROWTYPE;
    DECLARE deliverable fractal.professional_deliverable_versions%ROWTYPE;
    DECLARE payout_profile fractal.professional_payout_profile_versions%ROWTYPE;
    DECLARE treatment fractal.professional_invoice_tax_treatments%ROWTYPE;
    DECLARE calculated_indirect_tax BIGINT;
    DECLARE calculated_withholding_tax BIGINT;
    BEGIN
      SELECT * INTO work_order FROM fractal.professional_work_orders WHERE id = NEW.work_order_id;
      SELECT * INTO deliverable FROM fractal.professional_deliverable_versions WHERE id = NEW.deliverable_version_id;
      SELECT * INTO payout_profile FROM fractal.professional_payout_profile_versions WHERE id = NEW.payout_profile_version_id;
      IF NOT FOUND OR payout_profile.firm_organization_id <> NEW.professional_firm_organization_id OR payout_profile.status <> 'verified'
        OR EXISTS (SELECT 1 FROM fractal.professional_payout_profile_versions newer WHERE newer.firm_organization_id = payout_profile.firm_organization_id AND newer.version > payout_profile.version AND newer.status = 'verified') THEN
        RAISE EXCEPTION 'professional invoice requires a current verified payout profile';
      END IF;
      IF work_order.id IS NULL OR work_order.professional_firm_organization_id <> NEW.professional_firm_organization_id
        OR work_order.status NOT IN ('accepted', 'in_progress') OR deliverable.id IS NULL
        OR deliverable.work_order_id <> NEW.work_order_id OR deliverable.status <> 'accepted' THEN
        RAISE EXCEPTION 'professional invoice requires an accepted deliverable for an accepted active work order';
      END IF;
      SELECT * INTO treatment FROM fractal.professional_invoice_tax_treatments WHERE id = NEW.tax_treatment_id;
      IF NOT FOUND OR treatment.status <> 'active' OR treatment.issuer_organization_id <> work_order.issuer_organization_id
        OR treatment.currency <> NEW.currency OR treatment.effective_from > NEW.submitted_at
        OR (treatment.effective_until IS NOT NULL AND treatment.effective_until <= NEW.submitted_at) THEN
        RAISE EXCEPTION 'professional invoice requires an active finance-approved tax treatment';
      END IF;
      calculated_indirect_tax := ROUND(NEW.gross_minor::numeric * treatment.indirect_tax_rate_bps / 10000)::BIGINT;
      calculated_withholding_tax := ROUND(NEW.gross_minor::numeric * treatment.withholding_tax_rate_bps / 10000)::BIGINT;
      IF NEW.currency <> work_order.currency OR NEW.gross_minor <> work_order.fee_minor
        OR NEW.tax_minor <> calculated_indirect_tax OR NEW.withholding_tax_minor <> calculated_withholding_tax THEN
        RAISE EXCEPTION 'professional invoice must exactly reflect the governed fee and active tax treatment';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_invoices_submission_guard ON fractal.professional_invoices;
    CREATE TRIGGER professional_invoices_submission_guard BEFORE INSERT ON fractal.professional_invoices FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_invoice_submission();

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_invoice_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
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
      IF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected', 'disputed', 'cancelled') THEN RETURN NEW; END IF;
      IF OLD.status = 'approved' AND NEW.status = 'payment_instructed' THEN RETURN NEW; END IF;
      IF OLD.status = 'payment_instructed' AND NEW.status IN ('paid', 'payment_failed') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional invoice transition';
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_invoice_tax_treatment_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.issuer_organization_id IS DISTINCT FROM OLD.issuer_organization_id
        OR NEW.version IS DISTINCT FROM OLD.version OR NEW.jurisdiction_code IS DISTINCT FROM OLD.jurisdiction_code
        OR NEW.service_class IS DISTINCT FROM OLD.service_class OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.indirect_tax_rate_bps IS DISTINCT FROM OLD.indirect_tax_rate_bps
        OR NEW.withholding_tax_rate_bps IS DISTINCT FROM OLD.withholding_tax_rate_bps
        OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until
        OR NEW.legal_source_reference IS DISTINCT FROM OLD.legal_source_reference
        OR NEW.prepared_by_identity_id IS DISTINCT FROM OLD.prepared_by_identity_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional invoice tax-treatment facts are immutable';
      END IF;
      IF OLD.status = 'draft' AND NEW.status = 'active' AND NEW.approved_by_identity_id IS NOT NULL
        AND NEW.approved_by_identity_id <> OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status = 'active' AND NEW.status = 'superseded' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional invoice tax-treatment transition';
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_invoice_tax_treatments_transition ON fractal.professional_invoice_tax_treatments;
    CREATE TRIGGER professional_invoice_tax_treatments_transition BEFORE UPDATE OR DELETE ON fractal.professional_invoice_tax_treatments
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_invoice_tax_treatment_transition();
  `,
};
