import type { PostgresMigration } from "./types.js";

/** Permit a proved empty external result without weakening snapshot integrity. */
export const privacyExternalZeroRecordSnapshotsMigration: PostgresMigration = {
  version: "144-privacy-external-zero-record-snapshots",
  sql: `
    ALTER TABLE fractal.privacy_external_collection_snapshots
      DROP CONSTRAINT privacy_external_collection_snapshots_record_count_check,
      ADD CONSTRAINT privacy_external_collection_snapshots_record_count_check
        CHECK(record_count IS NULL OR record_count BETWEEN 0 AND 100000);

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
         OR NOT (
           exact_source_policy->'rights'->NEW.request_type->>'mode'='collect'
           OR (
             NEW.source_key='external.chain.public_records'
             AND NEW.request_type='access'
             AND exact_source_policy->>'collectionMode'='public_immutable_disclosure'
             AND exact_source_policy->'rights'->'access'->>'mode'='immutable_disclosure'
           )
         ) THEN
        RAISE EXCEPTION 'external snapshot requires the exact governed operation for the request right';
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
           OR item->>'recordCount' !~ '^(0|[1-9][0-9]*)$'
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
  `,
};
