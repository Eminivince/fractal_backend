import type { PostgresMigration } from "./types.js";

/** Immutable offering publication and pre-payment eligibility evidence. */
export const offeringCheckoutFoundationMigration: PostgresMigration = {
  version: "013-offering-checkout-foundation",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.offering_products (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      public_reference TEXT NOT NULL UNIQUE CHECK (length(public_reference) BETWEEN 1 AND 200),
      status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'paused', 'closed', 'cancelled')),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      capacity_minor BIGINT NOT NULL CHECK (capacity_minor > 0),
      opens_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (closes_at > opens_at)
    );
    CREATE INDEX IF NOT EXISTS offering_products_organization_status_idx
      ON fractal.offering_products (organization_id, status, opens_at, id);

    CREATE TABLE IF NOT EXISTS fractal.offering_publication_versions (
      id UUID PRIMARY KEY,
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      version INTEGER NOT NULL CHECK (version > 0),
      terms JSONB NOT NULL,
      eligibility_policy JSONB NOT NULL,
      agreement_document_hash CHAR(64) NOT NULL,
      disclosure_bundle_hash CHAR(64) NOT NULL,
      published_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      published_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (offering_id, version)
    );
    CREATE INDEX IF NOT EXISTS offering_publication_versions_current_idx
      ON fractal.offering_publication_versions (offering_id, version DESC);

    CREATE TABLE IF NOT EXISTS fractal.investor_compliance_profiles (
      identity_id UUID PRIMARY KEY REFERENCES fractal.identities(id),
      kyc_status TEXT NOT NULL CHECK (kyc_status IN ('pending', 'approved', 'rejected', 'expired')),
      investor_class TEXT NOT NULL CHECK (investor_class IN ('retail', 'sophisticated', 'institutional')),
      accreditation_status TEXT NOT NULL CHECK (accreditation_status IN ('not_required', 'pending', 'verified', 'expired')),
      jurisdiction_code TEXT NOT NULL CHECK (jurisdiction_code ~ '^[A-Z]{2,3}$'),
      reviewed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fractal.investment_eligibility_snapshots (
      id UUID PRIMARY KEY,
      offering_version_id UUID NOT NULL REFERENCES fractal.offering_publication_versions(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      status TEXT NOT NULL CHECK (status IN ('eligible', 'ineligible')),
      reason_codes JSONB NOT NULL DEFAULT '[]'::jsonb,
      policy_snapshot JSONB NOT NULL,
      evidence_snapshot JSONB NOT NULL,
      evaluated_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (expires_at >= evaluated_at)
    );
    CREATE INDEX IF NOT EXISTS investment_eligibility_snapshots_lookup_idx
      ON fractal.investment_eligibility_snapshots (investor_identity_id, offering_version_id, evaluated_at DESC);

    CREATE TABLE IF NOT EXISTS fractal.agreement_acceptances (
      id UUID PRIMARY KEY,
      offering_version_id UUID NOT NULL REFERENCES fractal.offering_publication_versions(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      agreement_document_hash CHAR(64) NOT NULL,
      signature_name TEXT NOT NULL CHECK (length(signature_name) BETWEEN 1 AND 200),
      execution_hash CHAR(64) NOT NULL,
      accepted_at TIMESTAMPTZ NOT NULL,
      ip_hash CHAR(64),
      user_agent_hash CHAR(64),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS agreement_acceptances_investor_version_idx
      ON fractal.agreement_acceptances (investor_identity_id, offering_version_id, accepted_at DESC);

    CREATE TABLE IF NOT EXISTS fractal.investment_reservations (
      id UUID PRIMARY KEY,
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      offering_version_id UUID NOT NULL REFERENCES fractal.offering_publication_versions(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      status TEXT NOT NULL CHECK (status IN ('pending_payment', 'confirmed', 'released', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      commitment_id UUID UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (expires_at >= created_at)
    );
    CREATE INDEX IF NOT EXISTS investment_reservations_capacity_idx
      ON fractal.investment_reservations (offering_id, status, expires_at, id);

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_offering_publication_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.offering_publication_versions is append-only';
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_publication_versions_immutable ON fractal.offering_publication_versions;
    CREATE TRIGGER offering_publication_versions_immutable
      BEFORE UPDATE OR DELETE ON fractal.offering_publication_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_offering_publication_mutation();

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_agreement_acceptance_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.agreement_acceptances is append-only';
    END;
    $$;
    DROP TRIGGER IF EXISTS agreement_acceptances_immutable ON fractal.agreement_acceptances;
    CREATE TRIGGER agreement_acceptances_immutable
      BEFORE UPDATE OR DELETE ON fractal.agreement_acceptances
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_agreement_acceptance_mutation();
  `,
};
