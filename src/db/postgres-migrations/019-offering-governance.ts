import type { PostgresMigration } from "./types.js";

/**
 * Two-person operational controls for the PostgreSQL investment path.
 * Candidate facts are immutable after submission; an approver may only decide
 * a submitted request and may never be its submitter.
 */
export const offeringGovernanceMigration: PostgresMigration = {
  version: "019-offering-governance",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.offering_publication_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      public_reference TEXT NOT NULL UNIQUE CHECK (length(public_reference) BETWEEN 1 AND 200),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      capacity_minor BIGINT NOT NULL CHECK (capacity_minor > 0),
      opens_at TIMESTAMPTZ NOT NULL,
      closes_at TIMESTAMPTZ NOT NULL CHECK (closes_at > opens_at),
      terms JSONB NOT NULL,
      eligibility_policy JSONB NOT NULL,
      agreement_document_hash CHAR(64) NOT NULL,
      disclosure_bundle_hash CHAR(64) NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL,
      decided_by_identity_id UUID REFERENCES fractal.identities(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      published_offering_id UUID UNIQUE REFERENCES fractal.offering_products(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'submitted' AND decided_by_identity_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND published_offering_id IS NULL)
          OR (status = 'approved' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL AND published_offering_id IS NOT NULL)
          OR (status = 'rejected' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND published_offering_id IS NULL)),
      CHECK (decided_by_identity_id IS NULL OR decided_by_identity_id <> submitted_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS offering_publication_requests_review_idx
      ON fractal.offering_publication_requests (organization_id, status, submitted_at, id);

    CREATE OR REPLACE FUNCTION fractal.enforce_offering_publication_request_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'offering publication request may only be decided once';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.public_reference IS DISTINCT FROM OLD.public_reference OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.capacity_minor IS DISTINCT FROM OLD.capacity_minor OR NEW.opens_at IS DISTINCT FROM OLD.opens_at
        OR NEW.closes_at IS DISTINCT FROM OLD.closes_at OR NEW.terms IS DISTINCT FROM OLD.terms
        OR NEW.eligibility_policy IS DISTINCT FROM OLD.eligibility_policy
        OR NEW.agreement_document_hash IS DISTINCT FROM OLD.agreement_document_hash
        OR NEW.disclosure_bundle_hash IS DISTINCT FROM OLD.disclosure_bundle_hash
        OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted offering publication facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_publication_requests_transition ON fractal.offering_publication_requests;
    CREATE TRIGGER offering_publication_requests_transition
      BEFORE UPDATE OR DELETE ON fractal.offering_publication_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_offering_publication_request_transition();

    CREATE TABLE IF NOT EXISTS fractal.investor_compliance_review_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      kyc_status TEXT NOT NULL CHECK (kyc_status IN ('pending', 'approved', 'rejected', 'expired')),
      investor_class TEXT NOT NULL CHECK (investor_class IN ('retail', 'sophisticated', 'institutional')),
      accreditation_status TEXT NOT NULL CHECK (accreditation_status IN ('not_required', 'pending', 'verified', 'expired')),
      jurisdiction_code TEXT NOT NULL CHECK (jurisdiction_code ~ '^[A-Z]{2,3}$'),
      reviewed_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ,
      evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL,
      decided_by_identity_id UUID REFERENCES fractal.identities(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'submitted' AND decided_by_identity_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
          OR (status IN ('approved', 'rejected') AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL)),
      CHECK (decided_by_identity_id IS NULL OR decided_by_identity_id <> submitted_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS investor_compliance_review_requests_review_idx
      ON fractal.investor_compliance_review_requests (organization_id, status, submitted_at, id);

    CREATE TABLE IF NOT EXISTS fractal.investor_compliance_profile_reviews (
      id UUID PRIMARY KEY,
      review_request_id UUID NOT NULL UNIQUE REFERENCES fractal.investor_compliance_review_requests(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      approved_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      approved_at TIMESTAMPTZ NOT NULL,
      profile_snapshot JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS investor_compliance_profile_reviews_investor_idx
      ON fractal.investor_compliance_profile_reviews (investor_identity_id, approved_at DESC, id);

    CREATE OR REPLACE FUNCTION fractal.enforce_compliance_review_request_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'compliance review request may only be decided once';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.investor_identity_id IS DISTINCT FROM OLD.investor_identity_id
        OR NEW.kyc_status IS DISTINCT FROM OLD.kyc_status OR NEW.investor_class IS DISTINCT FROM OLD.investor_class
        OR NEW.accreditation_status IS DISTINCT FROM OLD.accreditation_status OR NEW.jurisdiction_code IS DISTINCT FROM OLD.jurisdiction_code
        OR NEW.reviewed_at IS DISTINCT FROM OLD.reviewed_at OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
        OR NEW.evidence IS DISTINCT FROM OLD.evidence OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted compliance facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS investor_compliance_review_requests_transition ON fractal.investor_compliance_review_requests;
    CREATE TRIGGER investor_compliance_review_requests_transition
      BEFORE UPDATE OR DELETE ON fractal.investor_compliance_review_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_compliance_review_request_transition();

    CREATE OR REPLACE FUNCTION fractal.reject_investor_compliance_profile_review_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fractal.investor_compliance_profile_reviews is append-only'; END;
    $$;
    DROP TRIGGER IF EXISTS investor_compliance_profile_reviews_immutable ON fractal.investor_compliance_profile_reviews;
    CREATE TRIGGER investor_compliance_profile_reviews_immutable
      BEFORE UPDATE OR DELETE ON fractal.investor_compliance_profile_reviews
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_investor_compliance_profile_review_mutation();
  `,
};
