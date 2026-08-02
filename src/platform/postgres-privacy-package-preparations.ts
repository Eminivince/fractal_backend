import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { parsePrivacyPackagePolicy } from "../modules/privacy/domain/privacy-package-policy.js";
import type {
  PrivacyPackageArtifactInput,
} from "../modules/privacy/domain/privacy-package-archive.js";
import { parsePrivacyContentProfile, type PrivacyContentProfileSourceKey } from "../modules/privacy/domain/privacy-content-profile.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import { AdministratorCapabilityError, requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import { PrivacyRightsError, readPrivacyFulfillmentCoverage, type FulfillmentCoverage } from "./postgres-privacy-rights.js";

const CAPABILITY = "privacy_request_manage";
const PACKAGE_POLICY_KEY = "privacy.rights.package_policy";
const CONTENT_PROFILE_KEY = "privacy.rights.content_profile";

type PackageRequestType = "access" | "portability";
type JsonRecord = Record<string, unknown>;

type SourceRow = {
  source_key: string;
  authority_key: string;
  source_kind: string;
  contains_personal_data: boolean;
  access_status: "available" | "unavailable" | "not_applicable";
  portability_status: "available" | "unavailable" | "not_applicable";
  blocker: string | null;
};

type PreparationRow = {
  id: string; reference: string; privacy_request_id: string; decision_request_id: string;
  requester_identity_id: string; request_type: PackageRequestType; request_version: number;
  policy_version_id: string; policy_version_number: number; policy_projection_version: number;
  policy_value_sha256: string; policy_reference: string; policy_name: string; canonical_format: string;
  identity_assurance: string; delivery_channel: string; maximum_records: number; maximum_bytes: number; maximum_artifacts: number;
  package_retention_hours: number; requester_retrieval_hours: number; coverage_snapshot: FulfillmentCoverage;
  content_profile_binding_status: "legacy_unprofiled" | "governed";
  content_profile_reference: string | null; content_profile_name: string | null;
  content_profile_schema_version: string | null; content_profile_field_catalog_version: string | null;
  content_profile_jurisdiction_code: string | null; content_profile_value_sha256: string | null;
  coverage_sha256: string; transaction_snapshot: string; audit_sequence_high_watermark: string;
  source_manifest: PrivacyPackageSourceManifest[]; source_manifest_sha256: string;
  external_snapshot_manifest: PrivacyExternalSnapshotManifestItem[];
  collected_source_count: number; unavailable_source_count: number; not_applicable_source_count: number;
  collected_record_count: number; collected_byte_count: number;
  outcome: "blocked_incomplete_coverage" | "ready_for_delivery"; deliverable: boolean;
  prepared_by_identity_id: string; prepared_at: Date;
};

export type PrivacyPackageSourceManifest = {
  sourceKey: string;
  authorityKey: string;
  status: "collected" | "unavailable" | "not_applicable";
  recordCount: number;
  byteCount: number;
  contentSha256: string | null;
  blocker: string | null;
};

export type CanonicalPrivacySourceSection = {
  sourceKey: string;
  records: JsonRecord[];
  artifacts?: PrivacyPackageArtifactInput[];
  canonicalContent: string;
  contentSha256: string;
  byteCount: number;
};

export type PrivacyExternalSnapshotManifestItem = {
  sourceKey: string;
  snapshotId: string;
  snapshotReference: string;
  contentSha256: string;
  recordCount: number;
  byteCount: number;
  collectedAt: string;
  expiresAt: string;
};

