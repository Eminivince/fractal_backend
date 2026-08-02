import type { PostgresMigration } from "./types.js";

/** Immutable, reviewable professional invoices bound to accepted work and a verified payout profile. */
export const professionalInvoiceFoundationMigration: PostgresMigration = {
  version: "037-professional-invoice-foundation",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_payout_profile_versions (
      id UUID PRIMARY KEY,
      firm_organization_id UUID NOT NULL REFERENCES fractal.professional_firm_profiles(organization_id),
      version INTEGER NOT NULL CHECK (version > 0),
      rail TEXT NOT NULL CHECK (rail IN ('bank_transfer')),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      account_holder_name TEXT NOT NULL CHECK (length(account_holder_name) BETWEEN 2 AND 240),
      account_last4 CHAR(4) NOT NULL CHECK (account_last4 ~ '^[0-9]{4}$'),
      provider_recipient_reference TEXT NOT NULL CHECK (length(provider_recipient_reference) BETWEEN 4 AND 500),
      status TEXT NOT NULL CHECK (status IN ('verified', 'superseded', 'disabled')),
      verified_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (firm_organization_id, version),
      UNIQUE (provider_recipient_reference),
      CHECK ((status = 'verified') OR (status IN ('superseded', 'disabled')))
    );

    CREATE TABLE IF NOT EXISTS fractal.professional_invoices (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (length(reference) BETWEEN 3 AND 120),
      work_order_id UUID NOT NULL REFERENCES fractal.professional_work_orders(id),
      deliverable_version_id UUID NOT NULL REFERENCES fractal.professional_deliverable_versions(id),
      professional_firm_organization_id UUID NOT NULL REFERENCES fractal.professional_firm_profiles(organization_id),
      payout_profile_version_id UUID NOT NULL REFERENCES fractal.professional_payout_profile_versions(id),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      gross_minor BIGINT NOT NULL CHECK (gross_minor >= 0),
      tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
      withholding_tax_minor BIGINT NOT NULL DEFAULT 0 CHECK (withholding_tax_minor >= 0),
      net_payable_minor BIGINT NOT NULL CHECK (net_payable_minor >= 0),
      due_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected', 'disputed', 'payment_instructed', 'paid', 'payment_failed', 'cancelled')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_at TIMESTAMPTZ,
      review_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (deliverable_version_id),
      CHECK (net_payable_minor = gross_minor + tax_minor - withholding_tax_minor),
      CHECK ((status = 'submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND review_notes IS NULL)
        OR (status IN ('approved', 'rejected', 'disputed', 'payment_instructed', 'paid', 'payment_failed', 'cancelled') AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL)),
      CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> submitted_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS professional_invoices_firm_idx ON fractal.professional_invoices (professional_firm_organization_id, status, submitted_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS professional_invoices_issuer_queue_idx ON fractal.professional_invoices (work_order_id, status, submitted_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.validate_professional_invoice_submission()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE work_order fractal.professional_work_orders%ROWTYPE;
    DECLARE deliverable fractal.professional_deliverable_versions%ROWTYPE;
    DECLARE payout_profile fractal.professional_payout_profile_versions%ROWTYPE;
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
      IF NEW.currency <> work_order.currency OR NEW.gross_minor <> work_order.fee_minor OR NEW.tax_minor <> 0 OR NEW.withholding_tax_minor <> 0 THEN
        RAISE EXCEPTION 'professional invoice must exactly reflect the governed work-order fee until tax treatment is separately governed';
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
        OR NEW.payout_profile_version_id IS DISTINCT FROM OLD.payout_profile_version_id OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.gross_minor IS DISTINCT FROM OLD.gross_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor OR NEW.withholding_tax_minor IS DISTINCT FROM OLD.withholding_tax_minor
        OR NEW.net_payable_minor IS DISTINCT FROM OLD.net_payable_minor OR NEW.due_at IS DISTINCT FROM OLD.due_at OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN RAISE EXCEPTION 'professional invoice facts are immutable'; END IF;
      IF OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected', 'disputed', 'cancelled') THEN RETURN NEW; END IF;
      IF OLD.status = 'approved' AND NEW.status = 'payment_instructed' THEN RETURN NEW; END IF;
      IF OLD.status = 'payment_instructed' AND NEW.status IN ('paid', 'payment_failed') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional invoice transition';
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_invoices_transition ON fractal.professional_invoices;
    CREATE TRIGGER professional_invoices_transition BEFORE UPDATE OR DELETE ON fractal.professional_invoices FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_invoice_transition();

    CREATE OR REPLACE FUNCTION fractal.protect_professional_payout_profile_version()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'professional payout profile versions are immutable'; END; $$;
    DROP TRIGGER IF EXISTS professional_payout_profile_versions_immutable ON fractal.professional_payout_profile_versions;
    CREATE TRIGGER professional_payout_profile_versions_immutable BEFORE UPDATE OR DELETE ON fractal.professional_payout_profile_versions FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_payout_profile_version();
  `,
};
