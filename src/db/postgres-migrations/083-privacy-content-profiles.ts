import type { PostgresMigration } from "./types.js";

/**
 * Binds every new privacy collection preparation to an exact, independently
 * approved field-level access/portability content profile. Existing CP082
 * evidence remains explicitly legacy and permanently non-deliverable.
 */
export const privacyContentProfilesMigration: PostgresMigration = {
  version: "083-privacy-content-profiles",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding,status)
    VALUES (
      'privacy.rights.content_profile',
      'Privacy rights content profile',
      'Approved canonical field inclusion and reasoned exclusion rules, separately defined for authenticated access and portability preparation.',
      'json',
      '{"type":"object","required":["profileReference","profileName","schemaVersion","fieldCatalogVersion","jurisdictionCode","legalBasisReference","effectiveScope","access","portability"],"operationalValidator":"privacy_content_profile_v1"}'::jsonb,
      'next_request',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE
      SET label=EXCLUDED.label,description=EXCLUDED.description,value_type=EXCLUDED.value_type,
          validation_schema=EXCLUDED.validation_schema,consumer_binding=EXCLUDED.consumer_binding,status='active';

    ALTER TABLE fractal.privacy_rights_package_preparations
      ADD COLUMN content_profile_binding_status TEXT NOT NULL DEFAULT 'legacy_unprofiled'
        CHECK (content_profile_binding_status IN ('legacy_unprofiled','governed')),
      ADD COLUMN content_profile_configuration_key TEXT,
      ADD COLUMN content_profile_version_id UUID,
      ADD COLUMN content_profile_version_number INTEGER,
      ADD COLUMN content_profile_projection_version INTEGER,
      ADD COLUMN content_profile_value_sha256 CHAR(64),
      ADD COLUMN content_profile_reference TEXT,
      ADD COLUMN content_profile_name TEXT,
      ADD COLUMN content_profile_schema_version TEXT,
      ADD COLUMN content_profile_field_catalog_version TEXT,
      ADD COLUMN content_profile_jurisdiction_code TEXT,
      ADD COLUMN content_profile_legal_basis_reference TEXT,
      ADD COLUMN content_profile_effective_scope TEXT,
      ADD COLUMN selected_content_profile JSONB,
      ADD CONSTRAINT privacy_package_content_profile_exact_version
        FOREIGN KEY (content_profile_configuration_key,content_profile_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
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
          AND content_profile_field_catalog_version='privacy-safe-fields-v1'
          AND content_profile_jurisdiction_code ~ '^[A-Z0-9-]{2,16}$'
          AND length(content_profile_legal_basis_reference) BETWEEN 10 AND 500
          AND content_profile_effective_scope='authenticated_data_subject_access_and_portability'
          AND jsonb_typeof(selected_content_profile)='object')
      );

    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_content_profile()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_profile RECORD;
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
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_package_content_profile_exact ON fractal.privacy_rights_package_preparations;
    CREATE TRIGGER privacy_package_content_profile_exact
      BEFORE INSERT ON fractal.privacy_rights_package_preparations
      FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_privacy_content_profile();
  `,
};