const collectors: ReadonlyArray<{ sourceKey: PrivacyContentProfileSourceKey; sql: string }> = [
  {
    sourceKey: "postgres.fractal.identities",
    sql: `SELECT jsonb_build_object(
      'email',email,'legalName',legal_name,'status',status,
      'emailVerifiedAt',email_verified_at,'credentialInvalidatedAt',credential_invalidated_at,
      'createdAt',created_at,'updatedAt',updated_at) AS record
      FROM fractal.identities WHERE id=$1 ORDER BY id`,
  },
  {
    sourceKey: "postgres.fractal.identity_role_assignments",
    sql: `SELECT jsonb_build_object(
      'role',role,'scopeType',scope_type,'scopeId',scope_id,
      'grantedAt',granted_at,'revokedAt',revoked_at) AS record
      FROM fractal.identity_role_assignments WHERE identity_id=$1 ORDER BY granted_at,id`,
  },
  {
    sourceKey: "postgres.fractal.auth_sessions",
    sql: `SELECT jsonb_build_object(
      'role',role,'businessId',business_id,
      'createdAt',created_at,'lastSeenAt',last_seen_at,'expiresAt',expires_at,'revokedAt',revoked_at,
      'revokedReason',revoked_reason) AS record
      FROM fractal.auth_sessions WHERE identity_id=$1 OR subject_id=$1::text ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.legal_document_acceptances",
    sql: `SELECT jsonb_build_object(
      'documentKey',document_key,
      'semanticVersion',semantic_version,'contentSha256',content_sha256,'acceptanceContext',acceptance_context,
      'affirmativeAction',affirmative_action,'acceptedAt',accepted_at) AS record
      FROM fractal.legal_document_acceptances WHERE identity_id=$1 ORDER BY accepted_at,id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_rights_requests",
    sql: `SELECT jsonb_build_object(
      'reference',reference,
      'requestType',request_type,'details',details,'identityAssurance',identity_assurance,
      'emailVerifiedAtSnapshot',email_verified_at_snapshot,'dueAt',due_at,
      'status',status,'createdAt',created_at,'lastActivityAt',last_activity_at) AS record
      FROM fractal.privacy_rights_requests WHERE requester_identity_id=$1 ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_rights_policy_bindings",
    sql: `SELECT jsonb_build_object(
      'requestReference',request.reference,
      'policyReference',binding.policy_reference,'policyName',binding.policy_name,'jurisdiction',binding.jurisdiction,
      'controllerName',binding.controller_name,'identityAssurance',binding.identity_assurance,
      'communicationChannel',binding.communication_channel,'deadlineBasis',binding.deadline_basis,
      'responseCalendarDays',binding.response_calendar_days,'requestCreatedAt',binding.request_created_at,
      'dueAt',binding.due_at,'boundAt',binding.bound_at) AS record
      FROM fractal.privacy_rights_policy_bindings binding
      JOIN fractal.privacy_rights_requests request ON request.id=binding.privacy_request_id
      WHERE request.requester_identity_id=$1 ORDER BY binding.bound_at,binding.privacy_request_id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_rights_request_events",
    sql: `SELECT jsonb_build_object(
      'requestReference',request.reference,'sequence',event.sequence,'eventType',event.event_type,
      'fromStatus',event.from_status,'toStatus',event.to_status,
      'visibility',event.visibility,'message',event.message,
      'occurredAt',event.occurred_at) AS record
      FROM fractal.privacy_rights_request_events event
      JOIN fractal.privacy_rights_requests request ON request.id=event.privacy_request_id
      WHERE request.requester_identity_id=$1 AND event.visibility='requester'
      ORDER BY event.privacy_request_id,event.sequence,event.id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_rights_decision_requests",
    sql: `SELECT jsonb_build_object(
      'reference',decision.reference,'requestReference',request.reference,
      'outcome',decision.outcome,'decisionSummary',decision.decision_summary,'lawfulBasis',decision.lawful_basis,
      'scopeOutcomes',decision.scope_outcomes,'status',decision.status,
      'requestedAt',decision.requested_at,'reviewedAt',decision.reviewed_at,'appliedAt',decision.applied_at) AS record
      FROM fractal.privacy_rights_decision_requests decision
      JOIN fractal.privacy_rights_requests request ON request.id=decision.privacy_request_id
      WHERE request.requester_identity_id=$1 AND decision.status='applied'
      ORDER BY decision.requested_at,decision.id`,
  },
  {
    sourceKey: "postgres.fractal.auth_email_deliveries",
    sql: `SELECT jsonb_build_object(
      'deliveryType',delivery_type,'status',status,'attempts',attempts,
      'nextAttemptAt',next_attempt_at,'sentAt',sent_at,'terminalAt',terminal_at,
      'requestedAt',requested_at,'updatedAt',updated_at) AS record
      FROM fractal.auth_email_deliveries WHERE identity_id=$1 ORDER BY requested_at,id`,
  },
  {
    sourceKey: "postgres.fractal.auth_step_up_grants",
    sql: `SELECT jsonb_build_object(
      'method',method,'grantedAt',granted_at,'expiresAt',expires_at) AS record
      FROM fractal.auth_step_up_grants WHERE identity_id=$1 ORDER BY granted_at,session_id`,
  },
  {
    sourceKey: "postgres.fractal.security_notifications",
    sql: `SELECT jsonb_build_object(
      'eventType',event_type,'createdAt',created_at,'readAt',read_at) AS record
      FROM fractal.security_notifications WHERE subject_id=$1::text ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.totp_factors",
    sql: `SELECT jsonb_build_object(
      'confirmedAt',confirmed_at,'disabledAt',disabled_at,'createdAt',created_at,'updatedAt',updated_at) AS record
      FROM fractal.totp_factors WHERE identity_id=$1 ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.totp_recovery_codes",
    sql: `SELECT jsonb_build_object(
      'createdAt',created_at,'usedAt',used_at,'replacedAt',replaced_at) AS record
      FROM fractal.totp_recovery_codes WHERE identity_id=$1 ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.identity_access_change_requests",
    sql: `SELECT jsonb_build_object(
      'changeType',change_type,'priorRole',prior_role,'proposedRole',proposed_role,'priorStatus',prior_status,
      'status',status,'requestedAt',requested_at,'reviewedAt',reviewed_at,'appliedAt',applied_at) AS record
      FROM fractal.identity_access_change_requests WHERE target_identity_id=$1 ORDER BY requested_at,id`,
  },
  {
    sourceKey: "postgres.fractal.administrator_capability_assignments",
    sql: `SELECT jsonb_build_object(
      'capabilityKey',capability_key,'grantedAt',granted_at,'revokedAt',revoked_at) AS record
      FROM fractal.administrator_capability_assignments WHERE identity_id=$1 ORDER BY granted_at,id`,
  },
  {
    sourceKey: "postgres.fractal.administrator_capability_change_requests",
    sql: `SELECT jsonb_build_object(
      'capabilityKey',capability_key,'changeType',change_type,'priorEnabled',prior_enabled,'status',status,
      'requestedAt',requested_at,'reviewedAt',reviewed_at,'appliedAt',applied_at) AS record
      FROM fractal.administrator_capability_change_requests WHERE target_identity_id=$1 ORDER BY requested_at,id`,
  },
  {
    sourceKey: "postgres.fractal.administrator_recovery_requests",
    sql: `SELECT jsonb_build_object(
      'incidentReference',incident_reference,'status',status,'requestedAt',requested_at,'expiresAt',expires_at,
      'reviewedAt',reviewed_at,'appliedAt',applied_at) AS record
      FROM fractal.administrator_recovery_requests WHERE target_identity_id=$1 ORDER BY requested_at,id`,
  },
  {
    sourceKey: "postgres.fractal.administrator_audit_exports",
    sql: `SELECT jsonb_build_object(
      'sequenceHighWatermark',sequence_high_watermark,'firstSequence',first_sequence,'lastSequence',last_sequence,
      'recordCount',record_count,'contentSha256',content_sha256,'createdAt',created_at) AS record
      FROM fractal.administrator_audit_exports WHERE requested_by_identity_id=$1 ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.provider_identity_verification_applications",
    sql: `SELECT jsonb_build_object(
      'provider',provider,'status',status,'readyAt',ready_at,'terminalAt',terminal_at,
      'createdAt',created_at,'updatedAt',updated_at) AS record
      FROM fractal.provider_identity_verification_applications WHERE identity_id=$1 ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.provider_identity_verification_events",
    sql: `SELECT jsonb_build_object(
      'provider',provider,'eventType',event_type,'reviewStatus',review_status,'reviewAnswer',review_answer,
      'providerCreatedAt',provider_created_at,'receivedAt',received_at,'recordedAt',recorded_at) AS record
      FROM fractal.provider_identity_verification_events WHERE identity_id=$1 ORDER BY received_at,id`,
  },
  {
    sourceKey: "postgres.fractal.agreement_acceptances",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering.public_reference,'offeringVersion',version.version,
      'agreementDocumentHash',acceptance.agreement_document_hash,'signatureName',acceptance.signature_name,
      'executionHash',acceptance.execution_hash,'acceptedAt',acceptance.accepted_at,'createdAt',acceptance.created_at) AS record
      FROM fractal.agreement_acceptances acceptance
      JOIN fractal.offering_publication_versions version ON version.id=acceptance.offering_version_id
      JOIN fractal.offering_products offering ON offering.id=version.offering_id
      WHERE acceptance.investor_identity_id=$1 ORDER BY acceptance.accepted_at,acceptance.id`,
  },
  {
    sourceKey: "postgres.fractal.platform_content_events",
    sql: `SELECT jsonb_build_object(
      'documentKey',version.document_key,'semanticVersion',version.semantic_version,'sequence',event.sequence,
      'eventType',event.event_type,'fromStatus',event.from_status,'toStatus',event.to_status,'occurredAt',event.occurred_at) AS record
      FROM fractal.platform_content_events event
      JOIN fractal.platform_content_versions version ON version.id=event.content_version_id
      WHERE event.actor_identity_id=$1 ORDER BY event.occurred_at,event.content_version_id,event.sequence`,
  },
  {
    sourceKey: "postgres.fractal.platform_content_publications",
    sql: `SELECT jsonb_build_object(
      'documentKey',publication.document_key,'semanticVersion',version.semantic_version,
      'relationship',CASE WHEN version.proposed_by_identity_id=$1 THEN 'proposer' ELSE 'reviewer' END,
      'projectionVersion',publication.projection_version,'boundAt',publication.bound_at) AS record
      FROM fractal.platform_content_publications publication
      JOIN fractal.platform_content_versions version ON version.id=publication.published_version_id
      WHERE version.proposed_by_identity_id=$1 OR version.reviewed_by_identity_id=$1
      ORDER BY publication.bound_at,publication.document_key`,
  },
  {
    sourceKey: "postgres.fractal.platform_content_versions",
    sql: `SELECT jsonb_build_object(
      'documentKey',document_key,'semanticVersion',semantic_version,
      'relationship',CASE WHEN proposed_by_identity_id=$1 THEN 'proposer' ELSE 'reviewer' END,
      'status',status,'reacceptanceRequired',reacceptance_required,'effectiveAt',effective_at,'proposedAt',proposed_at,
      'reviewedAt',reviewed_at,'publishedAt',published_at,'supersededAt',superseded_at) AS record
      FROM fractal.platform_content_versions
      WHERE proposed_by_identity_id=$1 OR reviewed_by_identity_id=$1 ORDER BY proposed_at,id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_rights_package_preparations",
    sql: `SELECT jsonb_build_object(
      'reference',preparation.reference,'requestReference',request.reference,'requestType',preparation.request_type,
      'requestVersion',preparation.request_version,'contentProfileReference',preparation.content_profile_reference,
      'fieldCatalogVersion',preparation.content_profile_field_catalog_version,
      'collectedSourceCount',preparation.collected_source_count,'unavailableSourceCount',preparation.unavailable_source_count,
      'notApplicableSourceCount',preparation.not_applicable_source_count,'collectedRecordCount',preparation.collected_record_count,
      'collectedByteCount',preparation.collected_byte_count,'outcome',preparation.outcome,
      'deliverable',preparation.deliverable,'preparedAt',preparation.prepared_at) AS record
      FROM fractal.privacy_rights_package_preparations preparation
      JOIN fractal.privacy_rights_requests request ON request.id=preparation.privacy_request_id
      WHERE preparation.requester_identity_id=$1 AND ($2::uuid IS NULL OR preparation.id<>$2::uuid)
      ORDER BY preparation.prepared_at,preparation.id`,
  },
  {
    sourceKey: "postgres.fractal.platform_configuration_activation_attempts",
    sql: `SELECT jsonb_build_object(
      'configurationKey',version.configuration_key,'versionNumber',version.version_number,
      'relationship',CASE WHEN version.proposed_by_identity_id=$1 THEN 'proposer' ELSE 'reviewer' END,
      'outcome',attempt.outcome,'dueAt',attempt.due_at,'attemptedAt',attempt.attempted_at,'latenessMs',attempt.lateness_ms) AS record
      FROM fractal.platform_configuration_activation_attempts attempt
      JOIN fractal.platform_configuration_versions version ON version.id=attempt.configuration_version_id
      WHERE version.proposed_by_identity_id=$1 OR version.reviewed_by_identity_id=$1
      ORDER BY attempt.attempted_at,attempt.id`,
  },
  {
    sourceKey: "postgres.fractal.platform_configuration_active_versions",
    sql: `SELECT jsonb_build_object(
      'configurationKey',active.configuration_key,'versionNumber',version.version_number,
      'relationship',CASE WHEN version.proposed_by_identity_id=$1 THEN 'proposer' ELSE 'reviewer' END,
      'projectionVersion',active.projection_version,'boundAt',active.bound_at) AS record
      FROM fractal.platform_configuration_active_versions active
      JOIN fractal.platform_configuration_versions version ON version.id=active.active_version_id
      WHERE version.proposed_by_identity_id=$1 OR version.reviewed_by_identity_id=$1
      ORDER BY active.bound_at,active.configuration_key`,
  },
  {
    sourceKey: "postgres.fractal.platform_configuration_events",
    sql: `SELECT jsonb_build_object(
      'configurationKey',version.configuration_key,'versionNumber',version.version_number,'sequence',event.sequence,
      'eventType',event.event_type,'fromStatus',event.from_status,'toStatus',event.to_status,'occurredAt',event.occurred_at) AS record
      FROM fractal.platform_configuration_events event
      JOIN fractal.platform_configuration_versions version ON version.id=event.configuration_version_id
      WHERE event.actor_identity_id=$1 ORDER BY event.occurred_at,event.configuration_version_id,event.sequence`,
  },
  {
    sourceKey: "postgres.fractal.platform_configuration_versions",
    sql: `SELECT jsonb_build_object(
      'configurationKey',configuration_key,'versionNumber',version_number,
      'relationship',CASE WHEN proposed_by_identity_id=$1 THEN 'proposer' ELSE 'reviewer' END,
      'status',status,'effectiveAt',effective_at,'proposedAt',proposed_at,'reviewedAt',reviewed_at,
      'activatedAt',activated_at,'supersededAt',superseded_at) AS record
      FROM fractal.platform_configuration_versions
      WHERE proposed_by_identity_id=$1 OR reviewed_by_identity_id=$1 ORDER BY proposed_at,id`,
  },
  {
    sourceKey: "postgres.fractal.administrator_provider_incident_events",
    sql: `SELECT jsonb_build_object(
      'providerKey',incident.provider_key,
      'relationship',CASE WHEN event.actor_identity_id=$1 THEN 'actor' WHEN event.owner_identity_id=$1 THEN 'owner' ELSE 'former_owner' END,
      'sequence',event.sequence,'eventType',event.event_type,'fromStatus',event.from_status,'toStatus',event.to_status,
      'fromSeverity',event.from_severity,'severity',event.severity,
      'acknowledgementDueAt',event.acknowledgement_due_at,'resolutionDueAt',event.resolution_due_at,
      'acknowledgedAt',event.acknowledged_at,'containedAt',event.contained_at,'resolvedAt',event.resolved_at,
      'occurredAt',event.occurred_at) AS record
      FROM fractal.administrator_provider_incident_events event
      JOIN fractal.administrator_provider_incidents incident ON incident.id=event.incident_id
      WHERE event.actor_identity_id=$1 OR event.from_owner_identity_id=$1 OR event.owner_identity_id=$1
      ORDER BY event.occurred_at,event.incident_id,event.sequence`,
  },
  {
    sourceKey: "postgres.fractal.administrator_provider_incidents",
    sql: `SELECT jsonb_build_object(
      'providerKey',incident.provider_key,'source',incident.source,
      'relationship',CASE WHEN incident.created_by_identity_id=$1 THEN 'creator' WHEN incident.owner_identity_id=$1 THEN 'current_owner' ELSE 'historical_participant' END,
      'severity',incident.severity,'status',incident.status,'detectedAt',incident.detected_at,
      'acknowledgementDueAt',incident.acknowledgement_due_at,'resolutionDueAt',incident.resolution_due_at,
      'acknowledgedAt',incident.acknowledged_at,'containedAt',incident.contained_at,'resolvedAt',incident.resolved_at,
      'version',incident.version,'createdAt',incident.created_at,'updatedAt',incident.updated_at) AS record
      FROM fractal.administrator_provider_incidents incident
      WHERE incident.created_by_identity_id=$1 OR incident.owner_identity_id=$1 OR EXISTS (
        SELECT 1 FROM fractal.administrator_provider_incident_events event
         WHERE event.incident_id=incident.id
           AND (event.actor_identity_id=$1 OR event.from_owner_identity_id=$1 OR event.owner_identity_id=$1)
      ) ORDER BY incident.created_at,incident.id`,
  },
  {
    sourceKey: "postgres.fractal.support_case_events",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,
      'relationship',CASE WHEN event.actor_identity_id=$1 THEN 'requester_action' ELSE 'service_response' END,
      'sequence',event.sequence,'eventType',event.event_type,'fromStatus',event.from_status,'toStatus',event.to_status,
      'message',event.message,'occurredAt',event.occurred_at) AS record
      FROM fractal.support_case_events event
      JOIN fractal.support_cases support_case ON support_case.id=event.case_id
      WHERE support_case.requester_identity_id=$1 AND event.visibility='requester'
      ORDER BY support_case.created_at,event.case_id,event.sequence`,
  },
  {
    sourceKey: "postgres.fractal.support_cases",
    sql: `SELECT jsonb_build_object(
      'reference',reference,'requesterRole',requester_role,'category',category,'reportedImpact',reported_impact,
      'subject',subject,'description',description,'relatedReference',related_reference,'occurredAt',occurred_at,
      'status',status,'resolutionSummary',resolution_summary,'version',version,'createdAt',created_at,
      'lastActivityAt',last_activity_at) AS record
      FROM fractal.support_cases WHERE requester_identity_id=$1 ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.support_case_attachment_access_events",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,'filename',attachment.filename,
      'relationship',CASE WHEN event.actor_identity_id=$1 THEN 'requester_download' ELSE 'service_access' END,
      'accessType',event.access_type,'contentSha256',event.content_sha256,
      'integrityVerified',event.integrity_verified,'occurredAt',event.occurred_at) AS record
      FROM fractal.support_case_attachment_access_events event
      JOIN fractal.support_case_attachments attachment ON attachment.id=event.attachment_id
      JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
      WHERE support_case.requester_identity_id=$1 AND attachment.visibility='requester'
      ORDER BY support_case.created_at,attachment.id,event.occurred_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.support_case_attachments",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,
      'relationship',CASE WHEN attachment.uploaded_by_identity_id=$1 THEN 'requester_upload' ELSE 'service_attachment' END,
      'classification',attachment.classification,'filename',attachment.filename,'mimeType',attachment.mime_type,
      'bytes',attachment.bytes,'contentSha256',attachment.content_sha256,'scanStatus',attachment.scan_status,
      'scanner',attachment.scanner,'scannedAt',attachment.scanned_at,'policyReference',attachment.policy_reference,
      'policyName',attachment.policy_name,'retentionDays',attachment.retention_days,
      'uploadedAt',attachment.uploaded_at,'retentionDueAt',attachment.retention_due_at) AS record
      FROM fractal.support_case_attachments attachment
      JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
      WHERE support_case.requester_identity_id=$1 AND attachment.visibility='requester'
      ORDER BY support_case.created_at,attachment.uploaded_at,attachment.id`,
  },
  {
    sourceKey: "postgres.fractal.investor_wallet_link_challenges",
    sql: `SELECT jsonb_build_object(
      'chainId',chain_id,'walletAddress',wallet_address,'status',status,
      'expiresAt',expires_at,'consumedAt',consumed_at,'createdAt',created_at) AS record
      FROM fractal.investor_wallet_link_challenges
      WHERE investor_identity_id=$1
      ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.investor_wallets",
    sql: `SELECT jsonb_build_object(
      'chainId',chain_id,'walletAddress',wallet_address,'status',status,
      'verifiedAt',verified_at,'revokedAt',revoked_at,'createdAt',created_at) AS record
      FROM fractal.investor_wallets
      WHERE investor_identity_id=$1
      ORDER BY verified_at,id`,
  },
  {
    sourceKey: "postgres.fractal.investor_compliance_profile_reviews",
    sql: `SELECT jsonb_build_object(
      'kycStatus',request.kyc_status,'investorClass',request.investor_class,
      'accreditationStatus',request.accreditation_status,'jurisdictionCode',request.jurisdiction_code,
      'reviewedAt',request.reviewed_at,'expiresAt',request.expires_at,
      'approvedAt',review.approved_at,'createdAt',review.created_at) AS record
      FROM fractal.investor_compliance_profile_reviews review
      JOIN fractal.investor_compliance_review_requests request
        ON request.id=review.review_request_id AND request.investor_identity_id=review.investor_identity_id
      WHERE review.investor_identity_id=$1
      ORDER BY review.approved_at,review.id`,
  },
  {
    sourceKey: "postgres.fractal.investor_compliance_profiles",
    sql: `SELECT jsonb_build_object(
      'kycStatus',kyc_status,'investorClass',investor_class,
      'accreditationStatus',accreditation_status,'jurisdictionCode',jurisdiction_code,
      'reviewedAt',reviewed_at,'expiresAt',expires_at,'updatedAt',updated_at) AS record
      FROM fractal.investor_compliance_profiles
      WHERE identity_id=$1`,
  },
  {
    sourceKey: "postgres.fractal.investor_compliance_review_requests",
    sql: `SELECT jsonb_build_object(
      'kycStatus',kyc_status,'investorClass',investor_class,
      'accreditationStatus',accreditation_status,'jurisdictionCode',jurisdiction_code,
      'reviewedAt',reviewed_at,'expiresAt',expires_at,'status',status,
      'submittedAt',submitted_at,'decidedAt',decided_at,'createdAt',created_at) AS record
      FROM fractal.investor_compliance_review_requests
      WHERE investor_identity_id=$1
      ORDER BY submitted_at,id`,
  },
  {
    sourceKey: "postgres.fractal.investment_eligibility_snapshots",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering.public_reference,'offeringVersion',version.version,
      'status',snapshot.status,'reasonCodes',snapshot.reason_codes,
      'evaluatedAt',snapshot.evaluated_at,'expiresAt',snapshot.expires_at,'createdAt',snapshot.created_at) AS record
      FROM fractal.investment_eligibility_snapshots snapshot
      JOIN fractal.offering_publication_versions version ON version.id=snapshot.offering_version_id
      JOIN fractal.offering_products offering ON offering.id=version.offering_id
      WHERE snapshot.investor_identity_id=$1
      ORDER BY snapshot.evaluated_at,snapshot.id`,
  },
  {
    sourceKey: "postgres.fractal.investment_commitments",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering_reference,'currency',currency,
      'committedMinor',committed_minor::text,'status',status,
      'createdAt',created_at,'updatedAt',updated_at) AS record
      FROM fractal.investment_commitments
      WHERE investor_identity_id=$1
      ORDER BY created_at,id`,
  },
  {
    sourceKey: "postgres.fractal.investment_reservations",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering.public_reference,'offeringVersion',version.version,
      'amountMinor',reservation.amount_minor::text,'currency',reservation.currency,'status',reservation.status,
      'expiresAt',reservation.expires_at,'createdAt',reservation.created_at,'updatedAt',reservation.updated_at) AS record
      FROM fractal.investment_reservations reservation
      JOIN fractal.offering_products offering ON offering.id=reservation.offering_id
      JOIN fractal.offering_publication_versions version
        ON version.id=reservation.offering_version_id AND version.offering_id=reservation.offering_id
      WHERE reservation.investor_identity_id=$1
      ORDER BY reservation.created_at,reservation.id`,
  },
  {
    sourceKey: "postgres.fractal.investment_allocation_requests",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering.public_reference,'chainId',allocation.chain_id,
      'walletAddress',allocation.wallet_address,'investedMinor',allocation.invested_minor::text,
      'currency',allocation.currency,'tokenUnitPriceMinor',allocation.token_unit_price_minor::text,
      'tokenAmount',allocation.token_amount::text,'status',allocation.status,
      'submittedAt',allocation.submitted_at,'decidedAt',allocation.decided_at) AS record
      FROM fractal.investment_allocation_requests allocation
      JOIN fractal.offering_products offering ON offering.id=allocation.offering_id
      WHERE allocation.investor_identity_id=$1
      ORDER BY allocation.submitted_at,allocation.id`,
  },
  {
    sourceKey: "postgres.fractal.investment_allocation_chain_operations",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering.public_reference,'chainId',operation.chain_id,
      'tokenContractAddress',operation.token_contract_address,'walletAddress',operation.wallet_address,
      'tokenAmount',operation.token_amount::text,'operationType',operation.operation_type,'status',operation.status,
      'transactionHash',operation.transaction_hash,'submittedAt',operation.submitted_at,
      'confirmedAt',operation.confirmed_at,'createdAt',operation.created_at,'updatedAt',operation.updated_at) AS record
      FROM fractal.investment_allocation_chain_operations operation
      JOIN fractal.investment_allocation_requests allocation ON allocation.id=operation.allocation_request_id
      JOIN fractal.offering_products offering ON offering.id=operation.offering_id AND offering.id=allocation.offering_id
      WHERE allocation.investor_identity_id=$1
      ORDER BY operation.created_at,operation.id`,
  },
  {
    sourceKey: "postgres.fractal.investment_allocation_chain_dispatch_claims",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',offering.public_reference,'chainId',operation.chain_id,
      'operationType',operation.operation_type,'status',claim.status,'transactionHash',claim.transaction_hash,
      'claimedAt',claim.claimed_at,'completedAt',claim.completed_at) AS record
      FROM fractal.investment_allocation_chain_dispatch_claims claim
      JOIN fractal.investment_allocation_chain_operations operation ON operation.id=claim.operation_id
      JOIN fractal.investment_allocation_requests allocation ON allocation.id=operation.allocation_request_id
      JOIN fractal.offering_products offering ON offering.id=operation.offering_id AND offering.id=allocation.offering_id
      WHERE allocation.investor_identity_id=$1
      ORDER BY claim.claimed_at,claim.id`,
  },
  {
    sourceKey: "postgres.fractal.payment_intents",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',commitment.offering_reference,'provider',intent.provider,
      'expectedMinor',intent.expected_minor::text,'currency',intent.currency,'status',intent.status,
      'expiresAt',intent.expires_at,'createdAt',intent.created_at,'updatedAt',intent.updated_at) AS record
      FROM fractal.payment_intents intent
      JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
      WHERE commitment.investor_identity_id=$1 ORDER BY intent.created_at,intent.id`,
  },
  {
    sourceKey: "postgres.fractal.payment_provider_instructions",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',commitment.offering_reference,'provider',instruction.provider,
      'status',instruction.status,'initializedAt',instruction.initialized_at,'terminalAt',instruction.terminal_at,
      'createdAt',instruction.created_at,'updatedAt',instruction.updated_at) AS record
      FROM fractal.payment_provider_instructions instruction
      JOIN fractal.payment_intents intent ON intent.id=instruction.payment_intent_id
      JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
      WHERE commitment.investor_identity_id=$1 ORDER BY instruction.created_at,instruction.id`,
  },
  {
    sourceKey: "postgres.fractal.payment_receipts",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',commitment.offering_reference,'provider',receipt.provider,
      'amountMinor',receipt.amount_minor::text,'currency',receipt.currency,'status',receipt.status,
      'receivedAt',receipt.received_at,'createdAt',receipt.created_at) AS record
      FROM fractal.payment_receipts receipt
      JOIN fractal.payment_intents intent ON intent.id=receipt.payment_intent_id
      JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
      WHERE commitment.investor_identity_id=$1 ORDER BY receipt.received_at,receipt.id`,
  },
  {
    sourceKey: "postgres.fractal.payment_reconciliation_cases",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',commitment.offering_reference,'caseType',reconciliation.case_type,
      'status',reconciliation.status,'expectedMinor',reconciliation.expected_minor::text,
      'actualMinor',reconciliation.actual_minor::text,'currency',reconciliation.currency,
      'resolvedAt',reconciliation.resolved_at,'createdAt',reconciliation.created_at) AS record
      FROM fractal.payment_reconciliation_cases reconciliation
      JOIN fractal.payment_receipts receipt ON receipt.id=reconciliation.receipt_id
      JOIN fractal.payment_intents intent ON intent.id=receipt.payment_intent_id
      JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
      WHERE commitment.investor_identity_id=$1 ORDER BY reconciliation.created_at,reconciliation.id`,
  },
  {
    sourceKey: "postgres.fractal.journal_entries",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',commitment.offering_reference,'currency',journal.currency,
      'status',journal.status,'effectiveAt',journal.effective_at,'createdAt',journal.created_at) AS record
      FROM fractal.journal_entries journal
      JOIN fractal.payment_receipts receipt ON receipt.journal_id=journal.id
      JOIN fractal.payment_intents intent ON intent.id=receipt.payment_intent_id
      JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
      WHERE commitment.investor_identity_id=$1 ORDER BY journal.effective_at,journal.id`,
  },
  {
    sourceKey: "postgres.fractal.journal_postings",
    sql: `SELECT jsonb_build_object(
      'offeringPublicReference',commitment.offering_reference,'lineNumber',posting.line_number,
      'direction',posting.direction,'amountMinor',posting.amount_minor::text,
      'currency',posting.currency,'createdAt',posting.created_at) AS record
      FROM fractal.journal_postings posting
      JOIN fractal.journal_entries journal ON journal.id=posting.journal_id
      JOIN fractal.payment_receipts receipt ON receipt.journal_id=journal.id
      JOIN fractal.payment_intents intent ON intent.id=receipt.payment_intent_id
      JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
      WHERE commitment.investor_identity_id=$1 ORDER BY journal.effective_at,posting.journal_id,posting.line_number`,
  },
  {
    sourceKey: "postgres.fractal.support_case_service_obligations",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,'cycleNumber',obligation.cycle_number,
      'policyReference',obligation.policy_reference,'policyName',obligation.policy_name,'priority',obligation.priority,
      'acknowledgementDueAt',obligation.acknowledgement_due_at,'escalationDueAt',obligation.escalation_due_at,
      'resolutionDueAt',obligation.resolution_due_at,'openedAt',obligation.opened_at,'createdAt',obligation.created_at) AS record
      FROM fractal.support_case_service_obligations obligation
      JOIN fractal.support_cases support_case ON support_case.id=obligation.case_id
      WHERE support_case.requester_identity_id=$1 ORDER BY obligation.opened_at,obligation.id`,
  },
  {
    sourceKey: "postgres.fractal.support_case_service_events",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,'cycleNumber',obligation.cycle_number,
      'eventType',event.event_type,'actorType',event.actor_type,'dueAt',event.due_at,
      'occurredAt',event.occurred_at,'latenessMs',event.lateness_ms::text) AS record
      FROM fractal.support_case_service_events event
      JOIN fractal.support_case_service_obligations obligation ON obligation.id=event.obligation_id
      JOIN fractal.support_cases support_case ON support_case.id=obligation.case_id
      WHERE support_case.requester_identity_id=$1 ORDER BY obligation.cycle_number,event.occurred_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.support_case_notification_deliveries",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,'caseEventSequence',delivery.case_event_sequence,
      'notificationType',delivery.notification_type,'channel',delivery.channel,'status',delivery.status,
      'attempts',delivery.attempts,'requestedAt',delivery.requested_at,'sentAt',delivery.sent_at,
      'terminalAt',delivery.terminal_at,'cancelledAt',delivery.cancelled_at,'updatedAt',delivery.updated_at) AS record
      FROM fractal.support_case_notification_deliveries delivery
      JOIN fractal.support_cases support_case ON support_case.id=delivery.case_id
      WHERE support_case.requester_identity_id=$1 AND delivery.recipient_identity_id=$1
      ORDER BY delivery.requested_at,delivery.id`,
  },
  {
    sourceKey: "postgres.fractal.data_legal_hold_change_requests",
    sql: `SELECT jsonb_build_object(
      'reference',request.reference,'targetType',request.target_type,'changeType',request.change_type,
      'status',request.status,'requestedAt',request.requested_at,'reviewedAt',request.reviewed_at,
      'appliedAt',request.applied_at) AS record
      FROM fractal.data_legal_hold_change_requests request
      WHERE (request.target_type='identity' AND request.target_id=$1)
         OR (request.target_type='support_case' AND EXISTS (
              SELECT 1 FROM fractal.support_cases support_case
              WHERE support_case.id=request.target_id AND support_case.requester_identity_id=$1))
         OR (request.target_type='support_attachment' AND EXISTS (
              SELECT 1 FROM fractal.support_case_attachments attachment
              JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
              WHERE attachment.id=request.target_id AND support_case.requester_identity_id=$1))
         OR fractal.distribution_lifecycle_target_involves_identity(request.target_type,request.target_id,$1)
      ORDER BY request.requested_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.data_legal_holds",
    sql: `SELECT jsonb_build_object(
      'reference',hold_record.reference,'targetType',hold_record.target_type,
      'imposedAt',hold_record.imposed_at,'releasedAt',hold_record.released_at) AS record
      FROM fractal.data_legal_holds hold_record
      WHERE (hold_record.target_type='identity' AND hold_record.target_id=$1)
         OR (hold_record.target_type='support_case' AND EXISTS (
              SELECT 1 FROM fractal.support_cases support_case
              WHERE support_case.id=hold_record.target_id AND support_case.requester_identity_id=$1))
         OR (hold_record.target_type='support_attachment' AND EXISTS (
              SELECT 1 FROM fractal.support_case_attachments attachment
              JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
              WHERE attachment.id=hold_record.target_id AND support_case.requester_identity_id=$1))
         OR fractal.distribution_lifecycle_target_involves_identity(hold_record.target_type,hold_record.target_id,$1)
      ORDER BY hold_record.imposed_at,hold_record.id`,
  },
  {
    sourceKey: "postgres.fractal.organizations",
    sql: `SELECT jsonb_build_object(
      'legalName',organization.legal_name,'status',organization.status,
      'jurisdictionCode',organization.jurisdiction_code,'entityType',organization.entity_type,
      'primaryActivity',organization.primary_activity,'verificationStatus',organization.verification_status,
      'verificationUpdatedAt',organization.verification_updated_at,'verifiedAt',organization.verified_at,
      'verificationExpiresAt',organization.verification_expires_at,'createdAt',organization.created_at,
      'updatedAt',organization.updated_at) AS record
      FROM fractal.organizations organization
      WHERE organization.created_by_identity_id=$1 OR EXISTS (
        SELECT 1 FROM fractal.organization_memberships membership
        WHERE membership.organization_id=organization.id AND membership.identity_id=$1)
      ORDER BY organization.created_at,organization.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_memberships",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'role',membership.role,'status',membership.status,
      'grantedAt',membership.granted_at,'revokedAt',membership.revoked_at) AS record
      FROM fractal.organization_memberships membership
      JOIN fractal.organizations organization ON organization.id=membership.organization_id
      WHERE membership.identity_id=$1 ORDER BY membership.granted_at,membership.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_invitations",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'email',invitation.email,'role',invitation.role,
      'status',CASE WHEN invitation.accepted_at IS NOT NULL THEN 'accepted'
                    WHEN invitation.revoked_at IS NOT NULL THEN 'revoked'
                    WHEN invitation.expires_at<=CURRENT_TIMESTAMP THEN 'expired' ELSE 'pending' END,
      'expiresAt',invitation.expires_at,'acceptedAt',invitation.accepted_at,'revokedAt',invitation.revoked_at,
      'createdAt',invitation.created_at,'updatedAt',invitation.updated_at) AS record
      FROM fractal.organization_invitations invitation
      JOIN fractal.organizations organization ON organization.id=invitation.organization_id
      JOIN fractal.identities identity ON identity.id=$1
      WHERE invitation.accepted_by_identity_id=$1 OR invitation.email=identity.email
      ORDER BY invitation.created_at,invitation.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_ownership_transfer_requests",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,
      'participantSide',CASE WHEN source_membership.identity_id=$1 THEN 'source' ELSE 'target' END,
      'status',request.status,'expiresAt',request.expires_at,'decidedAt',request.decided_at,
      'createdAt',request.created_at,'updatedAt',request.updated_at) AS record
      FROM fractal.organization_ownership_transfer_requests request
      JOIN fractal.organizations organization ON organization.id=request.organization_id
      JOIN fractal.organization_memberships source_membership ON source_membership.id=request.source_membership_id
      JOIN fractal.organization_memberships target_membership ON target_membership.id=request.target_membership_id
      WHERE source_membership.identity_id=$1 OR target_membership.identity_id=$1
      ORDER BY request.created_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_verification_requests",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'version',request.version,'legalName',request.legal_name,
      'registrationNumber',request.registration_number,'jurisdictionCode',request.jurisdiction_code,
      'entityType',request.entity_type,'primaryActivity',request.primary_activity,
      'registeredAddress',request.registered_address,'representativeAuthorityBasis',request.representative_authority_basis,
      'status',request.status,'submittedAt',request.submitted_at,'decidedAt',request.decided_at,
      'verificationExpiresAt',request.verification_expires_at,'createdAt',request.created_at) AS record
      FROM fractal.organization_verification_requests request
      JOIN fractal.organizations organization ON organization.id=request.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY request.created_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_verification_evidence_documents",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'evidenceType',document.evidence_type,
      'filename',document.filename,'mimeType',document.mime_type,'contentSha256',document.content_sha256,
      'bytes',document.bytes::text,'createdAt',document.created_at) AS record
      FROM fractal.organization_verification_evidence_documents document
      JOIN fractal.organizations organization ON organization.id=document.organization_id
      WHERE document.uploaded_by_identity_id=$1 ORDER BY document.created_at,document.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_verification_request_evidence",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'requestVersion',request.version,
      'evidenceType',link.evidence_type,'filename',document.filename,'contentSha256',document.content_sha256) AS record
      FROM fractal.organization_verification_request_evidence link
      JOIN fractal.organization_verification_requests request ON request.id=link.verification_request_id
      JOIN fractal.organizations organization ON organization.id=link.organization_id
      JOIN fractal.organization_verification_evidence_documents document ON document.id=link.evidence_document_id
      WHERE request.submitted_by_identity_id=$1 AND document.uploaded_by_identity_id=$1
      ORDER BY request.version,link.evidence_type,link.evidence_document_id`,
  },
  {
    sourceKey: "postgres.fractal.asset_application_requests",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'applicationReference',request.application_reference,
      'applicationVersion',request.application_version,'assetName',request.asset_name,'assetType',request.asset_type,
      'countryCode',request.country_code,'state',request.state,'city',request.city,'summary',request.summary,
      'materialChangeSummary',request.material_change_summary,'requestedCapacityMinor',request.requested_capacity_minor::text,
      'currency',request.currency,'status',request.status,'submittedAt',request.submitted_at,
      'decidedAt',request.decided_at,'createdAt',request.created_at) AS record
      FROM fractal.asset_application_requests request
      JOIN fractal.organizations organization ON organization.id=request.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY request.submitted_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.asset_application_evidence_documents",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'filename',document.filename,'mimeType',document.mime_type,
      'contentSha256',document.content_sha256,'bytes',document.bytes::text,'createdAt',document.created_at) AS record
      FROM fractal.asset_application_evidence_documents document
      JOIN fractal.organizations organization ON organization.id=document.organization_id
      WHERE document.uploaded_by_identity_id=$1 ORDER BY document.created_at,document.id`,
  },
  {
    sourceKey: "postgres.fractal.asset_application_review_items",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'applicationReference',request.application_reference,
      'applicationVersion',request.application_version,'category',item.category,'title',item.title,
      'requestMessage',item.request_message,'required',item.required,'status',item.status,
      'responseProvidedByRequester',item.responded_by_identity_id=$1,
      'responseMessage',CASE WHEN item.responded_by_identity_id=$1 THEN item.response_message ELSE NULL END,
      'respondedAt',item.responded_at,'reviewedAt',item.reviewed_at,'openedAt',item.opened_at,'createdAt',item.created_at) AS record
      FROM fractal.asset_application_review_items item
      JOIN fractal.asset_application_requests request ON request.id=item.application_request_id
      JOIN fractal.organizations organization ON organization.id=item.organization_id
      WHERE request.submitted_by_identity_id=$1
      ORDER BY item.opened_at,item.id`,
  },
  {
    sourceKey: "postgres.fractal.approved_asset_application_versions",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'applicationReference',version.application_reference,
      'applicationVersion',version.application_version,'assetName',version.asset_name,'assetType',version.asset_type,
      'countryCode',version.country_code,'state',version.state,'city',version.city,'summary',version.summary,
      'requestedCapacityMinor',version.requested_capacity_minor::text,'currency',version.currency,
      'approvedAt',version.approved_at,'createdAt',version.created_at,
      'current',NOT EXISTS (SELECT 1 FROM fractal.asset_application_version_supersessions supersession
        WHERE supersession.superseded_application_version_id=version.id)) AS record
      FROM fractal.approved_asset_application_versions version
      JOIN fractal.asset_application_requests request ON request.id=version.application_request_id
      JOIN fractal.organizations organization ON organization.id=version.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY version.approved_at,version.id`,
  },
  {
    sourceKey: "postgres.fractal.asset_application_version_supersessions",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,
      'participantSide',CASE
        WHEN superseded_request.submitted_by_identity_id=$1 AND replacement_request.submitted_by_identity_id=$1 THEN 'both'
        WHEN superseded_request.submitted_by_identity_id=$1 THEN 'superseded'
        ELSE 'replacement' END,
      'supersededApplicationReference',superseded.application_reference,
      'supersededApplicationVersion',superseded.application_version,
      'replacementApplicationReference',replacement.application_reference,
      'replacementApplicationVersion',replacement.application_version,'supersededAt',supersession.superseded_at) AS record
      FROM fractal.asset_application_version_supersessions supersession
      JOIN fractal.approved_asset_application_versions superseded ON superseded.id=supersession.superseded_application_version_id
      JOIN fractal.asset_application_requests superseded_request ON superseded_request.id=superseded.application_request_id
      JOIN fractal.approved_asset_application_versions replacement ON replacement.id=supersession.replacement_application_version_id
      JOIN fractal.asset_application_requests replacement_request ON replacement_request.id=replacement.application_request_id
      JOIN fractal.organizations organization ON organization.id=supersession.organization_id
      WHERE superseded_request.submitted_by_identity_id=$1 OR replacement_request.submitted_by_identity_id=$1
      ORDER BY supersession.superseded_at,supersession.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_publication_requests",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'publicReference',request.public_reference,
      'currency',request.currency,'capacityMinor',request.capacity_minor::text,'opensAt',request.opens_at,'closesAt',request.closes_at,
      'publicSlug',request.terms->>'publicSlug','name',request.terms->>'name','assetClass',request.terms->>'assetClass',
      'summary',request.terms->>'summary','thesis',request.terms->>'thesis','riskSummary',request.terms->>'riskSummary',
      'incomeSource',request.terms->>'incomeSource','structure',request.terms->>'structure','security',request.terms->>'security',
      'feeSummary',request.terms->>'feeSummary','nextMilestone',request.terms->>'nextMilestone',
      'minimumTicketMinor',request.terms->'minimumTicketMinor','targetReturnBps',request.terms->'targetReturnBps',
      'termMonths',request.terms->'termMonths','status',request.status,'submittedAt',request.submitted_at,
      'decidedAt',request.decided_at,'createdAt',request.created_at) AS record
      FROM fractal.offering_publication_requests request
      JOIN fractal.organizations organization ON organization.id=request.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY request.submitted_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_publication_evidence_documents",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'evidenceKind',document.evidence_kind,'filename',document.filename,
      'mimeType',document.mime_type,'contentSha256',document.content_sha256,'bytes',document.bytes::text,'createdAt',document.created_at) AS record
      FROM fractal.offering_publication_evidence_documents document
      JOIN fractal.organizations organization ON organization.id=document.organization_id
      WHERE document.uploaded_by_identity_id=$1 ORDER BY document.created_at,document.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_products",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'publicReference',offering.public_reference,'status',offering.status,
      'currency',offering.currency,'capacityMinor',offering.capacity_minor::text,'opensAt',offering.opens_at,
      'closesAt',offering.closes_at,'createdAt',offering.created_at,'updatedAt',offering.updated_at) AS record
      FROM fractal.offering_products offering
      JOIN fractal.offering_publication_requests request ON request.published_offering_id=offering.id
      JOIN fractal.organizations organization ON organization.id=offering.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY offering.created_at,offering.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_publication_versions",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'publicReference',offering.public_reference,'version',version.version,
      'publicSlug',version.terms->>'publicSlug','name',version.terms->>'name','assetClass',version.terms->>'assetClass',
      'summary',version.terms->>'summary','thesis',version.terms->>'thesis','riskSummary',version.terms->>'riskSummary',
      'incomeSource',version.terms->>'incomeSource','structure',version.terms->>'structure','security',version.terms->>'security',
      'feeSummary',version.terms->>'feeSummary','nextMilestone',version.terms->>'nextMilestone',
      'minimumTicketMinor',version.terms->'minimumTicketMinor','targetReturnBps',version.terms->'targetReturnBps',
      'termMonths',version.terms->'termMonths','publishedAt',version.published_at,'createdAt',version.created_at) AS record
      FROM fractal.offering_publication_versions version
      JOIN fractal.offering_products offering ON offering.id=version.offering_id
      JOIN fractal.offering_publication_requests request ON request.published_offering_id=offering.id
      JOIN fractal.organizations organization ON organization.id=offering.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY version.published_at,version.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_chain_deployment_requests",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'offeringPublicReference',offering.public_reference,
      'offeringVersion',version.version,'chainId',request.chain_id,'tokenFactoryAddress',request.token_factory_address,
      'offeringName',request.offering_name,'tokenName',request.token_name,'tokenSymbol',request.token_symbol,
      'maxBalancePerHolder',request.max_balance_per_holder::text,'retailCap',request.retail_cap::text,
      'maxTotalSupply',request.max_total_supply::text,'status',request.status,'submittedAt',request.submitted_at,
      'decidedAt',request.decided_at) AS record
      FROM fractal.offering_chain_deployment_requests request
      JOIN fractal.offering_products offering ON offering.id=request.offering_id
      JOIN fractal.offering_publication_versions version ON version.id=request.offering_version_id AND version.offering_id=request.offering_id
      JOIN fractal.organizations organization ON organization.id=request.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY request.submitted_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_issuance_term_requests",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'offeringPublicReference',offering.public_reference,
      'offeringVersion',version.version,'currency',request.currency,'tokenUnitPriceMinor',request.token_unit_price_minor::text,
      'maxTotalSupply',request.max_total_supply::text,'status',request.status,'submittedAt',request.submitted_at,
      'decidedAt',request.decided_at) AS record
      FROM fractal.offering_issuance_term_requests request
      JOIN fractal.offering_products offering ON offering.id=request.offering_id
      JOIN fractal.offering_publication_versions version ON version.id=request.offering_version_id AND version.offering_id=request.offering_id
      JOIN fractal.organizations organization ON organization.id=request.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY request.submitted_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_chain_operations",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'offeringPublicReference',offering.public_reference,
      'chainId',operation.chain_id,'tokenFactoryAddress',operation.token_factory_address,
      'operationType',operation.operation_type,'status',operation.status,'transactionHash',operation.transaction_hash,
      'tokenContractAddress',operation.token_contract_address,'blockNumber',operation.block_number,
      'submittedAt',operation.submitted_at,'confirmedAt',operation.confirmed_at,'createdAt',operation.created_at,
      'updatedAt',operation.updated_at) AS record
      FROM fractal.offering_chain_operations operation
      JOIN fractal.offering_chain_deployment_requests request ON request.id=operation.request_id
      JOIN fractal.offering_products offering ON offering.id=operation.offering_id
      JOIN fractal.organizations organization ON organization.id=operation.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY operation.created_at,operation.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_chain_operation_dispatch_claims",
    sql: `SELECT jsonb_build_object(
      'organizationLegalName',organization.legal_name,'offeringPublicReference',offering.public_reference,
      'operationType',operation.operation_type,'status',claim.status,'transactionHash',claim.transaction_hash,
      'claimedAt',claim.claimed_at,'completedAt',claim.completed_at) AS record
      FROM fractal.offering_chain_operation_dispatch_claims claim
      JOIN fractal.offering_chain_operations operation ON operation.id=claim.operation_id
      JOIN fractal.offering_chain_deployment_requests request ON request.id=operation.request_id
      JOIN fractal.offering_products offering ON offering.id=operation.offering_id
      JOIN fractal.organizations organization ON organization.id=operation.organization_id
      WHERE request.submitted_by_identity_id=$1 ORDER BY claim.claimed_at,claim.id`,
  },
  {
    sourceKey: "postgres.fractal.support_attachment_disposition_requests",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,'attachmentFilename',attachment.filename,
      'attachmentClassification',attachment.classification,'dispositionReference',request.reference,
      'action',request.action,'retentionDueAt',request.retention_due_at_snapshot,'status',request.status,
      'requestedAt',request.requested_at,'reviewedAt',request.reviewed_at,'appliedAt',request.applied_at) AS record
      FROM fractal.support_attachment_disposition_requests request
      JOIN fractal.support_case_attachments attachment ON attachment.id=request.attachment_id
      JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
      WHERE support_case.requester_identity_id=$1 AND attachment.visibility='requester'
      ORDER BY request.requested_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.support_attachment_dispositions",
    sql: `SELECT jsonb_build_object(
      'caseReference',support_case.reference,'attachmentFilename',attachment.filename,
      'attachmentClassification',attachment.classification,'contentSha256',disposition.content_sha256,
      'status',disposition.status,'approvedAt',disposition.approved_at,
      'completedAt',disposition.completed_at,'failedAt',disposition.failed_at) AS record
      FROM fractal.support_attachment_dispositions disposition
      JOIN fractal.support_case_attachments attachment ON attachment.id=disposition.attachment_id
      JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
      WHERE support_case.requester_identity_id=$1 AND attachment.visibility='requester'
      ORDER BY disposition.approved_at,disposition.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_firm_profiles",
    sql: `SELECT DISTINCT jsonb_build_object(
      'firmLegalName',organization.legal_name,'organizationStatus',organization.status,
      'firmStatus',firm.status,'credentialStatus',firm.credential_status,
      'firmCreatedAt',firm.created_at,'firmUpdatedAt',firm.updated_at) AS record
      FROM fractal.professional_firm_profiles firm
      JOIN fractal.organizations organization ON organization.id=firm.organization_id
      JOIN fractal.professional_firm_memberships membership ON membership.firm_organization_id=firm.organization_id
      WHERE membership.identity_id=$1 ORDER BY record`,
  },
  {
    sourceKey: "postgres.fractal.professional_firm_memberships",
    sql: `SELECT jsonb_build_object(
      'firmLegalName',organization.legal_name,'role',membership.role,'status',membership.status,
      'grantedAt',membership.granted_at,'revokedAt',membership.revoked_at) AS record
      FROM fractal.professional_firm_memberships membership
      JOIN fractal.organizations organization ON organization.id=membership.firm_organization_id
      WHERE membership.identity_id=$1 ORDER BY membership.granted_at,membership.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_work_orders",
    sql: `SELECT DISTINCT jsonb_build_object(
      'reference',work_order.reference,'issuerLegalName',issuer.legal_name,'firmLegalName',firm.legal_name,
      'title',work_order.title,'confidentiality',work_order.confidentiality,
      'responseDueAt',work_order.response_due_at,'deliveryDueAt',work_order.delivery_due_at,
      'feeMinor',work_order.fee_minor::text,'currency',work_order.currency,'status',work_order.status,
      'invitedAt',work_order.invited_at,'decidedAt',work_order.decided_at) AS record
      FROM fractal.professional_work_orders work_order
      JOIN fractal.organizations issuer ON issuer.id=work_order.issuer_organization_id
      JOIN fractal.organizations firm ON firm.id=work_order.professional_firm_organization_id
      JOIN fractal.professional_work_order_assignments assignment ON assignment.work_order_id=work_order.id
      JOIN fractal.professional_firm_memberships membership ON membership.id=assignment.firm_membership_id
      WHERE membership.identity_id=$1 ORDER BY record`,
  },
  {
    sourceKey: "postgres.fractal.professional_work_order_assignments",
    sql: `SELECT jsonb_build_object(
      'workOrderReference',work_order.reference,'title',work_order.title,'firmLegalName',firm.legal_name,
      'assignmentStatus',CASE WHEN assignment.revoked_at IS NULL THEN 'active' ELSE 'revoked' END,
      'assignedAt',assignment.assigned_at,'revokedAt',assignment.revoked_at) AS record
      FROM fractal.professional_work_order_assignments assignment
      JOIN fractal.professional_firm_memberships membership ON membership.id=assignment.firm_membership_id
      JOIN fractal.professional_work_orders work_order ON work_order.id=assignment.work_order_id
      JOIN fractal.organizations firm ON firm.id=membership.firm_organization_id
      WHERE membership.identity_id=$1 ORDER BY assignment.assigned_at,assignment.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_deliverable_versions",
    sql: `SELECT jsonb_build_object(
      'workOrderReference',work_order.reference,'version',deliverable.version,'title',deliverable.title,
      'submissionSummary',deliverable.submission_summary,'submittedAt',deliverable.submitted_at) AS record
      FROM fractal.professional_deliverable_versions deliverable
      JOIN fractal.professional_work_orders work_order ON work_order.id=deliverable.work_order_id
      WHERE deliverable.submitted_by_identity_id=$1 ORDER BY deliverable.submitted_at,deliverable.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_deliverable_evidence_documents",
    sql: `SELECT jsonb_build_object(
      'workOrderReference',work_order.reference,'filename',evidence.filename,'mimeType',evidence.mime_type,
      'contentSha256',evidence.content_sha256,'bytes',evidence.bytes::text,'createdAt',evidence.created_at) AS record
      FROM fractal.professional_deliverable_evidence_documents evidence
      JOIN fractal.professional_work_orders work_order ON work_order.id=evidence.work_order_id
      WHERE evidence.uploaded_by_identity_id=$1 ORDER BY evidence.created_at,evidence.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_deliverable_version_documents",
    sql: `SELECT jsonb_build_object(
      'workOrderReference',work_order.reference,'deliverableVersion',deliverable.version,
      'deliverableTitle',deliverable.title,'filename',evidence.filename,'mimeType',evidence.mime_type,
      'contentSha256',evidence.content_sha256,'bytes',evidence.bytes::text) AS record
      FROM fractal.professional_deliverable_version_documents link
      JOIN fractal.professional_deliverable_versions deliverable ON deliverable.id=link.deliverable_version_id
      JOIN fractal.professional_deliverable_evidence_documents evidence ON evidence.id=link.evidence_document_id
      JOIN fractal.professional_work_orders work_order ON work_order.id=deliverable.work_order_id
      WHERE deliverable.submitted_by_identity_id=$1 AND evidence.uploaded_by_identity_id=$1
        AND evidence.work_order_id=deliverable.work_order_id
      ORDER BY deliverable.version,evidence.filename,evidence.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_invoices",
    sql: `SELECT jsonb_build_object(
      'reference',invoice.reference,'workOrderReference',work_order.reference,
      'deliverableVersion',deliverable.version,'deliverableTitle',deliverable.title,
      'currency',invoice.currency,'grossMinor',invoice.gross_minor::text,'taxMinor',invoice.tax_minor::text,
      'withholdingTaxMinor',invoice.withholding_tax_minor::text,'netPayableMinor',invoice.net_payable_minor::text,
      'dueAt',invoice.due_at,'status',invoice.status,'submittedAt',invoice.submitted_at,'reviewedAt',invoice.reviewed_at) AS record
      FROM fractal.professional_invoices invoice
      JOIN fractal.professional_work_orders work_order ON work_order.id=invoice.work_order_id
      JOIN fractal.professional_deliverable_versions deliverable ON deliverable.id=invoice.deliverable_version_id
        AND deliverable.work_order_id=invoice.work_order_id
      WHERE invoice.submitted_by_identity_id=$1 ORDER BY invoice.submitted_at,invoice.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_payout_instructions",
    sql: `SELECT jsonb_build_object(
      'invoiceReference',invoice.reference,'workOrderReference',work_order.reference,
      'currency',payout.currency,'amountMinor',payout.amount_minor::text,'status',payout.status,
      'authorizedAt',payout.authorized_at,'submittedAt',payout.submitted_at,
      'confirmedAt',payout.confirmed_at,'failedAt',payout.failed_at) AS record
      FROM fractal.professional_payout_instructions payout
      JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id
      JOIN fractal.professional_work_orders work_order ON work_order.id=invoice.work_order_id
      WHERE invoice.submitted_by_identity_id=$1 ORDER BY payout.authorized_at,payout.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_invoice_credit_notes",
    sql: `SELECT jsonb_build_object(
      'reference',credit.reference,'invoiceReference',invoice.reference,
      'workOrderReference',work_order.reference,'currency',credit.currency,
      'grossMinor',credit.gross_minor::text,'taxMinor',credit.tax_minor::text,
      'withholdingTaxMinor',credit.withholding_tax_minor::text,
      'netCreditMinor',credit.net_credit_minor::text,'issuedAt',credit.issued_at) AS record
      FROM fractal.professional_invoice_credit_notes credit
      JOIN fractal.professional_invoices invoice ON invoice.id=credit.invoice_id
      JOIN fractal.professional_work_orders work_order ON work_order.id=invoice.work_order_id
      WHERE invoice.submitted_by_identity_id=$1 ORDER BY credit.issued_at,credit.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_finance_exception_cases",
    sql: `SELECT jsonb_build_object(
      'invoiceReference',invoice.reference,'workOrderReference',work_order.reference,
      'status',exception.status,'resolutionType',exception.resolution_type,
      'openedAt',exception.opened_at,'preparedAt',exception.prepared_at,
      'reviewedAt',exception.reviewed_at,'executedAt',exception.executed_at,
      'closedAt',exception.closed_at) AS record
      FROM fractal.professional_finance_exception_cases exception
      JOIN fractal.professional_payout_instructions payout ON payout.id=exception.payout_instruction_id
      JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id
      JOIN fractal.professional_work_orders work_order ON work_order.id=invoice.work_order_id
      WHERE invoice.submitted_by_identity_id=$1 ORDER BY exception.opened_at,exception.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_work_order_conflicts",
    sql: `SELECT jsonb_build_object(
      'workOrderReference',work_order.reference,'declaration',conflict.declaration,
      'notes',conflict.notes,'declaredAt',conflict.declared_at) AS record
      FROM fractal.professional_work_order_conflicts conflict
      JOIN fractal.professional_work_orders work_order ON work_order.id=conflict.work_order_id
      WHERE conflict.declared_by_identity_id=$1 ORDER BY conflict.declared_at,conflict.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_finance_exception_evidence",
    sql: `SELECT jsonb_build_object(
      'evidenceType',evidence.evidence_type,'filename',evidence.filename,
      'mimeType',evidence.mime_type,'uploadedAt',evidence.uploaded_at) AS record
      FROM fractal.professional_finance_exception_evidence evidence
      WHERE evidence.uploaded_by_identity_id=$1 ORDER BY evidence.uploaded_at,evidence.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_work_order_events",
    sql: `SELECT jsonb_build_object(
      'workOrderReference',work_order.reference,'eventType',event.event_type,'createdAt',event.created_at) AS record
      FROM fractal.professional_work_order_events event
      JOIN fractal.professional_work_orders work_order ON work_order.id=event.work_order_id
      WHERE event.actor_identity_id=$1 ORDER BY event.created_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.governance_evidence_documents",
    sql: `SELECT jsonb_build_object(
      'evidenceKind',evidence.evidence_kind,'filename',evidence.filename,
      'mimeType',evidence.mime_type,'createdAt',evidence.created_at) AS record
      FROM fractal.governance_evidence_documents evidence
      WHERE evidence.uploaded_by_identity_id=$1 ORDER BY evidence.created_at,evidence.id`,
  },
  {
    sourceKey: "postgres.fractal.audit_events",
    sql: `SELECT jsonb_build_object(
      'actorType',event.actor_type,'action',event.action,
      'entityType',event.entity_type,'occurredAt',event.occurred_at) AS record
      FROM fractal.audit_events event
      WHERE event.actor_id=$1 ORDER BY event.occurred_at,event.sequence`,
  },
  {
    sourceKey: "postgres.fractal.professional_payout_profile_versions",
    sql: `SELECT jsonb_build_object(
      'participationRole','verifier','version',profile.version,'rail',profile.rail,
      'currency',profile.currency,'status',profile.status,'verifiedAt',profile.verified_at,
      'createdAt',profile.created_at) AS record
      FROM fractal.professional_payout_profile_versions profile
      WHERE profile.verified_by_identity_id=$1 ORDER BY profile.verified_at,profile.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_invoice_tax_treatments",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN treatment.prepared_by_identity_id=$1 THEN 'preparer' ELSE 'approver' END,
      'version',treatment.version,'status',treatment.status,'createdAt',treatment.created_at,
      'approvedAt',treatment.approved_at) AS record
      FROM fractal.professional_invoice_tax_treatments treatment
      WHERE treatment.prepared_by_identity_id=$1 OR treatment.approved_by_identity_id=$1
      ORDER BY treatment.created_at,treatment.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_finance_approval_policies",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN policy.prepared_by_identity_id=$1 THEN 'preparer' ELSE 'approver' END,
      'version',policy.version,'status',policy.status,'createdAt',policy.created_at,
      'approvedAt',policy.approved_at) AS record
      FROM fractal.professional_finance_approval_policies policy
      WHERE policy.prepared_by_identity_id=$1 OR policy.approved_by_identity_id=$1
      ORDER BY policy.created_at,policy.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_payout_recipient_recovery_cases",
    sql: `SELECT jsonb_build_object(
      'participationRole','resolver','status',recovery.status,
      'createdAt',recovery.created_at,'resolvedAt',recovery.resolved_at) AS record
      FROM fractal.professional_payout_recipient_recovery_cases recovery
      WHERE recovery.resolved_by_identity_id=$1 ORDER BY recovery.resolved_at,recovery.id`,
  },
  {
    sourceKey: "postgres.fractal.professional_replacement_payout_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole','authorizer','status',replacement.status,
      'authorizedAt',replacement.authorized_at,'createdAt',replacement.created_at) AS record
      FROM fractal.professional_replacement_payout_requests replacement
      WHERE replacement.authorized_by_identity_id=$1 ORDER BY replacement.authorized_at,replacement.id`,
  },
  {
    sourceKey: "postgres.fractal.audit_chain_heads",
    sql: `SELECT jsonb_build_object(
      'latestSequence',head.latest_sequence,'updatedAt',head.updated_at) AS record
      FROM fractal.audit_chain_heads head
      WHERE head.scope_key='identity:' || $1::text`,
  },
  {
    sourceKey: "postgres.fractal.administrator_bootstrap_state",
    sql: `SELECT jsonb_build_object(
      'cohortSize',bootstrap.cohort_size,'sealedAt',bootstrap.sealed_at) AS record
      FROM fractal.administrator_bootstrap_state bootstrap
      WHERE EXISTS (
        SELECT 1 FROM fractal.audit_events event
        WHERE event.scope_key='identity:' || $1::text
          AND event.action='identity.administrator_bootstrap.provisioned'
          AND event.entity_type='identity'
          AND event.entity_id=$1::text
          AND event.payload->>'cohortId'=bootstrap.cohort_id::text
      )`,
  },
  {
    sourceKey: "postgres.fractal.organization_beneficial_owner_declarations",
    sql: `SELECT jsonb_build_object(
      'ownerType',owner.owner_type,'legalName',owner.legal_name,
      'ownershipBps',owner.ownership_bps,'isControlPerson',owner.is_control_person,
      'nationalityOrJurisdictionCode',owner.nationality_or_jurisdiction_code,
      'countryOfResidenceCode',owner.country_of_residence_code,'declaredAt',owner.created_at) AS record
      FROM fractal.organization_beneficial_owner_declarations owner
      WHERE owner.subject_identity_id=$1
        AND owner.subject_link_basis='submitting_identity_self_declaration'
      ORDER BY owner.created_at,owner.id`,
  },
  {
    sourceKey: "postgres.fractal.storage_cleanup_tasks",
    sql: `SELECT record FROM (SELECT jsonb_build_object(
      'cleanupPurpose','governed_support_attachment_disposition',
      'status',disposition.status,'requestedAt',task.created_at,
      'completedAt',task.completed_at,'failedAt',task.failed_at) AS record,task.created_at AS sort_at,task.id AS sort_id
      FROM fractal.storage_cleanup_tasks task
      JOIN fractal.support_attachment_dispositions disposition ON disposition.id=task.governed_disposition_id
      JOIN fractal.support_case_attachments attachment ON attachment.id=disposition.attachment_id
      JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
      WHERE task.purpose='governed_disposition' AND support_case.requester_identity_id=$1
      UNION ALL
      SELECT jsonb_build_object('cleanupPurpose','privacy_package_retention_expiry','status',delivery.status,
        'requestedAt',task.created_at,'completedAt',task.completed_at,'failedAt',task.failed_at) AS record,task.created_at AS sort_at,task.id AS sort_id
      FROM fractal.storage_cleanup_tasks task
      JOIN fractal.privacy_rights_package_deliveries delivery ON delivery.id=task.privacy_package_delivery_id
      WHERE task.purpose='privacy_package_delivery' AND delivery.requester_identity_id=$1) rows
      ORDER BY sort_at,sort_id`,
  },
  {
    sourceKey: "postgres.fractal.ownership_snapshot_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN snapshot.submitted_by_identity_id=$1 THEN 'submitter' WHEN snapshot.reviewed_by_identity_id=$1 THEN 'reviewer' ELSE 'investor_holder' END,
      'reference',snapshot.reference,'chainId',snapshot.chain_id,'recordAt',snapshot.record_at,
      'blockNumber',snapshot.block_number::text,'confirmations',snapshot.confirmations,'sourceType',snapshot.source_type,
      'totalSupplyUnits',snapshot.total_supply_units::text,'holderCount',snapshot.holder_count,'status',snapshot.status,
      'submittedAt',snapshot.submitted_at,'reviewedAt',snapshot.reviewed_at) AS record
      FROM fractal.ownership_snapshot_requests snapshot
      WHERE snapshot.submitted_by_identity_id=$1 OR snapshot.reviewed_by_identity_id=$1 OR EXISTS(
        SELECT 1 FROM fractal.ownership_snapshot_holdings holding WHERE holding.snapshot_request_id=snapshot.id AND holding.investor_identity_id=$1)
      ORDER BY snapshot.submitted_at,snapshot.id`,
  },
  {
    sourceKey: "postgres.fractal.ownership_snapshot_holdings",
    sql: `SELECT jsonb_build_object('snapshotReference',snapshot.reference,'walletAddress',holding.wallet_address,
      'balanceUnits',holding.balance_units::text,'recordAt',snapshot.record_at,'createdAt',holding.created_at) AS record
      FROM fractal.ownership_snapshot_holdings holding
      JOIN fractal.ownership_snapshot_requests snapshot ON snapshot.id=holding.snapshot_request_id
      WHERE holding.investor_identity_id=$1 ORDER BY holding.created_at,holding.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_declaration_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN declaration.submitted_by_identity_id=$1 THEN 'submitter' WHEN declaration.reviewed_by_identity_id=$1 THEN 'reviewer' ELSE 'investor_entitled' END,
      'reference',declaration.reference,'periodLabel',declaration.period_label,'currency',declaration.currency,
      'grossAmountMinor',declaration.gross_amount_minor::text,'withholdingTaxBps',declaration.withholding_tax_bps,
      'withholdingTaxMinor',declaration.withholding_tax_minor::text,'netAmountMinor',declaration.net_amount_minor::text,
      'paymentDueAt',declaration.payment_due_at,'jurisdictionCode',declaration.policy_jurisdiction_code,
      'legalBasisReference',declaration.policy_legal_basis_reference,'retainUntil',declaration.retain_until,
      'status',declaration.status,'submittedAt',declaration.submitted_at,'reviewedAt',declaration.reviewed_at) AS record
      FROM fractal.distribution_declaration_requests declaration
      WHERE declaration.submitted_by_identity_id=$1 OR declaration.reviewed_by_identity_id=$1 OR EXISTS(
        SELECT 1 FROM fractal.distribution_entitlements entitlement WHERE entitlement.declaration_request_id=declaration.id AND entitlement.investor_identity_id=$1)
      ORDER BY declaration.submitted_at,declaration.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_entitlements",
    sql: `SELECT jsonb_build_object('declarationReference',declaration.reference,'periodLabel',declaration.period_label,
      'currency',declaration.currency,'balanceUnits',entitlement.balance_units::text,
      'grossAmountMinor',entitlement.gross_amount_minor::text,'withholdingTaxMinor',entitlement.withholding_tax_minor::text,
      'netAmountMinor',entitlement.net_amount_minor::text,'createdAt',entitlement.created_at) AS record
      FROM fractal.distribution_entitlements entitlement
      JOIN fractal.distribution_declaration_requests declaration ON declaration.id=entitlement.declaration_request_id
      WHERE entitlement.investor_identity_id=$1 ORDER BY entitlement.created_at,entitlement.id`,
  },
  {
    sourceKey: "postgres.fractal.investor_distribution_payout_profiles",
    sql: `SELECT jsonb_build_object('version',profile.version,'provider',profile.provider,'rail',profile.rail,
      'currency',profile.currency,'accountHolderName',profile.account_holder_name,'accountLast4',profile.account_last4,
      'status',profile.status,'verifiedAt',profile.verified_at,'supersededAt',profile.superseded_at) AS record
      FROM fractal.investor_distribution_payout_profiles profile
      WHERE profile.investor_identity_id=$1 ORDER BY profile.version,profile.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_recipient_recovery_cases",
    sql: `SELECT jsonb_build_object('provider',recovery.provider,'status',recovery.status,
      'createdAt',recovery.created_at,'resolvedAt',recovery.resolved_at) AS record
      FROM fractal.distribution_payout_recipient_recovery_cases recovery
      WHERE recovery.investor_identity_id=$1 ORDER BY recovery.created_at,recovery.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_funding_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN funding.submitted_by_identity_id=$1 THEN 'submitter' WHEN funding.reviewed_by_identity_id=$1 THEN 'reviewer' ELSE 'investor_entitled' END,
      'reference',funding.reference,'declarationReference',declaration.reference,'provider',funding.provider,
      'currency',funding.currency,'amountMinor',funding.amount_minor::text,'status',funding.status,
      'submittedAt',funding.submitted_at,'reviewedAt',funding.reviewed_at) AS record
      FROM fractal.distribution_funding_requests funding
      JOIN fractal.distribution_declaration_requests declaration ON declaration.id=funding.declaration_request_id
      WHERE funding.submitted_by_identity_id=$1 OR funding.reviewed_by_identity_id=$1 OR EXISTS(
        SELECT 1 FROM fractal.distribution_entitlements entitlement WHERE entitlement.declaration_request_id=funding.declaration_request_id AND entitlement.investor_identity_id=$1)
      ORDER BY funding.submitted_at,funding.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_instructions",
    sql: `SELECT jsonb_build_object('reference',payout.reference,'declarationReference',declaration.reference,
      'currency',payout.currency,'amountMinor',payout.amount_minor::text,'instructionKind',payout.instruction_kind,
      'status',payout.status,'authorizedAt',payout.authorized_at,'submittedAt',payout.submitted_at,
      'confirmedAt',payout.confirmed_at,'failedAt',payout.failed_at) AS record
      FROM fractal.distribution_payout_instructions payout
      JOIN fractal.distribution_declaration_requests declaration ON declaration.id=payout.declaration_request_id
      WHERE payout.investor_identity_id=$1 OR payout.authorized_by_identity_id=$1
      ORDER BY payout.authorized_at,payout.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_provider_events",
    sql: `SELECT jsonb_build_object('payoutReference',payout.reference,'source',event.source,
      'outcome',event.outcome,'createdAt',event.created_at) AS record
      FROM fractal.distribution_payout_provider_events event
      JOIN fractal.distribution_payout_instructions payout ON payout.id=event.payout_instruction_id
      WHERE payout.investor_identity_id=$1 OR payout.authorized_by_identity_id=$1
      ORDER BY event.created_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_exception_policies",
    sql: `SELECT jsonb_build_object('participationRole',CASE WHEN policy.prepared_by_identity_id=$1 THEN 'preparer' ELSE 'approver' END,
      'version',policy.version,'resolutionType',policy.resolution_type,'currency',policy.currency,
      'maximumAmountMinor',policy.maximum_amount_minor::text,'effectiveFrom',policy.effective_from,
      'effectiveUntil',policy.effective_until,'status',policy.status,'createdAt',policy.created_at,'approvedAt',policy.approved_at) AS record
      FROM fractal.distribution_payout_exception_policies policy
      WHERE policy.prepared_by_identity_id=$1 OR policy.approved_by_identity_id=$1
      ORDER BY policy.created_at,policy.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_exception_cases",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN payout.investor_identity_id=$1 THEN 'investor' WHEN case_record.opened_by_identity_id=$1 THEN 'opener' WHEN case_record.prepared_by_identity_id=$1 THEN 'preparer' WHEN case_record.reviewed_by_identity_id=$1 THEN 'reviewer' ELSE 'executor' END,
      'reference',case_record.reference,'payoutReference',payout.reference,'status',case_record.status,
      'resolutionType',case_record.resolution_type,'holdStatus',case_record.hold_status,'openedAt',case_record.opened_at,
      'preparedAt',case_record.prepared_at,'reviewedAt',case_record.reviewed_at,'executedAt',case_record.executed_at,'closedAt',case_record.closed_at) AS record
      FROM fractal.distribution_payout_exception_cases case_record
      JOIN fractal.distribution_payout_instructions payout ON payout.id=case_record.payout_instruction_id
      WHERE payout.investor_identity_id=$1 OR $1 IN(case_record.opened_by_identity_id,case_record.prepared_by_identity_id,case_record.reviewed_by_identity_id,case_record.executed_by_identity_id)
      ORDER BY case_record.opened_at,case_record.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_exception_evidence",
    sql: `SELECT jsonb_build_object('participationRole',CASE WHEN payout.investor_identity_id=$1 THEN 'investor' ELSE 'uploader' END,
      'caseReference',case_record.reference,'evidenceType',evidence.evidence_type,'filename',evidence.filename,
      'mimeType',evidence.mime_type,'uploadedAt',evidence.uploaded_at) AS record
      FROM fractal.distribution_payout_exception_evidence evidence
      JOIN fractal.distribution_payout_exception_cases case_record ON case_record.id=evidence.case_id
      JOIN fractal.distribution_payout_instructions payout ON payout.id=case_record.payout_instruction_id
      WHERE payout.investor_identity_id=$1 OR evidence.uploaded_by_identity_id=$1
      ORDER BY evidence.uploaded_at,evidence.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_exception_hold_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN payout.investor_identity_id=$1 THEN 'investor' WHEN hold.prepared_by_identity_id=$1 THEN 'preparer' ELSE 'reviewer' END,
      'caseReference',case_record.reference,'action',hold.action,'status',hold.status,
      'preparedAt',hold.prepared_at,'reviewedAt',hold.reviewed_at) AS record
      FROM fractal.distribution_payout_exception_hold_requests hold
      JOIN fractal.distribution_payout_exception_cases case_record ON case_record.id=hold.case_id
      JOIN fractal.distribution_payout_instructions payout ON payout.id=case_record.payout_instruction_id
      WHERE payout.investor_identity_id=$1 OR hold.prepared_by_identity_id=$1 OR hold.reviewed_by_identity_id=$1
      ORDER BY hold.prepared_at,hold.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_payout_exception_executions",
    sql: `SELECT jsonb_build_object('participationRole',CASE WHEN payout.investor_identity_id=$1 THEN 'investor' ELSE 'executor' END,
      'caseReference',case_record.reference,'resolutionType',execution.resolution_type,'executedAt',execution.executed_at) AS record
      FROM fractal.distribution_payout_exception_executions execution
      JOIN fractal.distribution_payout_exception_cases case_record ON case_record.id=execution.case_id
      JOIN fractal.distribution_payout_instructions payout ON payout.id=case_record.payout_instruction_id
      WHERE payout.investor_identity_id=$1 OR execution.executed_by_identity_id=$1
      ORDER BY execution.executed_at,execution.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_tax_remittance_policies",
    sql: `SELECT jsonb_build_object('participationRole',CASE WHEN policy.prepared_by_identity_id=$1 THEN 'preparer' ELSE 'approver' END,
      'version',policy.version,'jurisdictionCode',policy.jurisdiction_code,'currency',policy.currency,
      'taxAuthorityName',policy.tax_authority_name,'filingDueDays',policy.filing_due_days,'paymentDueDays',policy.payment_due_days,
      'effectiveFrom',policy.effective_from,'effectiveUntil',policy.effective_until,'status',policy.status,
      'createdAt',policy.created_at,'approvedAt',policy.approved_at) AS record
      FROM fractal.distribution_tax_remittance_policies policy
      WHERE policy.prepared_by_identity_id=$1 OR policy.approved_by_identity_id=$1
      ORDER BY policy.created_at,policy.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_tax_remittance_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN EXISTS(SELECT 1 FROM fractal.investor_distribution_tax_statements statement WHERE statement.remittance_request_id=remittance.id AND statement.investor_identity_id=$1) THEN 'investor' WHEN remittance.submitted_by_identity_id=$1 THEN 'submitter' WHEN remittance.reviewed_by_identity_id=$1 THEN 'filing_reviewer' WHEN remittance.payment_submitted_by_identity_id=$1 THEN 'payment_submitter' ELSE 'payment_reviewer' END,
      'reference',remittance.reference,'declarationReference',declaration.reference,'jurisdictionCode',remittance.jurisdiction_code,
      'currency',remittance.currency,'amountMinor',remittance.amount_minor::text,'taxPeriodStart',remittance.tax_period_start,
      'taxPeriodEnd',remittance.tax_period_end,'filingDueAt',remittance.filing_due_at,'paymentDueAt',remittance.payment_due_at,
      'filingReference',remittance.filing_reference,'paymentReference',remittance.payment_reference,
      'authorityReceiptReference',remittance.authority_receipt_reference,'status',remittance.status,
      'submittedAt',remittance.submitted_at,'reviewedAt',remittance.reviewed_at,'paymentSubmittedAt',remittance.payment_submitted_at,
      'paymentReviewedAt',remittance.payment_reviewed_at,'remittedAt',remittance.remitted_at,'reversedAt',remittance.reversed_at) AS record
      FROM fractal.distribution_tax_remittance_requests remittance
      JOIN fractal.distribution_declaration_requests declaration ON declaration.id=remittance.declaration_request_id
      WHERE $1 IN(remittance.submitted_by_identity_id,remittance.reviewed_by_identity_id,remittance.payment_submitted_by_identity_id,remittance.payment_reviewed_by_identity_id,remittance.remittance_confirmed_by_identity_id)
         OR EXISTS(SELECT 1 FROM fractal.investor_distribution_tax_statements statement WHERE statement.remittance_request_id=remittance.id AND statement.investor_identity_id=$1)
      ORDER BY remittance.submitted_at,remittance.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_tax_remittance_reversal_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN EXISTS(SELECT 1 FROM fractal.investor_distribution_tax_statements statement WHERE statement.remittance_request_id=reversal.remittance_request_id AND statement.investor_identity_id=$1) THEN 'investor' WHEN reversal.prepared_by_identity_id=$1 THEN 'preparer' ELSE 'reviewer' END,
      'remittanceReference',remittance.reference,'status',reversal.status,'preparedAt',reversal.prepared_at,
      'reviewedAt',reversal.reviewed_at,'executedAt',reversal.executed_at) AS record
      FROM fractal.distribution_tax_remittance_reversal_requests reversal
      JOIN fractal.distribution_tax_remittance_requests remittance ON remittance.id=reversal.remittance_request_id
      WHERE reversal.prepared_by_identity_id=$1 OR reversal.reviewed_by_identity_id=$1 OR EXISTS(
        SELECT 1 FROM fractal.investor_distribution_tax_statements statement WHERE statement.remittance_request_id=reversal.remittance_request_id AND statement.investor_identity_id=$1)
      ORDER BY reversal.prepared_at,reversal.id`,
  },
  {
    sourceKey: "postgres.fractal.investor_distribution_tax_statements",
    sql: `SELECT jsonb_build_object('reference',statement.reference,'declarationReference',declaration.reference,
      'jurisdictionCode',statement.jurisdiction_code,'currency',statement.currency,
      'grossAmountMinor',statement.gross_amount_minor::text,'withholdingTaxMinor',statement.withholding_tax_minor::text,
      'taxPeriodStart',statement.tax_period_start,'taxPeriodEnd',statement.tax_period_end,
      'taxAuthorityName',statement.tax_authority_name,'authorityReceiptReference',statement.authority_receipt_reference,
      'legalBasisReference',statement.legal_basis_reference,'statementSha256',statement.statement_sha256,
      'status',statement.status,'issuedAt',statement.issued_at,'revokedAt',statement.revoked_at) AS record
      FROM fractal.investor_distribution_tax_statements statement
      JOIN fractal.distribution_declaration_requests declaration ON declaration.id=statement.declaration_request_id
      WHERE statement.investor_identity_id=$1 ORDER BY statement.issued_at,statement.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_lifecycle_policy_bindings",
    sql: `SELECT jsonb_build_object(
      'targetType',binding.target_type,'recordClass',binding.record_class,
      'policyReference',binding.policy_reference,'policyName',binding.policy_name,
      'jurisdictionCode',binding.jurisdiction_code,'legalBasisReference',binding.legal_basis_reference,
      'retentionDays',binding.retention_days,'correctionTreatment',binding.correction_treatment,
      'erasureTreatment',binding.erasure_treatment,'restrictionTreatment',binding.restriction_treatment,
      'objectionTreatment',binding.objection_treatment,'retentionStartedAt',binding.retention_started_at,
      'retainUntil',binding.retain_until,'boundAt',binding.bound_at) AS record
      FROM fractal.distribution_lifecycle_policy_bindings binding
      WHERE fractal.distribution_lifecycle_target_involves_identity(binding.target_type,binding.target_id,$1)
      ORDER BY binding.retention_started_at,binding.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_privacy_treatment_requests",
    sql: `SELECT jsonb_build_object(
      'reference',treatment.reference,'targetType',treatment.target_type,
      'treatmentType',treatment.treatment_type,'policyTreatmentMode',treatment.policy_treatment_mode,
      'decisionScopeCategory',treatment.decision_scope_category,'decisionScopeAction',treatment.decision_scope_action,
      'status',treatment.status,'requesterVisibleSummary',treatment.requester_visible_summary,
      'proposedAt',treatment.proposed_at,'reviewedAt',treatment.reviewed_at) AS record
      FROM fractal.distribution_privacy_treatment_requests treatment
      WHERE treatment.requester_identity_id=$1 AND treatment.status='approved'
      ORDER BY treatment.proposed_at,treatment.id`,
  },
  {
    sourceKey: "postgres.fractal.distribution_privacy_treatment_executions",
    sql: `SELECT jsonb_build_object(
      'treatmentReference',treatment.reference,'executionResult',execution.execution_result,
      'lawfulBasis',execution.lawful_basis,'policyReference',execution.policy_reference,
      'retainUntil',execution.retain_until,'legalHoldActive',execution.legal_hold_active,
      'executedAt',execution.executed_at) AS record
      FROM fractal.distribution_privacy_treatment_executions execution
      JOIN fractal.distribution_privacy_treatment_requests treatment ON treatment.id=execution.treatment_request_id
      WHERE treatment.requester_identity_id=$1 AND treatment.status='approved'
      ORDER BY execution.executed_at,execution.id`,
  },
  {
    sourceKey:"postgres.fractal.privacy_rights_package_deliveries",
    sql:`SELECT jsonb_build_object('reference',delivery.reference,'status',delivery.status,'canonicalFormat',delivery.canonical_format,
      'contentSha256',delivery.content_sha256,'byteCount',delivery.byte_count,'requestedAt',delivery.requested_at,
      'retrievalExpiresAt',delivery.retrieval_expires_at,'retainUntil',delivery.retain_until,'generatedAt',delivery.generated_at,
      'availableAt',delivery.available_at,'expiredAt',delivery.expired_at,'destroyedAt',delivery.destroyed_at) AS record
      FROM fractal.privacy_rights_package_deliveries delivery
      WHERE delivery.requester_identity_id=$1 AND ($2::uuid IS NULL OR delivery.id<>$2::uuid)
      ORDER BY delivery.requested_at,delivery.id`,
  },
  {
    sourceKey:"postgres.fractal.privacy_rights_package_access_events",
    sql:`SELECT jsonb_build_object('deliveryReference',delivery.reference,'accessType',access.access_type,
      'contentSha256',access.content_sha256,'bytesServed',access.bytes_served,'occurredAt',access.occurred_at) AS record
      FROM fractal.privacy_rights_package_access_events access
      JOIN fractal.privacy_rights_package_deliveries delivery ON delivery.id=access.delivery_id
      WHERE access.requester_identity_id=$1 AND access.accessed_by_identity_id=$1 ORDER BY access.occurred_at,access.id`,
  },
  {
    sourceKey: "postgres.fractal.idempotency_commands",
    sql: `SELECT jsonb_build_object(
      'route',command.route,'responseStatus',command.response_status,
      'createdAt',command.created_at,'expiresAt',command.expires_at) AS record
      FROM fractal.idempotency_commands command
      WHERE command.actor_identity_id=$1 AND command.attribution_status='attributed'
      ORDER BY command.created_at,command.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_notice_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN request.submitted_by_identity_id=$1 THEN 'submitter'
        WHEN request.reviewed_by_identity_id=$1 THEN 'reviewer' ELSE 'recipient' END,
      'reference',request.reference,'category',request.category,'subject',request.subject,'body',request.body,
      'audienceType',request.audience_type,'policyReference',request.policy_reference,
      'policyJurisdictionCode',request.policy_jurisdiction_code,
      'policyLegalBasisReference',request.policy_legal_basis_reference,'retentionDays',request.retention_days,
      'acknowledgmentRequired',request.acknowledgment_required,
      'acknowledgmentWindowDays',request.acknowledgment_window_days,'status',request.status,
      'submittedAt',request.submitted_at,'reviewedAt',request.reviewed_at) AS record
      FROM fractal.offering_notice_requests request
      WHERE request.submitted_by_identity_id=$1 OR request.reviewed_by_identity_id=$1 OR (
        request.status='approved' AND EXISTS(
          SELECT 1 FROM fractal.offering_notices notice
          JOIN fractal.offering_notice_recipients recipient ON recipient.notice_id=notice.id
          WHERE notice.request_id=request.id AND recipient.investor_identity_id=$1))
      ORDER BY request.submitted_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_notices",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN notice.published_by_identity_id=$1 THEN 'publisher' ELSE 'recipient' END,
      'reference',request.reference,'category',notice.category,'subject',notice.subject,'body',notice.body,
      'audienceType',notice.audience_type,'policyReference',notice.policy_reference,
      'policyJurisdictionCode',notice.policy_jurisdiction_code,
      'policyLegalBasisReference',notice.policy_legal_basis_reference,'retainUntil',notice.retain_until,
      'acknowledgmentRequired',notice.acknowledgment_required,
      'acknowledgmentDueAt',notice.acknowledgment_due_at,'publishedAt',notice.published_at) AS record
      FROM fractal.offering_notices notice
      JOIN fractal.offering_notice_requests request ON request.id=notice.request_id AND request.status='approved'
      WHERE notice.published_by_identity_id=$1 OR EXISTS(
        SELECT 1 FROM fractal.offering_notice_recipients recipient
        WHERE recipient.notice_id=notice.id AND recipient.investor_identity_id=$1)
      ORDER BY notice.published_at,notice.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_notice_recipients",
    sql: `SELECT jsonb_build_object(
      'reference',request.reference,'category',notice.category,'subject',notice.subject,
      'madeAvailableAt',recipient.made_available_at,'firstReadAt',recipient.first_read_at,
      'acknowledgedAt',recipient.acknowledged_at) AS record
      FROM fractal.offering_notice_recipients recipient
      JOIN fractal.offering_notices notice ON notice.id=recipient.notice_id
      JOIN fractal.offering_notice_requests request ON request.id=notice.request_id AND request.status='approved'
      WHERE recipient.investor_identity_id=$1
      ORDER BY recipient.made_available_at,recipient.id`,
  },
  {
    sourceKey: "postgres.fractal.offering_notice_recipient_events",
    sql: `SELECT jsonb_build_object(
      'reference',request.reference,'eventType',event.event_type,'occurredAt',event.occurred_at) AS record
      FROM fractal.offering_notice_recipient_events event
      JOIN fractal.offering_notice_recipients recipient ON recipient.id=event.recipient_id
        AND recipient.investor_identity_id=event.actor_identity_id
      JOIN fractal.offering_notices notice ON notice.id=recipient.notice_id
      JOIN fractal.offering_notice_requests request ON request.id=notice.request_id AND request.status='approved'
      WHERE event.actor_identity_id=$1
      ORDER BY event.occurred_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_documents",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN document.created_by_identity_id=$1 AND document.archived_by_identity_id=$1
        THEN 'creator_and_archiver' WHEN document.created_by_identity_id=$1 THEN 'creator' ELSE 'archiver' END,
      'category',document.category,'status',document.status,
      'currentVersionNumber',document.current_version_number,'retentionBasis',document.retention_basis,
      'retainUntil',document.retain_until,'retentionPolicyReference',document.retention_policy_reference,
      'retentionPolicyJurisdictionCode',document.retention_policy_jurisdiction_code,
      'createdAt',document.created_at,'archivedAt',document.archived_at) AS record
      FROM fractal.organization_documents document
      WHERE document.created_by_identity_id=$1 OR document.archived_by_identity_id=$1
      ORDER BY document.created_at,document.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_document_versions",
    sql: `SELECT jsonb_build_object(
      'versionNumber',version.version_number,'filename',version.filename,'mimeType',version.mime_type,
      'contentSha256',version.content_sha256,'bytes',version.bytes,'retainUntil',version.retain_until,
      'createdAt',version.created_at) AS record
      FROM fractal.organization_document_versions version
      WHERE version.uploaded_by_identity_id=$1
      ORDER BY version.created_at,version.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_document_events",
    sql: `SELECT jsonb_build_object(
      'eventType',event.event_type,'fromStatus',event.from_status,'toStatus',event.to_status,
      'occurredAt',event.occurred_at) AS record
      FROM fractal.organization_document_events event
      WHERE event.actor_identity_id=$1
      ORDER BY event.occurred_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_document_access_events",
    sql: `SELECT jsonb_build_object('accessType',access.access_type,'occurredAt',access.occurred_at) AS record
      FROM fractal.organization_document_access_events access
      WHERE access.accessed_by_identity_id=$1
      ORDER BY access.occurred_at,access.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_document_disposition_requests",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN request.requested_by_identity_id=$1 THEN 'requester' ELSE 'reviewer' END,
      'reference',request.reference,'action',request.action,
      'retainUntil',request.retain_until_snapshot,'versionCount',request.version_count_snapshot,
      'status',request.status,'requestedAt',request.requested_at,'reviewedAt',request.reviewed_at,
      'appliedAt',request.applied_at) AS record
      FROM fractal.organization_document_disposition_requests request
      WHERE request.requested_by_identity_id=$1 OR request.reviewed_by_identity_id=$1
      ORDER BY request.requested_at,request.id`,
  },
  {
    sourceKey: "postgres.fractal.organization_document_dispositions",
    sql: `SELECT jsonb_build_object(
      'participationRole',CASE WHEN request.requested_by_identity_id=$1 THEN 'requester' ELSE 'reviewer' END,
      'requestReference',request.reference,'expectedVersionCount',disposition.expected_version_count,
      'status',disposition.status,'approvedAt',disposition.approved_at,
      'completedAt',disposition.completed_at,'failedAt',disposition.failed_at) AS record
      FROM fractal.organization_document_dispositions disposition
      JOIN fractal.organization_document_disposition_requests request
        ON request.id=disposition.disposition_request_id AND request.status='applied'
      WHERE request.requested_by_identity_id=$1 OR request.reviewed_by_identity_id=$1
      ORDER BY disposition.approved_at,disposition.id`,
  },
  {
    sourceKey: "postgres.fractal.inbox_events",
    sql: `SELECT jsonb_build_object(
      'provider',event.provider,
      'processingStatus',CASE WHEN event.processed_at IS NOT NULL THEN 'processed'
        WHEN event.failed_at IS NOT NULL THEN 'failed' ELSE 'pending' END,
      'receivedAt',event.received_at,'processedAt',event.processed_at,'failedAt',event.failed_at) AS record
      FROM fractal.inbox_events event
      WHERE event.privacy_classification='subject_attributed'
        AND event.privacy_subject_identity_ids @> ARRAY[$1::uuid]
      ORDER BY event.received_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.outbox_events",
    sql: `SELECT jsonb_build_object(
      'deliveryStatus',CASE WHEN event.published_at IS NULL THEN 'pending' ELSE 'published' END,
      'occurredAt',event.occurred_at,'publishedAt',event.published_at) AS record
      FROM fractal.outbox_events event
      WHERE event.privacy_classification='subject_attributed'
        AND event.privacy_subject_identity_ids @> ARRAY[$1::uuid]
        AND ($2::uuid IS NULL OR COALESCE(event.payload->>'preparationId','')<>$2::text)
        AND ($3::uuid IS NULL OR COALESCE(event.payload->>'deliveryId','')<>$3::text)
      ORDER BY event.occurred_at,event.id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_external_collection_snapshots",
    sql: `SELECT jsonb_build_object(
      'reference',snapshot.reference,'sourceKey',snapshot.source_key,
      'requestType',snapshot.request_type,'status',snapshot.status,
      'recordCount',snapshot.record_count,'byteCount',snapshot.byte_count,
      'requestedAt',snapshot.requested_at,'collectedAt',snapshot.collected_at,
      'expiresAt',snapshot.expires_at,'expiredAt',snapshot.expired_at,
      'destroyedAt',snapshot.destroyed_at) AS record
      FROM fractal.privacy_external_collection_snapshots snapshot
      WHERE snapshot.requester_identity_id=$1
      ORDER BY snapshot.requested_at,snapshot.id`,
  },
  {
    sourceKey: "postgres.fractal.privacy_external_provider_exports",
    sql: `SELECT jsonb_build_object(
      'reference',provider_export.reference,'sourceKey',provider_export.source_key,
      'requestType',provider_export.request_type,'status',provider_export.status,
      'entryCount',provider_export.entry_count,'sensitiveTier',provider_export.sensitive_tier,
      'byteCount',provider_export.byte_count,'generatedAt',provider_export.generated_at,
      'downloadedAt',provider_export.downloaded_at,'uploadedAt',provider_export.uploaded_at,
      'retainUntil',provider_export.retain_until,'destroyedAt',provider_export.destroyed_at) AS record
      FROM fractal.privacy_external_provider_exports provider_export
      WHERE provider_export.requester_identity_id=$1
      ORDER BY provider_export.uploaded_at,provider_export.id`,
  },
];

function sha256(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : stableJsonStringify(value)).digest("hex");
}

function reference() {
  return `PRP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function commandKey(value: string) {
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 200) throw new PrivacyRightsError("Command key must contain 1 to 200 characters.", "invalid_input");
  return normalized;
}

