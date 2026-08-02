import type { PostgresMigration } from "./types.js";

/** Governed, organization-scoped general documents with immutable versions and access evidence. */
export const organizationDocumentLifecycleMigration: PostgresMigration = {
  version: "123-organization-document-lifecycle",
  sql: `
    CREATE TABLE fractal.organization_documents (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 240),
      category TEXT NOT NULL CHECK (category IN ('corporate','finance','operations','compliance','governance','other')),
      reference TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 120),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
      current_version_id UUID,
      current_version_number INTEGER NOT NULL DEFAULT 1 CHECK (current_version_number > 0),
      retention_basis TEXT NOT NULL CHECK (retention_basis IN ('legal_requirement','contractual_record','corporate_record','operational_record')),
      retain_until TIMESTAMPTZ NOT NULL,
      created_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      archived_by_identity_id UUID REFERENCES fractal.identities(id),
      archived_at TIMESTAMPTZ,
      archive_reason TEXT CHECK (archive_reason IS NULL OR length(archive_reason) BETWEEN 10 AND 1000),
      UNIQUE (id,organization_id),
      CONSTRAINT organization_document_retention_future CHECK (
        retain_until > created_at AND retain_until <= created_at + interval '25 years'
      ),
      CONSTRAINT organization_document_archive_shape CHECK (
        (status='active' AND archived_by_identity_id IS NULL AND archived_at IS NULL AND archive_reason IS NULL)
        OR (status='archived' AND archived_by_identity_id IS NOT NULL AND archived_at IS NOT NULL AND archive_reason IS NOT NULL)
      )
    );
    CREATE INDEX organization_documents_register_idx ON fractal.organization_documents
      (organization_id,status,category,created_at DESC,id DESC);

    CREATE TABLE fractal.organization_document_versions (
      id UUID PRIMARY KEY,
      document_id UUID NOT NULL,
      organization_id UUID NOT NULL,
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 160),
      storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 1 AND 2000),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      bytes BIGINT NOT NULL CHECK (bytes > 0),
      retain_until TIMESTAMPTZ NOT NULL,
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (document_id,version_number),
      UNIQUE (id,document_id),
      UNIQUE (id,document_id,version_number),
      CONSTRAINT organization_document_version_parent FOREIGN KEY (document_id,organization_id)
        REFERENCES fractal.organization_documents(id,organization_id),
      CONSTRAINT organization_document_version_retention CHECK (
        retain_until > created_at AND retain_until <= created_at + interval '25 years'
      )
    );
    CREATE INDEX organization_document_versions_history_idx ON fractal.organization_document_versions
      (document_id,version_number DESC);
    ALTER TABLE fractal.organization_documents ADD CONSTRAINT organization_document_current_version
      FOREIGN KEY (current_version_id,id,current_version_number)
      REFERENCES fractal.organization_document_versions(id,document_id,version_number)
      DEFERRABLE INITIALLY DEFERRED;

    CREATE TABLE fractal.organization_document_events (
      id UUID PRIMARY KEY,
      document_id UUID NOT NULL REFERENCES fractal.organization_documents(id),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('created','version_added','archived')),
      from_status TEXT,
      to_status TEXT NOT NULL CHECK (to_status IN ('active','archived')),
      document_version_id UUID,
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 1000),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (document_id,sequence),
      CONSTRAINT organization_document_event_version_shape CHECK (
        (event_type IN ('created','version_added') AND document_version_id IS NOT NULL)
        OR (event_type='archived' AND document_version_id IS NULL)
      ),
      CONSTRAINT organization_document_event_transition_shape CHECK (
        (event_type='created' AND from_status IS NULL AND to_status='active')
        OR (event_type='version_added' AND from_status='active' AND to_status='active')
        OR (event_type='archived' AND from_status='active' AND to_status='archived')
      ),
      CONSTRAINT organization_document_event_version_parent FOREIGN KEY (document_version_id,document_id)
        REFERENCES fractal.organization_document_versions(id,document_id)
    );
    CREATE INDEX organization_document_events_timeline_idx ON fractal.organization_document_events
      (document_id,sequence);

    CREATE TABLE fractal.organization_document_access_events (
      id UUID PRIMARY KEY,
      document_id UUID NOT NULL,
      document_version_id UUID NOT NULL,
      organization_id UUID NOT NULL,
      accessed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      access_type TEXT NOT NULL CHECK (access_type='download'),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT organization_document_access_parent FOREIGN KEY (document_id,organization_id)
        REFERENCES fractal.organization_documents(id,organization_id),
      CONSTRAINT organization_document_access_version_parent FOREIGN KEY (document_version_id,document_id)
        REFERENCES fractal.organization_document_versions(id,document_id)
    );
    CREATE INDEX organization_document_access_actor_idx ON fractal.organization_document_access_events
      (accessed_by_identity_id,occurred_at DESC,id DESC);
    CREATE INDEX organization_document_access_document_idx ON fractal.organization_document_access_events
      (document_id,occurred_at DESC,id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_organization_document_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'organization document evidence is immutable'; END; $$;
    CREATE TRIGGER organization_document_versions_immutable BEFORE UPDATE OR DELETE ON fractal.organization_document_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_organization_document_evidence();
    CREATE TRIGGER organization_document_events_immutable BEFORE UPDATE OR DELETE ON fractal.organization_document_events
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_organization_document_evidence();
    CREATE TRIGGER organization_document_access_events_immutable BEFORE UPDATE OR DELETE ON fractal.organization_document_access_events
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_organization_document_evidence();

    CREATE OR REPLACE FUNCTION fractal.verify_organization_document_event_sequence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE expected_sequence INTEGER; projected_version INTEGER; event_version INTEGER;
    BEGIN
      SELECT COALESCE(max(sequence),0)+1 INTO expected_sequence
        FROM fractal.organization_document_events WHERE document_id=NEW.document_id;
      IF NEW.sequence<>expected_sequence THEN
        RAISE EXCEPTION 'organization document event sequence must be contiguous';
      END IF;
      SELECT current_version_number INTO projected_version
        FROM fractal.organization_documents WHERE id=NEW.document_id;
      IF NEW.event_type IN ('created','version_added') THEN
        SELECT version_number INTO event_version
          FROM fractal.organization_document_versions
         WHERE id=NEW.document_version_id AND document_id=NEW.document_id;
        IF NOT FOUND OR (NEW.event_type='created' AND (event_version<>1 OR NEW.sequence<>1))
          OR (NEW.event_type='version_added' AND (event_version<>projected_version+1 OR NEW.sequence<>event_version)) THEN
          RAISE EXCEPTION 'organization document event must match the exact version transition';
        END IF;
      ELSIF NEW.sequence<>projected_version+1 THEN
        RAISE EXCEPTION 'organization document archive event must follow the current version';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_event_sequence_valid
      BEFORE INSERT ON fractal.organization_document_events
      FOR EACH ROW EXECUTE FUNCTION fractal.verify_organization_document_event_sequence();

    CREATE OR REPLACE FUNCTION fractal.verify_organization_document_access_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE authoritative_hash CHAR(64);
    BEGIN
      SELECT content_sha256 INTO authoritative_hash
        FROM fractal.organization_document_versions
       WHERE id=NEW.document_version_id AND document_id=NEW.document_id AND organization_id=NEW.organization_id;
      IF NOT FOUND OR authoritative_hash<>NEW.content_sha256 THEN
        RAISE EXCEPTION 'organization document access evidence must match the authoritative version';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_access_evidence_valid
      BEFORE INSERT ON fractal.organization_document_access_events
      FOR EACH ROW EXECUTE FUNCTION fractal.verify_organization_document_access_evidence();

    CREATE OR REPLACE FUNCTION fractal.guard_organization_document_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'organization documents cannot be deleted'; END IF;
      IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.title<>OLD.title OR NEW.category<>OLD.category
         OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.retention_basis<>OLD.retention_basis
         OR NEW.created_by_identity_id<>OLD.created_by_identity_id OR NEW.created_at<>OLD.created_at THEN
        RAISE EXCEPTION 'organization document origin is immutable';
      END IF;
      IF NEW.retain_until<OLD.retain_until THEN RAISE EXCEPTION 'organization document retention cannot be shortened'; END IF;
      IF OLD.status='archived' THEN RAISE EXCEPTION 'archived organization documents are immutable'; END IF;
      IF NEW.status='active' AND NOT (
        (OLD.current_version_id IS NULL AND NEW.current_version_id IS NOT NULL
          AND OLD.current_version_number=1 AND NEW.current_version_number=1)
        OR (OLD.current_version_id IS NOT NULL AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
          AND NEW.current_version_number=OLD.current_version_number+1)
      ) THEN
        RAISE EXCEPTION 'organization document versions must bind the first version or advance exactly once';
      END IF;
      IF NEW.status='archived' AND (NEW.current_version_id<>OLD.current_version_id OR NEW.current_version_number<>OLD.current_version_number) THEN
        RAISE EXCEPTION 'archiving cannot change an organization document version';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_documents_projection_guard BEFORE UPDATE OR DELETE ON fractal.organization_documents
      FOR EACH ROW EXECUTE FUNCTION fractal.guard_organization_document_projection();

    CREATE OR REPLACE FUNCTION fractal.verify_organization_document_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE current_document fractal.organization_documents%ROWTYPE; event_exists BOOLEAN;
    BEGIN
      SELECT * INTO current_document FROM fractal.organization_documents WHERE id=NEW.id;
      IF current_document IS NULL THEN RETURN NULL; END IF;
      IF current_document.current_version_id IS NULL THEN RAISE EXCEPTION 'organization document requires a current version'; END IF;
      SELECT EXISTS(SELECT 1 FROM fractal.organization_document_events event
        WHERE event.document_id=current_document.id AND event.document_version_id=current_document.current_version_id
          AND event.event_type=CASE WHEN current_document.current_version_number=1 THEN 'created' ELSE 'version_added' END)
        INTO event_exists;
      IF NOT event_exists THEN RAISE EXCEPTION 'organization document version transition requires immutable event evidence'; END IF;
      IF current_document.status='archived' AND NOT EXISTS(SELECT 1 FROM fractal.organization_document_events event
        WHERE event.document_id=current_document.id AND event.event_type='archived' AND event.to_status='archived') THEN
        RAISE EXCEPTION 'organization document archive requires immutable event evidence';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER organization_document_evidence_required
      AFTER INSERT OR UPDATE ON fractal.organization_documents DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.verify_organization_document_evidence();

    CREATE OR REPLACE FUNCTION fractal.verify_organization_document_version_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE projected_version INTEGER;
    BEGIN
      SELECT current_version_number INTO projected_version
        FROM fractal.organization_documents WHERE id=NEW.document_id AND organization_id=NEW.organization_id;
      IF NOT FOUND OR projected_version<NEW.version_number OR NOT EXISTS(
        SELECT 1 FROM fractal.organization_document_events event
         WHERE event.document_id=NEW.document_id AND event.document_version_id=NEW.id
           AND event.event_type=CASE WHEN NEW.version_number=1 THEN 'created' ELSE 'version_added' END
      ) THEN
        RAISE EXCEPTION 'organization document version requires exact projection and event evidence';
      END IF;
      RETURN NULL;
    END; $$;
    CREATE CONSTRAINT TRIGGER organization_document_version_evidence_required
      AFTER INSERT ON fractal.organization_document_versions DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.verify_organization_document_version_evidence();

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources
      (source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,
       inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,
       retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'issuer_organization_offerings',true,
      'organization_relationship',ARRAY['organization_documents_and_actor_evidence'],'catalogued','unavailable','unavailable',
      'unavailable','unavailable','unavailable','unavailable','unapproved','absent',
      'Organization-document subject linkage, approved retention, legal-hold coverage, canonical rights collection, and execution adapters remain incomplete.'
    FROM unnest(ARRAY['organization_documents','organization_document_versions','organization_document_events','organization_document_access_events']) name;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
