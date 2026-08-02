import { z } from "zod";

export const privacyContentProfileV1SourceKeys = [
  "postgres.fractal.identities",
  "postgres.fractal.identity_role_assignments",
  "postgres.fractal.auth_sessions",
  "postgres.fractal.legal_document_acceptances",
  "postgres.fractal.privacy_rights_requests",
  "postgres.fractal.privacy_rights_policy_bindings",
  "postgres.fractal.privacy_rights_request_events",
  "postgres.fractal.privacy_rights_decision_requests",
] as const;

const privacyContentProfileV2AccessOnlySourceKeys = [
  "postgres.fractal.auth_email_deliveries",
  "postgres.fractal.auth_step_up_grants",
  "postgres.fractal.security_notifications",
  "postgres.fractal.totp_factors",
  "postgres.fractal.totp_recovery_codes",
] as const;

export const privacyContentProfileV2SourceKeys = [
  ...privacyContentProfileV1SourceKeys,
  ...privacyContentProfileV2AccessOnlySourceKeys,
] as const;

const privacyContentProfileV3AccessOnlySourceKeys = [
  "postgres.fractal.identity_access_change_requests",
  "postgres.fractal.administrator_capability_assignments",
  "postgres.fractal.administrator_capability_change_requests",
  "postgres.fractal.administrator_recovery_requests",
  "postgres.fractal.administrator_audit_exports",
] as const;

export const privacyContentProfileV3SourceKeys = [
  ...privacyContentProfileV2SourceKeys,
  ...privacyContentProfileV3AccessOnlySourceKeys,
] as const;

const privacyContentProfileV4AccessOnlySourceKeys = [
  "postgres.fractal.provider_identity_verification_applications",
  "postgres.fractal.provider_identity_verification_events",
] as const;

export const privacyContentProfileV4SourceKeys = [
  ...privacyContentProfileV3SourceKeys,
  ...privacyContentProfileV4AccessOnlySourceKeys,
] as const;

const privacyContentProfileV5LegalConsentSourceKeys = [
  "postgres.fractal.agreement_acceptances",
  "postgres.fractal.platform_content_events",
  "postgres.fractal.platform_content_publications",
  "postgres.fractal.platform_content_versions",
] as const;

export const privacyContentProfileV5SourceKeys = [
  ...privacyContentProfileV4SourceKeys,
  ...privacyContentProfileV5LegalConsentSourceKeys,
] as const;

const privacyContentProfileV5PortabilitySourceKeys = [
  ...privacyContentProfileV1SourceKeys,
  "postgres.fractal.agreement_acceptances",
] as const;

const privacyContentProfileV6AccessOnlySourceKeys = [
  "postgres.fractal.privacy_rights_package_preparations",
] as const;

export const privacyContentProfileV6SourceKeys = [
  ...privacyContentProfileV5SourceKeys,
  ...privacyContentProfileV6AccessOnlySourceKeys,
] as const;

const privacyContentProfileV7AccessOnlySourceKeys = [
  "postgres.fractal.platform_configuration_activation_attempts",
  "postgres.fractal.platform_configuration_active_versions",
  "postgres.fractal.platform_configuration_events",
  "postgres.fractal.platform_configuration_versions",
] as const;

export const privacyContentProfileV7SourceKeys = [
  ...privacyContentProfileV6SourceKeys,
  ...privacyContentProfileV7AccessOnlySourceKeys,
] as const;

const privacyContentProfileV8AccessOnlySourceKeys = [
  "postgres.fractal.administrator_provider_incident_events",
  "postgres.fractal.administrator_provider_incidents",
] as const;

export const privacyContentProfileV8SourceKeys = [
  ...privacyContentProfileV7SourceKeys,
  ...privacyContentProfileV8AccessOnlySourceKeys,
] as const;

const privacyContentProfileV9AccessOnlySourceKeys = [
  "postgres.fractal.support_case_events",
] as const;

const privacyContentProfileV9AccessAndPortabilitySourceKeys = [
  "postgres.fractal.support_cases",
] as const;

const privacyContentProfileV9PortabilitySourceKeys = [
  ...privacyContentProfileV5PortabilitySourceKeys,
  ...privacyContentProfileV9AccessAndPortabilitySourceKeys,
] as const;