async function requireCapability(client: PoolClient, actorIdentityId: string) {
  try { await requireAdministratorCapability(client, actorIdentityId, CAPABILITY); }
  catch (error) {
    if (error instanceof AdministratorCapabilityError) throw new PrivacyRightsError("Privacy rights management capability is required.", "forbidden");
    throw error;
  }
}

/** Testable canonical collectors. Secret-bearing credential and command fields are deliberately absent. */
export async function collectCanonicalPrivacySourceSections(
  client: PoolClient,
  requesterIdentityId: string,
  requestType: PackageRequestType,
  profileValue: unknown,
  options: { excludePrivacyPackagePreparationId?: string; excludePrivacyPackageDeliveryId?: string } = {},
) {
  const profile = parsePrivacyContentProfile(profileValue);
  const rules = new Map(profile[requestType].sourceRules.map((rule) => [rule.sourceKey, rule]));
  const sections = new Map<string, CanonicalPrivacySourceSection>();
  const applicableCollectors = collectors.filter((collector) => rules.has(collector.sourceKey));
  if (applicableCollectors.length !== rules.size) {
    throw new PrivacyRightsError("The active content profile and deployed safe-collector catalogue are inconsistent.", "policy_unavailable");
  }
  for (const collector of applicableCollectors) {
    const parameters = collector.sourceKey === "postgres.fractal.privacy_rights_package_preparations"
      ? [requesterIdentityId, options.excludePrivacyPackagePreparationId ?? null]
      : collector.sourceKey === "postgres.fractal.privacy_rights_package_deliveries"
        ? [requesterIdentityId, options.excludePrivacyPackageDeliveryId ?? null]
        : collector.sourceKey === "postgres.fractal.outbox_events"
          ? [requesterIdentityId, options.excludePrivacyPackagePreparationId ?? null, options.excludePrivacyPackageDeliveryId ?? null]
        : [requesterIdentityId];
    const result = await client.query<{ record: JsonRecord }>(collector.sql, parameters);
    const rule = rules.get(collector.sourceKey);
    if (!rule) throw new PrivacyRightsError(`The active content profile is missing ${collector.sourceKey}.`, "policy_unavailable");
    const records = result.rows.map((row) => Object.fromEntries(rule.includedFields.map((field) => {
      if (!(field in row.record)) throw new PrivacyRightsError(`The safe collector no longer provides ${collector.sourceKey}.${field}.`, "conflict");
      return [field, row.record[field]];
    })));
    const canonicalContent = stableJsonStringify({ sourceKey: collector.sourceKey, records });
    sections.set(collector.sourceKey, {
      sourceKey: collector.sourceKey,
      records,
      canonicalContent,
      contentSha256: sha256(canonicalContent),
      byteCount: Buffer.byteLength(canonicalContent, "utf8"),
    });
  }
  return sections;
}

