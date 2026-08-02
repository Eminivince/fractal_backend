import type { PostgresMigration } from "./types.js";

/** Require exact component coverage before a new external snapshot can exist. */
export const privacyExternalComponentCoverageMigration: PostgresMigration = {
  version: "145-privacy-external-component-coverage",
  sql: `
    UPDATE fractal.platform_configuration_definitions
       SET description='Exact versioned contract for all declared external privacy sources, including a complete source-component inventory, implementation binding, correlation, field minimization, rights operations, execution bounds, residency, retention, processor, and fail-closed requirements. Activation is not live-provider attestation and does not change source availability.',
           validation_schema='{"type":"object","required":["schemaVersion","policyReference","policyName","jurisdictionCode","controllerReference","sources"],"operationalValidator":"privacy_external_source_adapter_policy_v2","exactExternalSourceCount":11,"requiresExactComponentCoverage":true,"coverageInventoryVersion":"privacy-external-coverage-v1","requiresSeparateLiveAttestation":true}'::jsonb
     WHERE configuration_key='privacy.external_source.adapter_policy';

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_external_source_coverage(
      p_source_key TEXT,
      p_coverage JSONB
    ) RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    DECLARE components JSONB;
    BEGIN
      IF jsonb_typeof(p_coverage)<>'object'
         OR (SELECT count(*) FROM jsonb_object_keys(p_coverage))<>2
         OR p_coverage->>'inventoryVersion'<>'privacy-external-coverage-v1'
         OR jsonb_typeof(p_coverage->'componentKeys')<>'array' THEN
        RETURN FALSE;
      END IF;
      components:=p_coverage->'componentKeys';
      RETURN CASE p_source_key
        WHEN 'external.chain.public_records' THEN components='[
          "verified_wallet_links",
          "allocation_chain_transactions",
          "approved_ownership_snapshots"
        ]'::jsonb
        WHEN 'external.edge.access_logs' THEN components='[
          "dns_query_logs",
          "cdn_request_logs",
          "proxy_request_logs",
          "firewall_security_events",
          "hosting_access_logs"
        ]'::jsonb
        WHEN 'external.identity_verification.provider' THEN components='[
          "applicant_profile",
          "review_results",
          "identity_documents",
          "biometric_media",
          "questionnaire_and_consent",
          "device_and_network_metadata",
          "screening_and_watchlist_results",
          "provider_export_artifacts"
        ]'::jsonb
        WHEN 'external.malware_scan.provider' THEN components='[
          "scan_request_metadata",
          "scanner_result_metadata",
          "scanner_service_logs",
          "transient_content_handling"
        ]'::jsonb
        WHEN 'external.mongo.legacy_identity_projection' THEN components='[
          "legacy_identity_documents",
          "legacy_investor_profiles",
          "legacy_auth_and_verification_fields",
          "legacy_audit_and_event_links"
        ]'::jsonb
        WHEN 'external.object_store.managed' THEN components='[
          "current_objects",
          "historical_object_versions",
          "delete_markers",
          "object_lock_and_legal_hold",
          "replication_and_backup_copies",
          "provider_inventory_and_destruction_evidence"
        ]'::jsonb
        WHEN 'external.payment.provider' THEN components='[
          "checkout_customers",
          "payment_transactions",
          "refunds_and_reversals",
          "transfer_recipients",
          "outbound_transfers",
          "disputes_and_chargebacks",
          "settlements_and_reconciliation",
          "provider_events"
        ]'::jsonb
        WHEN 'external.postgres.backups' THEN components='[
          "base_backups",
          "write_ahead_logs",
          "snapshots",
          "replicas",
          "restore_artifacts",
          "provider_retention_and_destruction_evidence"
        ]'::jsonb
        WHEN 'external.redis.operational_cache' THEN components='[
          "sessions_and_presence",
          "rate_limit_keys",
          "worker_leases_and_queues",
          "application_cache",
          "replicas_and_persistence",
          "provider_expiry_and_deletion_evidence"
        ]'::jsonb
        WHEN 'external.resend.delivery' THEN components='[
          "authentication_delivery",
          "support_notification_delivery",
          "accepted_invitation_delivery"
        ]'::jsonb
        WHEN 'external.telemetry.logs' THEN components='[
          "application_logs",
          "error_events",
          "distributed_traces",
          "metrics_and_labels",
          "audit_log_exports",
          "provider_archives"
        ]'::jsonb
        ELSE FALSE
      END;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.require_privacy_external_snapshot_component_coverage()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT fractal.valid_privacy_external_source_coverage(
           NEW.source_key,
           NEW.source_policy->'coverage'
         )
         OR NEW.source_attestation->'payload'->>'schemaVersion'
            <>'privacy-external-source-attestation-payload-v2'
         OR NEW.source_attestation->'payload'->'coverage'
            IS DISTINCT FROM NEW.source_policy->'coverage' THEN
        RAISE EXCEPTION 'external snapshot requires exact policy, runtime, and attestation component coverage';
      END IF;
      RETURN NEW;
    END; $$;

    DROP TRIGGER IF EXISTS privacy_external_snapshot_component_coverage
      ON fractal.privacy_external_collection_snapshots;
    CREATE TRIGGER privacy_external_snapshot_component_coverage
      BEFORE INSERT ON fractal.privacy_external_collection_snapshots
      FOR EACH ROW
      EXECUTE FUNCTION fractal.require_privacy_external_snapshot_component_coverage();
  `,
};
