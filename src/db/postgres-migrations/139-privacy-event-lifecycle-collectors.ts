import type { PostgresMigration } from "./types.js";

/** Activates access-only event lifecycle collection after every retained event has an explicit classification. */
export const privacyEventLifecycleCollectorsMigration: PostgresMigration = {
  version: "139-privacy-event-lifecycle-collectors",
  sql: `
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM fractal.inbox_events WHERE privacy_classification='legacy_unresolved') THEN
        RAISE EXCEPTION 'privacy inbox collection requires classification of every retained legacy event';
      END IF;
      IF EXISTS (SELECT 1 FROM fractal.outbox_events WHERE privacy_classification='legacy_unresolved') THEN
        RAISE EXCEPTION 'privacy outbox collection requires classification of every retained legacy event';
      END IF;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.validate_event_privacy_attribution()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE canonical UUID[]; missing_count INTEGER;
    BEGIN
      IF NEW.privacy_classification='legacy_unresolved' THEN
        RAISE EXCEPTION 'new event writes require an explicit privacy classification';
      END IF;
      IF TG_OP='UPDATE' AND (
        NEW.privacy_classification IS DISTINCT FROM OLD.privacy_classification
        OR NEW.privacy_subject_identity_ids IS DISTINCT FROM OLD.privacy_subject_identity_ids
        OR NEW.privacy_attribution_basis IS DISTINCT FROM OLD.privacy_attribution_basis
      ) THEN RAISE EXCEPTION 'event privacy attribution is immutable'; END IF;
      SELECT COALESCE(array_agg(DISTINCT subject_id ORDER BY subject_id),'{}'::uuid[])
        INTO canonical FROM unnest(NEW.privacy_subject_identity_ids) subject_id;
      IF canonical IS DISTINCT FROM NEW.privacy_subject_identity_ids THEN
        RAISE EXCEPTION 'event privacy subject identities must be sorted and unique';
      END IF;
      SELECT count(*) INTO missing_count
        FROM unnest(NEW.privacy_subject_identity_ids) subject_id
        LEFT JOIN fractal.identities identity ON identity.id=subject_id
       WHERE identity.id IS NULL;
      IF missing_count<>0 THEN RAISE EXCEPTION 'event privacy attribution references an unknown identity'; END IF;
      RETURN NEW;
    END; $$;

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    UPDATE fractal.privacy_data_sources
       SET subject_linkage='provider_correlation',access_status='available',portability_status='unavailable',
           blocker='Access is limited to provider lifecycle state for events linked at immutable receipt through exact Paystack payment/transfer or Sumsub application relationships. Raw bodies, signatures, payloads, external event identifiers, hashes, retry/error/lease state, internal subject arrays, and unrelated events are excluded. Known-provider events without an internal identity remain explicitly external-subject-unlinked and require the separately governed external request channel. Portability and rights execution remain separately governed.'
     WHERE source_key='postgres.fractal.inbox_events';
    UPDATE fractal.privacy_data_sources
       SET subject_linkage='direct_identity',access_status='available',portability_status='unavailable',
           blocker='Access is limited to delivery lifecycle state and times for exact immutable audit-actor, authoritative-subject, or explicit-subject attribution. Event and aggregate types, aggregate identifiers, payloads, audit identifiers, subject arrays, retry/error/lease state, worker identifiers, and technical no-subject events are excluded. Migration fails closed while any retained legacy event is unresolved. Portability and rights execution remain separately governed.'
     WHERE source_key='postgres.fractal.outbox_events';
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    UPDATE fractal.platform_configuration_definitions
       SET validation_schema='{"type":"object","required":["profileReference","profileName","schemaVersion","fieldCatalogVersion","jurisdictionCode","legalBasisReference","effectiveScope","access","portability"],"operationalValidator":"privacy_content_profile_v1_v2_v3_v4_v5_v6_v7_v8_v9_v10_v11_v12_v13_v14_v15_v16_v17_v18_v19_v20_v21_v22_v23_v24_v25_v26_v27_v28_v29_v30_v31_v32_v33_v34_v35_v36_v37_v38_v39_v40_v41_v42_v43"}'::jsonb
     WHERE configuration_key='privacy.rights.content_profile';

    ALTER TABLE fractal.privacy_rights_package_preparations
      DROP CONSTRAINT privacy_package_content_profile_shape;
    ALTER TABLE fractal.privacy_rights_package_preparations
      ADD CONSTRAINT privacy_package_content_profile_shape CHECK (
        (content_profile_binding_status='legacy_unprofiled' AND content_profile_configuration_key IS NULL AND content_profile_version_id IS NULL AND content_profile_version_number IS NULL AND content_profile_projection_version IS NULL AND content_profile_value_sha256 IS NULL AND content_profile_reference IS NULL AND content_profile_name IS NULL AND content_profile_schema_version IS NULL AND content_profile_field_catalog_version IS NULL AND content_profile_jurisdiction_code IS NULL AND content_profile_legal_basis_reference IS NULL AND content_profile_effective_scope IS NULL AND selected_content_profile IS NULL)
        OR
        (content_profile_binding_status='governed' AND content_profile_configuration_key='privacy.rights.content_profile' AND content_profile_version_id IS NOT NULL AND content_profile_version_number>0 AND content_profile_projection_version>0 AND content_profile_value_sha256 ~ '^[0-9a-f]{64}$' AND length(content_profile_reference) BETWEEN 3 AND 120 AND length(content_profile_name) BETWEEN 10 AND 160 AND content_profile_schema_version='privacy-content-profile-v1' AND content_profile_field_catalog_version ~ '^privacy-safe-fields-v([1-9]|[1-3][0-9]|4[0-3])$' AND content_profile_jurisdiction_code ~ '^[A-Z0-9-]{2,16}$' AND length(content_profile_legal_basis_reference) BETWEEN 10 AND 500 AND content_profile_effective_scope='authenticated_data_subject_access_and_portability' AND jsonb_typeof(selected_content_profile)='object')
      );

    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_content_profile()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_profile RECORD; expected_rule_count INTEGER;
    BEGIN
      IF NEW.content_profile_binding_status<>'governed' THEN
        RAISE EXCEPTION 'new privacy package preparation requires a governed content profile';
      END IF;
      SELECT version.version_number,version.value_sha256,version.proposed_value,projection.projection_version
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
      IF NEW.content_profile_field_catalog_version<>'privacy-safe-fields-v43' THEN
        RAISE EXCEPTION 'privacy package preparation requires an active v43 content profile after event-lifecycle collector activation';
      END IF;
      expected_rule_count:=CASE NEW.request_type WHEN 'access' THEN 140 ELSE 24 END;
      IF jsonb_typeof(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM 'array'
         OR jsonb_array_length(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM expected_rule_count THEN
        RAISE EXCEPTION 'privacy package preparation requires the exact right-specific collector rule count';
      END IF;
      RETURN NEW;
    END; $$;
  `,
};