export const privacyContentProfileV9SourceKeys = [
  ...privacyContentProfileV8SourceKeys,
  ...privacyContentProfileV9AccessOnlySourceKeys,
  ...privacyContentProfileV9AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV10AccessOnlySourceKeys = [
  "postgres.fractal.support_case_attachment_access_events",
  "postgres.fractal.support_case_attachments",
] as const;

export const privacyContentProfileV10SourceKeys = [
  ...privacyContentProfileV9SourceKeys,
  ...privacyContentProfileV10AccessOnlySourceKeys,
] as const;

const privacyContentProfileV11AccessOnlySourceKeys = [
  "postgres.fractal.investor_wallet_link_challenges",
] as const;

const privacyContentProfileV11AccessAndPortabilitySourceKeys = [
  "postgres.fractal.investor_wallets",
] as const;

const privacyContentProfileV11PortabilitySourceKeys = [
  ...privacyContentProfileV9PortabilitySourceKeys,
  ...privacyContentProfileV11AccessAndPortabilitySourceKeys,
] as const;

export const privacyContentProfileV11SourceKeys = [
  ...privacyContentProfileV10SourceKeys,
  ...privacyContentProfileV11AccessOnlySourceKeys,
  ...privacyContentProfileV11AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV12AccessOnlySourceKeys = [
  "postgres.fractal.investor_compliance_profile_reviews",
  "postgres.fractal.investor_compliance_profiles",
  "postgres.fractal.investor_compliance_review_requests",
] as const;

const privacyContentProfileV13AccessOnlySourceKeys = [
  "postgres.fractal.investment_eligibility_snapshots",
  "postgres.fractal.investment_commitments",
] as const;

const privacyContentProfileV13AccessAndPortabilitySourceKeys = [
  "postgres.fractal.investment_reservations",
] as const;

const privacyContentProfileV14AccessOnlySourceKeys = [
  "postgres.fractal.investment_allocation_requests",
  "postgres.fractal.investment_allocation_chain_operations",
  "postgres.fractal.investment_allocation_chain_dispatch_claims",
] as const;

const privacyContentProfileV15AccessOnlySourceKeys = [
  "postgres.fractal.payment_intents",
  "postgres.fractal.payment_provider_instructions",
  "postgres.fractal.payment_receipts",
  "postgres.fractal.payment_reconciliation_cases",
] as const;

const privacyContentProfileV16AccessOnlySourceKeys = [
  "postgres.fractal.journal_entries",
  "postgres.fractal.journal_postings",
] as const;

const privacyContentProfileV17AccessOnlySourceKeys = [
  "postgres.fractal.support_case_service_obligations",
  "postgres.fractal.support_case_service_events",
  "postgres.fractal.support_case_notification_deliveries",
  "postgres.fractal.data_legal_hold_change_requests",
  "postgres.fractal.data_legal_holds",
] as const;

const privacyContentProfileV18AccessOnlySourceKeys = [
  "postgres.fractal.organizations",
  "postgres.fractal.organization_memberships",
  "postgres.fractal.organization_invitations",
  "postgres.fractal.organization_ownership_transfer_requests",
] as const;

const privacyContentProfileV19AccessAndPortabilitySourceKeys = [
  "postgres.fractal.organization_verification_requests",
] as const;

const privacyContentProfileV19AccessOnlySourceKeys = [
  "postgres.fractal.organization_verification_evidence_documents",
  "postgres.fractal.organization_verification_request_evidence",
] as const;

const privacyContentProfileV20AccessAndPortabilitySourceKeys = [
  "postgres.fractal.asset_application_requests",
] as const;

const privacyContentProfileV20AccessOnlySourceKeys = [
  "postgres.fractal.asset_application_evidence_documents",
  "postgres.fractal.asset_application_review_items",
  "postgres.fractal.approved_asset_application_versions",
  "postgres.fractal.asset_application_version_supersessions",
] as const;

const privacyContentProfileV21AccessAndPortabilitySourceKeys = [
  "postgres.fractal.offering_publication_requests",
] as const;

const privacyContentProfileV21AccessOnlySourceKeys = [
  "postgres.fractal.offering_publication_evidence_documents",
  "postgres.fractal.offering_products",
  "postgres.fractal.offering_publication_versions",
] as const;

const privacyContentProfileV22AccessAndPortabilitySourceKeys = [
  "postgres.fractal.offering_chain_deployment_requests",
  "postgres.fractal.offering_issuance_term_requests",
] as const;

const privacyContentProfileV22AccessOnlySourceKeys = [
  "postgres.fractal.offering_chain_operations",
  "postgres.fractal.offering_chain_operation_dispatch_claims",
] as const;

const privacyContentProfileV23AccessOnlySourceKeys = [
  "postgres.fractal.support_attachment_disposition_requests",
  "postgres.fractal.support_attachment_dispositions",
] as const;

const privacyContentProfileV24AccessOnlySourceKeys = [
  "postgres.fractal.professional_firm_profiles",
  "postgres.fractal.professional_firm_memberships",
  "postgres.fractal.professional_work_orders",
  "postgres.fractal.professional_work_order_assignments",
] as const;

const privacyContentProfileV25AccessAndPortabilitySourceKeys = [
  "postgres.fractal.professional_deliverable_versions",
  "postgres.fractal.professional_deliverable_evidence_documents",
] as const;

const privacyContentProfileV25AccessOnlySourceKeys = [
  "postgres.fractal.professional_deliverable_version_documents",
] as const;

const privacyContentProfileV26AccessAndPortabilitySourceKeys = [
  "postgres.fractal.professional_invoices",
] as const;

const privacyContentProfileV27AccessOnlySourceKeys = [
  "postgres.fractal.professional_payout_instructions",
] as const;

const privacyContentProfileV28AccessOnlySourceKeys = [
  "postgres.fractal.professional_invoice_credit_notes",
] as const;

const privacyContentProfileV29AccessOnlySourceKeys = [
  "postgres.fractal.professional_finance_exception_cases",
] as const;

const privacyContentProfileV30AccessAndPortabilitySourceKeys = [
  "postgres.fractal.professional_work_order_conflicts",
  "postgres.fractal.professional_finance_exception_evidence",
] as const;

const privacyContentProfileV30AccessOnlySourceKeys = [
  "postgres.fractal.professional_work_order_events",
] as const;

const privacyContentProfileV31AccessAndPortabilitySourceKeys = [
  "postgres.fractal.governance_evidence_documents",
] as const;

const privacyContentProfileV31AccessOnlySourceKeys = [
  "postgres.fractal.audit_events",
] as const;

const privacyContentProfileV32AccessOnlySourceKeys = [
  "postgres.fractal.professional_payout_profile_versions",
  "postgres.fractal.professional_invoice_tax_treatments",
  "postgres.fractal.professional_finance_approval_policies",
] as const;

const privacyContentProfileV33AccessOnlySourceKeys = [
  "postgres.fractal.professional_payout_recipient_recovery_cases",
  "postgres.fractal.professional_replacement_payout_requests",
] as const;

const privacyContentProfileV34AccessOnlySourceKeys = [
  "postgres.fractal.audit_chain_heads",
] as const;

const privacyContentProfileV35AccessOnlySourceKeys = [
  "postgres.fractal.administrator_bootstrap_state",
] as const;

const privacyContentProfileV36AccessAndPortabilitySourceKeys = [
  "postgres.fractal.organization_beneficial_owner_declarations",
] as const;

const privacyContentProfileV37AccessOnlySourceKeys = [
  "postgres.fractal.storage_cleanup_tasks",
] as const;

const privacyContentProfileV38AccessOnlySourceKeys = [
  "postgres.fractal.ownership_snapshot_requests",
  "postgres.fractal.ownership_snapshot_holdings",
  "postgres.fractal.distribution_declaration_requests",
  "postgres.fractal.distribution_entitlements",
  "postgres.fractal.investor_distribution_payout_profiles",
  "postgres.fractal.distribution_payout_recipient_recovery_cases",
  "postgres.fractal.distribution_funding_requests",
  "postgres.fractal.distribution_payout_instructions",
  "postgres.fractal.distribution_payout_provider_events",
  "postgres.fractal.distribution_payout_exception_policies",
  "postgres.fractal.distribution_payout_exception_cases",
  "postgres.fractal.distribution_payout_exception_evidence",
  "postgres.fractal.distribution_payout_exception_hold_requests",
  "postgres.fractal.distribution_payout_exception_executions",
  "postgres.fractal.distribution_tax_remittance_policies",
  "postgres.fractal.distribution_tax_remittance_requests",
  "postgres.fractal.distribution_tax_remittance_reversal_requests",
  "postgres.fractal.investor_distribution_tax_statements",
] as const;

const privacyContentProfileV39AccessOnlySourceKeys = [
  "postgres.fractal.distribution_lifecycle_policy_bindings",
] as const;

const privacyContentProfileV40AccessOnlySourceKeys = [
  "postgres.fractal.distribution_privacy_treatment_requests",
  "postgres.fractal.distribution_privacy_treatment_executions",
] as const;

const privacyContentProfileV41AccessOnlySourceKeys = [
  "postgres.fractal.privacy_rights_package_deliveries",
  "postgres.fractal.privacy_rights_package_access_events",
] as const;

const privacyContentProfileV42AccessOnlySourceKeys = [
  "postgres.fractal.idempotency_commands",
  "postgres.fractal.offering_notice_requests",
  "postgres.fractal.offering_notices",
  "postgres.fractal.offering_notice_recipients",
  "postgres.fractal.offering_notice_recipient_events",
  "postgres.fractal.organization_documents",
  "postgres.fractal.organization_document_versions",
  "postgres.fractal.organization_document_events",
  "postgres.fractal.organization_document_access_events",
  "postgres.fractal.organization_document_disposition_requests",
  "postgres.fractal.organization_document_dispositions",
] as const;

const privacyContentProfileV43AccessOnlySourceKeys = [
  "postgres.fractal.inbox_events",
  "postgres.fractal.outbox_events",
] as const;

const privacyContentProfileV44AccessOnlySourceKeys = [
  "postgres.fractal.privacy_external_collection_snapshots",
] as const;

const privacyContentProfileV45AccessOnlySourceKeys = [
  "postgres.fractal.privacy_external_provider_exports",
] as const;

const privacyContentProfileV13PortabilitySourceKeys = [
  ...privacyContentProfileV11PortabilitySourceKeys,
  ...privacyContentProfileV13AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV19PortabilitySourceKeys = [
  ...privacyContentProfileV13PortabilitySourceKeys,
  ...privacyContentProfileV19AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV20PortabilitySourceKeys = [
  ...privacyContentProfileV19PortabilitySourceKeys,
  ...privacyContentProfileV20AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV21PortabilitySourceKeys = [
  ...privacyContentProfileV20PortabilitySourceKeys,
  ...privacyContentProfileV21AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV22PortabilitySourceKeys = [
  ...privacyContentProfileV21PortabilitySourceKeys,
  ...privacyContentProfileV22AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV25PortabilitySourceKeys = [
  ...privacyContentProfileV22PortabilitySourceKeys,
  ...privacyContentProfileV25AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV26PortabilitySourceKeys = [
  ...privacyContentProfileV25PortabilitySourceKeys,
  ...privacyContentProfileV26AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV30PortabilitySourceKeys = [
  ...privacyContentProfileV26PortabilitySourceKeys,
  ...privacyContentProfileV30AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV31PortabilitySourceKeys = [
  ...privacyContentProfileV30PortabilitySourceKeys,
  ...privacyContentProfileV31AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV36PortabilitySourceKeys = [
  ...privacyContentProfileV31PortabilitySourceKeys,
  ...privacyContentProfileV36AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV12SourceKeys = [
  ...privacyContentProfileV11SourceKeys,
  ...privacyContentProfileV12AccessOnlySourceKeys,
] as const;

const privacyContentProfileV13SourceKeys = [
  ...privacyContentProfileV12SourceKeys,
  ...privacyContentProfileV13AccessOnlySourceKeys,
  ...privacyContentProfileV13AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV14SourceKeys = [
  ...privacyContentProfileV13SourceKeys,
  ...privacyContentProfileV14AccessOnlySourceKeys,
] as const;

const privacyContentProfileV15SourceKeys = [
  ...privacyContentProfileV14SourceKeys,
  ...privacyContentProfileV15AccessOnlySourceKeys,
] as const;

const privacyContentProfileV16SourceKeys = [
  ...privacyContentProfileV15SourceKeys,
  ...privacyContentProfileV16AccessOnlySourceKeys,
] as const;

const privacyContentProfileV17SourceKeys = [
  ...privacyContentProfileV16SourceKeys,
  ...privacyContentProfileV17AccessOnlySourceKeys,
] as const;

const privacyContentProfileV18SourceKeys = [
  ...privacyContentProfileV17SourceKeys,
  ...privacyContentProfileV18AccessOnlySourceKeys,
] as const;

const privacyContentProfileV19SourceKeys = [
  ...privacyContentProfileV18SourceKeys,
  ...privacyContentProfileV19AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV19AccessOnlySourceKeys,
] as const;

const privacyContentProfileV20SourceKeys = [
  ...privacyContentProfileV19SourceKeys,
  ...privacyContentProfileV20AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV20AccessOnlySourceKeys,
] as const;

const privacyContentProfileV21SourceKeys = [
  ...privacyContentProfileV20SourceKeys,
  ...privacyContentProfileV21AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV21AccessOnlySourceKeys,
] as const;

const privacyContentProfileV22SourceKeys = [
  ...privacyContentProfileV21SourceKeys,
  ...privacyContentProfileV22AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV22AccessOnlySourceKeys,
] as const;

const privacyContentProfileV23SourceKeys = [
  ...privacyContentProfileV22SourceKeys,
  ...privacyContentProfileV23AccessOnlySourceKeys,
] as const;

const privacyContentProfileV24SourceKeys = [
  ...privacyContentProfileV23SourceKeys,
  ...privacyContentProfileV24AccessOnlySourceKeys,
] as const;

const privacyContentProfileV25SourceKeys = [
  ...privacyContentProfileV24SourceKeys,
  ...privacyContentProfileV25AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV25AccessOnlySourceKeys,
] as const;

const privacyContentProfileV26SourceKeys = [
  ...privacyContentProfileV25SourceKeys,
  ...privacyContentProfileV26AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV27SourceKeys = [
  ...privacyContentProfileV26SourceKeys,
  ...privacyContentProfileV27AccessOnlySourceKeys,
] as const;

const privacyContentProfileV28SourceKeys = [
  ...privacyContentProfileV27SourceKeys,
  ...privacyContentProfileV28AccessOnlySourceKeys,
] as const;

const privacyContentProfileV29SourceKeys = [
  ...privacyContentProfileV28SourceKeys,
  ...privacyContentProfileV29AccessOnlySourceKeys,
] as const;

const privacyContentProfileV30SourceKeys = [
  ...privacyContentProfileV29SourceKeys,
  ...privacyContentProfileV30AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV30AccessOnlySourceKeys,
] as const;

const privacyContentProfileV31SourceKeys = [
  ...privacyContentProfileV30SourceKeys,
  ...privacyContentProfileV31AccessAndPortabilitySourceKeys,
  ...privacyContentProfileV31AccessOnlySourceKeys,
] as const;

const privacyContentProfileV32SourceKeys = [
  ...privacyContentProfileV31SourceKeys,
  ...privacyContentProfileV32AccessOnlySourceKeys,
] as const;

const privacyContentProfileV33SourceKeys = [
  ...privacyContentProfileV32SourceKeys,
  ...privacyContentProfileV33AccessOnlySourceKeys,
] as const;

const privacyContentProfileV34SourceKeys = [
  ...privacyContentProfileV33SourceKeys,
  ...privacyContentProfileV34AccessOnlySourceKeys,
] as const;

const privacyContentProfileV35SourceKeys = [
  ...privacyContentProfileV34SourceKeys,
  ...privacyContentProfileV35AccessOnlySourceKeys,
] as const;

const privacyContentProfileV36SourceKeys = [
  ...privacyContentProfileV35SourceKeys,
  ...privacyContentProfileV36AccessAndPortabilitySourceKeys,
] as const;

const privacyContentProfileV37SourceKeys = [
  ...privacyContentProfileV36SourceKeys,
  ...privacyContentProfileV37AccessOnlySourceKeys,
] as const;

const privacyContentProfileV38SourceKeys = [
  ...privacyContentProfileV37SourceKeys,
  ...privacyContentProfileV38AccessOnlySourceKeys,
] as const;

const privacyContentProfileV39SourceKeys = [
  ...privacyContentProfileV38SourceKeys,
  ...privacyContentProfileV39AccessOnlySourceKeys,
] as const;

const privacyContentProfileV40SourceKeys = [
  ...privacyContentProfileV39SourceKeys,
  ...privacyContentProfileV40AccessOnlySourceKeys,
] as const;

const privacyContentProfileV41SourceKeys = [
  ...privacyContentProfileV40SourceKeys,
  ...privacyContentProfileV41AccessOnlySourceKeys,
] as const;

const privacyContentProfileV42SourceKeys = [
  ...privacyContentProfileV41SourceKeys,
  ...privacyContentProfileV42AccessOnlySourceKeys,
] as const;

const privacyContentProfileV44SourceKeys = [
  ...privacyContentProfileV42SourceKeys,
  ...privacyContentProfileV43AccessOnlySourceKeys,
  ...privacyContentProfileV44AccessOnlySourceKeys,
] as const;

export const privacyContentProfileSourceKeys = [
  ...privacyContentProfileV44SourceKeys,
  ...privacyContentProfileV45AccessOnlySourceKeys,
] as const;

export type PrivacyContentProfileSourceKey = typeof privacyContentProfileSourceKeys[number];
export type PrivacyContentFieldCatalogVersion = "privacy-safe-fields-v1" | "privacy-safe-fields-v2" | "privacy-safe-fields-v3" | "privacy-safe-fields-v4" | "privacy-safe-fields-v5" | "privacy-safe-fields-v6" | "privacy-safe-fields-v7" | "privacy-safe-fields-v8" | "privacy-safe-fields-v9" | "privacy-safe-fields-v10" | "privacy-safe-fields-v11" | "privacy-safe-fields-v12" | "privacy-safe-fields-v13" | "privacy-safe-fields-v14" | "privacy-safe-fields-v15" | "privacy-safe-fields-v16" | "privacy-safe-fields-v17" | "privacy-safe-fields-v18" | "privacy-safe-fields-v19" | "privacy-safe-fields-v20" | "privacy-safe-fields-v21" | "privacy-safe-fields-v22" | "privacy-safe-fields-v23" | "privacy-safe-fields-v24" | "privacy-safe-fields-v25" | "privacy-safe-fields-v26" | "privacy-safe-fields-v27" | "privacy-safe-fields-v28" | "privacy-safe-fields-v29" | "privacy-safe-fields-v30" | "privacy-safe-fields-v31" | "privacy-safe-fields-v32" | "privacy-safe-fields-v33" | "privacy-safe-fields-v34" | "privacy-safe-fields-v35" | "privacy-safe-fields-v36" | "privacy-safe-fields-v37" | "privacy-safe-fields-v38" | "privacy-safe-fields-v39" | "privacy-safe-fields-v40" | "privacy-safe-fields-v41" | "privacy-safe-fields-v42" | "privacy-safe-fields-v43" | "privacy-safe-fields-v44" | "privacy-safe-fields-v45";
export type PrivacyContentRight = "access" | "portability";

/**
 * Fields in this catalogue are the maximum disclosure-safe projection the
 * collectors can ever read. Credential material, security fingerprints,
 * administrator identities, internal notes, and unapplied decisions are
 * excluded in SQL before a governed profile can select fields.
 */
export const privacySafeFieldCatalog: Readonly<Record<PrivacyContentProfileSourceKey, readonly string[]>> = {
  "postgres.fractal.identities": [
    "email", "legalName", "status", "emailVerifiedAt", "credentialInvalidatedAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.identity_role_assignments": ["role", "scopeType", "scopeId", "grantedAt", "revokedAt"],
  "postgres.fractal.auth_sessions": ["role", "businessId", "createdAt", "lastSeenAt", "expiresAt", "revokedAt", "revokedReason"],
  "postgres.fractal.legal_document_acceptances": [
    "documentKey", "semanticVersion", "contentSha256", "acceptanceContext", "affirmativeAction", "acceptedAt",
  ],
  "postgres.fractal.privacy_rights_requests": [
    "reference", "requestType", "details", "identityAssurance", "emailVerifiedAtSnapshot", "dueAt", "status", "createdAt", "lastActivityAt",
  ],
  "postgres.fractal.privacy_rights_policy_bindings": [
    "requestReference", "policyReference", "policyName", "jurisdiction", "controllerName", "identityAssurance",
    "communicationChannel", "deadlineBasis", "responseCalendarDays", "requestCreatedAt", "dueAt", "boundAt",
  ],
  "postgres.fractal.privacy_rights_request_events": [
    "requestReference", "sequence", "eventType", "fromStatus", "toStatus", "visibility", "message", "occurredAt",
  ],
  "postgres.fractal.privacy_rights_decision_requests": [
    "reference", "requestReference", "outcome", "decisionSummary", "lawfulBasis", "scopeOutcomes", "status",
    "requestedAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.auth_email_deliveries": [
    "deliveryType", "status", "attempts", "nextAttemptAt", "sentAt", "terminalAt", "requestedAt", "updatedAt",
  ],
  "postgres.fractal.auth_step_up_grants": ["method", "grantedAt", "expiresAt"],
  "postgres.fractal.security_notifications": ["eventType", "createdAt", "readAt"],
  "postgres.fractal.totp_factors": ["confirmedAt", "disabledAt", "createdAt", "updatedAt"],
  "postgres.fractal.totp_recovery_codes": ["createdAt", "usedAt", "replacedAt"],
  "postgres.fractal.identity_access_change_requests": [
    "changeType", "priorRole", "proposedRole", "priorStatus", "status", "requestedAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.administrator_capability_assignments": ["capabilityKey", "grantedAt", "revokedAt"],
  "postgres.fractal.administrator_capability_change_requests": [
    "capabilityKey", "changeType", "priorEnabled", "status", "requestedAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.administrator_recovery_requests": [
    "incidentReference", "status", "requestedAt", "expiresAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.administrator_audit_exports": [
    "sequenceHighWatermark", "firstSequence", "lastSequence", "recordCount", "contentSha256", "createdAt",
  ],
  "postgres.fractal.provider_identity_verification_applications": [
    "provider", "status", "readyAt", "terminalAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.provider_identity_verification_events": [
    "provider", "eventType", "reviewStatus", "reviewAnswer", "providerCreatedAt", "receivedAt", "recordedAt",
  ],
  "postgres.fractal.agreement_acceptances": [
    "offeringPublicReference", "offeringVersion", "agreementDocumentHash", "signatureName", "executionHash", "acceptedAt", "createdAt",
  ],
  "postgres.fractal.platform_content_events": [
    "documentKey", "semanticVersion", "sequence", "eventType", "fromStatus", "toStatus", "occurredAt",
  ],
  "postgres.fractal.platform_content_publications": [
    "documentKey", "semanticVersion", "relationship", "projectionVersion", "boundAt",
  ],
  "postgres.fractal.platform_content_versions": [
    "documentKey", "semanticVersion", "relationship", "status", "reacceptanceRequired", "effectiveAt", "proposedAt",
    "reviewedAt", "publishedAt", "supersededAt",
  ],
  "postgres.fractal.privacy_rights_package_preparations": [
    "reference", "requestReference", "requestType", "requestVersion", "contentProfileReference", "fieldCatalogVersion",
    "collectedSourceCount", "unavailableSourceCount", "notApplicableSourceCount", "collectedRecordCount",
    "collectedByteCount", "outcome", "deliverable", "preparedAt",
  ],
  "postgres.fractal.platform_configuration_activation_attempts": [
    "configurationKey", "versionNumber", "relationship", "outcome", "dueAt", "attemptedAt", "latenessMs",
  ],
  "postgres.fractal.platform_configuration_active_versions": [
    "configurationKey", "versionNumber", "relationship", "projectionVersion", "boundAt",
  ],
  "postgres.fractal.platform_configuration_events": [
    "configurationKey", "versionNumber", "sequence", "eventType", "fromStatus", "toStatus", "occurredAt",
  ],
  "postgres.fractal.platform_configuration_versions": [
    "configurationKey", "versionNumber", "relationship", "status", "effectiveAt", "proposedAt", "reviewedAt",
    "activatedAt", "supersededAt",
  ],
  "postgres.fractal.administrator_provider_incident_events": [
    "providerKey", "relationship", "sequence", "eventType", "fromStatus", "toStatus", "fromSeverity", "severity",
    "acknowledgementDueAt", "resolutionDueAt", "acknowledgedAt", "containedAt", "resolvedAt", "occurredAt",
  ],
  "postgres.fractal.administrator_provider_incidents": [
    "providerKey", "source", "relationship", "severity", "status", "detectedAt", "acknowledgementDueAt",
    "resolutionDueAt", "acknowledgedAt", "containedAt", "resolvedAt", "version", "createdAt", "updatedAt",
  ],
  "postgres.fractal.support_case_events": [
    "caseReference", "relationship", "sequence", "eventType", "fromStatus", "toStatus", "message", "occurredAt",
  ],
  "postgres.fractal.support_cases": [
    "reference", "requesterRole", "category", "reportedImpact", "subject", "description", "relatedReference",
    "occurredAt", "status", "resolutionSummary", "version", "createdAt", "lastActivityAt",
  ],
  "postgres.fractal.support_case_attachment_access_events": [
    "caseReference", "filename", "relationship", "accessType", "contentSha256", "integrityVerified", "occurredAt",
  ],
  "postgres.fractal.support_case_attachments": [
    "caseReference", "relationship", "classification", "filename", "mimeType", "bytes", "contentSha256",
    "scanStatus", "scanner", "scannedAt", "policyReference", "policyName", "retentionDays", "uploadedAt", "retentionDueAt",
  ],
  "postgres.fractal.investor_wallet_link_challenges": [
    "chainId", "walletAddress", "status", "expiresAt", "consumedAt", "createdAt",
  ],
  "postgres.fractal.investor_wallets": [
    "chainId", "walletAddress", "status", "verifiedAt", "revokedAt", "createdAt",
  ],
  "postgres.fractal.investor_compliance_profile_reviews": [
    "kycStatus", "investorClass", "accreditationStatus", "jurisdictionCode", "reviewedAt", "expiresAt",
    "approvedAt", "createdAt",
  ],
  "postgres.fractal.investor_compliance_profiles": [
    "kycStatus", "investorClass", "accreditationStatus", "jurisdictionCode", "reviewedAt", "expiresAt", "updatedAt",
  ],
  "postgres.fractal.investor_compliance_review_requests": [
    "kycStatus", "investorClass", "accreditationStatus", "jurisdictionCode", "reviewedAt", "expiresAt",
    "status", "submittedAt", "decidedAt", "createdAt",
  ],
  "postgres.fractal.investment_eligibility_snapshots": [
    "offeringPublicReference", "offeringVersion", "status", "reasonCodes", "evaluatedAt", "expiresAt", "createdAt",
  ],
  "postgres.fractal.investment_commitments": [
    "offeringPublicReference", "currency", "committedMinor", "status", "createdAt", "updatedAt",
  ],
  "postgres.fractal.investment_reservations": [
    "offeringPublicReference", "offeringVersion", "amountMinor", "currency", "status", "expiresAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.investment_allocation_requests": [
    "offeringPublicReference", "chainId", "walletAddress", "investedMinor", "currency", "tokenUnitPriceMinor",
    "tokenAmount", "status", "submittedAt", "decidedAt",
  ],
  "postgres.fractal.investment_allocation_chain_operations": [
    "offeringPublicReference", "chainId", "tokenContractAddress", "walletAddress", "tokenAmount", "operationType",
    "status", "transactionHash", "submittedAt", "confirmedAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.investment_allocation_chain_dispatch_claims": [
    "offeringPublicReference", "chainId", "operationType", "status", "transactionHash", "claimedAt", "completedAt",
  ],
  "postgres.fractal.payment_intents": [
    "offeringPublicReference", "provider", "expectedMinor", "currency", "status", "expiresAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.payment_provider_instructions": [
    "offeringPublicReference", "provider", "status", "initializedAt", "terminalAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.payment_receipts": [
    "offeringPublicReference", "provider", "amountMinor", "currency", "status", "receivedAt", "createdAt",
  ],
  "postgres.fractal.payment_reconciliation_cases": [
    "offeringPublicReference", "caseType", "status", "expectedMinor", "actualMinor", "currency", "resolvedAt", "createdAt",
  ],
  "postgres.fractal.journal_entries": [
    "offeringPublicReference", "currency", "status", "effectiveAt", "createdAt",
  ],
  "postgres.fractal.journal_postings": [
    "offeringPublicReference", "lineNumber", "direction", "amountMinor", "currency", "createdAt",
  ],
  "postgres.fractal.support_case_service_obligations": [
    "caseReference", "cycleNumber", "policyReference", "policyName", "priority", "acknowledgementDueAt",
    "escalationDueAt", "resolutionDueAt", "openedAt", "createdAt",
  ],
  "postgres.fractal.support_case_service_events": [
    "caseReference", "cycleNumber", "eventType", "actorType", "dueAt", "occurredAt", "latenessMs",
  ],
  "postgres.fractal.support_case_notification_deliveries": [
    "caseReference", "caseEventSequence", "notificationType", "channel", "status", "attempts",
    "requestedAt", "sentAt", "terminalAt", "cancelledAt", "updatedAt",
  ],
  "postgres.fractal.data_legal_hold_change_requests": [
    "reference", "targetType", "changeType", "status", "requestedAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.data_legal_holds": [
    "reference", "targetType", "imposedAt", "releasedAt",
  ],
  "postgres.fractal.organizations": [
    "legalName", "status", "jurisdictionCode", "entityType", "primaryActivity", "verificationStatus",
    "verificationUpdatedAt", "verifiedAt", "verificationExpiresAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.organization_memberships": [
    "organizationLegalName", "role", "status", "grantedAt", "revokedAt",
  ],
  "postgres.fractal.organization_invitations": [
    "organizationLegalName", "email", "role", "status", "expiresAt", "acceptedAt", "revokedAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.organization_ownership_transfer_requests": [
    "organizationLegalName", "participantSide", "status", "expiresAt", "decidedAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.organization_verification_requests": [
    "organizationLegalName", "version", "legalName", "registrationNumber", "jurisdictionCode", "entityType",
    "primaryActivity", "registeredAddress", "representativeAuthorityBasis", "status", "submittedAt", "decidedAt",
    "verificationExpiresAt", "createdAt",
  ],
  "postgres.fractal.organization_verification_evidence_documents": [
    "organizationLegalName", "evidenceType", "filename", "mimeType", "contentSha256", "bytes", "createdAt",
  ],
  "postgres.fractal.organization_verification_request_evidence": [
    "organizationLegalName", "requestVersion", "evidenceType", "filename", "contentSha256",
  ],
  "postgres.fractal.asset_application_requests": [
    "organizationLegalName", "applicationReference", "applicationVersion", "assetName", "assetType", "countryCode",
    "state", "city", "summary", "materialChangeSummary", "requestedCapacityMinor", "currency", "status",
    "submittedAt", "decidedAt", "createdAt",
  ],
  "postgres.fractal.asset_application_evidence_documents": [
    "organizationLegalName", "filename", "mimeType", "contentSha256", "bytes", "createdAt",
  ],
  "postgres.fractal.asset_application_review_items": [
    "organizationLegalName", "applicationReference", "applicationVersion", "category", "title", "requestMessage",
    "required", "status", "responseProvidedByRequester", "responseMessage", "respondedAt", "reviewedAt", "openedAt", "createdAt",
  ],
  "postgres.fractal.approved_asset_application_versions": [
    "organizationLegalName", "applicationReference", "applicationVersion", "assetName", "assetType", "countryCode",
    "state", "city", "summary", "requestedCapacityMinor", "currency", "approvedAt", "createdAt", "current",
  ],
  "postgres.fractal.asset_application_version_supersessions": [
    "organizationLegalName", "participantSide", "supersededApplicationReference", "supersededApplicationVersion",
    "replacementApplicationReference", "replacementApplicationVersion", "supersededAt",
  ],
  "postgres.fractal.offering_publication_requests": [
    "organizationLegalName", "publicReference", "currency", "capacityMinor", "opensAt", "closesAt", "publicSlug",
    "name", "assetClass", "summary", "thesis", "riskSummary", "incomeSource", "structure", "security", "feeSummary",
    "nextMilestone", "minimumTicketMinor", "targetReturnBps", "termMonths", "status", "submittedAt", "decidedAt", "createdAt",
  ],
  "postgres.fractal.offering_publication_evidence_documents": [
    "organizationLegalName", "evidenceKind", "filename", "mimeType", "contentSha256", "bytes", "createdAt",
  ],
  "postgres.fractal.offering_products": [
    "organizationLegalName", "publicReference", "status", "currency", "capacityMinor", "opensAt", "closesAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.offering_publication_versions": [
    "organizationLegalName", "publicReference", "version", "publicSlug", "name", "assetClass", "summary", "thesis",
    "riskSummary", "incomeSource", "structure", "security", "feeSummary", "nextMilestone", "minimumTicketMinor",
    "targetReturnBps", "termMonths", "publishedAt", "createdAt",
  ],
  "postgres.fractal.offering_chain_deployment_requests": [
    "organizationLegalName", "offeringPublicReference", "offeringVersion", "chainId", "tokenFactoryAddress",
    "offeringName", "tokenName", "tokenSymbol", "maxBalancePerHolder", "retailCap", "maxTotalSupply",
    "status", "submittedAt", "decidedAt",
  ],
  "postgres.fractal.offering_issuance_term_requests": [
    "organizationLegalName", "offeringPublicReference", "offeringVersion", "currency", "tokenUnitPriceMinor",
    "maxTotalSupply", "status", "submittedAt", "decidedAt",
  ],
  "postgres.fractal.offering_chain_operations": [
    "organizationLegalName", "offeringPublicReference", "chainId", "tokenFactoryAddress", "operationType", "status",
    "transactionHash", "tokenContractAddress", "blockNumber", "submittedAt", "confirmedAt", "createdAt", "updatedAt",
  ],
  "postgres.fractal.offering_chain_operation_dispatch_claims": [
    "organizationLegalName", "offeringPublicReference", "operationType", "status", "transactionHash", "claimedAt", "completedAt",
  ],
  "postgres.fractal.support_attachment_disposition_requests": [
    "caseReference", "attachmentFilename", "attachmentClassification", "dispositionReference", "action",
    "retentionDueAt", "status", "requestedAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.support_attachment_dispositions": [
    "caseReference", "attachmentFilename", "attachmentClassification", "contentSha256", "status",
    "approvedAt", "completedAt", "failedAt",
  ],
  "postgres.fractal.professional_firm_profiles": [
    "firmLegalName", "organizationStatus", "firmStatus", "credentialStatus", "firmCreatedAt", "firmUpdatedAt",
  ],
  "postgres.fractal.professional_firm_memberships": [
    "firmLegalName", "role", "status", "grantedAt", "revokedAt",
  ],
  "postgres.fractal.professional_work_orders": [
    "reference", "issuerLegalName", "firmLegalName", "title", "confidentiality", "responseDueAt",
    "deliveryDueAt", "feeMinor", "currency", "status", "invitedAt", "decidedAt",
  ],
  "postgres.fractal.professional_work_order_assignments": [
    "workOrderReference", "title", "firmLegalName", "assignmentStatus", "assignedAt", "revokedAt",
  ],
  "postgres.fractal.professional_deliverable_versions": [
    "workOrderReference", "version", "title", "submissionSummary", "submittedAt",
  ],
  "postgres.fractal.professional_deliverable_evidence_documents": [
    "workOrderReference", "filename", "mimeType", "contentSha256", "bytes", "createdAt",
  ],
  "postgres.fractal.professional_deliverable_version_documents": [
    "workOrderReference", "deliverableVersion", "deliverableTitle", "filename", "mimeType", "contentSha256", "bytes",
  ],
  "postgres.fractal.professional_invoices": [
    "reference", "workOrderReference", "deliverableVersion", "deliverableTitle", "currency", "grossMinor",
    "taxMinor", "withholdingTaxMinor", "netPayableMinor", "dueAt", "status", "submittedAt", "reviewedAt",
  ],
  "postgres.fractal.professional_payout_instructions": [
    "invoiceReference", "workOrderReference", "currency", "amountMinor", "status", "authorizedAt",
    "submittedAt", "confirmedAt", "failedAt",
  ],
  "postgres.fractal.professional_invoice_credit_notes": [
    "reference", "invoiceReference", "workOrderReference", "currency", "grossMinor", "taxMinor",
    "withholdingTaxMinor", "netCreditMinor", "issuedAt",
  ],
  "postgres.fractal.professional_finance_exception_cases": [
    "invoiceReference", "workOrderReference", "status", "resolutionType", "openedAt", "preparedAt",
    "reviewedAt", "executedAt", "closedAt",
  ],
  "postgres.fractal.professional_work_order_conflicts": [
    "workOrderReference", "declaration", "notes", "declaredAt",
  ],
  "postgres.fractal.professional_finance_exception_evidence": [
    "evidenceType", "filename", "mimeType", "uploadedAt",
  ],
  "postgres.fractal.professional_work_order_events": [
    "workOrderReference", "eventType", "createdAt",
  ],
  "postgres.fractal.governance_evidence_documents": [
    "evidenceKind", "filename", "mimeType", "createdAt",
  ],
  "postgres.fractal.audit_events": [
    "actorType", "action", "entityType", "occurredAt",
  ],
  "postgres.fractal.professional_payout_profile_versions": [
    "participationRole", "version", "rail", "currency", "status", "verifiedAt", "createdAt",
  ],
  "postgres.fractal.professional_invoice_tax_treatments": [
    "participationRole", "version", "status", "createdAt", "approvedAt",
  ],
  "postgres.fractal.professional_finance_approval_policies": [
    "participationRole", "version", "status", "createdAt", "approvedAt",
  ],
  "postgres.fractal.professional_payout_recipient_recovery_cases": [
    "participationRole", "status", "createdAt", "resolvedAt",
  ],
  "postgres.fractal.professional_replacement_payout_requests": [
    "participationRole", "status", "authorizedAt", "createdAt",
  ],
  "postgres.fractal.audit_chain_heads": [
    "latestSequence", "updatedAt",
  ],
  "postgres.fractal.administrator_bootstrap_state": [
    "cohortSize", "sealedAt",
  ],
  "postgres.fractal.organization_beneficial_owner_declarations": [
    "ownerType", "legalName", "ownershipBps", "isControlPerson", "nationalityOrJurisdictionCode",
    "countryOfResidenceCode", "declaredAt",
  ],
  "postgres.fractal.storage_cleanup_tasks": ["cleanupPurpose", "status", "requestedAt", "completedAt", "failedAt"],
  "postgres.fractal.ownership_snapshot_requests": ["participationRole", "reference", "chainId", "recordAt", "blockNumber", "confirmations", "sourceType", "totalSupplyUnits", "holderCount", "status", "submittedAt", "reviewedAt"],
  "postgres.fractal.ownership_snapshot_holdings": ["snapshotReference", "walletAddress", "balanceUnits", "recordAt", "createdAt"],
  "postgres.fractal.distribution_declaration_requests": ["participationRole", "reference", "periodLabel", "currency", "grossAmountMinor", "withholdingTaxBps", "withholdingTaxMinor", "netAmountMinor", "paymentDueAt", "jurisdictionCode", "legalBasisReference", "retainUntil", "status", "submittedAt", "reviewedAt"],
  "postgres.fractal.distribution_entitlements": ["declarationReference", "periodLabel", "currency", "balanceUnits", "grossAmountMinor", "withholdingTaxMinor", "netAmountMinor", "createdAt"],
  "postgres.fractal.investor_distribution_payout_profiles": ["version", "provider", "rail", "currency", "accountHolderName", "accountLast4", "status", "verifiedAt", "supersededAt"],
  "postgres.fractal.distribution_payout_recipient_recovery_cases": ["provider", "status", "createdAt", "resolvedAt"],
  "postgres.fractal.distribution_funding_requests": ["participationRole", "reference", "declarationReference", "provider", "currency", "amountMinor", "status", "submittedAt", "reviewedAt"],
  "postgres.fractal.distribution_payout_instructions": ["reference", "declarationReference", "currency", "amountMinor", "instructionKind", "status", "authorizedAt", "submittedAt", "confirmedAt", "failedAt"],
  "postgres.fractal.distribution_payout_provider_events": ["payoutReference", "source", "outcome", "createdAt"],
  "postgres.fractal.distribution_payout_exception_policies": ["participationRole", "version", "resolutionType", "currency", "maximumAmountMinor", "effectiveFrom", "effectiveUntil", "status", "createdAt", "approvedAt"],
  "postgres.fractal.distribution_payout_exception_cases": ["participationRole", "reference", "payoutReference", "status", "resolutionType", "holdStatus", "openedAt", "preparedAt", "reviewedAt", "executedAt", "closedAt"],
  "postgres.fractal.distribution_payout_exception_evidence": ["participationRole", "caseReference", "evidenceType", "filename", "mimeType", "uploadedAt"],
  "postgres.fractal.distribution_payout_exception_hold_requests": ["participationRole", "caseReference", "action", "status", "preparedAt", "reviewedAt"],
  "postgres.fractal.distribution_payout_exception_executions": ["participationRole", "caseReference", "resolutionType", "executedAt"],
  "postgres.fractal.distribution_tax_remittance_policies": ["participationRole", "version", "jurisdictionCode", "currency", "taxAuthorityName", "filingDueDays", "paymentDueDays", "effectiveFrom", "effectiveUntil", "status", "createdAt", "approvedAt"],
  "postgres.fractal.distribution_tax_remittance_requests": ["participationRole", "reference", "declarationReference", "jurisdictionCode", "currency", "amountMinor", "taxPeriodStart", "taxPeriodEnd", "filingDueAt", "paymentDueAt", "filingReference", "paymentReference", "authorityReceiptReference", "status", "submittedAt", "reviewedAt", "paymentSubmittedAt", "paymentReviewedAt", "remittedAt", "reversedAt"],
  "postgres.fractal.distribution_tax_remittance_reversal_requests": ["participationRole", "remittanceReference", "status", "preparedAt", "reviewedAt", "executedAt"],
  "postgres.fractal.investor_distribution_tax_statements": ["reference", "declarationReference", "jurisdictionCode", "currency", "grossAmountMinor", "withholdingTaxMinor", "taxPeriodStart", "taxPeriodEnd", "taxAuthorityName", "authorityReceiptReference", "legalBasisReference", "statementSha256", "status", "issuedAt", "revokedAt"],
  "postgres.fractal.distribution_lifecycle_policy_bindings": ["targetType", "recordClass", "policyReference", "policyName", "jurisdictionCode", "legalBasisReference", "retentionDays", "correctionTreatment", "erasureTreatment", "restrictionTreatment", "objectionTreatment", "retentionStartedAt", "retainUntil", "boundAt"],
  "postgres.fractal.distribution_privacy_treatment_requests": [
    "reference", "targetType", "treatmentType", "policyTreatmentMode", "decisionScopeCategory",
    "decisionScopeAction", "status", "requesterVisibleSummary", "proposedAt", "reviewedAt",
  ],
  "postgres.fractal.distribution_privacy_treatment_executions": [
    "treatmentReference", "executionResult", "lawfulBasis", "policyReference", "retainUntil",
    "legalHoldActive", "executedAt",
  ],
  "postgres.fractal.privacy_rights_package_deliveries": ["reference", "status", "canonicalFormat", "contentSha256", "byteCount", "requestedAt", "retrievalExpiresAt", "retainUntil", "generatedAt", "availableAt", "expiredAt", "destroyedAt"],
  "postgres.fractal.privacy_rights_package_access_events": ["deliveryReference", "accessType", "contentSha256", "bytesServed", "occurredAt"],
  "postgres.fractal.idempotency_commands": ["route", "responseStatus", "createdAt", "expiresAt"],
  "postgres.fractal.offering_notice_requests": [
    "participationRole", "reference", "category", "subject", "body", "audienceType", "policyReference",
    "policyJurisdictionCode", "policyLegalBasisReference", "retentionDays", "acknowledgmentRequired",
    "acknowledgmentWindowDays", "status", "submittedAt", "reviewedAt",
  ],
  "postgres.fractal.offering_notices": [
    "participationRole", "reference", "category", "subject", "body", "audienceType", "policyReference",
    "policyJurisdictionCode", "policyLegalBasisReference", "retainUntil", "acknowledgmentRequired",
    "acknowledgmentDueAt", "publishedAt",
  ],
  "postgres.fractal.offering_notice_recipients": [
    "reference", "category", "subject", "madeAvailableAt", "firstReadAt", "acknowledgedAt",
  ],
  "postgres.fractal.offering_notice_recipient_events": ["reference", "eventType", "occurredAt"],
  "postgres.fractal.organization_documents": [
    "participationRole", "category", "status", "currentVersionNumber", "retentionBasis", "retainUntil",
    "retentionPolicyReference", "retentionPolicyJurisdictionCode", "createdAt", "archivedAt",
  ],
  "postgres.fractal.organization_document_versions": [
    "versionNumber", "filename", "mimeType", "contentSha256", "bytes", "retainUntil", "createdAt",
  ],
  "postgres.fractal.organization_document_events": [
    "eventType", "fromStatus", "toStatus", "occurredAt",
  ],
  "postgres.fractal.organization_document_access_events": ["accessType", "occurredAt"],
  "postgres.fractal.organization_document_disposition_requests": [
    "participationRole", "reference", "action", "retainUntil", "versionCount", "status",
    "requestedAt", "reviewedAt", "appliedAt",
  ],
  "postgres.fractal.organization_document_dispositions": [
    "participationRole", "requestReference", "expectedVersionCount", "status", "approvedAt", "completedAt", "failedAt",
  ],
  "postgres.fractal.inbox_events": ["provider", "processingStatus", "receivedAt", "processedAt", "failedAt"],
  "postgres.fractal.outbox_events": ["deliveryStatus", "occurredAt", "publishedAt"],
  "postgres.fractal.privacy_external_collection_snapshots": [
    "reference", "sourceKey", "requestType", "status", "recordCount",
    "byteCount", "requestedAt", "collectedAt", "expiresAt", "expiredAt", "destroyedAt",
  ],
  "postgres.fractal.privacy_external_provider_exports": [
    "reference", "sourceKey", "requestType", "status", "entryCount", "sensitiveTier",
    "byteCount", "generatedAt", "downloadedAt", "uploadedAt", "retainUntil", "destroyedAt",
  ],
};

export function privacyContentProfileSourceKeysForRight(
  fieldCatalogVersion: PrivacyContentFieldCatalogVersion,
  right: PrivacyContentRight,
): readonly PrivacyContentProfileSourceKey[] {
  if (fieldCatalogVersion === "privacy-safe-fields-v1") return privacyContentProfileV1SourceKeys;
  if (right === "portability") {
    if (fieldCatalogVersion === "privacy-safe-fields-v45") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v44") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v43") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v42") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v41") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v40") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v39") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v38") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v37") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v36") return privacyContentProfileV36PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v35") return privacyContentProfileV31PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v34") return privacyContentProfileV31PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v33") return privacyContentProfileV31PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v32") return privacyContentProfileV31PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v31") return privacyContentProfileV31PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v30") return privacyContentProfileV30PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v26" || fieldCatalogVersion === "privacy-safe-fields-v27" || fieldCatalogVersion === "privacy-safe-fields-v28" || fieldCatalogVersion === "privacy-safe-fields-v29") return privacyContentProfileV26PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v25") return privacyContentProfileV25PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v22" || fieldCatalogVersion === "privacy-safe-fields-v23" || fieldCatalogVersion === "privacy-safe-fields-v24") return privacyContentProfileV22PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v21") return privacyContentProfileV21PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v20") return privacyContentProfileV20PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v19") return privacyContentProfileV19PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v13" || fieldCatalogVersion === "privacy-safe-fields-v14" || fieldCatalogVersion === "privacy-safe-fields-v15" || fieldCatalogVersion === "privacy-safe-fields-v16" || fieldCatalogVersion === "privacy-safe-fields-v17" || fieldCatalogVersion === "privacy-safe-fields-v18") return privacyContentProfileV13PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v11" || fieldCatalogVersion === "privacy-safe-fields-v12") return privacyContentProfileV11PortabilitySourceKeys;
    if (fieldCatalogVersion === "privacy-safe-fields-v9" || fieldCatalogVersion === "privacy-safe-fields-v10") return privacyContentProfileV9PortabilitySourceKeys;
    return fieldCatalogVersion === "privacy-safe-fields-v5" || fieldCatalogVersion === "privacy-safe-fields-v6" || fieldCatalogVersion === "privacy-safe-fields-v7" || fieldCatalogVersion === "privacy-safe-fields-v8"
      ? privacyContentProfileV5PortabilitySourceKeys
      : privacyContentProfileV1SourceKeys;
  }
  if (fieldCatalogVersion === "privacy-safe-fields-v37") return privacyContentProfileV37SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v38") return privacyContentProfileV38SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v39") return privacyContentProfileV39SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v40") return privacyContentProfileV40SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v41") return privacyContentProfileV41SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v42") return privacyContentProfileV42SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v43") return [
    ...privacyContentProfileV42SourceKeys,
    ...privacyContentProfileV43AccessOnlySourceKeys,
  ];
  if (fieldCatalogVersion === "privacy-safe-fields-v44") return privacyContentProfileV44SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v45") return privacyContentProfileSourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v2") return privacyContentProfileV2SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v3") return privacyContentProfileV3SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v4") return privacyContentProfileV4SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v5") return privacyContentProfileV5SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v6") return privacyContentProfileV6SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v7") return privacyContentProfileV7SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v8") return privacyContentProfileV8SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v9") return privacyContentProfileV9SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v10") return privacyContentProfileV10SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v11") return privacyContentProfileV11SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v12") return privacyContentProfileV12SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v13") return privacyContentProfileV13SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v14") return privacyContentProfileV14SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v15") return privacyContentProfileV15SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v16") return privacyContentProfileV16SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v17") return privacyContentProfileV17SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v18") return privacyContentProfileV18SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v19") return privacyContentProfileV19SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v20") return privacyContentProfileV20SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v21") return privacyContentProfileV21SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v22") return privacyContentProfileV22SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v23") return privacyContentProfileV23SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v24") return privacyContentProfileV24SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v25") return privacyContentProfileV25SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v26") return privacyContentProfileV26SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v27") return privacyContentProfileV27SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v28") return privacyContentProfileV28SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v29") return privacyContentProfileV29SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v30") return privacyContentProfileV30SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v31") return privacyContentProfileV31SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v32") return privacyContentProfileV32SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v33") return privacyContentProfileV33SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v34") return privacyContentProfileV34SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v35") return privacyContentProfileV35SourceKeys;
  if (fieldCatalogVersion === "privacy-safe-fields-v36") return privacyContentProfileV36SourceKeys;
  return privacyContentProfileSourceKeys;
}

