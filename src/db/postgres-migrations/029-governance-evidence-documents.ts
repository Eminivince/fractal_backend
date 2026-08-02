import type { PostgresMigration } from "./types.js";

/** Immutable, tenant-scoped evidence used by governed issuance decisions. */
export const governanceEvidenceDocumentsMigration: PostgresMigration = {
  version: "029-governance-evidence-documents",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.governance_evidence_documents (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      evidence_kind TEXT NOT NULL CHECK (evidence_kind IN ('allocation_policy')),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 160),
      storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 2_000),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      bytes BIGINT NOT NULL CHECK (bytes > 0 AND bytes <= 15728640),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS governance_evidence_documents_offering_idx
      ON fractal.governance_evidence_documents (organization_id, offering_id, evidence_kind, created_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_governance_evidence_document()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.governance_evidence_documents are immutable';
    END;
    $$;
    DROP TRIGGER IF EXISTS governance_evidence_documents_immutable ON fractal.governance_evidence_documents;
    CREATE TRIGGER governance_evidence_documents_immutable
      BEFORE UPDATE OR DELETE ON fractal.governance_evidence_documents
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_governance_evidence_document();

    ALTER TABLE fractal.offering_issuance_term_requests
      ADD COLUMN IF NOT EXISTS allocation_policy_evidence_document_id UUID
      REFERENCES fractal.governance_evidence_documents(id);

    CREATE OR REPLACE FUNCTION fractal.validate_issuance_terms_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE evidence fractal.governance_evidence_documents%ROWTYPE;
    BEGIN
      IF NEW.allocation_policy_evidence_document_id IS NULL THEN
        RAISE EXCEPTION 'issuance terms require allocation-policy evidence';
      END IF;
      SELECT * INTO evidence FROM fractal.governance_evidence_documents
       WHERE id = NEW.allocation_policy_evidence_document_id;
      IF NOT FOUND OR evidence.organization_id <> NEW.organization_id OR evidence.offering_id <> NEW.offering_id
         OR evidence.evidence_kind <> 'allocation_policy' OR evidence.content_sha256 <> NEW.allocation_policy_hash THEN
        RAISE EXCEPTION 'issuance terms evidence does not match the governed offering or policy hash';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS issuance_terms_evidence_guard ON fractal.offering_issuance_term_requests;
    CREATE TRIGGER issuance_terms_evidence_guard
      BEFORE INSERT ON fractal.offering_issuance_term_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_issuance_terms_evidence();

    CREATE OR REPLACE FUNCTION fractal.protect_offering_issuance_terms()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.offering_issuance_term_requests are not deletable'; END IF;
      IF NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.offering_id <> OLD.offering_id
         OR NEW.offering_version_id <> OLD.offering_version_id OR NEW.currency <> OLD.currency
         OR NEW.token_unit_price_minor <> OLD.token_unit_price_minor OR NEW.max_total_supply <> OLD.max_total_supply
         OR NEW.allocation_policy_hash <> OLD.allocation_policy_hash
         OR NEW.allocation_policy_evidence_document_id IS DISTINCT FROM OLD.allocation_policy_evidence_document_id
         OR NEW.submitted_by_identity_id <> OLD.submitted_by_identity_id OR NEW.submitted_at <> OLD.submitted_at THEN
        RAISE EXCEPTION 'fractal.offering_issuance_term_request facts are immutable';
      END IF;
      IF OLD.status <> 'submitted' OR NEW.status NOT IN ('approved','rejected') OR NEW.decided_by_identity_id IS NULL OR NEW.decided_at IS NULL THEN
        RAISE EXCEPTION 'invalid offering issuance terms transition';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
