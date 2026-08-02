import type { PostgresMigration } from "./types.js";

/** Add exact Sumsub export correlation and governed private staging. */
export const sumsubPrivacyExportStagingMigration: PostgresMigration = {
  version: "147-sumsub-privacy-export-staging",
  sql: `
    ALTER TABLE fractal.provider_identity_verification_applications
      ADD COLUMN inspection_id TEXT
        CHECK(inspection_id IS NULL OR length(inspection_id) BETWEEN 1 AND 500),
      ADD CONSTRAINT provider_identity_verification_ready_inspection
        CHECK(status<>'ready' OR inspection_id IS NOT NULL) NOT VALID;
    CREATE UNIQUE INDEX provider_identity_verification_inspection_idx
      ON fractal.provider_identity_verification_applications(provider,inspection_id)
      WHERE inspection_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION fractal.protect_ready_identity_verification_binding()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'identity-verification application evidence is not deletable';
      END IF;
      IF OLD.status='ready' AND (
        NEW.id IS DISTINCT FROM OLD.id
        OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
        OR NEW.provider IS DISTINCT FROM OLD.provider
        OR NEW.external_user_id IS DISTINCT FROM OLD.external_user_id
        OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
        OR NEW.inspection_id IS DISTINCT FROM OLD.inspection_id
        OR NEW.status IS DISTINCT FROM OLD.status
        OR NEW.ready_at IS DISTINCT FROM OLD.ready_at
        OR NEW.created_at IS DISTINCT FROM OLD.created_at
      ) THEN
        RAISE EXCEPTION 'ready identity-verification correlation is immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER provider_identity_verification_ready_guard
      BEFORE UPDATE OR DELETE
      ON fractal.provider_identity_verification_applications
      FOR EACH ROW
      EXECUTE FUNCTION fractal.protect_ready_identity_verification_binding();

    CREATE TABLE fractal.privacy_external_provider_exports(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE
        CHECK(reference ~ '^PVE-[0-9]{8}-[A-Z0-9]{8}$'),
      privacy_request_id UUID NOT NULL
        REFERENCES fractal.privacy_rights_requests(id) ON DELETE RESTRICT,
      requester_identity_id UUID NOT NULL
        REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      request_type TEXT NOT NULL CHECK(request_type IN('access','portability')),
      source_key TEXT NOT NULL
        CHECK(source_key='external.identity_verification.provider'),
      identity_verification_application_id UUID NOT NULL
        REFERENCES fractal.provider_identity_verification_applications(id) ON DELETE RESTRICT,
      applicant_id TEXT NOT NULL CHECK(length(applicant_id) BETWEEN 1 AND 500),
      external_user_id TEXT NOT NULL CHECK(length(external_user_id) BETWEEN 1 AND 500),
      inspection_id TEXT NOT NULL CHECK(length(inspection_id) BETWEEN 1 AND 500),
      report_reference TEXT NOT NULL UNIQUE
        CHECK(length(report_reference) BETWEEN 1 AND 500),
      entry_count INTEGER NOT NULL CHECK(entry_count=1),
      sensitive_tier TEXT NOT NULL CHECK(sensitive_tier='higher_sensitive_data'),
      generated_at TIMESTAMPTZ NOT NULL,
      downloaded_at TIMESTAMPTZ NOT NULL,
      content_sha256 CHAR(64) NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
      byte_count INTEGER NOT NULL CHECK(byte_count BETWEEN 1 AND 104857600),
      settings_sha256 CHAR(64) NOT NULL CHECK(settings_sha256 ~ '^[0-9a-f]{64}$'),
      scanner TEXT NOT NULL CHECK(scanner='clamav_instream'),
      scanned_at TIMESTAMPTZ NOT NULL,
      malware_scan_evidence_sha256 CHAR(64) NOT NULL
        CHECK(malware_scan_evidence_sha256 ~ '^[0-9a-f]{64}$'),
      storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 2000),
      package_policy_configuration_key TEXT NOT NULL
        CHECK(package_policy_configuration_key='privacy.rights.package_policy'),
      package_policy_version_id UUID NOT NULL,
      package_policy_version_number INTEGER NOT NULL CHECK(package_policy_version_number>0),
      package_policy_projection_version INTEGER NOT NULL CHECK(package_policy_projection_version>0),
      package_policy_value_sha256 CHAR(64) NOT NULL
        CHECK(package_policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      status TEXT NOT NULL CHECK(status IN(
        'staged','cleanup_requested','destroyed','cleanup_failed'
      )),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      uploaded_by_identity_id UUID NOT NULL
        REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      uploaded_at TIMESTAMPTZ NOT NULL,
      retain_until TIMESTAMPTZ NOT NULL,
      destroyed_at TIMESTAMPTZ,
      failure_category TEXT CHECK(
        failure_category IS NULL OR failure_category='cleanup_failed'
      ),
      CONSTRAINT privacy_external_provider_export_package_policy
        FOREIGN KEY(package_policy_configuration_key,package_policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      UNIQUE(uploaded_by_identity_id,command_key),
      CHECK(generated_at<=downloaded_at),
      CHECK(downloaded_at<=scanned_at),
      CHECK(scanned_at<=uploaded_at),
      CHECK(retain_until>uploaded_at),
      CHECK(
        (status IN('staged','cleanup_requested')
          AND destroyed_at IS NULL AND failure_category IS NULL)
        OR
        (status='destroyed'
          AND destroyed_at IS NOT NULL AND failure_category IS NULL)
        OR
        (status='cleanup_failed'
          AND destroyed_at IS NULL AND failure_category='cleanup_failed')
      )
    );
    CREATE INDEX privacy_external_provider_export_request_idx
      ON fractal.privacy_external_provider_exports(
        privacy_request_id,uploaded_at DESC,id DESC
      );
    CREATE INDEX privacy_external_provider_export_subject_idx
      ON fractal.privacy_external_provider_exports(
        requester_identity_id,uploaded_at DESC,id DESC
      );
    CREATE INDEX privacy_external_provider_export_retention_idx
      ON fractal.privacy_external_provider_exports(retain_until,id)
      WHERE status='staged';

    CREATE OR REPLACE FUNCTION fractal.validate_privacy_external_provider_export()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_request RECORD;
    DECLARE exact_application RECORD;
    DECLARE exact_policy RECORD;
    BEGIN
      SELECT requester_identity_id,request_type,status,assigned_to_identity_id
        INTO exact_request
        FROM fractal.privacy_rights_requests
       WHERE id=NEW.privacy_request_id;
      IF exact_request IS NULL
         OR exact_request.requester_identity_id<>NEW.requester_identity_id
         OR exact_request.request_type<>NEW.request_type
         OR exact_request.status<>'in_review'
         OR exact_request.assigned_to_identity_id<>NEW.uploaded_by_identity_id
         OR NEW.status<>'staged' THEN
        RAISE EXCEPTION 'provider export requires the assigned owner of an in-review privacy request';
      END IF;

      SELECT identity_id,provider,external_user_id,applicant_id,inspection_id,status
        INTO exact_application
        FROM fractal.provider_identity_verification_applications
       WHERE id=NEW.identity_verification_application_id;
      IF exact_application IS NULL
         OR exact_application.identity_id<>NEW.requester_identity_id
         OR exact_application.provider<>'sumsub'
         OR exact_application.status<>'ready'
         OR exact_application.external_user_id<>NEW.external_user_id
         OR exact_application.applicant_id<>NEW.applicant_id
         OR exact_application.inspection_id IS NULL
         OR exact_application.inspection_id<>NEW.inspection_id THEN
        RAISE EXCEPTION 'provider export requires the exact ready Sumsub correlation';
      END IF;

      SELECT version.version_number,version.value_sha256,version.proposed_value,
             active.projection_version
        INTO exact_policy
        FROM fractal.platform_configuration_active_versions active
        JOIN fractal.platform_configuration_versions version
          ON version.id=active.active_version_id AND version.status='active'
       WHERE active.configuration_key=NEW.package_policy_configuration_key
         AND version.id=NEW.package_policy_version_id;
      IF exact_policy IS NULL
         OR NEW.package_policy_version_number<>exact_policy.version_number
         OR NEW.package_policy_projection_version<>exact_policy.projection_version
         OR NEW.package_policy_value_sha256<>exact_policy.value_sha256
         OR exact_policy.proposed_value->>'schemaVersion'<>'privacy-package-policy-v2'
         OR exact_policy.proposed_value->>'canonicalFormat'
            <>'application/vnd.fractal.privacy-package+tar;version=2'
         OR (exact_policy.proposed_value->>'maximumArtifacts')::integer<1
         OR NEW.retain_until<>NEW.uploaded_at
            +(exact_policy.proposed_value->>'packageRetentionHours')::integer*interval '1 hour' THEN
        RAISE EXCEPTION 'provider export requires the exact active archive retention policy';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_external_provider_export_validate
      BEFORE INSERT ON fractal.privacy_external_provider_exports
      FOR EACH ROW
      EXECUTE FUNCTION fractal.validate_privacy_external_provider_export();

    CREATE OR REPLACE FUNCTION fractal.protect_privacy_external_provider_export()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN
        RAISE EXCEPTION 'provider export evidence is not deletable';
      END IF;
      IF NEW.id<>OLD.id
         OR NEW.reference<>OLD.reference
         OR NEW.privacy_request_id<>OLD.privacy_request_id
         OR NEW.requester_identity_id<>OLD.requester_identity_id
         OR NEW.request_type<>OLD.request_type
         OR NEW.source_key<>OLD.source_key
         OR NEW.identity_verification_application_id<>OLD.identity_verification_application_id
         OR NEW.applicant_id<>OLD.applicant_id
         OR NEW.external_user_id<>OLD.external_user_id
         OR NEW.inspection_id<>OLD.inspection_id
         OR NEW.report_reference<>OLD.report_reference
         OR NEW.entry_count<>OLD.entry_count
         OR NEW.sensitive_tier<>OLD.sensitive_tier
         OR NEW.generated_at<>OLD.generated_at
         OR NEW.downloaded_at<>OLD.downloaded_at
         OR NEW.content_sha256<>OLD.content_sha256
         OR NEW.byte_count<>OLD.byte_count
         OR NEW.settings_sha256<>OLD.settings_sha256
         OR NEW.scanner<>OLD.scanner
         OR NEW.scanned_at<>OLD.scanned_at
         OR NEW.malware_scan_evidence_sha256<>OLD.malware_scan_evidence_sha256
         OR NEW.storage_key<>OLD.storage_key
         OR NEW.package_policy_configuration_key<>OLD.package_policy_configuration_key
         OR NEW.package_policy_version_id<>OLD.package_policy_version_id
         OR NEW.package_policy_version_number<>OLD.package_policy_version_number
         OR NEW.package_policy_projection_version<>OLD.package_policy_projection_version
         OR NEW.package_policy_value_sha256<>OLD.package_policy_value_sha256
         OR NEW.command_key<>OLD.command_key
         OR NEW.uploaded_by_identity_id<>OLD.uploaded_by_identity_id
         OR NEW.uploaded_at<>OLD.uploaded_at
         OR NEW.retain_until<>OLD.retain_until
         OR (OLD.destroyed_at IS NOT NULL
             AND NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at) THEN
        RAISE EXCEPTION 'provider export origin and evidence are immutable';
      END IF;
      IF NOT (
        (OLD.status='staged' AND NEW.status='cleanup_requested')
        OR (OLD.status='cleanup_requested' AND NEW.status IN('destroyed','cleanup_failed'))
      ) THEN
        RAISE EXCEPTION 'invalid provider export transition';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_external_provider_export_guard
      BEFORE UPDATE OR DELETE ON fractal.privacy_external_provider_exports
      FOR EACH ROW
      EXECUTE FUNCTION fractal.protect_privacy_external_provider_export();

    ALTER TABLE fractal.storage_cleanup_tasks
      DROP CONSTRAINT storage_cleanup_tasks_purpose_check,
      DROP CONSTRAINT storage_cleanup_governed_purpose_shape,
      ADD COLUMN privacy_external_provider_export_id UUID UNIQUE
        REFERENCES fractal.privacy_external_provider_exports(id);
    ALTER TABLE fractal.storage_cleanup_tasks
      ADD CONSTRAINT storage_cleanup_tasks_purpose_check CHECK(
        purpose IN(
          'orphan_cleanup','governed_disposition','organization_document_disposition',
          'privacy_package_delivery','privacy_external_snapshot',
          'privacy_external_provider_export'
        )
      ),
      ADD CONSTRAINT storage_cleanup_governed_purpose_shape CHECK(
        (purpose='orphan_cleanup'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL
          AND privacy_external_provider_export_id IS NULL)
        OR
        (purpose='governed_disposition'
          AND governed_disposition_id IS NOT NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL
          AND privacy_external_provider_export_id IS NULL)
        OR
        (purpose='organization_document_disposition'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NOT NULL
          AND organization_document_version_id IS NOT NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL
          AND privacy_external_provider_export_id IS NULL)
        OR
        (purpose='privacy_package_delivery'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NOT NULL
          AND privacy_external_collection_snapshot_id IS NULL
          AND privacy_external_provider_export_id IS NULL)
        OR
        (purpose='privacy_external_snapshot'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NOT NULL
          AND privacy_external_provider_export_id IS NULL)
        OR
        (purpose='privacy_external_provider_export'
          AND governed_disposition_id IS NULL
          AND organization_document_disposition_id IS NULL
          AND organization_document_version_id IS NULL
          AND privacy_package_delivery_id IS NULL
          AND privacy_external_collection_snapshot_id IS NULL
          AND privacy_external_provider_export_id IS NOT NULL)
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
         OR NEW.organization_document_disposition_id
            IS DISTINCT FROM OLD.organization_document_disposition_id
         OR NEW.organization_document_version_id
            IS DISTINCT FROM OLD.organization_document_version_id
         OR NEW.privacy_package_delivery_id
            IS DISTINCT FROM OLD.privacy_package_delivery_id
         OR NEW.privacy_external_collection_snapshot_id
            IS DISTINCT FROM OLD.privacy_external_collection_snapshot_id
         OR NEW.privacy_external_provider_export_id
            IS DISTINCT FROM OLD.privacy_external_provider_export_id THEN
        RAISE EXCEPTION 'storage cleanup origin and subject linkage are immutable';
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.require_privacy_external_provider_export_cleanup()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IN('cleanup_requested','destroyed','cleanup_failed')
         AND NOT EXISTS(
           SELECT 1
             FROM fractal.storage_cleanup_tasks task
            WHERE task.privacy_external_provider_export_id=NEW.id
              AND task.storage_key=NEW.storage_key
         ) THEN
        RAISE EXCEPTION 'provider export cleanup state requires its exact durable cleanup task';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER privacy_external_provider_export_cleanup_required
      AFTER UPDATE ON fractal.privacy_external_provider_exports
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW
      EXECUTE FUNCTION fractal.require_privacy_external_provider_export_cleanup();

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(
      source_key,source_kind,source_locator,authority_key,contains_personal_data,
      subject_linkage,data_categories,inventory_status,access_status,portability_status,
      correction_status,erasure_status,restriction_status,objection_status,
      retention_policy_status,hold_coverage_status,blocker
    ) VALUES(
      'postgres.fractal.privacy_external_provider_exports',
      'postgres_relation',
      'fractal.privacy_external_provider_exports',
      'privacy_register',
      true,
      'direct_identity',
      ARRAY['provider_export_lifecycle_metadata'],
      'catalogued',
      'available',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'unavailable',
      'approved',
      'partial',
      'Access includes only export lifecycle, classification, size, and time metadata. Provider identifiers, report identifiers, storage locators, hashes, scan evidence, policy evidence, commands, and administrator identities are excluded. Portability and provider rights execution remain separately governed.'
    );
    CREATE TRIGGER privacy_data_sources_immutable
      BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW
      EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    UPDATE fractal.platform_configuration_definitions
       SET validation_schema='{"type":"object","required":["profileReference","profileName","schemaVersion","fieldCatalogVersion","jurisdictionCode","legalBasisReference","effectiveScope","access","portability"],"operationalValidator":"privacy_content_profile_v1_v2_v3_v4_v5_v6_v7_v8_v9_v10_v11_v12_v13_v14_v15_v16_v17_v18_v19_v20_v21_v22_v23_v24_v25_v26_v27_v28_v29_v30_v31_v32_v33_v34_v35_v36_v37_v38_v39_v40_v41_v42_v43_v44_v45"}'::jsonb
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
          AND content_profile_field_catalog_version
              ~ '^privacy-safe-fields-v([1-9]|[1-3][0-9]|4[0-5])$'
          AND content_profile_jurisdiction_code ~ '^[A-Z0-9-]{2,16}$'
          AND length(content_profile_legal_basis_reference) BETWEEN 10 AND 500
          AND content_profile_effective_scope
              ='authenticated_data_subject_access_and_portability'
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
      IF NEW.content_profile_field_catalog_version<>'privacy-safe-fields-v45' THEN
        RAISE EXCEPTION 'privacy package preparation requires an active v45 content profile after provider export staging activation';
      END IF;
      expected_rule_count:=CASE NEW.request_type WHEN 'access' THEN 142 ELSE 24 END;
      IF jsonb_typeof(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM 'array'
         OR jsonb_array_length(NEW.selected_content_profile->'sourceRules')
            IS DISTINCT FROM expected_rule_count THEN
        RAISE EXCEPTION 'privacy package preparation requires the exact right-specific collector rule count';
      END IF;
      RETURN NEW;
    END; $$;
  `,
};
