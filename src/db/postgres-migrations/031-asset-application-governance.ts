import type { PostgresMigration } from "./types.js";

/** The governed source-asset approval that publication requests must reference. */
export const assetApplicationGovernanceMigration: PostgresMigration = {
  version: "031-asset-application-governance",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.asset_application_evidence_documents (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 160),
      storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 2000),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      bytes BIGINT NOT NULL CHECK (bytes > 0 AND bytes <= 15728640),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS asset_application_evidence_documents_org_idx
      ON fractal.asset_application_evidence_documents (organization_id, created_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_asset_application_evidence_document()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fractal.asset_application_evidence_documents are immutable'; END;
    $$;
    DROP TRIGGER IF EXISTS asset_application_evidence_documents_immutable ON fractal.asset_application_evidence_documents;
    CREATE TRIGGER asset_application_evidence_documents_immutable
      BEFORE UPDATE OR DELETE ON fractal.asset_application_evidence_documents
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_asset_application_evidence_document();

    CREATE TABLE IF NOT EXISTS fractal.asset_application_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      application_reference TEXT NOT NULL CHECK (length(application_reference) BETWEEN 1 AND 200),
      application_version INTEGER NOT NULL CHECK (application_version > 0),
      asset_name TEXT NOT NULL CHECK (length(asset_name) BETWEEN 2 AND 200),
      asset_type TEXT NOT NULL CHECK (length(asset_type) BETWEEN 2 AND 120),
      country_code CHAR(2) NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
      state TEXT NOT NULL CHECK (length(state) BETWEEN 2 AND 120),
      city TEXT NOT NULL CHECK (length(city) BETWEEN 2 AND 120),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 20 AND 5000),
      requested_capacity_minor BIGINT NOT NULL CHECK (requested_capacity_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      dossier_evidence_document_id UUID NOT NULL REFERENCES fractal.asset_application_evidence_documents(id),
      dossier_hash CHAR(64) NOT NULL CHECK (dossier_hash ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL,
      decided_by_identity_id UUID REFERENCES fractal.identities(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      approved_application_version_id UUID UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, application_reference, application_version),
      CHECK ((status = 'submitted' AND decided_by_identity_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL AND approved_application_version_id IS NULL)
          OR (status = 'approved' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL AND approved_application_version_id IS NOT NULL)
          OR (status = 'rejected' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND approved_application_version_id IS NULL)),
      CHECK (decided_by_identity_id IS NULL OR decided_by_identity_id <> submitted_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS asset_application_requests_org_status_idx
      ON fractal.asset_application_requests (organization_id, status, submitted_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS fractal.approved_asset_application_versions (
      id UUID PRIMARY KEY,
      application_request_id UUID NOT NULL UNIQUE REFERENCES fractal.asset_application_requests(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      application_reference TEXT NOT NULL,
      application_version INTEGER NOT NULL CHECK (application_version > 0),
      asset_name TEXT NOT NULL,
      asset_type TEXT NOT NULL,
      country_code CHAR(2) NOT NULL,
      state TEXT NOT NULL,
      city TEXT NOT NULL,
      summary TEXT NOT NULL,
      requested_capacity_minor BIGINT NOT NULL CHECK (requested_capacity_minor > 0),
      currency CHAR(3) NOT NULL,
      dossier_evidence_document_id UUID NOT NULL REFERENCES fractal.asset_application_evidence_documents(id),
      dossier_hash CHAR(64) NOT NULL,
      approved_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      approved_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (organization_id, application_reference, application_version)
    );
    CREATE INDEX IF NOT EXISTS approved_asset_application_versions_org_idx
      ON fractal.approved_asset_application_versions (organization_id, approved_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_approved_asset_application_version()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fractal.approved_asset_application_versions are immutable'; END;
    $$;
    DROP TRIGGER IF EXISTS approved_asset_application_versions_immutable ON fractal.approved_asset_application_versions;
    CREATE TRIGGER approved_asset_application_versions_immutable
      BEFORE UPDATE OR DELETE ON fractal.approved_asset_application_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_approved_asset_application_version();

    CREATE OR REPLACE FUNCTION fractal.validate_asset_application_request_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE evidence fractal.asset_application_evidence_documents%ROWTYPE;
    BEGIN
      SELECT * INTO evidence FROM fractal.asset_application_evidence_documents WHERE id = NEW.dossier_evidence_document_id;
      IF NOT FOUND OR evidence.organization_id <> NEW.organization_id OR evidence.content_sha256 <> NEW.dossier_hash THEN
        RAISE EXCEPTION 'asset application dossier evidence does not match the request';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS asset_application_requests_evidence_guard ON fractal.asset_application_requests;
    CREATE TRIGGER asset_application_requests_evidence_guard
      BEFORE INSERT ON fractal.asset_application_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_asset_application_request_evidence();

    CREATE OR REPLACE FUNCTION fractal.enforce_asset_application_request_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'asset application request may only be decided once';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.application_reference IS DISTINCT FROM OLD.application_reference OR NEW.application_version IS DISTINCT FROM OLD.application_version
        OR NEW.asset_name IS DISTINCT FROM OLD.asset_name OR NEW.asset_type IS DISTINCT FROM OLD.asset_type
        OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.state IS DISTINCT FROM OLD.state OR NEW.city IS DISTINCT FROM OLD.city
        OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.requested_capacity_minor IS DISTINCT FROM OLD.requested_capacity_minor
        OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.dossier_evidence_document_id IS DISTINCT FROM OLD.dossier_evidence_document_id
        OR NEW.dossier_hash IS DISTINCT FROM OLD.dossier_hash OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted asset application facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS asset_application_requests_transition ON fractal.asset_application_requests;
    CREATE TRIGGER asset_application_requests_transition
      BEFORE UPDATE OR DELETE ON fractal.asset_application_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_asset_application_request_transition();

    ALTER TABLE fractal.offering_publication_requests
      ADD COLUMN IF NOT EXISTS approved_asset_application_version_id UUID REFERENCES fractal.approved_asset_application_versions(id);

    CREATE OR REPLACE FUNCTION fractal.validate_offering_publication_request_origin()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE origin fractal.approved_asset_application_versions%ROWTYPE;
    BEGIN
      IF NEW.approved_asset_application_version_id IS NULL THEN
        RAISE EXCEPTION 'offering publication requires an approved asset application version';
      END IF;
      SELECT * INTO origin FROM fractal.approved_asset_application_versions WHERE id = NEW.approved_asset_application_version_id;
      IF NOT FOUND OR origin.organization_id <> NEW.organization_id OR origin.currency <> NEW.currency
         OR NEW.capacity_minor > origin.requested_capacity_minor THEN
        RAISE EXCEPTION 'offering publication does not match its approved asset application origin';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_publication_requests_origin_guard ON fractal.offering_publication_requests;
    CREATE TRIGGER offering_publication_requests_origin_guard
      BEFORE INSERT ON fractal.offering_publication_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_offering_publication_request_origin();

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
        OR NEW.approved_asset_application_version_id IS DISTINCT FROM OLD.approved_asset_application_version_id
        OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted offering publication facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
