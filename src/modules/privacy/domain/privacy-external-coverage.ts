import type { ExternalPrivacySourceKey } from "./privacy-external-adapter-policy.js";

export const EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION =
  "privacy-external-coverage-v1" as const;

export const externalPrivacyRequiredCoverage = {
  "external.chain.public_records": [
    "verified_wallet_links",
    "allocation_chain_transactions",
    "approved_ownership_snapshots",
  ],
  "external.edge.access_logs": [
    "dns_query_logs",
    "cdn_request_logs",
    "proxy_request_logs",
    "firewall_security_events",
    "hosting_access_logs",
  ],
  "external.identity_verification.provider": [
    "applicant_profile",
    "review_results",
    "identity_documents",
    "biometric_media",
    "questionnaire_and_consent",
    "device_and_network_metadata",
    "screening_and_watchlist_results",
    "provider_export_artifacts",
  ],
  "external.malware_scan.provider": [
    "scan_request_metadata",
    "scanner_result_metadata",
    "scanner_service_logs",
    "transient_content_handling",
  ],
  "external.mongo.legacy_identity_projection": [
    "legacy_identity_documents",
    "legacy_investor_profiles",
    "legacy_auth_and_verification_fields",
    "legacy_audit_and_event_links",
  ],
  "external.object_store.managed": [
    "current_objects",
    "historical_object_versions",
    "delete_markers",
    "object_lock_and_legal_hold",
    "replication_and_backup_copies",
    "provider_inventory_and_destruction_evidence",
  ],
  "external.payment.provider": [
    "checkout_customers",
    "payment_transactions",
    "refunds_and_reversals",
    "transfer_recipients",
    "outbound_transfers",
    "disputes_and_chargebacks",
    "settlements_and_reconciliation",
    "provider_events",
  ],
  "external.postgres.backups": [
    "base_backups",
    "write_ahead_logs",
    "snapshots",
    "replicas",
    "restore_artifacts",
    "provider_retention_and_destruction_evidence",
  ],
  "external.redis.operational_cache": [
    "sessions_and_presence",
    "rate_limit_keys",
    "worker_leases_and_queues",
    "application_cache",
    "replicas_and_persistence",
    "provider_expiry_and_deletion_evidence",
  ],
  "external.resend.delivery": [
    "authentication_delivery",
    "support_notification_delivery",
    "accepted_invitation_delivery",
  ],
  "external.telemetry.logs": [
    "application_logs",
    "error_events",
    "distributed_traces",
    "metrics_and_labels",
    "audit_log_exports",
    "provider_archives",
  ],
} as const satisfies Record<ExternalPrivacySourceKey, readonly string[]>;

export type ExternalPrivacyCoverage = {
  inventoryVersion: typeof EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION;
  componentKeys: string[];
};

export function requiredExternalPrivacyCoverage(
  sourceKey: ExternalPrivacySourceKey,
): ExternalPrivacyCoverage {
  return {
    inventoryVersion: EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
    componentKeys: [...externalPrivacyRequiredCoverage[sourceKey]],
  };
}