function mapPreparation(row: PreparationRow) {
  return {
    id: row.id, reference: row.reference, privacyRequestId: row.privacy_request_id,
    requestType: row.request_type, requestVersion: row.request_version,
    policy: {
      reference: row.policy_reference, name: row.policy_name, canonicalFormat: row.canonical_format,
      identityAssurance: row.identity_assurance, deliveryChannel: row.delivery_channel,
      maximumRecords: row.maximum_records, maximumBytes: row.maximum_bytes,
      maximumArtifacts: row.maximum_artifacts,
      packageRetentionHours: row.package_retention_hours, requesterRetrievalHours: row.requester_retrieval_hours,
    },
    contentProfile: row.content_profile_binding_status === "governed" ? {
      reference: row.content_profile_reference!, name: row.content_profile_name!,
      schemaVersion: row.content_profile_schema_version!, fieldCatalogVersion: row.content_profile_field_catalog_version!,
      jurisdictionCode: row.content_profile_jurisdiction_code!, valueSha256: row.content_profile_value_sha256!,
    } : null,
    coverageSnapshot: row.coverage_snapshot, coverageSha256: row.coverage_sha256,
    sourceManifestSha256: row.source_manifest_sha256,
    externalSnapshotSourceCount: row.external_snapshot_manifest.length,
    collectedSourceCount: row.collected_source_count, unavailableSourceCount: row.unavailable_source_count,
    notApplicableSourceCount: row.not_applicable_source_count, collectedRecordCount: row.collected_record_count,
    collectedByteCount: row.collected_byte_count,
    outcome: row.outcome, deliverable: row.deliverable, preparedAt: row.prepared_at.toISOString(),
  };
}

