import type { PostgresMigration } from "./types.js";

/** Bind one staged Sumsub export and its artifacts to the external snapshot. */
export const sumsubPrivacySnapshotArtifactsMigration: PostgresMigration = {
  version: "148-sumsub-privacy-snapshot-artifacts",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.valid_privacy_external_snapshot_artifacts(
      value JSONB
    ) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value)<>'array'
         OR jsonb_array_length(value)<1
         OR jsonb_array_length(value)>1000 THEN
        RETURN FALSE;
      END IF;
      RETURN NOT EXISTS(
        SELECT 1
          FROM jsonb_array_elements(value) item
         WHERE jsonb_typeof(item)<>'object'
            OR (SELECT count(*) FROM jsonb_object_keys(item))<>6
            OR (item->>'sourceKey')<>'external.identity_verification.provider'
            OR (item->>'componentKey') NOT IN(
              'identity_documents','biometric_media','provider_export_artifacts'
            )
            OR (item->>'mediaType') NOT IN(
              'application/json','application/octet-stream','application/pdf',
              'application/zip','image/gif','image/jpeg','image/png','image/tiff',
              'image/webp','text/csv','video/mp4','video/webm'
            )
            OR (item->>'sha256') !~ '^[0-9a-f]{64}$'
            OR (item->>'byteCount') !~ '^[1-9][0-9]*$'
            OR (item->>'byteCount')::numeric>104857600
            OR (item->>'path')<>(
              'artifacts/' || (item->>'sha256') || '.' ||
              CASE (item->>'mediaType')
                WHEN 'application/json' THEN 'json'
                WHEN 'application/octet-stream' THEN 'bin'
                WHEN 'application/pdf' THEN 'pdf'
                WHEN 'application/zip' THEN 'zip'
                WHEN 'image/gif' THEN 'gif'
                WHEN 'image/jpeg' THEN 'jpg'
                WHEN 'image/png' THEN 'png'
                WHEN 'image/tiff' THEN 'tiff'
                WHEN 'image/webp' THEN 'webp'
                WHEN 'text/csv' THEN 'csv'
                WHEN 'video/mp4' THEN 'mp4'
                WHEN 'video/webm' THEN 'webm'
              END
            )
      ) AND (
        SELECT count(*)=count(DISTINCT
          (item->>'sourceKey') || chr(31) || (item->>'componentKey')
            || chr(31) || (item->>'sha256')
        ) FROM jsonb_array_elements(value) item
      ) AND (
        SELECT count(*)=1
          FROM jsonb_array_elements(value) item
         WHERE (item->>'componentKey')='provider_export_artifacts'
           AND (item->>'mediaType')='application/zip'
      );
    END; $$;

    ALTER TABLE fractal.privacy_external_collection_snapshots
      ADD COLUMN provider_export_id UUID
        REFERENCES fractal.privacy_external_provider_exports(id) ON DELETE RESTRICT,
      ADD COLUMN canonical_format TEXT NOT NULL DEFAULT
        'application/vnd.fractal.privacy-external-snapshot+json;version=1',
      ADD COLUMN artifact_count INTEGER NOT NULL DEFAULT 0
        CHECK(artifact_count BETWEEN 0 AND 1000),
      ADD COLUMN artifact_manifest JSONB NOT NULL DEFAULT '[]'::jsonb
        CHECK(jsonb_typeof(artifact_manifest)='array'),
      ADD CONSTRAINT privacy_external_snapshot_provider_export_shape CHECK(
        (
          source_key='external.identity_verification.provider'
          AND provider_export_id IS NOT NULL
        ) OR (
          source_key<>'external.identity_verification.provider'
          AND provider_export_id IS NULL
        )
      ) NOT VALID,
      ADD CONSTRAINT privacy_external_snapshot_archive_shape CHECK(
        (
          canonical_format=
            'application/vnd.fractal.privacy-external-snapshot+json;version=1'
          AND artifact_count=0
          AND artifact_manifest='[]'::jsonb
        ) OR (
          source_key='external.identity_verification.provider'
          AND canonical_format=
            'application/vnd.fractal.privacy-external-snapshot+tar;version=2'
          AND artifact_count=jsonb_array_length(artifact_manifest)
          AND fractal.valid_privacy_external_snapshot_artifacts(artifact_manifest)
        )
      ),
      ADD CONSTRAINT privacy_external_snapshot_available_archive_shape CHECK(
        source_key<>'external.identity_verification.provider'
        OR status NOT IN(
          'available','expired','cleanup_requested','destroyed','cleanup_failed'
        )
        OR (
          canonical_format=
            'application/vnd.fractal.privacy-external-snapshot+tar;version=2'
          AND artifact_count>0
        )
      ) NOT VALID;
    CREATE UNIQUE INDEX privacy_external_snapshot_active_provider_export_idx
      ON fractal.privacy_external_collection_snapshots(provider_export_id)
      WHERE provider_export_id IS NOT NULL AND status<>'failed';

    CREATE OR REPLACE FUNCTION fractal.validate_sumsub_privacy_snapshot_export()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_export RECORD;
    BEGIN
      IF NEW.source_key<>'external.identity_verification.provider' THEN
        IF NEW.provider_export_id IS NOT NULL THEN
          RAISE EXCEPTION 'only the Sumsub snapshot can bind a provider export';
        END IF;
        RETURN NEW;
      END IF;
      SELECT privacy_request_id,requester_identity_id,request_type,source_key,
             status,retain_until
        INTO exact_export
        FROM fractal.privacy_external_provider_exports
       WHERE id=NEW.provider_export_id;
      IF exact_export IS NULL
         OR exact_export.privacy_request_id<>NEW.privacy_request_id
         OR exact_export.requester_identity_id<>NEW.requester_identity_id
         OR exact_export.request_type<>NEW.request_type
         OR exact_export.source_key<>NEW.source_key
         OR exact_export.status<>'staged'
         OR exact_export.retain_until<=NEW.requested_at THEN
        RAISE EXCEPTION 'Sumsub snapshot requires the exact current staged provider export';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_external_snapshot_sumsub_export_validate
      BEFORE INSERT ON fractal.privacy_external_collection_snapshots
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_sumsub_privacy_snapshot_export();

    CREATE OR REPLACE FUNCTION fractal.protect_privacy_external_snapshot_archive()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE archive_changed BOOLEAN;
    BEGIN
      IF NEW.provider_export_id IS DISTINCT FROM OLD.provider_export_id THEN
        RAISE EXCEPTION 'external snapshot provider-export binding is immutable';
      END IF;
      archive_changed :=
        NEW.canonical_format IS DISTINCT FROM OLD.canonical_format
        OR NEW.artifact_count IS DISTINCT FROM OLD.artifact_count
        OR NEW.artifact_manifest IS DISTINCT FROM OLD.artifact_manifest;
      IF archive_changed AND NOT (
        OLD.status='collecting'
        AND NEW.status='available'
        AND OLD.canonical_format=
          'application/vnd.fractal.privacy-external-snapshot+json;version=1'
        AND OLD.artifact_count=0
        AND OLD.artifact_manifest='[]'::jsonb
      ) THEN
        RAISE EXCEPTION 'external snapshot archive evidence is immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_external_snapshot_archive_guard
      BEFORE UPDATE ON fractal.privacy_external_collection_snapshots
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_privacy_external_snapshot_archive();

    CREATE OR REPLACE FUNCTION fractal.require_sumsub_snapshot_export_cleanup()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.source_key='external.identity_verification.provider'
         AND NEW.status='available'
         AND NOT EXISTS(
           SELECT 1
             FROM fractal.privacy_external_provider_exports provider_export
             JOIN fractal.storage_cleanup_tasks task
               ON task.privacy_external_provider_export_id=provider_export.id
              AND task.storage_key=provider_export.storage_key
            WHERE provider_export.id=NEW.provider_export_id
              AND provider_export.status='cleanup_requested'
         ) THEN
        RAISE EXCEPTION 'available Sumsub snapshot requires staged-export cleanup';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER privacy_external_snapshot_sumsub_cleanup_required
      AFTER UPDATE ON fractal.privacy_external_collection_snapshots
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_sumsub_snapshot_export_cleanup();
  `,
};