export const privacyContentExclusionReasonCodes = [
  "not_personal_data_of_requester",
  "rights_and_freedoms_of_others",
  "legal_privilege",
  "security_sensitive",
  "internal_deliberative_material",
  "not_provided_or_observed_from_requester",
  "not_applicable_to_portability",
  "lawful_retention_or_restriction",
] as const;

const sourceKeySchema = z.enum(privacyContentProfileSourceKeys);
const exclusionReasonSchema = z.enum(privacyContentExclusionReasonCodes);
const canonicalText = (minimum: number, maximum: number) => z.string().min(minimum).max(maximum).refine(
  (value) => value === value.trim(),
  "Value must not contain leading or trailing whitespace.",
);
const excludedFieldSchema = z.object({
  field: canonicalText(1, 120),
  reasonCode: exclusionReasonSchema,
  explanation: canonicalText(20, 500),
}).strict();

const sourceRuleSchema = z.object({
  sourceKey: sourceKeySchema,
  includedFields: z.array(canonicalText(1, 120)).min(1).max(100),
  excludedFields: z.array(excludedFieldSchema).max(100),
}).strict();

const rightProfileSchema = z.object({
  sourceRules: z.array(sourceRuleSchema).min(1).max(142),
}).strict();

export const privacyContentProfileSchema = z.object({
  profileReference: canonicalText(3, 120),
  profileName: canonicalText(10, 160),
  schemaVersion: z.literal("privacy-content-profile-v1"),
  fieldCatalogVersion: z.enum(["privacy-safe-fields-v1", "privacy-safe-fields-v2", "privacy-safe-fields-v3", "privacy-safe-fields-v4", "privacy-safe-fields-v5", "privacy-safe-fields-v6", "privacy-safe-fields-v7", "privacy-safe-fields-v8", "privacy-safe-fields-v9", "privacy-safe-fields-v10", "privacy-safe-fields-v11", "privacy-safe-fields-v12", "privacy-safe-fields-v13", "privacy-safe-fields-v14", "privacy-safe-fields-v15", "privacy-safe-fields-v16", "privacy-safe-fields-v17", "privacy-safe-fields-v18", "privacy-safe-fields-v19", "privacy-safe-fields-v20", "privacy-safe-fields-v21", "privacy-safe-fields-v22", "privacy-safe-fields-v23", "privacy-safe-fields-v24", "privacy-safe-fields-v25", "privacy-safe-fields-v26", "privacy-safe-fields-v27", "privacy-safe-fields-v28", "privacy-safe-fields-v29", "privacy-safe-fields-v30", "privacy-safe-fields-v31", "privacy-safe-fields-v32", "privacy-safe-fields-v33", "privacy-safe-fields-v34", "privacy-safe-fields-v35", "privacy-safe-fields-v36", "privacy-safe-fields-v37", "privacy-safe-fields-v38", "privacy-safe-fields-v39", "privacy-safe-fields-v40", "privacy-safe-fields-v41", "privacy-safe-fields-v42", "privacy-safe-fields-v43", "privacy-safe-fields-v44", "privacy-safe-fields-v45"]),
  jurisdictionCode: z.string().regex(/^[A-Z0-9-]{2,16}$/),
  legalBasisReference: canonicalText(10, 500),
  effectiveScope: z.literal("authenticated_data_subject_access_and_portability"),
  access: rightProfileSchema,
  portability: rightProfileSchema,
}).strict().superRefine((profile, context) => {
  for (const right of ["access", "portability"] as const) {
    const rules = profile[right].sourceRules;
    const expectedSourceKeys = privacyContentProfileSourceKeysForRight(profile.fieldCatalogVersion, right);
    if (rules.length !== expectedSourceKeys.length) {
      context.addIssue({
        code: "custom",
        path: [right, "sourceRules"],
        message: `${right} must contain exactly ${expectedSourceKeys.length} source rules for ${profile.fieldCatalogVersion}.`,
      });
    }
    for (const [sourceIndex, expectedSourceKey] of expectedSourceKeys.entries()) {
      const rule = rules[sourceIndex];
      if (!rule || rule.sourceKey !== expectedSourceKey) {
        context.addIssue({
          code: "custom",
          path: [right, "sourceRules", sourceIndex, "sourceKey"],
          message: `Source rules must contain ${expectedSourceKey} in canonical catalogue order.`,
        });
        continue;
      }
      const expectedFields = privacySafeFieldCatalog[expectedSourceKey];
      const included = rule.includedFields;
      const excluded = rule.excludedFields.map((item) => item.field);
      const represented = [...included, ...excluded];
      if (new Set(represented).size !== represented.length) {
        context.addIssue({ code: "custom", path: [right, "sourceRules", sourceIndex], message: "Each safe field must be represented exactly once." });
      }
      const missing = expectedFields.filter((field) => !represented.includes(field));
      const unknown = represented.filter((field) => !expectedFields.includes(field));
      if (missing.length) {
        context.addIssue({ code: "custom", path: [right, "sourceRules", sourceIndex], message: `Missing safe fields: ${missing.join(", ")}.` });
      }
      if (unknown.length) {
        context.addIssue({ code: "custom", path: [right, "sourceRules", sourceIndex], message: `Unsupported fields: ${unknown.join(", ")}.` });
      }
      const canonicalIncluded = expectedFields.filter((field) => included.includes(field));
      const canonicalExcluded = expectedFields.filter((field) => excluded.includes(field));
      if (included.join("\u0000") !== canonicalIncluded.join("\u0000")) {
        context.addIssue({ code: "custom", path: [right, "sourceRules", sourceIndex, "includedFields"], message: "Included fields must follow canonical catalogue order." });
      }
      if (excluded.join("\u0000") !== canonicalExcluded.join("\u0000")) {
        context.addIssue({ code: "custom", path: [right, "sourceRules", sourceIndex, "excludedFields"], message: "Excluded fields must follow canonical catalogue order." });
      }
    }
  }
});

export type PrivacyContentProfile = z.infer<typeof privacyContentProfileSchema>;
export type PrivacyContentProfileRight = PrivacyContentProfile["access"];

export function parsePrivacyContentProfile(value: unknown): PrivacyContentProfile {
  return privacyContentProfileSchema.parse(value);
}

export function validatePrivacyContentProfile(value: unknown): string[] {
  const result = privacyContentProfileSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "profile"}: ${issue.message}`);
}
