import type { PostgresMigration } from "./types.js";

/** Add subject-bound external collection snapshots and exact package bindings. */
export const privacyExternalCollectionSnapshotsMigration: PostgresMigration = {
  version: "143-privacy-external-collection-snapshots",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions(
      capability_key,label,description
    ) VALUES(
      'privacy_external_collect',
      'External privacy collection',
      'Request subject-bound collection from an approved external privacy adapter. The command requires a current signed attestation and separate step-up authentication.'
    ) ON CONFLICT(capability_key) DO NOTHING;

    CREATE TABLE fractal.privacy_external_collection_snapshots(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE
        CHECK(reference ~ '^PXS-[0-9]{8}-[A-Z0-9]{8}$'),
      privacy_request_id UUID NOT NULL
        REFERENCES fractal.privacy_rights_requests(id) ON DELETE RESTRICT,
      requester_identity_id UUID NOT NULL
        REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      request_type TEXT NOT NULL CHECK(request_type IN('access','portability')),
      source_key TEXT NOT NULL CHECK(source_key IN(
        'external.chain.public_records',
        'external.edge.access_logs',
        'external.identity_verification.provider',
        'external.malware_scan.provider',
        'external.mongo.legacy_identity_projection',
        'external.object_store.managed',
        'external.payment.provider',
        'external.postgres.backups',
        'external.redis.operational_cache',
        'external.resend.delivery',
        'external.telemetry.logs'
      )),
      status TEXT NOT NULL CHECK(status IN(
        'queued','collecting','available','failed','expired',
        'cleanup_requested','destroyed','cleanup_failed'
      )),
      adapter_policy_configuration_key TEXT NOT NULL
        CHECK(adapter_policy_configuration_key='privacy.external_source.adapter_policy'),
      adapter_policy_version_id UUID NOT NULL,
      adapter_policy_version_number INTEGER NOT NULL CHECK(adapter_policy_version_number>0),
      adapter_policy_projection_version INTEGER NOT NULL CHECK(adapter_policy_projection_version>0),
      adapter_policy_value_sha256 CHAR(64) NOT NULL
        CHECK(adapter_policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      source_policy JSONB NOT NULL CHECK(jsonb_typeof(source_policy)='object'),
      attestation_configuration_key TEXT NOT NULL
        CHECK(attestation_configuration_key='privacy.external_source.attestation_set'),
      attestation_version_id UUID NOT NULL,
      attestation_version_number INTEGER NOT NULL CHECK(attestation_version_number>0),
      attestation_projection_version INTEGER NOT NULL CHECK(attestation_projection_version>0),
      attestation_value_sha256 CHAR(64) NOT NULL
        CHECK(attestation_value_sha256 ~ '^[0-9a-f]{64}$'),
      source_attestation JSONB NOT NULL CHECK(jsonb_typeof(source_attestation)='object'),
      package_policy_configuration_key TEXT NOT NULL
        CHECK(package_policy_configuration_key='privacy.rights.package_policy'),
      package_policy_version_id UUID NOT NULL,
      package_policy_version_number INTEGER NOT NULL CHECK(package_policy_version_number>0),
      package_policy_projection_version INTEGER NOT NULL CHECK(package_policy_projection_version>0),
      package_policy_value_sha256 CHAR(64) NOT NULL
        CHECK(package_policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      requested_by_identity_id UUID NOT NULL
        REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      requested_at TIMESTAMPTZ NOT NULL,
      retain_until TIMESTAMPTZ NOT NULL CHECK(retain_until>requested_at),
      claimed_by TEXT CHECK(claimed_by IS NULL OR length(claimed_by) BETWEEN 1 AND 200),
      claimed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
      record_count INTEGER CHECK(record_count IS NULL OR record_count BETWEEN 1 AND 100000),
      byte_count INTEGER CHECK(byte_count IS NULL OR byte_count BETWEEN 1 AND 104857600),
      content_sha256 CHAR(64) CHECK(content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
      storage_key TEXT CHECK(storage_key IS NULL OR length(storage_key) BETWEEN 1 AND 2000),
      collected_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      expired_at TIMESTAMPTZ,
      destroyed_at TIMESTAMPTZ,
      failure_category TEXT CHECK(failure_category IS NULL OR failure_category IN(
        'policy_changed','attestation_changed','reference_unavailable',
        'provider_failed','storage_failed','finalization_failed','cleanup_failed'
      )),
      CONSTRAINT privacy_external_snapshot_adapter_policy_version
        FOREIGN KEY(adapter_policy_configuration_key,adapter_policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      CONSTRAINT privacy_external_snapshot_attestation_version
        FOREIGN KEY(attestation_configuration_key,attestation_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      CONSTRAINT privacy_external_snapshot_package_policy_version
        FOREIGN KEY(package_policy_configuration_key,package_policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      UNIQUE(requested_by_identity_id,command_key),
      CHECK((claimed_by IS NULL)=(claimed_at IS NULL)),
      CHECK(
        (status='queued' AND claimed_by IS NULL AND record_count IS NULL
          AND byte_count IS NULL AND content_sha256 IS NULL AND storage_key IS NULL
          AND collected_at IS NULL AND expires_at IS NULL AND expired_at IS NULL
          AND destroyed_at IS NULL AND failure_category IS NULL)
        OR
        (status='collecting' AND claimed_by IS NOT NULL AND record_count IS NULL
          AND byte_count IS NULL AND content_sha256 IS NULL AND storage_key IS NULL
          AND collected_at IS NULL AND expires_at IS NULL AND expired_at IS NULL
          AND destroyed_at IS NULL AND failure_category IS NULL)
        OR
        (status='available' AND claimed_by IS NULL AND record_count IS NOT NULL
          AND byte_count IS NOT NULL AND content_sha256 IS NOT NULL AND storage_key IS NOT NULL
          AND collected_at IS NOT NULL AND expires_at>collected_at
          AND expires_at<=retain_until AND expired_at IS NULL AND destroyed_at IS NULL
          AND failure_category IS NULL)
        OR
        (status='failed' AND claimed_by IS NULL AND record_count IS NULL
          AND byte_count IS NULL AND content_sha256 IS NULL AND storage_key IS NULL
          AND collected_at IS NULL AND expires_at IS NULL AND expired_at IS NULL
          AND destroyed_at IS NULL AND failure_category IS NOT NULL
          AND failure_category<>'cleanup_failed')
        OR
        (status='expired' AND claimed_by IS NULL AND record_count IS NOT NULL
          AND byte_count IS NOT NULL AND content_sha256 IS NOT NULL AND storage_key IS NOT NULL
          AND collected_at IS NOT NULL AND expires_at IS NOT NULL AND expired_at IS NOT NULL
          AND expired_at>=expires_at
          AND destroyed_at IS NULL AND failure_category IS NULL)
        OR
        (status='cleanup_requested' AND claimed_by IS NULL AND record_count IS NOT NULL
          AND byte_count IS NOT NULL AND content_sha256 IS NOT NULL AND storage_key IS NOT NULL
          AND collected_at IS NOT NULL AND expires_at IS NOT NULL
          AND destroyed_at IS NULL AND failure_category IS NULL)
        OR
        (status='destroyed' AND claimed_by IS NULL AND record_count IS NOT NULL
          AND byte_count IS NOT NULL AND content_sha256 IS NOT NULL AND storage_key IS NOT NULL
          AND collected_at IS NOT NULL AND expires_at IS NOT NULL
          AND destroyed_at IS NOT NULL AND failure_category IS NULL)
        OR
        (status='cleanup_failed' AND claimed_by IS NULL AND record_count IS NOT NULL
          AND byte_count IS NOT NULL AND content_sha256 IS NOT NULL AND storage_key IS NOT NULL
          AND collected_at IS NOT NULL AND expires_at IS NOT NULL
          AND destroyed_at IS NULL AND failure_category='cleanup_failed')
      )
    );
    CREATE INDEX privacy_external_snapshot_queue_idx
      ON fractal.privacy_external_collection_snapshots(status,requested_at,id);
    CREATE INDEX privacy_external_snapshot_request_idx
      ON fractal.privacy_external_collection_snapshots(
        privacy_request_id,source_key,requested_at DESC,id DESC
      );
    CREATE INDEX privacy_external_snapshot_subject_idx
      ON fractal.privacy_external_collection_snapshots(
        requester_identity_id,requested_at DESC,id DESC
      );
    CREATE INDEX privacy_external_snapshot_retention_idx
      ON fractal.privacy_external_collection_snapshots(retain_until,id)
      WHERE status IN('available','expired');

    CREATE OR REPLACE FUNCTION fractal.validate_privacy_external_snapshot_origin()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE request_record RECORD;
    DECLARE policy_record RECORD;
    DECLARE attestation_record RECORD;
    DECLARE package_policy_record RECORD;
    DECLARE exact_source_policy JSONB;
    DECLARE exact_source_attestation JSONB;
    BEGIN
      SELECT requester_identity_id,request_type,status,assigned_to_identity_id
        INTO request_record
        FROM fractal.privacy_rights_requests
       WHERE id=NEW.privacy_request_id;
      IF request_record IS NULL
         OR request_record.requester_identity_id<>NEW.requester_identity_id
         OR request_record.request_type<>NEW.request_type
         OR request_record.status<>'in_review'
         OR request_record.assigned_to_identity_id<>NEW.requested_by_identity_id
         OR NEW.status<>'queued' THEN
        RAISE EXCEPTION 'external snapshot requires the assigned owner of an in-review privacy request';
      END IF;

      SELECT version.version_number,version.value_sha256,version.proposed_value,
             projection.projection_version
        INTO policy_record
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.adapter_policy_configuration_key
         AND version.id=NEW.adapter_policy_version_id;
      IF policy_record IS NULL
         OR NEW.adapter_policy_version_number<>policy_record.version_number
         OR NEW.adapter_policy_projection_version<>policy_record.projection_version
         OR NEW.adapter_policy_value_sha256<>policy_record.value_sha256 THEN
        RAISE EXCEPTION 'external snapshot requires the exact active adapter policy';
      END IF;
      SELECT item INTO exact_source_policy
        FROM jsonb_array_elements(policy_record.proposed_value->'sources') item
       WHERE item->>'sourceKey'=NEW.source_key;
      IF exact_source_policy IS NULL
         OR NEW.source_policy IS DISTINCT FROM exact_source_policy
         OR exact_source_policy->'rights'->NEW.request_type->>'mode'<>'collect' THEN
        RAISE EXCEPTION 'external snapshot requires the exact collect operation for the request right';
      END IF;

      SELECT version.version_number,version.value_sha256,version.proposed_value,
             projection.projection_version
        INTO attestation_record
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.attestation_configuration_key
         AND version.id=NEW.attestation_version_id;
      IF attestation_record IS NULL
         OR NEW.attestation_version_number<>attestation_record.version_number
         OR NEW.attestation_projection_version<>attestation_record.projection_version
         OR NEW.attestation_value_sha256<>attestation_record.value_sha256 THEN
        RAISE EXCEPTION 'external snapshot requires the exact active attestation set';
      END IF;
      SELECT item INTO exact_source_attestation
        FROM jsonb_array_elements(attestation_record.proposed_value->'attestations') item
       WHERE item->'payload'->>'sourceKey'=NEW.source_key;
      IF exact_source_attestation IS NULL
         OR NEW.source_attestation IS DISTINCT FROM exact_source_attestation
         OR exact_source_attestation->'payload'->'policyBinding'->>'versionId'
            <>NEW.adapter_policy_version_id::text
         OR exact_source_attestation->'payload'->'policyBinding'->>'configurationKey'
            <>NEW.adapter_policy_configuration_key
         OR (exact_source_attestation->'payload'->'policyBinding'->>'versionNumber')::integer
            <>NEW.adapter_policy_version_number
         OR (exact_source_attestation->'payload'->'policyBinding'->>'projectionVersion')::integer
            <>NEW.adapter_policy_projection_version
         OR exact_source_attestation->'payload'->'policyBinding'->>'valueSha256'
            <>NEW.adapter_policy_value_sha256
         OR exact_source_attestation->'payload'->'implementation'
            IS DISTINCT FROM jsonb_build_object(
              'adapterKey',exact_source_policy->'implementation'->>'adapterKey',
              'version',exact_source_policy->'implementation'->>'version',
              'sha256',exact_source_policy->'implementation'->>'sha256',
              'releaseSha256',exact_source_attestation->'payload'->'implementation'->>'releaseSha256'
            ) THEN
        RAISE EXCEPTION 'external snapshot attestation does not bind the exact source policy';
      END IF;

      SELECT version.version_number,version.value_sha256,version.proposed_value,
             projection.projection_version
        INTO package_policy_record
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.package_policy_configuration_key
         AND version.id=NEW.package_policy_version_id;
      IF package_policy_record IS NULL
         OR NEW.package_policy_version_number<>package_policy_record.version_number
         OR NEW.package_policy_projection_version<>package_policy_record.projection_version
         OR NEW.package_policy_value_sha256<>package_policy_record.value_sha256
         OR NEW.retain_until<>NEW.requested_at
            +(package_policy_record.proposed_value->>'packageRetentionHours')::integer*interval '1 hour' THEN
        RAISE EXCEPTION 'external snapshot requires the exact active package retention policy';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_external_snapshot_origin_validate
      BEFORE INSERT ON fractal.privacy_external_collection_snapshots
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_privacy_external_snapshot_origin();

    CREATE OR REPLACE FUNCTION fractal.protect_privacy_external_snapshot()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'external privacy snapshot evidence is not deletable';
      END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference
         OR NEW.privacy_request_id<>OLD.privacy_request_id
         OR NEW.requester_identity_id<>OLD.requester_identity_id
         OR NEW.request_type<>OLD.request_type OR NEW.source_key<>OLD.source_key
         OR NEW.adapter_policy_configuration_key<>OLD.adapter_policy_configuration_key
         OR NEW.adapter_policy_version_id<>OLD.adapter_policy_version_id
         OR NEW.adapter_policy_version_number<>OLD.adapter_policy_version_number
         OR NEW.adapter_policy_projection_version<>OLD.adapter_policy_projection_version
         OR NEW.adapter_policy_value_sha256<>OLD.adapter_policy_value_sha256
         OR NEW.source_policy<>OLD.source_policy
         OR NEW.attestation_configuration_key<>OLD.attestation_configuration_key
         OR NEW.attestation_version_id<>OLD.attestation_version_id
         OR NEW.attestation_version_number<>OLD.attestation_version_number
         OR NEW.attestation_projection_version<>OLD.attestation_projection_version
         OR NEW.attestation_value_sha256<>OLD.attestation_value_sha256
         OR NEW.source_attestation<>OLD.source_attestation
         OR NEW.package_policy_configuration_key<>OLD.package_policy_configuration_key
         OR NEW.package_policy_version_id<>OLD.package_policy_version_id
         OR NEW.package_policy_version_number<>OLD.package_policy_version_number
         OR NEW.package_policy_projection_version<>OLD.package_policy_projection_version
         OR NEW.package_policy_value_sha256<>OLD.package_policy_value_sha256
         OR NEW.command_key<>OLD.command_key
         OR NEW.requested_by_identity_id<>OLD.requested_by_identity_id
         OR NEW.requested_at<>OLD.requested_at OR NEW.retain_until<>OLD.retain_until
         OR NEW.attempts<OLD.attempts
         OR (OLD.record_count IS NOT NULL AND NEW.record_count IS DISTINCT FROM OLD.record_count)
         OR (OLD.byte_count IS NOT NULL AND NEW.byte_count IS DISTINCT FROM OLD.byte_count)
         OR (OLD.content_sha256 IS NOT NULL AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
         OR (OLD.storage_key IS NOT NULL AND NEW.storage_key IS DISTINCT FROM OLD.storage_key)
         OR (OLD.collected_at IS NOT NULL AND NEW.collected_at IS DISTINCT FROM OLD.collected_at)
         OR (OLD.expires_at IS NOT NULL AND NEW.expires_at IS DISTINCT FROM OLD.expires_at)
         OR (OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at)
         OR (OLD.destroyed_at IS NOT NULL AND NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at) THEN
        RAISE EXCEPTION 'external privacy snapshot origin and evidence are immutable';
      END IF;
      IF NOT (
        (OLD.status='queued' AND NEW.status='collecting')
        OR (OLD.status='collecting' AND NEW.status IN('collecting','available','failed'))
        OR (OLD.status='available' AND NEW.status IN('expired','cleanup_requested'))
        OR (OLD.status='expired' AND NEW.status='cleanup_requested')
        OR (OLD.status='cleanup_requested' AND NEW.status IN('destroyed','cleanup_failed'))
      ) THEN
        RAISE EXCEPTION 'invalid external privacy snapshot transition';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_external_snapshot_guard
      BEFORE UPDATE OR DELETE ON fractal.privacy_external_collection_snapshots
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_privacy_external_snapshot();

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_external_snapshot_manifest(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value)<>'array' OR jsonb_array_length(value)>11 THEN
        RETURN FALSE;
      END IF;
      RETURN NOT EXISTS(
        SELECT 1 FROM jsonb_array_elements(value) item
         WHERE jsonb_typeof(item)<>'object'
           OR (SELECT count(*) FROM jsonb_object_keys(item))<>8
           OR item->>'sourceKey' NOT IN(
             'external.chain.public_records',
             'external.edge.access_logs',
             'external.identity_verification.provider',
             'external.malware_scan.provider',
             'external.mongo.legacy_identity_projection',
             'external.object_store.managed',
             'external.payment.provider',
             'external.postgres.backups',
             'external.redis.operational_cache',
             'external.resend.delivery',
             'external.telemetry.logs'
           )
           OR item->>'snapshotId' !~ '^[0-9a-f-]{36}$'
           OR item->>'snapshotReference' !~ '^PXS-[0-9]{8}-[A-Z0-9]{8}$'
           OR item->>'contentSha256' !~ '^[0-9a-f]{64}$'
           OR item->>'recordCount' !~ '^[1-9][0-9]*$'
           OR item->>'byteCount' !~ '^[1-9][0-9]*$'
           OR jsonb_typeof(item->'collectedAt')<>'string'
           OR jsonb_typeof(item->'expiresAt')<>'string'
      ) AND (
        SELECT count(*)=count(DISTINCT item->>'sourceKey')
          FROM jsonb_array_elements(value) item
      ) AND (
        SELECT count(*)=count(DISTINCT item->>'snapshotId')
          FROM jsonb_array_elements(value) item
      );
    END; $$;

    ALTER TABLE fractal.privacy_rights_package_preparations
      ADD COLUMN external_snapshot_manifest JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK(fractal.valid_privacy_external_snapshot_manifest(external_snapshot_manifest));

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(
      source_key,source_kind,source_locator,authority_key,contains_personal_data,
      subject_linkage,data_categories,inventory_status,access_status,portability_status,
      correction_status,erasure_status,restriction_status,objection_status,
      retention_policy_status,hold_coverage_status,blocker
    ) VALUES(
      'postgres.fractal.privacy_external_collection_snapshots',
      'postgres_relation',
      'fractal.privacy_external_collection_snapshots',
      'privacy_register',
      true,
      'direct_identity',
      ARRAY['external_collection_lifecycle_metadata'],
      'catalogued',
      'available',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'approved',
      'partial',
      'Access includes only source, lifecycle state, counts, and times. Provider records, storage locators, hashes, policy evidence, attestation evidence, commands, workers, errors, and administrator identities are excluded. Portability and rights execution remain separately governed.'
    );
    CREATE TRIGGER privacy_data_sources_immutable
      BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    UPDATE fractal.platform_configuration_definitions
       SET validation_schema='{"type":"object","required":["profileReference","profileName","schemaVersion","fieldCatalogVersion","jurisdictionCode","legalBasisReference","effectiveScope","access","portability"],"operationalValidator":"privacy_content_profile_v1_v2_v3_v4_v5_v6_v7_v8_v9_v10_v11_v12_v13_v14_v15_v16_v17_v18_v19_v20_v21_v22_v23_v24_v25_v26_v27_v28_v29_v30_v31_v32_v33_v34_v35_v36_v37_v38_v39_v40_v41_v42_v43_v44"}'::jsonb
     WHERE configuration_key='privacy.rights.content_profile';

    ALTER TABLE fractal.privacy_rights_package_preparations
      DROP CONSTRAINT privacy_package_content_profile_shape;
    ALTER TABLE fractal.privacy_rights_package_preparations
      ADD CONSTRAINT privacy_package_content_profile_shape CHECK(
        (content_profile_binding_status='legacy_unprofiled'
          AND content_profile_configuration_key IS NULL
          AND content_profile_version_id IS NULL
          AND content_profile_version_number IS NULL
          AND content_profile_projection_version IS NULL
          AND content_profile_value_sha256 IS NULL
          AND content_profile_reference IS NULL
          AND content_profile_name IS NULL
          AND content_profile_schema_version IS NULL
          AND content_profile_field_catalog_version IS NULL
          AND content_profile_jurisdiction_code IS NULL
          AND content_profile_legal_basis_reference IS NULL
          AND content_profile_effective_scope IS NULL
          AND selected_content_profile IS NULL)
        OR
        (content_profile_binding_status='governed'
          AND content_profile_configuration_key='privacy.rights.content_profile'
          AND content_profile_version_id IS NOT NULL
          AND content_profile_version_number>0
          AND content_profile_projection_version>0
          AND content_profile_value_sha256 ~ '^[0-9a-f]{64}$'
          AND length(content_profile_reference) BETWEEN 3 AND 120
          AND length(content_profile_name) BETWEEN 10 AND 160
          AND content_profile_schema_version='privacy-content-profile-v1'
          AND content_profile_field_catalog_version ~ '^privacy-safe-fields-v([1-9]|[1-3][0-9]|4[0-4])$'
          AND content_profile_jurisdiction_code ~ '^[A-Z0-9-]{2,16}$'
          AND length(content_profile_legal_basis_reference) BETWEEN 10 AND 500
          AND content_profile_effective_scope='authenticated_data_subject_access_and_portability'
          AND jsonb_typeof(selected_content_profile)='object')
      );

    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_content_profile()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_profile RECORD;
    DECLARE expected_rule_count INTEGER;
    BEGIN
      IF NEW.content_profile_binding_status<>'governed' THEN
        RAISE EXCEPTION 'new privacy package preparation requires a governed content profile';
      END IF;
      SELECT version.version_number,version.value_sha256,version.proposed_value,
             projection.projection_version
        INTO exact_profile
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.content_profile_configuration_key
         AND version.id=NEW.content_profile_version_id;
      IF exact_profile IS NULL
         OR NEW.content_profile_version_number IS DISTINCT FROM exact_profile.version_number
         OR NEW.content_profile_projection_version IS DISTINCT FROM exact_profile.projection_version
         OR NEW.content_profile_value_sha256 IS DISTINCT FROM exact_profile.value_sha256
         OR NEW.content_profile_reference IS DISTINCT FROM exact_profile.proposed_value->>'profileReference'
         OR NEW.content_profile_name IS DISTINCT FROM exact_profile.proposed_value->>'profileName'
         OR NEW.content_profile_schema_version IS DISTINCT FROM exact_profile.proposed_value->>'schemaVersion'
         OR NEW.content_profile_field_catalog_version IS DISTINCT FROM exact_profile.proposed_value->>'fieldCatalogVersion'
         OR NEW.content_profile_jurisdiction_code IS DISTINCT FROM exact_profile.proposed_value->>'jurisdictionCode'
         OR NEW.content_profile_legal_basis_reference IS DISTINCT FROM exact_profile.proposed_value->>'legalBasisReference'
         OR NEW.content_profile_effective_scope IS DISTINCT FROM exact_profile.proposed_value->>'effectiveScope'
         OR NEW.selected_content_profile IS DISTINCT FROM exact_profile.proposed_value->NEW.request_type THEN
        RAISE EXCEPTION 'privacy package preparation requires the exact active approved content profile';
      END IF;
      IF NEW.content_profile_field_catalog_version<>'privacy-safe-fields-v44' THEN
        RAISE EXCEPTION 'privacy package preparation requires an active v44 content profile after external snapshot activation';
      END IF;
      expected_rule_count:=CASE NEW.request_type WHEN 'access' THEN 141 ELSE 24 END;
      IF jsonb_typeof(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM 'array'
         OR jsonb_array_length(NEW.selected_content_profile->'sourceRules')
            IS DISTINCT FROM expected_rule_count THEN
        RAISE EXCEPTION 'privacy package preparation requires the exact right-specific collector rule count';
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_package_preparation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_policy RECORD;
    DECLARE exact_request RECORD;
    DECLARE exact_source_count INTEGER;
    BEGIN
      SELECT request.requester_identity_id,request.request_type,request.version,
             request.status,decision.status AS decision_status,
             decision.scope_outcomes,decision.fulfillment_coverage
        INTO exact_request
        FROM fractal.privacy_rights_requests request
        JOIN fractal.privacy_rights_decision_requests decision
          ON decision.id=NEW.decision_request_id
         AND decision.privacy_request_id=request.id
       WHERE request.id=NEW.privacy_request_id;
      IF exact_request IS NULL
         OR exact_request.requester_identity_id<>NEW.requester_identity_id
         OR exact_request.request_type<>NEW.request_type
         OR exact_request.version<>NEW.request_version
         OR exact_request.status NOT IN('approved','partially_approved')
         OR exact_request.decision_status<>'applied'
         OR exact_request.fulfillment_coverage IS DISTINCT FROM NEW.coverage_snapshot
         OR NOT EXISTS(
           SELECT 1 FROM jsonb_array_elements(exact_request.scope_outcomes) item
            WHERE item->>'action'='provide'
         ) THEN
        RAISE EXCEPTION 'privacy package preparation requires an applied providing decision for the exact request state and coverage';
      END IF;

      SELECT version.version_number,version.value_sha256,version.proposed_value,
             projection.projection_version
        INTO exact_policy
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.configuration_key
         AND version.id=NEW.policy_version_id;
      IF exact_policy IS NULL
         OR NEW.policy_version_number<>exact_policy.version_number
         OR NEW.policy_projection_version<>exact_policy.projection_version
         OR NEW.policy_value_sha256<>exact_policy.value_sha256
         OR NEW.policy_reference<>exact_policy.proposed_value->>'policyReference'
         OR NEW.policy_name<>exact_policy.proposed_value->>'policyName'
         OR NEW.canonical_format<>exact_policy.proposed_value->>'canonicalFormat'
         OR NEW.identity_assurance<>exact_policy.proposed_value->>'identityAssurance'
         OR NEW.delivery_channel<>exact_policy.proposed_value->>'deliveryChannel'
         OR (exact_policy.proposed_value->>'allowInternalIncompletePreparation')::boolean IS NOT TRUE
         OR NEW.maximum_records<>(exact_policy.proposed_value->>'maximumRecords')::integer
         OR NEW.maximum_bytes<>(exact_policy.proposed_value->>'maximumBytes')::integer
         OR NEW.package_retention_hours<>(exact_policy.proposed_value->>'packageRetentionHours')::integer
         OR NEW.requester_retrieval_hours<>(exact_policy.proposed_value->>'requesterRetrievalHours')::integer THEN
        RAISE EXCEPTION 'privacy package preparation requires the exact active approved package policy';
      END IF;

      IF EXISTS(
        SELECT 1
          FROM jsonb_array_elements(NEW.external_snapshot_manifest) binding
          LEFT JOIN fractal.privacy_external_collection_snapshots snapshot
            ON snapshot.id=(binding->>'snapshotId')::uuid
         WHERE snapshot.id IS NULL
            OR snapshot.privacy_request_id<>NEW.privacy_request_id
            OR snapshot.requester_identity_id<>NEW.requester_identity_id
            OR snapshot.request_type<>NEW.request_type
            OR snapshot.source_key<>binding->>'sourceKey'
            OR snapshot.reference<>binding->>'snapshotReference'
            OR snapshot.status<>'available'
            OR snapshot.content_sha256<>binding->>'contentSha256'
            OR snapshot.record_count<>(binding->>'recordCount')::integer
            OR snapshot.byte_count<>(binding->>'byteCount')::integer
            OR snapshot.collected_at<>(binding->>'collectedAt')::timestamptz
            OR snapshot.expires_at<>(binding->>'expiresAt')::timestamptz
            OR snapshot.expires_at<=NEW.prepared_at
            OR NOT EXISTS(
              SELECT 1 FROM fractal.platform_configuration_active_versions active
               WHERE active.configuration_key=snapshot.adapter_policy_configuration_key
                 AND active.active_version_id=snapshot.adapter_policy_version_id
            )
            OR NOT EXISTS(
              SELECT 1 FROM fractal.platform_configuration_active_versions active
               WHERE active.configuration_key=snapshot.attestation_configuration_key
                 AND active.active_version_id=snapshot.attestation_version_id
            )
      ) THEN
        RAISE EXCEPTION 'privacy package preparation requires exact current external snapshots';
      END IF;

      SELECT count(*) INTO exact_source_count FROM fractal.privacy_data_sources;
      IF jsonb_array_length(NEW.source_manifest)<>exact_source_count
         OR EXISTS(
           SELECT 1
             FROM fractal.privacy_data_sources source
             LEFT JOIN jsonb_array_elements(NEW.source_manifest) item
               ON item->>'sourceKey'=source.source_key
            WHERE item IS NULL
               OR item->>'authorityKey'<>source.authority_key
               OR item->>'status'<>CASE
                    WHEN NOT source.contains_personal_data THEN 'not_applicable'
                    WHEN source.source_kind<>'postgres_relation'
                         AND EXISTS(
                           SELECT 1
                             FROM jsonb_array_elements(NEW.external_snapshot_manifest) binding
                            WHERE binding->>'sourceKey'=source.source_key
                         ) THEN 'collected'
                    WHEN (
                      CASE NEW.request_type
                        WHEN 'access' THEN source.access_status
                        ELSE source.portability_status
                      END
                    )='available' THEN 'collected'
                    ELSE 'unavailable'
                  END
               OR (
                 source.source_kind<>'postgres_relation'
                 AND item->>'status'='collected'
                 AND NOT EXISTS(
                   SELECT 1
                     FROM jsonb_array_elements(NEW.external_snapshot_manifest) binding
                    WHERE binding->>'sourceKey'=source.source_key
                      AND binding->>'contentSha256'=item->>'contentSha256'
                      AND (binding->>'recordCount')::integer=(item->>'recordCount')::integer
                      AND (binding->>'byteCount')::integer=(item->>'byteCount')::integer
                 )
               )
         )
         OR NEW.collected_record_count<>(
           SELECT COALESCE(sum((item->>'recordCount')::integer),0)
             FROM jsonb_array_elements(NEW.source_manifest) item
            WHERE item->>'status'='collected'
         ) THEN
        RAISE EXCEPTION 'privacy package preparation manifest must exactly represent the migration-owned source inventory and external snapshots';
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.privacy_package_preparation_is_current(preparation_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT COALESCE((
        SELECT preparation.deliverable
          AND EXISTS(
            SELECT 1 FROM fractal.platform_configuration_active_versions active
             WHERE active.configuration_key=preparation.configuration_key
               AND active.active_version_id=preparation.policy_version_id
          )
          AND EXISTS(
            SELECT 1 FROM fractal.platform_configuration_active_versions active
             WHERE active.configuration_key=preparation.content_profile_configuration_key
               AND active.active_version_id=preparation.content_profile_version_id
          )
          AND jsonb_array_length(preparation.source_manifest)=(
            SELECT count(*) FROM fractal.privacy_data_sources
          )
          AND NOT EXISTS(
            SELECT 1
              FROM jsonb_array_elements(preparation.external_snapshot_manifest) binding
              LEFT JOIN fractal.privacy_external_collection_snapshots snapshot
                ON snapshot.id=(binding->>'snapshotId')::uuid
             WHERE snapshot.id IS NULL
                OR snapshot.status<>'available'
                OR snapshot.expires_at<=now()
                OR snapshot.privacy_request_id<>preparation.privacy_request_id
                OR snapshot.requester_identity_id<>preparation.requester_identity_id
                OR snapshot.request_type<>preparation.request_type
                OR snapshot.source_key<>binding->>'sourceKey'
                OR snapshot.content_sha256<>binding->>'contentSha256'
                OR NOT EXISTS(
                  SELECT 1 FROM fractal.platform_configuration_active_versions active
                   WHERE active.configuration_key=snapshot.adapter_policy_configuration_key
                     AND active.active_version_id=snapshot.adapter_policy_version_id
                )
                OR NOT EXISTS(
                  SELECT 1 FROM fractal.platform_configuration_active_versions active
                   WHERE active.configuration_key=snapshot.attestation_configuration_key
                     AND active.active_version_id=snapshot.attestation_version_id
                )
          )
          AND NOT EXISTS(
            SELECT 1
              FROM fractal.privacy_data_sources source
              LEFT JOIN jsonb_array_elements(preparation.source_manifest) item
                ON item->>'sourceKey'=source.source_key
             WHERE item IS NULL OR item->>'authorityKey'<>source.authority_key
                OR item->>'status'<>CASE
                     WHEN NOT source.contains_personal_data THEN 'not_applicable'
                     WHEN source.source_kind<>'postgres_relation'
                          AND EXISTS(
                            SELECT 1
                              FROM jsonb_array_elements(preparation.external_snapshot_manifest) binding
                             WHERE binding->>'sourceKey'=source.source_key
                          ) THEN 'collected'
                     WHEN (
                       CASE preparation.request_type
                         WHEN 'access' THEN source.access_status
                         ELSE source.portability_status
                       END
                     )='available' THEN 'collected'
                     ELSE 'unavailable'
                   END
          )
        FROM fractal.privacy_rights_package_preparations preparation
        WHERE preparation.id=preparation_id
      ),false)
    $$;

    ALTER TABLE fractal.storage_cleanup_tasks
      DROP CONSTRAINT storage_cleanup_tasks_purpose_check,
      DROP CONSTRAINT storage_cleanup_governed_purpose_shape,
      ADD COLUMN privacy_external_collection_snapshot_id UUID UNIQUE
        REFERENCES fractal.privacy_external_collection_snapshots(id);
    ALTER TABLE fractal.storage_cleanup_tasks
      ADD CONSTRAINT storage_cleanup_tasks_purpose_check CHECK(
        purpose IN(
          'orphan_cleanup','governed_disposition','organization_document_disposition',
          'privacy_package_delivery','privacy_external_snapshot'
        )
      ),
      ADD CONSTRAINT storage_cleanup_governed_purpose_shape CHECK(
        (purpose='orphan_cleanup'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL)
        OR
        (purpose='governed_disposition'
          AND governed_disposition_id IS NOT NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL)
        OR
        (purpose='organization_document_disposition'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NOT NULL
          AND organization_document_version_id IS NOT NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL)
        OR
        (purpose='privacy_package_delivery'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NOT NULL
          AND privacy_external_collection_snapshot_id IS NULL)
        OR
        (purpose='privacy_external_snapshot'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NOT NULL)
      );

    CREATE OR REPLACE FUNCTION fractal.enforce_storage_cleanup_subject_link_immutability()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.metadata_error IS DISTINCT FROM OLD.metadata_error
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.purpose IS DISTINCT FROM OLD.purpose
         OR NEW.governed_disposition_id IS DISTINCT FROM OLD.governed_disposition_id
         OR NEW.organization_document_disposition_id IS DISTINCT FROM OLD.organization_document_disposition_id
         OR NEW.organization_document_version_id IS DISTINCT FROM OLD.organization_document_version_id
         OR NEW.privacy_package_delivery_id IS DISTINCT FROM OLD.privacy_package_delivery_id
         OR NEW.privacy_external_collection_snapshot_id
            IS DISTINCT FROM OLD.privacy_external_collection_snapshot_id THEN
        RAISE EXCEPTION 'storage cleanup origin and subject linkage are immutable';
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.require_privacy_external_snapshot_cleanup_task()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IN('cleanup_requested','destroyed','cleanup_failed')
         AND NOT EXISTS(
           SELECT 1 FROM fractal.storage_cleanup_tasks task
            WHERE task.privacy_external_collection_snapshot_id=NEW.id
              AND task.storage_key=NEW.storage_key
         ) THEN
        RAISE EXCEPTION 'external privacy snapshot cleanup state requires its exact durable cleanup task';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER privacy_external_snapshot_cleanup_task_required
      AFTER UPDATE ON fractal.privacy_external_collection_snapshots
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_privacy_external_snapshot_cleanup_task();
  `,
};
