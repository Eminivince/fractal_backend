import type { PostgresMigration } from "./types.js";

/** Approved retention binding, legal holds, and governed object disposition for organization documents. */
export const organizationDocumentRetentionDispositionMigration: PostgresMigration = {
  version: "124-organization-document-retention-disposition",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding,status)
    VALUES (
      'organization.document.retention_policy',
      'Organization document retention policy',
      'Approved jurisdiction, legal basis, category, retention basis, and retention duration bound to each new organization document.',
      'json',
      '{"type":"object","required":["policyReference","policyName","schemaVersion","jurisdictions"],"operationalValidator":"organization_document_retention_v1"}'::jsonb,
      'next_request',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE SET
      label=EXCLUDED.label,description=EXCLUDED.description,value_type=EXCLUDED.value_type,
      validation_schema=EXCLUDED.validation_schema,consumer_binding=EXCLUDED.consumer_binding,status='active';

    ALTER TABLE fractal.organization_documents
      ADD COLUMN retention_binding_status TEXT NOT NULL DEFAULT 'legacy_declared',
      ADD COLUMN retention_configuration_key TEXT,
      ADD COLUMN retention_policy_version_id UUID,
      ADD COLUMN retention_policy_version_number INTEGER,
      ADD COLUMN retention_policy_projection_version INTEGER,
      ADD COLUMN retention_policy_value_sha256 CHAR(64),
      ADD COLUMN retention_policy_reference TEXT,
      ADD COLUMN retention_policy_name TEXT,
      ADD COLUMN retention_policy_schema_version TEXT,
      ADD COLUMN retention_policy_jurisdiction_code TEXT,
      ADD COLUMN retention_policy_legal_basis_reference TEXT,
      ADD COLUMN retention_days INTEGER;
    ALTER TABLE fractal.organization_documents ADD CONSTRAINT organization_document_retention_binding_shape CHECK (
      (retention_binding_status='legacy_declared' AND retention_configuration_key IS NULL AND retention_policy_version_id IS NULL
        AND retention_policy_version_number IS NULL AND retention_policy_projection_version IS NULL
        AND retention_policy_value_sha256 IS NULL AND retention_policy_reference IS NULL AND retention_policy_name IS NULL
        AND retention_policy_schema_version IS NULL AND retention_policy_jurisdiction_code IS NULL
        AND retention_policy_legal_basis_reference IS NULL AND retention_days IS NULL)
      OR
      (retention_binding_status='governed' AND retention_configuration_key='organization.document.retention_policy'
        AND retention_policy_version_id IS NOT NULL AND retention_policy_version_number>0 AND retention_policy_projection_version>0
        AND retention_policy_value_sha256 ~ '^[0-9a-f]{64}$' AND length(retention_policy_reference) BETWEEN 3 AND 120
        AND length(retention_policy_name) BETWEEN 10 AND 160
        AND retention_policy_schema_version='organization-document-retention-v1'
        AND retention_policy_jurisdiction_code ~ '^[A-Z]{2}$'
        AND length(retention_policy_legal_basis_reference) BETWEEN 10 AND 500
        AND retention_days BETWEEN 1 AND 9131)
    );
    CREATE OR REPLACE FUNCTION fractal.validate_organization_document_retention_binding()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_policy RECORD; organization_jurisdiction TEXT; expected_days INTEGER;
    BEGIN
      IF NEW.retention_binding_status<>'governed' THEN RETURN NEW; END IF;
      SELECT version.version_number,version.value_sha256,version.proposed_value,projection.projection_version
        INTO exact_policy
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version ON version.id=projection.active_version_id
       WHERE projection.configuration_key=NEW.retention_configuration_key
         AND projection.active_version_id=NEW.retention_policy_version_id AND version.status='active';
      SELECT jurisdiction_code INTO organization_jurisdiction FROM fractal.organizations WHERE id=NEW.organization_id;
      expected_days := (exact_policy.proposed_value #>> ARRAY['jurisdictions',organization_jurisdiction,'rules',NEW.category,NEW.retention_basis,'retentionDays'])::integer;
      IF exact_policy IS NULL OR organization_jurisdiction IS NULL OR expected_days IS NULL
         OR NEW.retention_policy_version_number<>exact_policy.version_number
         OR NEW.retention_policy_projection_version<>exact_policy.projection_version
         OR NEW.retention_policy_value_sha256<>exact_policy.value_sha256
         OR NEW.retention_policy_reference<>exact_policy.proposed_value->>'policyReference'
         OR NEW.retention_policy_name<>exact_policy.proposed_value->>'policyName'
         OR NEW.retention_policy_schema_version<>exact_policy.proposed_value->>'schemaVersion'
         OR NEW.retention_policy_jurisdiction_code<>organization_jurisdiction
         OR NEW.retention_policy_legal_basis_reference<>(exact_policy.proposed_value #>> ARRAY['jurisdictions',organization_jurisdiction,'legalBasisReference'])
         OR NEW.retention_days<>expected_days
         OR NEW.retain_until<>NEW.created_at+make_interval(days=>expected_days) THEN
        RAISE EXCEPTION 'organization document requires the exact active approved retention policy';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_retention_binding_validate BEFORE INSERT ON fractal.organization_documents
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_organization_document_retention_binding();

    CREATE OR REPLACE FUNCTION fractal.validate_organization_document_version_retention()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE parent RECORD; expected_due TIMESTAMPTZ;
    BEGIN
      SELECT retention_binding_status,retention_days,retain_until INTO parent
        FROM fractal.organization_documents WHERE id=NEW.document_id AND organization_id=NEW.organization_id;
      IF parent.retention_binding_status='governed' THEN
        expected_due:=greatest(parent.retain_until,NEW.created_at+make_interval(days=>parent.retention_days));
        IF NEW.retain_until<>expected_due THEN RAISE EXCEPTION 'organization document version retention must follow the bound policy'; END IF;
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_version_retention_validate BEFORE INSERT ON fractal.organization_document_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_organization_document_version_retention();

    CREATE OR REPLACE FUNCTION fractal.guard_organization_document_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'organization documents cannot be deleted'; END IF;
      IF NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.title<>OLD.title OR NEW.category<>OLD.category
         OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.retention_basis<>OLD.retention_basis
         OR NEW.created_by_identity_id<>OLD.created_by_identity_id OR NEW.created_at<>OLD.created_at
         OR NEW.retention_binding_status<>OLD.retention_binding_status
         OR NEW.retention_configuration_key IS DISTINCT FROM OLD.retention_configuration_key
         OR NEW.retention_policy_version_id IS DISTINCT FROM OLD.retention_policy_version_id
         OR NEW.retention_policy_version_number IS DISTINCT FROM OLD.retention_policy_version_number
         OR NEW.retention_policy_projection_version IS DISTINCT FROM OLD.retention_policy_projection_version
         OR NEW.retention_policy_value_sha256 IS DISTINCT FROM OLD.retention_policy_value_sha256
         OR NEW.retention_policy_reference IS DISTINCT FROM OLD.retention_policy_reference
         OR NEW.retention_policy_name IS DISTINCT FROM OLD.retention_policy_name
         OR NEW.retention_policy_schema_version IS DISTINCT FROM OLD.retention_policy_schema_version
         OR NEW.retention_policy_jurisdiction_code IS DISTINCT FROM OLD.retention_policy_jurisdiction_code
         OR NEW.retention_policy_legal_basis_reference IS DISTINCT FROM OLD.retention_policy_legal_basis_reference
         OR NEW.retention_days IS DISTINCT FROM OLD.retention_days THEN
        RAISE EXCEPTION 'organization document origin and retention authority are immutable';
      END IF;
      IF NEW.retain_until<OLD.retain_until THEN RAISE EXCEPTION 'organization document retention cannot be shortened'; END IF;
      IF OLD.status='archived' THEN RAISE EXCEPTION 'archived organization documents are immutable'; END IF;
      IF NEW.status='active' AND NOT (
        (OLD.current_version_id IS NULL AND NEW.current_version_id IS NOT NULL AND OLD.current_version_number=1 AND NEW.current_version_number=1)
        OR (OLD.current_version_id IS NOT NULL AND NEW.current_version_id IS DISTINCT FROM OLD.current_version_id
          AND NEW.current_version_number=OLD.current_version_number+1)
      ) THEN RAISE EXCEPTION 'organization document versions must bind the first version or advance exactly once'; END IF;
      IF NEW.status='archived' AND (NEW.current_version_id<>OLD.current_version_id OR NEW.current_version_number<>OLD.current_version_number
        OR NEW.retain_until<>OLD.retain_until) THEN RAISE EXCEPTION 'archiving cannot change an organization document version or retention'; END IF;
      RETURN NEW;
    END; $$;

    ALTER TABLE fractal.data_legal_hold_change_requests DROP CONSTRAINT IF EXISTS data_legal_hold_change_requests_target_type_check;
    ALTER TABLE fractal.data_legal_hold_change_requests ADD CONSTRAINT data_legal_hold_change_requests_target_type_check
      CHECK (target_type IN ('identity','support_case','support_attachment','organization','organization_document'));
    ALTER TABLE fractal.data_legal_holds DROP CONSTRAINT IF EXISTS data_legal_holds_target_type_check;
    ALTER TABLE fractal.data_legal_holds ADD CONSTRAINT data_legal_holds_target_type_check
      CHECK (target_type IN ('identity','support_case','support_attachment','organization','organization_document'));

    CREATE TABLE fractal.organization_document_disposition_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^ODSP-[0-9]{8}-[A-Z0-9]{8}$'),
      document_id UUID NOT NULL REFERENCES fractal.organization_documents(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      action TEXT NOT NULL CHECK (action='delete_all_version_objects'),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 20 AND 2000),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      retain_until_snapshot TIMESTAMPTZ NOT NULL,
      retention_policy_version_id_snapshot UUID NOT NULL,
      version_count_snapshot INTEGER NOT NULL CHECK (version_count_snapshot>0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 20 AND 2000),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT organization_document_disposition_parent FOREIGN KEY (document_id,organization_id)
        REFERENCES fractal.organization_documents(id,organization_id),
      CONSTRAINT organization_document_disposition_independent_reviewer CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id<>requested_by_identity_id),
      CONSTRAINT organization_document_disposition_request_shape CHECK (
        (status='pending' AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
        OR (status='applied' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      UNIQUE (requested_by_identity_id,command_key)
    );
    CREATE UNIQUE INDEX organization_document_disposition_pending_idx ON fractal.organization_document_disposition_requests(document_id) WHERE status='pending';
    CREATE INDEX organization_document_disposition_queue_idx ON fractal.organization_document_disposition_requests(requested_at,id) WHERE status='pending';

    CREATE TABLE fractal.organization_document_dispositions (
      id UUID PRIMARY KEY,
      document_id UUID NOT NULL UNIQUE REFERENCES fractal.organization_documents(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      disposition_request_id UUID NOT NULL UNIQUE REFERENCES fractal.organization_document_disposition_requests(id),
      expected_version_count INTEGER NOT NULL CHECK (expected_version_count>0),
      status TEXT NOT NULL CHECK (status IN ('cleanup_requested','completed','failed')),
      approved_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      CONSTRAINT organization_document_disposition_record_parent FOREIGN KEY (document_id,organization_id)
        REFERENCES fractal.organization_documents(id,organization_id),
      CONSTRAINT organization_document_disposition_status_shape CHECK (
        (status='cleanup_requested' AND completed_at IS NULL AND failed_at IS NULL)
        OR (status='completed' AND completed_at IS NOT NULL AND failed_at IS NULL)
        OR (status='failed' AND completed_at IS NULL AND failed_at IS NOT NULL)
      )
    );

    ALTER TABLE fractal.storage_cleanup_tasks DROP CONSTRAINT IF EXISTS storage_cleanup_tasks_purpose_check;
    ALTER TABLE fractal.storage_cleanup_tasks DROP CONSTRAINT IF EXISTS storage_cleanup_governed_purpose_shape;
    ALTER TABLE fractal.storage_cleanup_tasks
      ADD COLUMN organization_document_disposition_id UUID REFERENCES fractal.organization_document_dispositions(id),
      ADD COLUMN organization_document_version_id UUID REFERENCES fractal.organization_document_versions(id);
    ALTER TABLE fractal.storage_cleanup_tasks ADD CONSTRAINT storage_cleanup_tasks_purpose_check
      CHECK (purpose IN ('orphan_cleanup','governed_disposition','organization_document_disposition'));
    ALTER TABLE fractal.storage_cleanup_tasks ADD CONSTRAINT storage_cleanup_governed_purpose_shape CHECK (
      (purpose='orphan_cleanup' AND governed_disposition_id IS NULL AND organization_document_disposition_id IS NULL AND organization_document_version_id IS NULL)
      OR (purpose='governed_disposition' AND governed_disposition_id IS NOT NULL AND organization_document_disposition_id IS NULL AND organization_document_version_id IS NULL)
      OR (purpose='organization_document_disposition' AND governed_disposition_id IS NULL AND organization_document_disposition_id IS NOT NULL AND organization_document_version_id IS NOT NULL)
    );
    CREATE UNIQUE INDEX storage_cleanup_organization_document_version_idx
      ON fractal.storage_cleanup_tasks(organization_document_version_id) WHERE organization_document_version_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION fractal.enforce_storage_cleanup_subject_link_immutability()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.source IS DISTINCT FROM OLD.source OR NEW.metadata_error IS DISTINCT FROM OLD.metadata_error
         OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.purpose IS DISTINCT FROM OLD.purpose
         OR NEW.governed_disposition_id IS DISTINCT FROM OLD.governed_disposition_id
         OR NEW.organization_document_disposition_id IS DISTINCT FROM OLD.organization_document_disposition_id
         OR NEW.organization_document_version_id IS DISTINCT FROM OLD.organization_document_version_id THEN
        RAISE EXCEPTION 'storage cleanup origin and subject linkage are immutable';
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.data_lifecycle_target_exists(target_type TEXT,target_id UUID)
    RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF target_type='identity' THEN RETURN EXISTS (SELECT 1 FROM fractal.identities WHERE id=target_id); END IF;
      IF target_type='support_case' THEN RETURN EXISTS (SELECT 1 FROM fractal.support_cases WHERE id=target_id); END IF;
      IF target_type='support_attachment' THEN RETURN EXISTS (SELECT 1 FROM fractal.support_case_attachments WHERE id=target_id); END IF;
      IF target_type='organization' THEN RETURN EXISTS (SELECT 1 FROM fractal.organizations WHERE id=target_id); END IF;
      IF target_type='organization_document' THEN RETURN EXISTS (SELECT 1 FROM fractal.organization_documents WHERE id=target_id); END IF;
      RETURN FALSE;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.data_lifecycle_target_has_disposition(target_type TEXT,target_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM fractal.support_attachment_dispositions disposition
        JOIN fractal.support_case_attachments attachment ON attachment.id=disposition.attachment_id
        JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
        WHERE (target_type='support_attachment' AND attachment.id=target_id)
           OR (target_type='support_case' AND support_case.id=target_id)
           OR (target_type='identity' AND support_case.requester_identity_id=target_id)
      ) OR EXISTS (
        SELECT 1 FROM fractal.organization_document_dispositions disposition
        WHERE (target_type='organization_document' AND disposition.document_id=target_id)
           OR (target_type='organization' AND disposition.organization_id=target_id)
      );
    $$;

    CREATE OR REPLACE FUNCTION fractal.protect_organization_document_disposition_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'organization document disposition request evidence is immutable'; END IF;
      IF OLD.status<>'pending' THEN RAISE EXCEPTION 'terminal organization document disposition request evidence is immutable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.document_id<>OLD.document_id OR NEW.organization_id<>OLD.organization_id
         OR NEW.action<>OLD.action OR NEW.reason<>OLD.reason OR NEW.command_key<>OLD.command_key
         OR NEW.retain_until_snapshot<>OLD.retain_until_snapshot OR NEW.retention_policy_version_id_snapshot<>OLD.retention_policy_version_id_snapshot
         OR NEW.version_count_snapshot<>OLD.version_count_snapshot OR NEW.requested_by_identity_id<>OLD.requested_by_identity_id
         OR NEW.requested_at<>OLD.requested_at OR NOT fractal.identity_has_data_lifecycle_capability(NEW.reviewed_by_identity_id) THEN
        RAISE EXCEPTION 'organization document disposition request facts are immutable or reviewer is unauthorized';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_disposition_request_guard BEFORE UPDATE OR DELETE ON fractal.organization_document_disposition_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_organization_document_disposition_request();

    CREATE OR REPLACE FUNCTION fractal.validate_organization_document_disposition_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE document_record RECORD; actual_versions INTEGER;
    BEGIN
      SELECT status,retention_binding_status,retain_until,retention_policy_version_id INTO document_record
        FROM fractal.organization_documents WHERE id=NEW.document_id AND organization_id=NEW.organization_id;
      SELECT count(*)::integer INTO actual_versions FROM fractal.organization_document_versions WHERE document_id=NEW.document_id;
      IF NOT fractal.identity_has_data_lifecycle_capability(NEW.requested_by_identity_id) THEN RAISE EXCEPTION 'organization document disposition requester lacks data lifecycle capability'; END IF;
      IF document_record IS NULL OR document_record.status<>'archived' OR document_record.retention_binding_status<>'governed'
         OR document_record.retain_until>now() OR NEW.retain_until_snapshot<>document_record.retain_until
         OR NEW.retention_policy_version_id_snapshot<>document_record.retention_policy_version_id
         OR NEW.version_count_snapshot<>actual_versions THEN RAISE EXCEPTION 'organization document is not eligible for governed disposition'; END IF;
      IF EXISTS (SELECT 1 FROM fractal.organization_document_dispositions WHERE document_id=NEW.document_id) THEN RAISE EXCEPTION 'organization document already has a disposition'; END IF;
      IF EXISTS (SELECT 1 FROM fractal.data_legal_holds WHERE released_at IS NULL AND ((target_type='organization_document' AND target_id=NEW.document_id) OR (target_type='organization' AND target_id=NEW.organization_id))) THEN RAISE EXCEPTION 'organization document is protected by an active legal hold'; END IF;
      IF EXISTS (SELECT 1 FROM fractal.data_legal_hold_change_requests WHERE status='pending' AND change_type='impose' AND ((target_type='organization_document' AND target_id=NEW.document_id) OR (target_type='organization' AND target_id=NEW.organization_id))) THEN RAISE EXCEPTION 'organization document is protected by a pending legal hold request'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_disposition_request_validate BEFORE INSERT ON fractal.organization_document_disposition_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_organization_document_disposition_request();

    CREATE OR REPLACE FUNCTION fractal.validate_organization_document_disposition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE request_record RECORD;
    BEGIN
      SELECT * INTO request_record FROM fractal.organization_document_disposition_requests WHERE id=NEW.disposition_request_id;
      IF request_record IS NULL OR request_record.status<>'applied' OR request_record.document_id<>NEW.document_id
         OR request_record.organization_id<>NEW.organization_id OR request_record.applied_at<>NEW.approved_at
         OR request_record.version_count_snapshot<>NEW.expected_version_count THEN
        RAISE EXCEPTION 'organization document disposition requires its exact applied request';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_disposition_validate BEFORE INSERT ON fractal.organization_document_dispositions
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_organization_document_disposition();

    CREATE OR REPLACE FUNCTION fractal.protect_organization_document_disposition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'organization document disposition evidence is immutable'; END IF;
      IF OLD.status<>'cleanup_requested' OR NEW.status NOT IN ('completed','failed')
         OR NEW.id<>OLD.id OR NEW.document_id<>OLD.document_id OR NEW.organization_id<>OLD.organization_id
         OR NEW.disposition_request_id<>OLD.disposition_request_id OR NEW.expected_version_count<>OLD.expected_version_count
         OR NEW.approved_at<>OLD.approved_at THEN RAISE EXCEPTION 'organization document disposition facts are immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER organization_document_disposition_guard BEFORE UPDATE OR DELETE ON fractal.organization_document_dispositions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_organization_document_disposition();

    CREATE OR REPLACE FUNCTION fractal.require_organization_document_disposition_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status='applied' AND NOT EXISTS (SELECT 1 FROM fractal.organization_document_dispositions WHERE disposition_request_id=NEW.id)
        THEN RAISE EXCEPTION 'applied organization document disposition request requires its projection'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER organization_document_disposition_projection_required
      AFTER UPDATE ON fractal.organization_document_disposition_requests DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_organization_document_disposition_projection();

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources
      (source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,
       inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,
       retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'support_and_lifecycle',true,
      'organization_relationship',ARRAY['organization_document_disposition_actor_evidence'],'catalogued','unavailable','unavailable',
      'unavailable','unavailable','unavailable','unavailable','unapproved','partial',
      'Operational document retention and hold controls exist, but privacy-rights retention approval and a safe subject-scoped collector remain incomplete.'
    FROM unnest(ARRAY['organization_document_disposition_requests','organization_document_dispositions']) name
    ON CONFLICT (source_key) DO NOTHING;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
