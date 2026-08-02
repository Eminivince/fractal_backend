import type { PostgresMigration } from "./types.js";

/** Immutable source documents required before a governed offering can be published. */
export const offeringPublicationEvidenceMigration: PostgresMigration = {
  version: "030-offering-publication-evidence",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.offering_publication_evidence_documents (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('agreement', 'disclosure_bundle')),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 160),
      storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 2_000),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      bytes BIGINT NOT NULL CHECK (bytes > 0 AND bytes <= 15728640),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS offering_publication_evidence_documents_org_idx
      ON fractal.offering_publication_evidence_documents (organization_id, evidence_kind, created_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_offering_publication_evidence_document()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.offering_publication_evidence_documents are immutable';
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_publication_evidence_documents_immutable ON fractal.offering_publication_evidence_documents;
    CREATE TRIGGER offering_publication_evidence_documents_immutable
      BEFORE UPDATE OR DELETE ON fractal.offering_publication_evidence_documents
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_publication_evidence_document();

    ALTER TABLE fractal.offering_publication_requests
      ADD COLUMN IF NOT EXISTS agreement_evidence_document_id UUID REFERENCES fractal.offering_publication_evidence_documents(id),
      ADD COLUMN IF NOT EXISTS disclosure_evidence_document_id UUID REFERENCES fractal.offering_publication_evidence_documents(id);

    CREATE OR REPLACE FUNCTION fractal.validate_offering_publication_request_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE agreement fractal.offering_publication_evidence_documents%ROWTYPE;
    DECLARE disclosure fractal.offering_publication_evidence_documents%ROWTYPE;
    BEGIN
      IF NEW.agreement_evidence_document_id IS NULL OR NEW.disclosure_evidence_document_id IS NULL THEN
        RAISE EXCEPTION 'offering publication requires agreement and disclosure evidence';
      END IF;
      IF NEW.agreement_evidence_document_id = NEW.disclosure_evidence_document_id THEN
        RAISE EXCEPTION 'agreement and disclosure evidence must be distinct documents';
      END IF;
      SELECT * INTO agreement FROM fractal.offering_publication_evidence_documents WHERE id = NEW.agreement_evidence_document_id;
      IF NOT FOUND OR agreement.organization_id <> NEW.organization_id OR agreement.evidence_kind <> 'agreement'
         OR agreement.content_sha256 <> NEW.agreement_document_hash THEN
        RAISE EXCEPTION 'agreement evidence does not match the governed publication request';
      END IF;
      SELECT * INTO disclosure FROM fractal.offering_publication_evidence_documents WHERE id = NEW.disclosure_evidence_document_id;
      IF NOT FOUND OR disclosure.organization_id <> NEW.organization_id OR disclosure.evidence_kind <> 'disclosure_bundle'
         OR disclosure.content_sha256 <> NEW.disclosure_bundle_hash THEN
        RAISE EXCEPTION 'disclosure evidence does not match the governed publication request';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_publication_requests_evidence_guard ON fractal.offering_publication_requests;
    CREATE TRIGGER offering_publication_requests_evidence_guard
      BEFORE INSERT ON fractal.offering_publication_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_offering_publication_request_evidence();

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
        OR NEW.agreement_evidence_document_id IS DISTINCT FROM OLD.agreement_evidence_document_id
        OR NEW.disclosure_evidence_document_id IS DISTINCT FROM OLD.disclosure_evidence_document_id
        OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted offering publication facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
