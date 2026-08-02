import type { PostgresMigration } from "./types.js";

/** Add a governed deterministic archive format for binary privacy evidence. */
export const privacyPackageArchiveFormatMigration: PostgresMigration = {
  version: "146-privacy-package-archive-format",
  sql: `
    UPDATE fractal.platform_configuration_definitions
       SET description='Exact privacy package policy for authenticated delivery. Version 1 permits canonical JSON only. Version 2 permits a deterministic TAR archive with a bounded binary-artifact manifest.',
           validation_schema='{"type":"object","required":["policyReference","policyName","canonicalFormat","identityAssurance","deliveryChannel","allowInternalIncompletePreparation","maximumRecords","maximumBytes","packageRetentionHours","requesterRetrievalHours"],"operationalValidator":"privacy_package_policy_v2","supportedCanonicalFormats":["application/vnd.fractal.privacy-package+json;version=1","application/vnd.fractal.privacy-package+tar;version=2"],"archiveSchemaVersion":"privacy-package-policy-v2","maximumArchiveArtifacts":1000}'::jsonb
     WHERE configuration_key='privacy.rights.package_policy';

    ALTER TABLE fractal.privacy_rights_package_preparations
      DROP CONSTRAINT privacy_rights_package_preparations_canonical_format_check;
    ALTER TABLE fractal.privacy_rights_package_preparations
      ADD CONSTRAINT privacy_rights_package_preparations_canonical_format_check
      CHECK(canonical_format IN(
        'application/vnd.fractal.privacy-package+json;version=1',
        'application/vnd.fractal.privacy-package+tar;version=2'
      )),
      ADD COLUMN maximum_artifacts INTEGER NOT NULL DEFAULT 0
        CHECK(maximum_artifacts BETWEEN 0 AND 1000);

    ALTER TABLE fractal.privacy_rights_package_deliveries
      DROP CONSTRAINT privacy_rights_package_deliveries_canonical_format_check;
    ALTER TABLE fractal.privacy_rights_package_deliveries
      ADD CONSTRAINT privacy_rights_package_deliveries_canonical_format_check
      CHECK(canonical_format IN(
        'application/vnd.fractal.privacy-package+json;version=1',
        'application/vnd.fractal.privacy-package+tar;version=2'
      ));

    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_package_archive_policy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_policy JSONB;
    BEGIN
      SELECT version.proposed_value INTO exact_policy
        FROM fractal.platform_configuration_active_versions active
        JOIN fractal.platform_configuration_versions version
          ON version.id=active.active_version_id
         AND version.status='active'
       WHERE active.configuration_key=NEW.configuration_key
         AND version.id=NEW.policy_version_id;
      IF exact_policy IS NULL THEN
        RAISE EXCEPTION 'privacy package archive policy requires the exact active policy';
      END IF;
      IF NEW.canonical_format='application/vnd.fractal.privacy-package+json;version=1' THEN
        IF NEW.maximum_artifacts<>0
           OR exact_policy ? 'schemaVersion'
           OR exact_policy ? 'maximumArtifacts' THEN
          RAISE EXCEPTION 'privacy package JSON version 1 cannot bind archive fields';
        END IF;
      ELSIF NEW.canonical_format='application/vnd.fractal.privacy-package+tar;version=2' THEN
        IF exact_policy->>'schemaVersion' IS DISTINCT FROM 'privacy-package-policy-v2'
           OR NOT (exact_policy ? 'maximumArtifacts')
           OR jsonb_typeof(exact_policy->'maximumArtifacts') IS DISTINCT FROM 'number'
           OR NEW.maximum_artifacts IS DISTINCT FROM
              (exact_policy->>'maximumArtifacts')::integer THEN
          RAISE EXCEPTION 'privacy package archive requires the exact version 2 artifact limit';
        END IF;
      ELSE
        RAISE EXCEPTION 'privacy package format is not supported';
      END IF;
      RETURN NEW;
    END; $$;

    DROP TRIGGER IF EXISTS privacy_package_archive_policy_exact
      ON fractal.privacy_rights_package_preparations;
    CREATE TRIGGER privacy_package_archive_policy_exact
      BEFORE INSERT ON fractal.privacy_rights_package_preparations
      FOR EACH ROW
      EXECUTE FUNCTION fractal.require_exact_privacy_package_archive_policy();
  `,
};
