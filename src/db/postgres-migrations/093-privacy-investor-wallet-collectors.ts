import type { PostgresMigration } from "./types.js";

/**
 * Adds identity-owned wallet-link history to access and bounded active/revoked
 * wallet facts to portability. Signature proofs, message hashes, challenge and
 * record identifiers, audit/outbox material, and chain activity stay excluded.
 */
export const privacyInvestorWalletCollectorsMigration: PostgresMigration = {
  version: "093-privacy-investor-wallet-collectors",
  sql: `
    UPDATE fractal.platform_configuration_definitions
       SET validation_schema='{"type":"object","required":["profileReference","profileName","schemaVersion","fieldCatalogVersion","jurisdictionCode","legalBasisReference","effectiveScope","access","portability"],"operationalValidator":"privacy_content_profile_v1_v2_v3_v4_v5_v6_v7_v8_v9_v10_v11"}'::jsonb
     WHERE configuration_key='privacy.rights.content_profile';

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    UPDATE fractal.privacy_data_sources
       SET subject_linkage='direct_identity',
           access_status='available',
           blocker='Canonical identity-owned wallet-link challenge metadata collection is implemented for access without message hashes, challenge identifiers, signature material, audit/outbox records, or chain activity; portability and all correction, restriction, objection, erasure, delivery, and approved-retention operations remain unavailable.'
     WHERE source_key='postgres.fractal.investor_wallet_link_challenges';
    UPDATE fractal.privacy_data_sources
       SET subject_linkage='direct_identity',
           access_status='available',
           portability_status='available',
           blocker='Canonical identity-owned linked-wallet facts are implemented for access and bounded portability without signature hashes, link-challenge identifiers, internal record identifiers, audit/outbox records, custody claims, balances, or chain activity; all correction, restriction, objection, erasure, delivery, and approved-retention operations remain unavailable.'
     WHERE source_key='postgres.fractal.investor_wallets';
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    ALTER TABLE fractal.privacy_rights_package_preparations
      DROP CONSTRAINT privacy_package_content_profile_shape,
      ADD CONSTRAINT privacy_package_content_profile_shape CHECK (
        (content_profile_binding_status='legacy_unprofiled'
          AND content_profile_configuration_key IS NULL AND content_profile_version_id IS NULL
          AND content_profile_version_number IS NULL AND content_profile_projection_version IS NULL
          AND content_profile_value_sha256 IS NULL AND content_profile_reference IS NULL
          AND content_profile_name IS NULL AND content_profile_schema_version IS NULL
          AND content_profile_field_catalog_version IS NULL AND content_profile_jurisdiction_code IS NULL
          AND content_profile_legal_basis_reference IS NULL AND content_profile_effective_scope IS NULL
          AND selected_content_profile IS NULL)
        OR
        (content_profile_binding_status='governed'
          AND content_profile_configuration_key IS NOT NULL AND content_profile_version_id IS NOT NULL
          AND content_profile_version_number IS NOT NULL AND content_profile_projection_version IS NOT NULL
          AND content_profile_value_sha256 IS NOT NULL AND content_profile_reference IS NOT NULL
          AND content_profile_name IS NOT NULL AND content_profile_schema_version IS NOT NULL
          AND content_profile_field_catalog_version IS NOT NULL AND content_profile_jurisdiction_code IS NOT NULL
          AND content_profile_legal_basis_reference IS NOT NULL AND content_profile_effective_scope IS NOT NULL
          AND selected_content_profile IS NOT NULL
          AND content_profile_configuration_key='privacy.rights.content_profile'
          AND content_profile_version_number>0
          AND content_profile_projection_version>0
          AND content_profile_value_sha256 ~ '^[0-9a-f]{64}$'
          AND length(content_profile_reference) BETWEEN 3 AND 120
          AND length(content_profile_name) BETWEEN 10 AND 160
          AND content_profile_schema_version='privacy-content-profile-v1'
          AND content_profile_field_catalog_version IN ('privacy-safe-fields-v1','privacy-safe-fields-v2','privacy-safe-fields-v3','privacy-safe-fields-v4','privacy-safe-fields-v5','privacy-safe-fields-v6','privacy-safe-fields-v7','privacy-safe-fields-v8','privacy-safe-fields-v9','privacy-safe-fields-v10','privacy-safe-fields-v11')
          AND content_profile_jurisdiction_code ~ '^[A-Z0-9-]{2,16}$'
          AND length(content_profile_legal_basis_reference) BETWEEN 10 AND 500
          AND content_profile_effective_scope='authenticated_data_subject_access_and_portability'
          AND jsonb_typeof(selected_content_profile)='object')
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
         OR NEW.selected_content_profile IS DISTINCT FROM exact_profile.proposed_value->NEW.request_type
      THEN RAISE EXCEPTION 'privacy package preparation requires the exact active approved content profile'; END IF;

      IF NEW.content_profile_field_catalog_version<>'privacy-safe-fields-v11' THEN
        RAISE EXCEPTION 'privacy package preparation requires an active v11 content profile after investor-wallet collector activation';
      END IF;
      expected_rule_count := CASE NEW.request_type WHEN 'access' THEN 37 ELSE 11 END;
      IF jsonb_typeof(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'privacy package preparation requires right-specific collector rules';
      END IF;
      IF jsonb_array_length(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM expected_rule_count THEN
        RAISE EXCEPTION 'privacy package preparation requires the exact right-specific collector rule count';
      END IF;
      RETURN NEW;
    END; $$;
  `,
};
