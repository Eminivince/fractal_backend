import type { PostgresMigration } from "./types.js";

/** Governed, content-free access/portability collection preparation evidence. */
export const privacyPackagePreparationsMigration: PostgresMigration = {
  version: "082-privacy-package-preparations",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding,status)
    VALUES (
      'privacy.rights.package_policy',
      'Privacy rights package policy',
      'Approved canonical format, bounded collection size, protected-register delivery, internal incomplete-preparation permission, and package retention/retrieval limits.',
      'json',
      '{"type":"object","required":["policyReference","policyName","canonicalFormat","identityAssurance","deliveryChannel","allowInternalIncompletePreparation","maximumRecords","maximumBytes","packageRetentionHours","requesterRetrievalHours"],"operationalValidator":"privacy_package_policy_v1"}'::jsonb,
      'next_request',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE
      SET label=EXCLUDED.label,description=EXCLUDED.description,value_type=EXCLUDED.value_type,
          validation_schema=EXCLUDED.validation_schema,consumer_binding=EXCLUDED.consumer_binding,status='active';

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    ALTER TABLE fractal.privacy_data_sources
      DROP CONSTRAINT privacy_data_sources_access_status_check,
      DROP CONSTRAINT privacy_data_sources_portability_status_check,
      DROP CONSTRAINT privacy_data_source_execution_shape;
    ALTER TABLE fractal.privacy_data_sources
      ADD CONSTRAINT privacy_data_sources_access_status_check CHECK (access_status IN ('available','unavailable','not_applicable')),
      ADD CONSTRAINT privacy_data_sources_portability_status_check CHECK (portability_status IN ('available','unavailable','not_applicable')),
      ADD CONSTRAINT privacy_data_source_execution_shape CHECK (
        (contains_personal_data
          AND access_status IN ('available','unavailable') AND portability_status IN ('available','unavailable')
          AND correction_status='unavailable' AND erasure_status='unavailable'
          AND restriction_status='unavailable' AND objection_status='unavailable'
          AND retention_policy_status='unapproved' AND hold_coverage_status IN ('absent','partial')
          AND blocker IS NOT NULL AND length(blocker) BETWEEN 20 AND 1000)
        OR (NOT contains_personal_data AND subject_linkage='technical_no_subject'
          AND access_status='not_applicable' AND portability_status='not_applicable' AND correction_status='not_applicable'
          AND erasure_status='not_applicable' AND restriction_status='not_applicable' AND objection_status='not_applicable'
          AND retention_policy_status='not_applicable' AND hold_coverage_status='not_applicable' AND blocker IS NULL)
      );
    UPDATE fractal.privacy_data_sources
       SET access_status='available',portability_status='available',
           blocker='Canonical access and portability collection is implemented, but correction, restriction, objection, erasure, complete-package delivery, and approved retention remain unavailable.'
     WHERE source_key IN (
       'postgres.fractal.identities','postgres.fractal.identity_role_assignments','postgres.fractal.auth_sessions',
       'postgres.fractal.legal_document_acceptances','postgres.fractal.privacy_rights_requests',
       'postgres.fractal.privacy_rights_policy_bindings','postgres.fractal.privacy_rights_request_events',
       'postgres.fractal.privacy_rights_decision_requests'
     );
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_package_source_manifest(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value)<>'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 500 THEN RETURN FALSE; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value) item
        WHERE jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>7
          OR jsonb_typeof(item->'sourceKey')<>'string' OR jsonb_typeof(item->'authorityKey')<>'string'
          OR item->>'status' NOT IN ('collected','unavailable','not_applicable')
          OR jsonb_typeof(item->'recordCount')<>'number' OR item->>'recordCount' !~ '^(0|[1-9][0-9]*)$'
          OR jsonb_typeof(item->'byteCount')<>'number' OR item->>'byteCount' !~ '^(0|[1-9][0-9]*)$'
          OR NOT (jsonb_typeof(item->'contentSha256')='string' OR jsonb_typeof(item->'contentSha256')='null')
          OR NOT (jsonb_typeof(item->'blocker')='string' OR jsonb_typeof(item->'blocker')='null')
          OR (item->>'status'='collected' AND (item->>'contentSha256' IS NULL OR item->>'contentSha256' !~ '^[0-9a-f]{64}$'))
          OR (item->>'status'='collected' AND (item->>'byteCount')::integer<1)
          OR (item->>'status'<>'collected' AND (item->'contentSha256')<>'null'::jsonb)
          OR (item->>'status'='collected' AND (item->'blocker')<>'null'::jsonb)
          OR (item->>'status'='unavailable' AND (jsonb_typeof(item->'blocker')<>'string' OR length(item->>'blocker')<20))
          OR (item->>'status'='not_applicable' AND (item->'blocker')<>'null'::jsonb)
          OR (item->>'status'<>'collected' AND (item->>'recordCount')::integer<>0)
          OR (item->>'status'<>'collected' AND (item->>'byteCount')::integer<>0)
      ) AND (SELECT count(*)=count(DISTINCT item->>'sourceKey') FROM jsonb_array_elements(value) item);
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.privacy_package_manifest_counts_match(
      value JSONB,collected INTEGER,unavailable INTEGER,not_applicable INTEGER,records INTEGER,bytes INTEGER
    )
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
      SELECT jsonb_array_length(value)=collected+unavailable+not_applicable
        AND collected=(SELECT count(*) FROM jsonb_array_elements(value) item WHERE item->>'status'='collected')
        AND unavailable=(SELECT count(*) FROM jsonb_array_elements(value) item WHERE item->>'status'='unavailable')
        AND not_applicable=(SELECT count(*) FROM jsonb_array_elements(value) item WHERE item->>'status'='not_applicable')
        AND records=(SELECT COALESCE(sum((item->>'recordCount')::integer),0) FROM jsonb_array_elements(value) item)
        AND bytes=(SELECT COALESCE(sum((item->>'byteCount')::integer),0) FROM jsonb_array_elements(value) item)
    $$;

    CREATE TABLE IF NOT EXISTS fractal.privacy_rights_package_preparations (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^PRP-[0-9]{8}-[A-Z0-9]{8}$'),
      privacy_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_requests(id) ON DELETE RESTRICT,
      decision_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_decision_requests(id) ON DELETE RESTRICT,
      requester_identity_id UUID NOT NULL REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      request_type TEXT NOT NULL CHECK (request_type IN ('access','portability')),
      request_version INTEGER NOT NULL CHECK (request_version>0),
      configuration_key TEXT NOT NULL DEFAULT 'privacy.rights.package_policy' CHECK (configuration_key='privacy.rights.package_policy'),
      policy_version_id UUID NOT NULL,
      policy_version_number INTEGER NOT NULL CHECK (policy_version_number>0),
      policy_projection_version INTEGER NOT NULL CHECK (policy_projection_version>0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK (policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      policy_reference TEXT NOT NULL CHECK (length(policy_reference) BETWEEN 3 AND 120),
      policy_name TEXT NOT NULL CHECK (length(policy_name) BETWEEN 10 AND 160),
      canonical_format TEXT NOT NULL CHECK (canonical_format='application/vnd.fractal.privacy-package+json;version=1'),
      identity_assurance TEXT NOT NULL CHECK (identity_assurance='authenticated_verified_email_session'),
      delivery_channel TEXT NOT NULL CHECK (delivery_channel='authenticated_register'),
      maximum_records INTEGER NOT NULL CHECK (maximum_records BETWEEN 1 AND 100000),
      maximum_bytes INTEGER NOT NULL CHECK (maximum_bytes BETWEEN 1024 AND 104857600),
      package_retention_hours INTEGER NOT NULL CHECK (package_retention_hours BETWEEN 1 AND 720),
      requester_retrieval_hours INTEGER NOT NULL CHECK (requester_retrieval_hours BETWEEN 1 AND 168 AND requester_retrieval_hours<=package_retention_hours),
      coverage_snapshot JSONB NOT NULL CHECK (fractal.valid_privacy_fulfillment_coverage(coverage_snapshot)),
      coverage_sha256 CHAR(64) NOT NULL CHECK (coverage_sha256 ~ '^[0-9a-f]{64}$'),
      transaction_snapshot TEXT NOT NULL CHECK (length(transaction_snapshot) BETWEEN 3 AND 500),
      audit_sequence_high_watermark BIGINT NOT NULL CHECK (audit_sequence_high_watermark>=0),
      source_manifest JSONB NOT NULL CHECK (fractal.valid_privacy_package_source_manifest(source_manifest)),
      source_manifest_sha256 CHAR(64) NOT NULL CHECK (source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      collected_source_count INTEGER NOT NULL CHECK (collected_source_count>=0),
      unavailable_source_count INTEGER NOT NULL CHECK (unavailable_source_count>0),
      not_applicable_source_count INTEGER NOT NULL CHECK (not_applicable_source_count>=0),
      collected_record_count INTEGER NOT NULL CHECK (collected_record_count>=0 AND collected_record_count<=maximum_records),
      collected_byte_count INTEGER NOT NULL CHECK (collected_byte_count>=0 AND collected_byte_count<=maximum_bytes),
      outcome TEXT NOT NULL CHECK (outcome='blocked_incomplete_coverage'),
      deliverable BOOLEAN NOT NULL DEFAULT false CHECK (deliverable=false),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      prepared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT privacy_package_policy_exact_version FOREIGN KEY (configuration_key,policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      CONSTRAINT privacy_package_manifest_counts CHECK (fractal.privacy_package_manifest_counts_match(
        source_manifest,collected_source_count,unavailable_source_count,not_applicable_source_count,
        collected_record_count,collected_byte_count
      )),
      UNIQUE (prepared_by_identity_id,command_key)
    );
    CREATE INDEX IF NOT EXISTS privacy_package_preparations_request_idx
      ON fractal.privacy_rights_package_preparations (privacy_request_id,prepared_at DESC,id DESC);

    INSERT INTO fractal.privacy_data_sources
      (source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,
       inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,
       retention_policy_status,hold_coverage_status,blocker)
    VALUES (
      'postgres.fractal.privacy_rights_package_preparations','postgres_relation','fractal.privacy_rights_package_preparations',
      'privacy_register',true,'relational_identity',ARRAY['content_free_collection_preparation_evidence'],'catalogued',
      'unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent',
      'The preparation register is newly governed but is not yet included in its own canonical access or portability adapter.'
    ) ON CONFLICT (source_key) DO NOTHING;

    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_package_preparation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_policy RECORD; exact_request RECORD; exact_source_count INTEGER;
    BEGIN
      SELECT request.requester_identity_id,request.request_type,request.version,request.status,decision.status AS decision_status,
             decision.scope_outcomes
        INTO exact_request
        FROM fractal.privacy_rights_requests request
        JOIN fractal.privacy_rights_decision_requests decision ON decision.id=NEW.decision_request_id AND decision.privacy_request_id=request.id
       WHERE request.id=NEW.privacy_request_id;
      IF exact_request IS NULL OR exact_request.requester_identity_id<>NEW.requester_identity_id
         OR exact_request.request_type<>NEW.request_type OR exact_request.version<>NEW.request_version
         OR exact_request.status NOT IN ('approved','partially_approved') OR exact_request.decision_status<>'applied'
         OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(exact_request.scope_outcomes) item WHERE item->>'action'='provide')
      THEN RAISE EXCEPTION 'privacy package preparation requires an applied providing decision for the exact request state'; END IF;

      SELECT version.version_number,version.value_sha256,version.proposed_value,projection.projection_version
        INTO exact_policy
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.configuration_key AND version.id=NEW.policy_version_id;
      IF exact_policy IS NULL OR NEW.policy_version_number<>exact_policy.version_number
         OR NEW.policy_projection_version<>exact_policy.projection_version OR NEW.policy_value_sha256<>exact_policy.value_sha256
         OR NEW.policy_reference<>exact_policy.proposed_value->>'policyReference'
         OR NEW.policy_name<>exact_policy.proposed_value->>'policyName'
         OR NEW.canonical_format<>exact_policy.proposed_value->>'canonicalFormat'
         OR NEW.identity_assurance<>exact_policy.proposed_value->>'identityAssurance'
         OR NEW.delivery_channel<>exact_policy.proposed_value->>'deliveryChannel'
         OR (exact_policy.proposed_value->>'allowInternalIncompletePreparation')::boolean IS NOT TRUE
         OR NEW.maximum_records<>(exact_policy.proposed_value->>'maximumRecords')::integer
         OR NEW.maximum_bytes<>(exact_policy.proposed_value->>'maximumBytes')::integer
         OR NEW.package_retention_hours<>(exact_policy.proposed_value->>'packageRetentionHours')::integer
         OR NEW.requester_retrieval_hours<>(exact_policy.proposed_value->>'requesterRetrievalHours')::integer
      THEN RAISE EXCEPTION 'privacy package preparation requires the exact active approved package policy'; END IF;

      SELECT count(*) INTO exact_source_count FROM fractal.privacy_data_sources;
      IF jsonb_array_length(NEW.source_manifest)<>exact_source_count
         OR EXISTS (
           SELECT 1
             FROM fractal.privacy_data_sources source
             LEFT JOIN jsonb_array_elements(NEW.source_manifest) item ON item->>'sourceKey'=source.source_key
            WHERE item IS NULL OR item->>'authorityKey'<>source.authority_key
               OR item->>'status'<>CASE
                    WHEN NOT source.contains_personal_data THEN 'not_applicable'
                    WHEN (CASE NEW.request_type WHEN 'access' THEN source.access_status ELSE source.portability_status END)='available' THEN 'collected'
                    ELSE 'unavailable'
                  END
         )
         OR NEW.collected_record_count<>(
           SELECT COALESCE(sum((item->>'recordCount')::integer),0)
             FROM jsonb_array_elements(NEW.source_manifest) item WHERE item->>'status'='collected'
         )
      THEN RAISE EXCEPTION 'privacy package preparation manifest must exactly represent the migration-owned source inventory'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_package_preparation_exact ON fractal.privacy_rights_package_preparations;
    CREATE TRIGGER privacy_package_preparation_exact BEFORE INSERT ON fractal.privacy_rights_package_preparations
      FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_privacy_package_preparation();
    DROP TRIGGER IF EXISTS privacy_package_preparations_immutable ON fractal.privacy_rights_package_preparations;
    CREATE TRIGGER privacy_package_preparations_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_rights_package_preparations
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_privacy_rights_evidence();

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_fulfillment_coverage(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value)<>'object' THEN RETURN FALSE; END IF;
      IF value->>'schemaVersion'='privacy-fulfillment-inventory-v1' THEN
        RETURN (SELECT count(*) FROM jsonb_object_keys(value))=6
          AND jsonb_typeof(value->'complete')='boolean' AND value->>'complete'='false'
          AND jsonb_typeof(value->'executionAvailable')='boolean' AND value->>'executionAvailable'='false'
          AND jsonb_typeof(value->'coveredAuthorities')='array' AND jsonb_typeof(value->'uncoveredAuthorities')='array'
          AND jsonb_typeof(value->'legalHold')='object' AND (SELECT count(*) FROM jsonb_object_keys(value->'legalHold'))=2
          AND jsonb_typeof(value->'legalHold'->'active')='boolean' AND jsonb_typeof(value->'legalHold'->'pendingImposition')='boolean'
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'coveredAuthorities') item WHERE jsonb_typeof(item)<>'string')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'uncoveredAuthorities') item WHERE jsonb_typeof(item)<>'string');
      END IF;
      IF value->>'schemaVersion'<>'privacy-fulfillment-inventory-v2'
         OR (SELECT count(*) FROM jsonb_object_keys(value))<>7
         OR jsonb_typeof(value->'complete')<>'boolean' OR value->>'complete'<>'false'
         OR jsonb_typeof(value->'executionAvailable')<>'boolean' OR value->>'executionAvailable'<>'false'
         OR jsonb_typeof(value->'coveredAuthorities')<>'array' OR jsonb_typeof(value->'uncoveredAuthorities')<>'array'
         OR jsonb_typeof(value->'authorities')<>'array' OR jsonb_array_length(value->'authorities') NOT BETWEEN 1 AND 50
         OR jsonb_typeof(value->'legalHold')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value->'legalHold'))<>2
         OR jsonb_typeof(value->'legalHold'->'active')<>'boolean' OR jsonb_typeof(value->'legalHold'->'pendingImposition')<>'boolean' THEN RETURN FALSE; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value->'authorities') item
        WHERE jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>6
          OR jsonb_typeof(item->'key')<>'string' OR jsonb_typeof(item->'label')<>'string'
          OR jsonb_typeof(item->'sourceCount')<>'number' OR (item->>'sourceCount')::integer<1
          OR item->>'inventoryStatus' NOT IN ('catalogued','unresolved')
          OR item->>'rightStatus' NOT IN ('available','partial','unavailable','not_applicable')
          OR NOT (jsonb_typeof(item->'blocker')='string' OR jsonb_typeof(item->'blocker')='null')
      ) AND (SELECT count(*)=count(DISTINCT item->>'key') FROM jsonb_array_elements(value->'authorities') item);
    END; $$;
  `,
};
