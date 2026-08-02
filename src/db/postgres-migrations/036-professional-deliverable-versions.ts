import type { PostgresMigration } from "./types.js";

/** Immutable professional deliverable packages with a separate reviewer decision. */
export const professionalDeliverableVersionsMigration: PostgresMigration = {
  version: "036-professional-deliverable-versions",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_deliverable_evidence_documents (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES fractal.professional_work_orders(id),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 1 AND 160),
      storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 2000),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      bytes BIGINT NOT NULL CHECK (bytes > 0 AND bytes <= 15728640),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS professional_deliverable_evidence_documents_order_idx ON fractal.professional_deliverable_evidence_documents (work_order_id, created_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS fractal.professional_deliverable_versions (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES fractal.professional_work_orders(id),
      version INTEGER NOT NULL CHECK (version > 0),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 240),
      submission_summary TEXT NOT NULL CHECK (length(submission_summary) BETWEEN 2 AND 5000),
      status TEXT NOT NULL CHECK (status IN ('submitted', 'revision_requested', 'accepted', 'rejected')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_at TIMESTAMPTZ,
      review_notes TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (work_order_id, version),
      CHECK ((status = 'submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND review_notes IS NULL)
        OR (status IN ('revision_requested', 'accepted', 'rejected') AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND review_notes IS NOT NULL)),
      CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> submitted_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS professional_deliverable_versions_order_idx ON fractal.professional_deliverable_versions (work_order_id, version DESC, id DESC);

    CREATE TABLE IF NOT EXISTS fractal.professional_deliverable_version_documents (
      deliverable_version_id UUID NOT NULL REFERENCES fractal.professional_deliverable_versions(id),
      evidence_document_id UUID NOT NULL REFERENCES fractal.professional_deliverable_evidence_documents(id),
      PRIMARY KEY (deliverable_version_id, evidence_document_id)
    );

    CREATE OR REPLACE FUNCTION fractal.protect_professional_deliverable_record()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'professional deliverable record is immutable'; END;
    $$;
    DROP TRIGGER IF EXISTS professional_deliverable_evidence_documents_immutable ON fractal.professional_deliverable_evidence_documents;
    CREATE TRIGGER professional_deliverable_evidence_documents_immutable BEFORE UPDATE OR DELETE ON fractal.professional_deliverable_evidence_documents FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_deliverable_record();
    DROP TRIGGER IF EXISTS professional_deliverable_version_documents_immutable ON fractal.professional_deliverable_version_documents;
    CREATE TRIGGER professional_deliverable_version_documents_immutable BEFORE UPDATE OR DELETE ON fractal.professional_deliverable_version_documents FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_deliverable_record();

    CREATE OR REPLACE FUNCTION fractal.validate_professional_deliverable_submission()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE work_order fractal.professional_work_orders%ROWTYPE;
    DECLARE expected_version INTEGER;
    BEGIN
      SELECT * INTO work_order FROM fractal.professional_work_orders WHERE id = NEW.work_order_id;
      IF NOT FOUND OR work_order.status NOT IN ('accepted', 'in_progress') THEN
        RAISE EXCEPTION 'professional deliverable requires an accepted active work order';
      END IF;
      PERFORM pg_advisory_xact_lock(hashtext(NEW.work_order_id::text));
      SELECT COALESCE(MAX(version), 0) + 1 INTO expected_version FROM fractal.professional_deliverable_versions WHERE work_order_id = NEW.work_order_id;
      IF NEW.version <> expected_version THEN RAISE EXCEPTION 'professional deliverable version must be sequential'; END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_deliverable_versions_submission_guard ON fractal.professional_deliverable_versions;
    CREATE TRIGGER professional_deliverable_versions_submission_guard BEFORE INSERT ON fractal.professional_deliverable_versions FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_deliverable_submission();

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_deliverable_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'submitted' OR NEW.status NOT IN ('revision_requested', 'accepted', 'rejected') THEN RAISE EXCEPTION 'professional deliverable may only be reviewed once'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.work_order_id IS DISTINCT FROM OLD.work_order_id OR NEW.version IS DISTINCT FROM OLD.version
        OR NEW.title IS DISTINCT FROM OLD.title OR NEW.submission_summary IS DISTINCT FROM OLD.submission_summary
        OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted professional deliverable facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_deliverable_versions_transition ON fractal.professional_deliverable_versions;
    CREATE TRIGGER professional_deliverable_versions_transition BEFORE UPDATE OR DELETE ON fractal.professional_deliverable_versions FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_deliverable_transition();
  `,
};