export async function preparePrivacyRightsPackageEvidence(input: {
  actorIdentityId: string; requestId: string; expectedVersion: number; commandKey: string;
}) {
  return withPostgresTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('privacy-package:' || $1, 0))", [input.requestId]);
    await requireCapability(client, input.actorIdentityId);
    const key = commandKey(input.commandKey);
    const replay = await client.query<PreparationRow>(
      "SELECT * FROM fractal.privacy_rights_package_preparations WHERE prepared_by_identity_id=$1 AND command_key=$2",
      [input.actorIdentityId, key],
    );
    if (replay.rows[0]) {
      if (replay.rows[0].privacy_request_id !== input.requestId || replay.rows[0].request_version !== input.expectedVersion) {
        throw new PrivacyRightsError("This command key was already used for a different package preparation.", "conflict");
      }
      return { preparation: mapPreparation(replay.rows[0]), replayed: true };
    }

    const requestResult = await client.query<{
      id: string; requester_identity_id: string; request_type: string; status: string; version: number; current_decision_request_id: string | null;
    }>("SELECT id,requester_identity_id,request_type,status,version,current_decision_request_id FROM fractal.privacy_rights_requests WHERE id=$1 FOR UPDATE", [input.requestId]);
    const request = requestResult.rows[0];
    if (!request) throw new PrivacyRightsError("Privacy-rights request not found.", "not_found");
    if (request.version !== input.expectedVersion) throw new PrivacyRightsError("The request changed; reload before preparing collection evidence.", "conflict");
    if (!(["access", "portability"] as string[]).includes(request.request_type)) throw new PrivacyRightsError("Only access and portability requests support canonical collection preparation.", "conflict");
    if (!(["approved", "partially_approved"] as string[]).includes(request.status) || !request.current_decision_request_id) {
      throw new PrivacyRightsError("An applied providing decision is required before collection preparation.", "conflict");
    }
    const decisionResult = await client.query<{
      id: string; scope_outcomes: Array<{ action?: string }>; status: string; fulfillment_coverage: FulfillmentCoverage;
    }>(
      "SELECT id,scope_outcomes,status,fulfillment_coverage FROM fractal.privacy_rights_decision_requests WHERE id=$1 AND privacy_request_id=$2",
      [request.current_decision_request_id, request.id],
    );
    const decision = decisionResult.rows[0];
    if (!decision || decision.status !== "applied" || !decision.scope_outcomes.some((scope) => scope.action === "provide")) {
      throw new PrivacyRightsError("An applied providing decision is required before collection preparation.", "conflict");
    }

    const policyBinding = await readActivePlatformConfigurationForBinding(client, PACKAGE_POLICY_KEY);
    if (!policyBinding) throw new PrivacyRightsError("No approved privacy package policy is active.", "policy_unavailable");
    let policy;
    try { policy = parsePrivacyPackagePolicy(policyBinding.value); }
    catch { throw new PrivacyRightsError("The active privacy package policy is invalid.", "policy_unavailable"); }
    const contentProfileBinding = await readActivePlatformConfigurationForBinding(client, CONTENT_PROFILE_KEY);
    if (!contentProfileBinding) throw new PrivacyRightsError("No approved privacy content profile is active.", "policy_unavailable");
    let contentProfile;
    try { contentProfile = parsePrivacyContentProfile(contentProfileBinding.value); }
    catch { throw new PrivacyRightsError("The active privacy content profile is invalid.", "policy_unavailable"); }

    const requestType = request.request_type as PackageRequestType;
    const coverage = await readPrivacyFulfillmentCoverage(client, request.requester_identity_id, requestType, request.id);
    if (stableJsonStringify(coverage) !== stableJsonStringify(decision.fulfillment_coverage)) {
      throw new PrivacyRightsError("The fulfillment coverage changed after the applied decision. A new decision is required.", "conflict");
    }
    if (!coverage.complete && !policy.allowInternalIncompletePreparation) {
      throw new PrivacyRightsError("The active policy does not permit incomplete internal package preparation.", "policy_unavailable");
    }
    const selectedContentProfile = contentProfile[requestType];
    const sections = await collectCanonicalPrivacySourceSections(
      client,
      request.requester_identity_id,
      requestType,
      contentProfile,
    );
    const snapshotResult = await client.query<{
      id: string; reference: string; source_key: string; content_sha256: string; record_count: number;
      byte_count: number; collected_at: Date; expires_at: Date;
    }>(
      `SELECT DISTINCT ON(snapshot.source_key)
         snapshot.id,snapshot.reference,snapshot.source_key,snapshot.content_sha256,
         snapshot.record_count,snapshot.byte_count,snapshot.collected_at,snapshot.expires_at
       FROM fractal.privacy_external_collection_snapshots snapshot
       JOIN fractal.platform_configuration_active_versions adapter
         ON adapter.configuration_key=snapshot.adapter_policy_configuration_key
        AND adapter.active_version_id=snapshot.adapter_policy_version_id
       JOIN fractal.platform_configuration_active_versions attestation
         ON attestation.configuration_key=snapshot.attestation_configuration_key
        AND attestation.active_version_id=snapshot.attestation_version_id
       WHERE snapshot.privacy_request_id=$1
         AND snapshot.requester_identity_id=$2
         AND snapshot.request_type=$3
         AND snapshot.status='available'
         AND snapshot.expires_at>now()
       ORDER BY snapshot.source_key,snapshot.collected_at DESC,snapshot.id DESC`,
      [request.id, request.requester_identity_id, requestType],
    );
    const externalSnapshotManifest: PrivacyExternalSnapshotManifestItem[] = snapshotResult.rows.map((snapshot) => ({
      sourceKey: snapshot.source_key,
      snapshotId: snapshot.id,
      snapshotReference: snapshot.reference,
      contentSha256: snapshot.content_sha256,
      recordCount: snapshot.record_count,
      byteCount: snapshot.byte_count,
      collectedAt: snapshot.collected_at.toISOString(),
      expiresAt: snapshot.expires_at.toISOString(),
    }));
    const externalSnapshots = new Map(externalSnapshotManifest.map((snapshot) => [snapshot.sourceKey, snapshot]));
    const sourceResult = await client.query<SourceRow>(
      "SELECT source_key,authority_key,source_kind,contains_personal_data,access_status,portability_status,blocker FROM fractal.privacy_data_sources ORDER BY source_key",
    );
    const sourceManifest: PrivacyPackageSourceManifest[] = sourceResult.rows.map((source) => {
      if (!source.contains_personal_data) return { sourceKey: source.source_key, authorityKey: source.authority_key, status: "not_applicable", recordCount: 0, byteCount: 0, contentSha256: null, blocker: null };
      const externalSnapshot = source.source_kind !== "postgres_relation" ? externalSnapshots.get(source.source_key) : undefined;
      if (externalSnapshot) return {
        sourceKey: source.source_key, authorityKey: source.authority_key, status: "collected",
        recordCount: externalSnapshot.recordCount, byteCount: externalSnapshot.byteCount,
        contentSha256: externalSnapshot.contentSha256, blocker: null,
      };
      const status = requestType === "access" ? source.access_status : source.portability_status;
      if (status !== "available") return { sourceKey: source.source_key, authorityKey: source.authority_key, status: "unavailable", recordCount: 0, byteCount: 0, contentSha256: null, blocker: source.blocker };
      const section = sections.get(source.source_key);
      if (!section) throw new PrivacyRightsError(`Canonical collector is missing for ${source.source_key}.`, "conflict");
      return { sourceKey: source.source_key, authorityKey: source.authority_key, status: "collected", recordCount: section.records.length, byteCount: section.byteCount, contentSha256: section.contentSha256, blocker: null };
    });
    if (sections.size + externalSnapshotManifest.length !== sourceManifest.filter((source) => source.status === "collected").length) {
      throw new PrivacyRightsError("Canonical collectors and approved source inventory are inconsistent.", "conflict");
    }
    const collectedRecordCount = [...sections.values()].reduce((sum, section) => sum + section.records.length, 0)
      + externalSnapshotManifest.reduce((sum, snapshot) => sum + snapshot.recordCount, 0);
    const collectedByteCount = [...sections.values()].reduce((sum, section) => sum + section.byteCount, 0)
      + externalSnapshotManifest.reduce((sum, snapshot) => sum + snapshot.byteCount, 0);
    if (collectedRecordCount > policy.maximumRecords || collectedByteCount > policy.maximumBytes) {
      throw new PrivacyRightsError("Canonical collection exceeds the active package policy limits and was not persisted.", "invalid_input");
    }
    const unavailableSourceCount = sourceManifest.filter((source) => source.status === "unavailable").length;
    const deliverable = unavailableSourceCount === 0 && coverage.complete && coverage.executionAvailable;
    if (!deliverable && unavailableSourceCount < 1) throw new PrivacyRightsError("Incomplete preparation cannot be recorded without an unavailable source.", "conflict");
    const outcome = deliverable ? "ready_for_delivery" : "blocked_incomplete_coverage";

    const [snapshot, auditHighWatermark] = await Promise.all([
      client.query<{ snapshot: string }>("SELECT txid_current_snapshot()::text AS snapshot"),
      client.query<{ sequence: string }>("SELECT COALESCE(max(sequence),0)::text AS sequence FROM fractal.audit_events"),
    ]);
    const id = randomUUID();
    const sourceManifestSha256 = sha256(sourceManifest);
    const coverageSha256 = sha256(coverage);
    const inserted = await client.query<PreparationRow>(
      `INSERT INTO fractal.privacy_rights_package_preparations
        (id,reference,privacy_request_id,decision_request_id,requester_identity_id,request_type,request_version,
         policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,policy_reference,policy_name,
         canonical_format,identity_assurance,delivery_channel,maximum_records,maximum_bytes,maximum_artifacts,package_retention_hours,
         requester_retrieval_hours,content_profile_binding_status,content_profile_configuration_key,content_profile_version_id,
         content_profile_version_number,content_profile_projection_version,content_profile_value_sha256,content_profile_reference,
         content_profile_name,content_profile_schema_version,content_profile_field_catalog_version,content_profile_jurisdiction_code,
         content_profile_legal_basis_reference,content_profile_effective_scope,selected_content_profile,
         coverage_snapshot,coverage_sha256,transaction_snapshot,audit_sequence_high_watermark,
         source_manifest,external_snapshot_manifest,source_manifest_sha256,collected_source_count,unavailable_source_count,not_applicable_source_count,
         collected_record_count,collected_byte_count,outcome,deliverable,command_key,prepared_by_identity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               'governed',$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37,$38,$39,$40,$41,$42,$43,$44,$45,
               $46,$47,$48,$49,$50)
       RETURNING *`,
      [id, reference(), request.id, decision.id, request.requester_identity_id, requestType, request.version,
        policyBinding.versionId, policyBinding.versionNumber, policyBinding.projectionVersion, policyBinding.valueSha256,
        policy.policyReference, policy.policyName, policy.canonicalFormat, policy.identityAssurance, policy.deliveryChannel,
        policy.maximumRecords, policy.maximumBytes, policy.maximumArtifacts ?? 0,
        policy.packageRetentionHours, policy.requesterRetrievalHours,
        CONTENT_PROFILE_KEY, contentProfileBinding.versionId, contentProfileBinding.versionNumber,
        contentProfileBinding.projectionVersion, contentProfileBinding.valueSha256,
        contentProfile.profileReference, contentProfile.profileName, contentProfile.schemaVersion,
        contentProfile.fieldCatalogVersion, contentProfile.jurisdictionCode, contentProfile.legalBasisReference,
        contentProfile.effectiveScope, JSON.stringify(selectedContentProfile),
        JSON.stringify(coverage), coverageSha256, snapshot.rows[0]!.snapshot, auditHighWatermark.rows[0]!.sequence,
        JSON.stringify(sourceManifest), JSON.stringify(externalSnapshotManifest), sourceManifestSha256,
        sourceManifest.filter((source) => source.status === "collected").length, unavailableSourceCount,
        sourceManifest.filter((source) => source.status === "not_applicable").length, collectedRecordCount, collectedByteCount,
        outcome, deliverable, key, input.actorIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `privacy-request:${request.id}`, actorId: input.actorIdentityId, actorType: "user",
      action: "privacy.request.package_preparation_recorded", entityType: "privacy_rights_package_preparation", entityId: id,
      reason: "A capable administrator recorded content-free canonical collection evidence under the exact active package policy and field-content profile.",
      payload: { requestId: request.id, decisionRequestId: decision.id, coverageSha256, sourceManifestSha256,
        externalSnapshotManifestSha256: sha256(externalSnapshotManifest), externalSnapshotSourceCount: externalSnapshotManifest.length,
        contentProfileValueSha256: contentProfileBinding.valueSha256, collectedRecordCount, collectedByteCount,
        unavailableSourceCount, deliverable },
    });
    await appendOutboxEvent(client, {
      aggregateType: "privacy_rights_request", aggregateId: request.id,
      eventType: "privacy.request.package_preparation_recorded",
      payload: { preparationId: id, auditEventId: audit.id, sourceManifestSha256, contentProfileValueSha256: contentProfileBinding.valueSha256, deliverable },
    });
    return { preparation: mapPreparation(inserted.rows[0]!), replayed: false };
  });
}

export async function listPrivacyRightsPackagePreparations(input: {
  actorIdentityId: string; requestId: string; administrator: boolean;
}) {
  return withPostgresTransaction(async (client) => {
    if (input.administrator) await requireCapability(client, input.actorIdentityId);
    else {
      const owned = await client.query("SELECT 1 FROM fractal.privacy_rights_requests WHERE id=$1 AND requester_identity_id=$2", [input.requestId, input.actorIdentityId]);
      if (!owned.rowCount) throw new PrivacyRightsError("Privacy-rights request not found.", "not_found");
    }
    const rows = await client.query<PreparationRow>(
      "SELECT * FROM fractal.privacy_rights_package_preparations WHERE privacy_request_id=$1 ORDER BY prepared_at,id",
      [input.requestId],
    );
    return rows.rows.map(mapPreparation);
  });
}
