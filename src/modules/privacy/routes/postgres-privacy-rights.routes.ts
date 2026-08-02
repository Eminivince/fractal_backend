import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import {
  bindPrivacyRightsResponsePolicy, createPrivacyRightsRequest, decidePrivacyRightsDecision, getAdministratorPrivacyDataInventory, getAdministratorPrivacyRightsRequest, getOwnPrivacyRightsRequest,
  listAdministratorPrivacyRightsRequests, listOwnPrivacyRightsRequests, PrivacyRightsError, proposePrivacyRightsDecision,
  replyToPrivacyRightsRequest, transitionAdministratorPrivacyRightsRequest, withdrawPrivacyRightsRequest,
} from "../../../platform/postgres-privacy-rights.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";
import { listPrivacyRightsPackagePreparations, preparePrivacyRightsPackageEvidence } from "../../../platform/postgres-privacy-package-preparations.js";
import { decideDistributionPrivacyTreatment, DistributionPrivacyTreatmentError, proposeDistributionPrivacyTreatment } from "../../../platform/postgres-distribution-privacy-treatments.js";
import { downloadOwnPrivacyPackage, listAdministratorPrivacyPackageDeliveries, listOwnPrivacyPackageDeliveries, PrivacyPackageDeliveryError, requestPrivacyPackageDelivery } from "../../../platform/postgres-privacy-package-deliveries.js";
import {
  listAdministratorPrivacyExternalSnapshots,
  listOwnPrivacyExternalSnapshots,
  PrivacyExternalSnapshotError,
  requestPrivacyExternalSnapshot,
} from "../../../platform/postgres-privacy-external-snapshots.js";
import { externalPrivacySourceKeys } from "../../privacy/domain/privacy-external-adapter-policy.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import {
  authorizeSumsubPrivacyExportUpload,
  listAdministratorSumsubPrivacyExports,
  mapSumsubPrivacyExport,
  recordSumsubPrivacyExportUpload,
  sumsubPrivacyScanEvidenceSha256,
  SumsubPrivacyExportError,
  type AuthorizedSumsubPrivacyExportUpload,
} from "../../../platform/postgres-sumsub-privacy-exports.js";
import { persistSumsubPrivacyExportBinary } from "../../../services/storage.js";
import { recordStoredDocument } from "../../../services/storage-metadata-guard.js";

const requestType = z.enum(["access", "portability", "correction", "erasure", "restriction", "objection"]);
const requestStatus = z.enum(["submitted", "in_review", "awaiting_requester", "decision_pending", "approved", "partially_approved", "refused", "withdrawn"]);
const createBody = z.object({ requestType, details: z.string().trim().min(20).max(5000) });
const versionedMessageBody = z.object({ message: z.string().trim().min(2).max(5000), expectedVersion: z.number().int().positive() });
const withdrawBody = z.object({ reason: z.string().trim().min(10).max(2000), expectedVersion: z.number().int().positive() });
const transitionBody = z.object({ action: z.enum(["begin_review", "request_information", "note"]), message: z.string().trim().min(2).max(5000), expectedVersion: z.number().int().positive() });
const scopeOutcome = z.object({ category: z.string().trim().min(2).max(120), action: z.enum(["provide", "correct", "erase", "restrict", "retain", "refuse", "not_applicable"]), explanation: z.string().trim().min(20).max(2000) });
const decisionProposalBody = z.object({ outcome: z.enum(["approve", "partially_approve", "refuse"]), decisionSummary: z.string().trim().min(20).max(5000), lawfulBasis: z.string().trim().min(20).max(2000), scopeOutcomes: z.array(scopeOutcome).min(1).max(100) });
const decisionBody = z.object({ decision: z.enum(["approve", "reject"]), reviewReason: z.string().trim().min(20).max(2000) });
const distributionTargetType = z.enum(["ownership_snapshot", "distribution_declaration", "distribution_payout_exception", "distribution_tax_remittance"]);
const treatmentProposalBody = z.object({ targetType: distributionTargetType, targetId: z.string().uuid(), decisionScopeCategory: z.string().trim().min(2).max(120), treatmentStatement: z.string().trim().min(20).max(2000) });
const treatmentDecisionBody = z.object({ decision: z.enum(["approve", "reject"]), reviewReason: z.string().trim().min(20).max(2000), requesterVisibleSummary: z.string().trim().min(20).max(2000) });
const commandHeaders = { type: "object", required: ["x-command-id"], properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } } } as const;
const actorSchema = { type: "object", additionalProperties: false, required: ["id", "legalName"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" } } } as const;
const requesterSchema = { type: "object", additionalProperties: false, required: ["id", "email", "legalName", "role"], properties: { id: { type: "string", format: "uuid" }, email: { type: "string", format: "email" }, legalName: { type: "string" }, role: { type: "string", enum: ["investor", "issuer", "professional", "operator", "admin"] } } } as const;
const statusSchema = { type: "string", enum: requestStatus.options } as const;
const coverageAuthoritySchema = { type: "object", additionalProperties: false, required: ["key", "label", "sourceCount", "inventoryStatus", "rightStatus", "blocker"], properties: {
  key: { type: "string" }, label: { type: "string" }, sourceCount: { type: "integer", minimum: 1 }, inventoryStatus: { type: "string", enum: ["catalogued", "unresolved"] }, rightStatus: { type: "string", enum: ["available", "partial", "unavailable", "not_applicable"] }, blocker: { anyOf: [{ type: "string" }, { type: "null" }] },
} } as const;
const coverageSchema = { type: "object", additionalProperties: false, required: ["complete", "schemaVersion", "coveredAuthorities", "uncoveredAuthorities", "authorities", "legalHold", "executionAvailable"], properties: {
  complete: { type: "boolean" }, schemaVersion: { type: "string" }, coveredAuthorities: { type: "array", items: { type: "string" } }, uncoveredAuthorities: { type: "array", items: { type: "string" } }, executionAvailable: { type: "boolean" },
  authorities: { type: "array", items: coverageAuthoritySchema },
  legalHold: { type: "object", additionalProperties: false, required: ["active", "pendingImposition"], properties: { active: { type: "boolean" }, pendingImposition: { type: "boolean" } } },
} } as const;
const sourceStatusSchema = { type: "string", enum: ["available", "unavailable", "not_applicable"] } as const;
const inventorySourceSchema = { type: "object", additionalProperties: false, required: ["key", "kind", "locator", "containsPersonalData", "subjectLinkage", "dataCategories", "inventoryStatus", "rightsStatus", "retentionPolicyStatus", "holdCoverageStatus", "blocker"], properties: {
  key: { type: "string" }, kind: { type: "string", enum: ["postgres_relation", "external_processor", "object_store", "cache", "backup", "log_or_trace", "blockchain"] }, locator: { type: "string" }, containsPersonalData: { type: "boolean" },
  subjectLinkage: { type: "string", enum: ["direct_identity", "relational_identity", "organization_relationship", "embedded_reference", "provider_correlation", "technical_no_subject", "unresolved"] }, dataCategories: { type: "array", items: { type: "string" } }, inventoryStatus: { type: "string", enum: ["catalogued", "unresolved"] },
  rightsStatus: { type: "object", additionalProperties: false, required: requestType.options, properties: { access: sourceStatusSchema, portability: sourceStatusSchema, correction: sourceStatusSchema, erasure: sourceStatusSchema, restriction: sourceStatusSchema, objection: sourceStatusSchema } },
  retentionPolicyStatus: { type: "string", enum: ["unapproved", "partial", "approved", "not_applicable"] }, holdCoverageStatus: { type: "string", enum: ["absent", "partial", "not_applicable"] }, blocker: { anyOf: [{ type: "string" }, { type: "null" }] },
} } as const;
const externalAdapterPolicySchema = { type: "object", additionalProperties: false, required: ["status", "versionId", "versionNumber", "projectionVersion", "valueSha256", "policyReference", "jurisdictionCode", "contractSourceCount", "runtimeCompatibleSourceCount", "liveAttestedSourceCount", "missingRuntimeSourceKeys", "mismatchedRuntimeSourceKeys", "coverageMissingSourceKeys", "coverageMismatchedRuntimeSourceKeys", "duplicateRuntimeSourceKeys", "blocksAvailability"], properties: {
  status: { type: "string", enum: ["not_activated", "active_contract_only", "runtime_compatible_unattested", "runtime_compatible_attested"] },
  versionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }, versionNumber: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, projectionVersion: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
  valueSha256: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] }, policyReference: { anyOf: [{ type: "string" }, { type: "null" }] }, jurisdictionCode: { anyOf: [{ type: "string" }, { type: "null" }] },
  contractSourceCount: { type: "integer", minimum: 0 }, runtimeCompatibleSourceCount: { type: "integer", minimum: 0 }, liveAttestedSourceCount: { type: "integer", minimum: 0 },
  missingRuntimeSourceKeys: { type: "array", items: { type: "string" } }, mismatchedRuntimeSourceKeys: { type: "array", items: { type: "string" } }, coverageMissingSourceKeys: { type: "array", items: { type: "string" } }, coverageMismatchedRuntimeSourceKeys: { type: "array", items: { type: "string" } }, duplicateRuntimeSourceKeys: { type: "array", items: { type: "string" } }, blocksAvailability: { type: "boolean" },
} } as const;
const externalAttestationSchema = { type: "object", additionalProperties: false, required: ["status", "versionId", "versionNumber", "projectionVersion", "valueSha256", "setReference", "validSourceCount", "invalidSourceKeys", "earliestExpiryAt", "configurationErrorCount", "sources", "blocksAvailability"], properties: {
  status: { type: "string", enum: ["not_activated", "active_invalid", "active_partially_valid", "active_valid"] },
  versionId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }, versionNumber: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, projectionVersion: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
  valueSha256: { anyOf: [{ type: "string", pattern: "^[0-9a-f]{64}$" }, { type: "null" }] }, setReference: { anyOf: [{ type: "string" }, { type: "null" }] },
  validSourceCount: { type: "integer", minimum: 0 }, invalidSourceKeys: { type: "array", items: { type: "string" } },
  earliestExpiryAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, configurationErrorCount: { type: "integer", minimum: 0 },
  sources: { type: "array", items: { type: "object", additionalProperties: false, required: ["sourceKey", "status", "failures", "reason"], properties: {
    sourceKey: { type: "string" },
    status: { type: "string", enum: ["valid", "policy_mismatch", "runtime_missing", "runtime_ambiguous", "runtime_mismatch", "policy_coverage_missing", "coverage_mismatch", "key_unknown", "key_revoked", "key_invalid", "signature_invalid", "not_yet_valid", "expired", "stale"] },
    failures: { type: "array", items: { type: "string", enum: ["valid", "policy_mismatch", "runtime_missing", "runtime_ambiguous", "runtime_mismatch", "policy_coverage_missing", "coverage_mismatch", "key_unknown", "key_revoked", "key_invalid", "signature_invalid", "not_yet_valid", "expired", "stale"] } },
    reason: { type: "string" }, expiresAt: { type: "string", format: "date-time" },
  } } },
  blocksAvailability: { type: "boolean" },
} } as const;
const inventoryResponseSchema = { type: "object", additionalProperties: false, required: ["schemaVersion", "summary", "externalAdapterPolicy", "externalAttestation", "authorities"], properties: {
  schemaVersion: { type: "string", enum: ["privacy-data-source-inventory-v1"] },
  summary: { type: "object", additionalProperties: false, required: ["authorityCount", "sourceCount", "postgresRelationCount", "externalSourceCount", "unresolvedSourceCount", "accessReadySourceCount", "portabilityReadySourceCount", "executionReadySourceCount"], properties: { authorityCount: { type: "integer" }, sourceCount: { type: "integer" }, postgresRelationCount: { type: "integer" }, externalSourceCount: { type: "integer" }, unresolvedSourceCount: { type: "integer" }, accessReadySourceCount: { type: "integer" }, portabilityReadySourceCount: { type: "integer" }, executionReadySourceCount: { type: "integer" } } },
  externalAdapterPolicy: externalAdapterPolicySchema,
  externalAttestation: externalAttestationSchema,
  authorities: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "label", "description", "containsPersonalData", "rightsApplicability", "blocker", "sources"], properties: { key: { type: "string" }, label: { type: "string" }, description: { type: "string" }, containsPersonalData: { type: "boolean" }, rightsApplicability: { type: "array", items: { type: "string", enum: requestType.options } }, blocker: { anyOf: [{ type: "string" }, { type: "null" }] }, sources: { type: "array", items: inventorySourceSchema } } } },
} } as const;
const requestObject = { type: "object", additionalProperties: false, required: ["id", "reference", "requester", "requestType", "details", "identityAssurance", "emailVerifiedAt", "policy", "status", "assignee", "currentDecisionRequestId", "version", "createdAt", "lastActivityAt"], properties: {
  id: { type: "string", format: "uuid" }, reference: { type: "string" }, requester: requesterSchema, requestType: { type: "string", enum: requestType.options }, details: { type: "string" }, identityAssurance: { type: "string", enum: ["authenticated_verified_email_session"] }, emailVerifiedAt: { type: "string", format: "date-time" },
  policy: { anyOf: [{ type: "object", additionalProperties: false, required: ["versionId", "versionNumber", "projectionVersion", "valueSha256", "reference", "name", "jurisdiction", "controllerName", "communicationChannel", "deadlineBasis", "responseCalendarDays", "dueAt", "boundAt"], properties: {
    versionId: { type: "string", format: "uuid" }, versionNumber: { type: "integer", minimum: 1 }, projectionVersion: { type: "integer", minimum: 1 }, valueSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    reference: { type: "string" }, name: { type: "string" }, jurisdiction: { type: "string" }, controllerName: { type: "string" }, communicationChannel: { type: "string", enum: ["authenticated_register"] }, deadlineBasis: { type: "string", enum: ["calendar_days_from_authenticated_intake"] }, responseCalendarDays: { type: "integer", minimum: 1, maximum: 365 }, dueAt: { type: "string", format: "date-time" }, boundAt: { type: "string", format: "date-time" },
  } }, { type: "null" }] },
  status: statusSchema, assignee: { anyOf: [actorSchema, { type: "null" }] }, currentDecisionRequestId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }, version: { type: "integer", minimum: 1 }, createdAt: { type: "string", format: "date-time" }, lastActivityAt: { type: "string", format: "date-time" },
} } as const;
const scopeOutcomeSchema = { type: "object", additionalProperties: false, required: ["category", "action", "explanation"], properties: { category: { type: "string" }, action: { type: "string", enum: scopeOutcome.shape.action.options }, explanation: { type: "string" } } } as const;
const eventSchema = { type: "object", additionalProperties: false, required: ["id", "sequence", "eventType", "fromStatus", "toStatus", "actor", "assignee", "decisionRequestId", "visibility", "message", "occurredAt"], properties: {
  id: { type: "string", format: "uuid" }, sequence: { type: "integer", minimum: 1 }, eventType: { type: "string", enum: ["opened", "review_started", "information_requested", "requester_replied", "staff_note", "decision_proposed", "decision_approved", "decision_rejected", "withdrawn"] }, fromStatus: { anyOf: [statusSchema, { type: "null" }] }, toStatus: statusSchema, actor: actorSchema, assignee: { anyOf: [actorSchema, { type: "null" }] }, decisionRequestId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }, visibility: { type: "string", enum: ["requester", "internal"] }, message: { type: "string" }, occurredAt: { type: "string", format: "date-time" },
} } as const;
const decisionSchema = { type: "object", additionalProperties: false, required: ["id", "reference", "privacyRequestId", "outcome", "decisionSummary", "lawfulBasis", "scopeOutcomes", "fulfillmentCoverage", "status", "requestedBy", "reviewedBy", "reviewReason", "requestedAt", "reviewedAt", "appliedAt"], properties: {
  id: { type: "string", format: "uuid" }, reference: { type: "string" }, privacyRequestId: { type: "string", format: "uuid" }, outcome: { type: "string", enum: decisionProposalBody.shape.outcome.options }, decisionSummary: { type: "string" }, lawfulBasis: { type: "string" }, scopeOutcomes: { type: "array", items: scopeOutcomeSchema }, fulfillmentCoverage: coverageSchema, status: { type: "string", enum: ["pending", "applied", "rejected"] }, requestedBy: actorSchema, reviewedBy: { anyOf: [actorSchema, { type: "null" }] }, reviewReason: { anyOf: [{ type: "string" }, { type: "null" }] }, requestedAt: { type: "string", format: "date-time" }, reviewedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, appliedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
} } as const;
const packagePreparationSchema = { type: "object", additionalProperties: false, required: ["id", "reference", "privacyRequestId", "requestType", "requestVersion", "policy", "contentProfile", "coverageSnapshot", "coverageSha256", "sourceManifestSha256", "externalSnapshotSourceCount", "collectedSourceCount", "unavailableSourceCount", "notApplicableSourceCount", "collectedRecordCount", "collectedByteCount", "outcome", "deliverable", "preparedAt"], properties: {
  id: { type: "string", format: "uuid" }, reference: { type: "string" }, privacyRequestId: { type: "string", format: "uuid" }, requestType: { type: "string", enum: ["access", "portability"] }, requestVersion: { type: "integer", minimum: 1 },
  policy: { type: "object", additionalProperties: false, required: ["reference", "name", "canonicalFormat", "identityAssurance", "deliveryChannel", "maximumRecords", "maximumBytes", "maximumArtifacts", "packageRetentionHours", "requesterRetrievalHours"], properties: { reference: { type: "string" }, name: { type: "string" }, canonicalFormat: { type: "string", enum: ["application/vnd.fractal.privacy-package+json;version=1", "application/vnd.fractal.privacy-package+tar;version=2"] }, identityAssurance: { type: "string" }, deliveryChannel: { type: "string" }, maximumRecords: { type: "integer" }, maximumBytes: { type: "integer" }, maximumArtifacts: { type: "integer", minimum: 0, maximum: 1000 }, packageRetentionHours: { type: "integer" }, requesterRetrievalHours: { type: "integer" } } },
  contentProfile: { anyOf: [{ type: "object", additionalProperties: false, required: ["reference", "name", "schemaVersion", "fieldCatalogVersion", "jurisdictionCode", "valueSha256"], properties: { reference: { type: "string" }, name: { type: "string" }, schemaVersion: { type: "string", enum: ["privacy-content-profile-v1"] }, fieldCatalogVersion: { type: "string", pattern: "^privacy-safe-fields-v([1-9]|[1-3][0-9]|4[0-5])$" }, jurisdictionCode: { type: "string" }, valueSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } }, { type: "null" }] },
  coverageSnapshot: coverageSchema, coverageSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, sourceManifestSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, externalSnapshotSourceCount: { type: "integer", minimum: 0 }, collectedSourceCount: { type: "integer", minimum: 0 }, unavailableSourceCount: { type: "integer", minimum: 0 }, notApplicableSourceCount: { type: "integer", minimum: 0 }, collectedRecordCount: { type: "integer", minimum: 0 }, collectedByteCount: { type: "integer", minimum: 0 }, outcome: { type: "string", enum: ["blocked_incomplete_coverage", "ready_for_delivery"] }, deliverable: { type: "boolean" }, preparedAt: { type: "string", format: "date-time" },
} } as const;
const packageDeliverySchema = { type:"object",additionalProperties:false,required:["id","reference","preparationId","privacyRequestId","status","canonicalFormat","contentSha256","byteCount","requestedAt","retrievalExpiresAt","retainUntil","generatedAt","availableAt","expiredAt","destroyedAt","failureCategory"],properties:{
  id:{type:"string",format:"uuid"},reference:{type:"string"},preparationId:{type:"string",format:"uuid"},privacyRequestId:{type:"string",format:"uuid"},
  status:{type:"string",enum:["queued","materializing","available","failed","expired","cleanup_requested","destroyed","cleanup_failed"]},canonicalFormat:{type:"string"},
  contentSha256:{anyOf:[{type:"string",pattern:"^[0-9a-f]{64}$"},{type:"null"}]},byteCount:{anyOf:[{type:"integer",minimum:1},{type:"null"}]},
  requestedAt:{type:"string",format:"date-time"},retrievalExpiresAt:{type:"string",format:"date-time"},retainUntil:{type:"string",format:"date-time"},
  generatedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},availableAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},expiredAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},destroyedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},failureCategory:{anyOf:[{type:"string"},{type:"null"}]},
}} as const;
const requestCommandResponse = { type: "object", additionalProperties: false, required: ["request", "replayed"], properties: { request: requestObject, replayed: { type: "boolean" } } } as const;
const requestTransitionResponse = { type: "object", additionalProperties: false, required: ["request"], properties: { request: requestObject } } as const;
const decisionCommandResponse = { type: "object", additionalProperties: false, required: ["decision", "replayed"], properties: { decision: decisionSchema, replayed: { type: "boolean" } } } as const;
const treatmentSchema = { type: "object", additionalProperties: false, required: ["id", "reference", "privacyRequestId", "privacyDecisionRequestId", "targetType", "treatmentType", "policyTreatmentMode", "decisionScopeCategory", "decisionScopeAction", "treatmentStatement", "status", "policyReference", "retainUntil", "proposedBy", "reviewedBy", "reviewReason", "requesterVisibleSummary", "proposedAt", "reviewedAt", "execution"], properties: {
  id: { type: "string", format: "uuid" }, reference: { type: "string" }, privacyRequestId: { type: "string", format: "uuid" }, privacyDecisionRequestId: { type: "string", format: "uuid" }, targetType: { type: "string", enum: distributionTargetType.options }, treatmentType: { type: "string", enum: ["correction", "erasure", "restriction", "objection"] }, policyTreatmentMode: { type: "string" }, decisionScopeCategory: { type: "string" }, decisionScopeAction: { type: "string", enum: ["correct", "retain", "restrict", "refuse"] }, treatmentStatement: { type: "string" }, status: { type: "string", enum: ["pending", "approved", "rejected"] }, policyReference: { type: "string" }, retainUntil: { type: "string", format: "date-time" }, proposedBy: actorSchema, reviewedBy: { anyOf: [actorSchema, { type: "null" }] }, reviewReason: { anyOf: [{ type: "string" }, { type: "null" }] }, requesterVisibleSummary: { anyOf: [{ type: "string" }, { type: "null" }] }, proposedAt: { type: "string", format: "date-time" }, reviewedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, execution: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "result", "lawfulBasis", "legalHoldActive", "executedAt"], properties: { id: { type: "string", format: "uuid" }, result: { type: "string", enum: ["append_only_correction_recorded", "lawful_retention_confirmed", "mandatory_processing_restriction_applied", "objection_lawful_basis_review_recorded"] }, lawfulBasis: { type: "string" }, legalHoldActive: { type: "boolean" }, executedAt: { type: "string", format: "date-time" } } }, { type: "null" }] },
} } as const;
const treatmentCommandResponse = { type: "object", additionalProperties: false, required: ["treatment", "replayed"], properties: { treatment: treatmentSchema, replayed: { type: "boolean" } } } as const;
const externalSnapshotSchema = { type:"object",additionalProperties:false,required:[
  "id","reference","privacyRequestId","requestType","sourceKey","status","recordCount","byteCount",
  "canonicalFormat","artifactCount","requestedAt","collectedAt","expiresAt","expiredAt",
  "destroyedAt","failureCategory",
],properties:{
  id:{type:"string",format:"uuid"},reference:{type:"string"},privacyRequestId:{type:"string",format:"uuid"},
  requestType:{type:"string",enum:["access","portability"]},sourceKey:{type:"string",enum:externalPrivacySourceKeys},
  status:{type:"string",enum:["queued","collecting","available","failed","expired","cleanup_requested","destroyed","cleanup_failed"]},
  recordCount:{anyOf:[{type:"integer",minimum:0},{type:"null"}]},byteCount:{anyOf:[{type:"integer",minimum:1},{type:"null"}]},
  canonicalFormat:{type:"string",enum:["application/vnd.fractal.privacy-external-snapshot+json;version=1","application/vnd.fractal.privacy-external-snapshot+tar;version=2"]},
  artifactCount:{type:"integer",minimum:0,maximum:1000},
  requestedAt:{type:"string",format:"date-time"},collectedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},
  expiresAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},expiredAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},
  destroyedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},failureCategory:{anyOf:[{type:"string"},{type:"null"}]},
}} as const;
const sumsubProviderExportSchema = { type:"object",additionalProperties:false,required:[
  "id","reference","privacyRequestId","requestType","sourceKey","reportReference","entryCount",
  "sensitiveTier","status","byteCount","contentSha256","scan","generatedAt","downloadedAt",
  "uploadedAt","retainUntil","destroyedAt","failureCategory",
],properties:{
  id:{type:"string",format:"uuid"},reference:{type:"string"},privacyRequestId:{type:"string",format:"uuid"},
  requestType:{type:"string",enum:["access","portability"]},
  sourceKey:{type:"string",enum:["external.identity_verification.provider"]},
  reportReference:{type:"string"},entryCount:{type:"integer",enum:[1]},
  sensitiveTier:{type:"string",enum:["higher_sensitive_data"]},
  status:{type:"string",enum:["staged","cleanup_requested","destroyed","cleanup_failed"]},
  byteCount:{type:"integer",minimum:1,maximum:104857600},
  contentSha256:{type:"string",pattern:"^[0-9a-f]{64}$"},
  scan:{type:"object",additionalProperties:false,required:["status","scanner","scannedAt","evidenceSha256"],properties:{
    status:{type:"string",enum:["clean"]},scanner:{type:"string",enum:["clamav_instream"]},
    scannedAt:{type:"string",format:"date-time"},evidenceSha256:{type:"string",pattern:"^[0-9a-f]{64}$"},
  }},
  generatedAt:{type:"string",format:"date-time"},downloadedAt:{type:"string",format:"date-time"},
  uploadedAt:{type:"string",format:"date-time"},retainUntil:{type:"string",format:"date-time"},
  destroyedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},
  failureCategory:{anyOf:[{type:"string",enum:["cleanup_failed"]},{type:"null"}]},
}} as const;
const detailObject = { type: "object", additionalProperties: false, required: ["request", "events", "decisions", "distributionTreatments", "fulfillmentCoverage", "externalSnapshots", "sumsubProviderExports", "packagePreparations", "packageDeliveries"], properties: { request: requestObject, events: { type: "array", items: eventSchema }, decisions: { type: "array", items: decisionSchema }, distributionTreatments: { type: "array", items: treatmentSchema }, fulfillmentCoverage: coverageSchema, externalSnapshots:{type:"array",items:externalSnapshotSchema},sumsubProviderExports:{type:"array",items:sumsubProviderExportSchema}, packagePreparations: { type: "array", items: packagePreparationSchema },packageDeliveries:{type:"array",items:packageDeliverySchema} } } as const;

const sumsubPrivacyExportBodyLimit = 100 * 1024 * 1024;
const sumsubPrivacyExportHeaders = { type:"object",additionalProperties:true,required:[
  "x-command-id","x-fractal-sumsub-report-reference","x-fractal-sumsub-generated-at",
  "x-fractal-sumsub-downloaded-at","x-fractal-sumsub-settings-sha256",
],properties:{
  "x-command-id":{type:"string",minLength:1,maxLength:200},
  "x-fractal-sumsub-report-reference":{type:"string",minLength:1,maxLength:500},
  "x-fractal-sumsub-generated-at":{type:"string",format:"date-time"},
  "x-fractal-sumsub-downloaded-at":{type:"string",format:"date-time"},
  "x-fractal-sumsub-settings-sha256":{type:"string",pattern:"^[0-9a-fA-F]{64}$"},
}} as const;
const sumsubPrivacyExportAuthorizations = new WeakMap<FastifyRequest, AuthorizedSumsubPrivacyExportUpload>();

async function identity(request: FastifyRequest) {
  if (!request.authUser?.userId) throw new HttpError(401, "Authentication is required.");
  try { return await requirePostgresIdentityForSubject(request.authUser.userId); }
  catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Your account is not ready for the governed privacy-rights workflow.");
    throw error;
  }
}

function commandId(request: FastifyRequest) {
  const value = readCommandId(request.headers);
  if (!value || value.length > 200) throw new HttpError(400, "A valid X-Command-Id is required.");
  return value;
}

function privacyError(error: unknown): never {
  if(error instanceof SumsubPrivacyExportError){const status=error.code==="not_found"?404:error.code==="forbidden"?403:error.code==="conflict"?409:error.code==="policy_unavailable"?503:422;throw new HttpError(status,error.message);}
  if(error instanceof PrivacyExternalSnapshotError){const status=error.code==="not_found"?404:error.code==="forbidden"?403:error.code==="conflict"?409:error.code==="policy_unavailable"||error.code==="unavailable"?503:422;throw new HttpError(status,error.message);}
  if(error instanceof PrivacyPackageDeliveryError){const status=error.code==="not_found"?404:error.code==="forbidden"?403:error.code==="conflict"?409:error.code==="unavailable"?503:422;throw new HttpError(status,error.message);}
  if (error instanceof DistributionPrivacyTreatmentError) {
    const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 422;
    throw new HttpError(status, error.message);
  }
  if (error instanceof PrivacyRightsError) {
    const status = error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : error.code === "policy_unavailable" ? 503 : 422;
    throw new HttpError(status, error.message);
  }
  throw error;
}

async function requireSnapshotStepUp(request: FastifyRequest, identityId: string) {
  try {
    await requireFreshTotpStepUp({ sessionId: request.authUser?.sessionId, identityId });
  } catch (error) {
    if (error instanceof StepUpRequiredError) throw new HttpError(403, error.message);
    throw error;
  }
}

function readSumsubPrivacyExportMetadata(request: FastifyRequest) {
  const {requestId}=z.object({requestId:z.string().uuid()}).parse(request.params);
  const metadata=z.object({
    reportReference:z.string().trim().min(1).max(500),
    generatedAt:z.coerce.date(),
    downloadedAt:z.coerce.date(),
    settingsSha256:z.string().regex(/^[0-9a-fA-F]{64}$/),
  }).parse({
    reportReference:request.headers["x-fractal-sumsub-report-reference"],
    generatedAt:request.headers["x-fractal-sumsub-generated-at"],
    downloadedAt:request.headers["x-fractal-sumsub-downloaded-at"],
    settingsSha256:request.headers["x-fractal-sumsub-settings-sha256"],
  });
  return {requestId,...metadata};
}

async function authorizeSumsubPrivacyExportRequest(request: FastifyRequest) {
  const actorIdentityId=await identity(request);
  await requireSnapshotStepUp(request,actorIdentityId);
  const metadata=readSumsubPrivacyExportMetadata(request);
  return authorizeSumsubPrivacyExportUpload({
    actorIdentityId,
    privacyRequestId:metadata.requestId,
    reportReference:metadata.reportReference,
    generatedAt:metadata.generatedAt,
    downloadedAt:metadata.downloadedAt,
    settingsSha256:metadata.settingsSha256,
    commandKey:commandId(request),
  });
}

export async function postgresPrivacyRightsRoutes(app: FastifyInstance) {
  if(!app.hasContentTypeParser("application/octet-stream")){
    app.addContentTypeParser(
      "application/octet-stream",
      {parseAs:"buffer",bodyLimit:sumsubPrivacyExportBodyLimit},
      (_request,body,done)=>done(null,body),
    );
  }
  app.get("/v1/privacy/requests", {
    preHandler: [app.authenticate],
    schema: { tags: ["Privacy rights"], summary: "List the authenticated identity's privacy-rights requests", response: { 200: { type: "object", additionalProperties: false, required: ["requests"], properties: { requests: { type: "array", items: requestObject } } } } },
  }, async (request) => listOwnPrivacyRightsRequests({ actorIdentityId: await identity(request) }));

  app.post("/v1/privacy/requests", {
    preHandler: [app.authenticate],
    schema: { tags: ["Privacy rights"], summary: "Open an authenticated privacy-rights request", headers: commandHeaders, body: { type: "object", additionalProperties: false, required: ["requestType", "details"], properties: { requestType: { type: "string", enum: requestType.options }, details: { type: "string", minLength: 20, maxLength: 5000 } } }, response: { 200: requestCommandResponse, 201: requestCommandResponse } },
  }, async (request, reply) => {
    try { const body = createBody.parse(request.body); const result = await createPrivacyRightsRequest({ actorIdentityId: await identity(request), ...body, commandKey: commandId(request) }); return reply.code(result.replayed ? 200 : 201).send(result); }
    catch (error) { privacyError(error); }
  });

  app.get("/v1/privacy/requests/:requestId", {
    preHandler: [app.authenticate],
    schema: { tags: ["Privacy rights"], summary: "Read one owned privacy-rights request and requester-visible evidence", params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } }, response: { 200: detailObject } },
  }, async (request) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const actorIdentityId = await identity(request); const detail = await getOwnPrivacyRightsRequest({ actorIdentityId, requestId }); return { ...detail, externalSnapshots:await listOwnPrivacyExternalSnapshots({actorIdentityId,privacyRequestId:requestId}),sumsubProviderExports:[],packagePreparations: await listPrivacyRightsPackagePreparations({ actorIdentityId, requestId, administrator: false }),packageDeliveries:await listOwnPrivacyPackageDeliveries({actorIdentityId,privacyRequestId:requestId}) }; }
    catch (error) { privacyError(error); }
  });

  app.get("/v1/privacy/package-deliveries/:deliveryId/download", {
    preHandler:[app.authenticate],
    schema:{tags:["Privacy rights"],summary:"Download an owned integrity-verified privacy package within its retrieval window",params:{type:"object",additionalProperties:false,required:["deliveryId"],properties:{deliveryId:{type:"string",format:"uuid"}}},response:{200:{type:"string",format:"binary"}}},
  },async(request,reply)=>{
    try{const{deliveryId}=z.object({deliveryId:z.string().uuid()}).parse(request.params);const result=await downloadOwnPrivacyPackage({actorIdentityId:await identity(request),deliveryId});
      const extension=result.delivery.canonicalFormat==="application/vnd.fractal.privacy-package+tar;version=2"?"tar":"json";
      return reply.header("Content-Type",result.delivery.canonicalFormat).header("Content-Disposition",`attachment; filename="${result.delivery.reference}.${extension}"`).header("Cache-Control","private, no-store, max-age=0").header("Pragma","no-cache").header("X-Content-Type-Options","nosniff").header("X-Fractal-Content-SHA256",result.delivery.contentSha256).send(result.buffer);}
    catch(error){privacyError(error);}
  });

  app.post("/v1/privacy/requests/:requestId/messages", {
    preHandler: [app.authenticate],
    schema: { tags: ["Privacy rights"], summary: "Supply requested information to an owned privacy-rights request", params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["message", "expectedVersion"], properties: { message: { type: "string", minLength: 2, maxLength: 5000 }, expectedVersion: { type: "integer", minimum: 1 } } }, response: { 200: requestTransitionResponse } },
  }, async (request) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const body = versionedMessageBody.parse(request.body); return await replyToPrivacyRightsRequest({ actorIdentityId: await identity(request), requestId, ...body }); }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/privacy/requests/:requestId/withdraw", {
    preHandler: [app.authenticate],
    schema: { tags: ["Privacy rights"], summary: "Withdraw an eligible owned privacy-rights request", params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["reason", "expectedVersion"], properties: { reason: { type: "string", minLength: 10, maxLength: 2000 }, expectedVersion: { type: "integer", minimum: 1 } } }, response: { 200: requestTransitionResponse } },
  }, async (request) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const body = withdrawBody.parse(request.body); return await withdrawPrivacyRightsRequest({ actorIdentityId: await identity(request), requestId, ...body }); }
    catch (error) { privacyError(error); }
  });

  app.get("/v1/admin/privacy-requests", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "List capability-protected privacy-rights requests", querystring: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: requestStatus.options }, requestType: { type: "string", enum: requestType.options } } }, response: { 200: { type: "object", additionalProperties: false, required: ["requests"], properties: { requests: { type: "array", items: requestObject } } } } },
  }, async (request) => {
    try { const query = z.object({ status: requestStatus.optional(), requestType: requestType.optional() }).parse(request.query); return await listAdministratorPrivacyRightsRequests({ actorIdentityId: await identity(request), ...query }); }
    catch (error) { privacyError(error); }
  });

  app.get("/v1/admin/privacy-data-inventory", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Read the restricted authoritative personal-data source inventory", response: { 200: inventoryResponseSchema } },
  }, async (request) => {
    try { return await getAdministratorPrivacyDataInventory({ actorIdentityId: await identity(request) }); }
    catch (error) { privacyError(error); }
  });

  app.get("/v1/admin/privacy-requests/:requestId", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Read restricted privacy-rights request evidence", params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } }, response: { 200: detailObject } },
  }, async (request) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const actorIdentityId = await identity(request); const detail = await getAdministratorPrivacyRightsRequest({ actorIdentityId, requestId }); return { ...detail, externalSnapshots:await listAdministratorPrivacyExternalSnapshots({actorIdentityId,privacyRequestId:requestId}),sumsubProviderExports:await listAdministratorSumsubPrivacyExports({actorIdentityId,privacyRequestId:requestId}),packagePreparations: await listPrivacyRightsPackagePreparations({ actorIdentityId, requestId, administrator: true }), packageDeliveries: await listAdministratorPrivacyPackageDeliveries({ actorIdentityId, privacyRequestId: requestId }) }; }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/admin/privacy-requests/:requestId/external-snapshots", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration", "Privacy rights"],
      summary: "Request a step-up protected subject-bound external privacy snapshot",
      headers: commandHeaders,
      params: {
        type: "object", additionalProperties: false, required: ["requestId"],
        properties: { requestId: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object", additionalProperties: false, required: ["sourceKey"],
        properties: {
          sourceKey: { type: "string", enum: externalPrivacySourceKeys },
          providerExportId: { type: "string", format: "uuid" },
        },
      },
      response: {
        200: { type:"object",additionalProperties:false,required:["snapshot","replayed"],properties:{snapshot:externalSnapshotSchema,replayed:{type:"boolean"}} },
        201: { type:"object",additionalProperties:false,required:["snapshot","replayed"],properties:{snapshot:externalSnapshotSchema,replayed:{type:"boolean"}} },
      },
    },
  }, async (request, reply) => {
    try {
      const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
      const { sourceKey, providerExportId } = z.object({
        sourceKey: z.enum(externalPrivacySourceKeys),
        providerExportId: z.string().uuid().optional(),
      }).parse(request.body);
      const actorIdentityId = await identity(request);
      await requireSnapshotStepUp(request, actorIdentityId);
      const result = await requestPrivacyExternalSnapshot({
        actorIdentityId,
        privacyRequestId: requestId,
        sourceKey,
        providerExportId,
        commandKey: commandId(request),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      privacyError(error);
    }
  });

  app.post("/v1/admin/privacy-requests/:requestId/sumsub-provider-exports", {
    bodyLimit:sumsubPrivacyExportBodyLimit,
    onRequest:[
      app.authenticate,
      async(request)=>{
        try{
          const authorization=await authorizeSumsubPrivacyExportRequest(request);
          sumsubPrivacyExportAuthorizations.set(request,authorization);
        }catch(error){
          privacyError(error);
        }
      },
    ],
    schema:{
      tags:["Administration","Privacy rights"],
      summary:"Stage one exact malware-screened higher-sensitive Sumsub privacy export",
      consumes:["application/octet-stream"],
      headers:sumsubPrivacyExportHeaders,
      params:{type:"object",additionalProperties:false,required:["requestId"],properties:{
        requestId:{type:"string",format:"uuid"},
      }},
      response:{
        200:{type:"object",additionalProperties:false,required:["providerExport","replayed"],properties:{
          providerExport:sumsubProviderExportSchema,replayed:{type:"boolean"},
        }},
        201:{type:"object",additionalProperties:false,required:["providerExport","replayed"],properties:{
          providerExport:sumsubProviderExportSchema,replayed:{type:"boolean"},
        }},
      },
    },
  },async(request,reply)=>{
    try{
      const authorization=sumsubPrivacyExportAuthorizations.get(request)
        ?? await authorizeSumsubPrivacyExportRequest(request);
      sumsubPrivacyExportAuthorizations.delete(request);
      if(!Buffer.isBuffer(request.body)||request.body.length<1){
        throw new HttpError(422,"A non-empty Sumsub export ZIP is required.");
      }
      if(authorization.existing){
        const contentSha256=createHash("sha256").update(request.body).digest("hex");
        if(
          authorization.existing.content_sha256!==contentSha256
          || authorization.existing.byte_count!==request.body.length
        ){
          throw new SumsubPrivacyExportError(
            "This command key was completed with different Sumsub export bytes.",
            "conflict",
          );
        }
        return reply.code(200).send({
          providerExport:mapSumsubPrivacyExport(authorization.existing),
          replayed:true,
        });
      }
      const stored=await persistSumsubPrivacyExportBinary({
        exportId:authorization.exportId,
        content:request.body,
      });
      await requireSnapshotStepUp(request,authorization.actorIdentityId);
      const malwareScanEvidenceSha256=sumsubPrivacyScanEvidenceSha256({
        scanner:stored.scanner,
        scannedAt:stored.scannedAt,
        contentSha256:stored.sha256,
        byteCount:stored.bytes,
      });
      const result=await recordStoredDocument({
        storageKey:stored.storageKey,
        source:"sumsub-privacy-provider-export",
        logger:request.log,
        record:()=>recordSumsubPrivacyExportUpload({
          authorization,
          storageKey:stored.storageKey,
          contentSha256:stored.sha256,
          byteCount:stored.bytes,
          scanner:stored.scanner,
          scannedAt:stored.scannedAt,
          malwareScanEvidenceSha256,
        }),
      });
      return reply.code(201).send(result);
    }catch(error){
      sumsubPrivacyExportAuthorizations.delete(request);
      privacyError(error);
    }
  });

  app.post("/v1/admin/privacy-requests/:requestId/policy-binding", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Bind the exact active privacy response policy to an existing request", params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["expectedVersion"], properties: { expectedVersion: { type: "integer", minimum: 1 } } }, response: { 200: requestCommandResponse, 201: requestCommandResponse } },
  }, async (request, reply) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const body = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body); const result = await bindPrivacyRightsResponsePolicy({ actorIdentityId: await identity(request), requestId, ...body }); return reply.code(result.replayed ? 200 : 201).send(result); }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/admin/privacy-requests/:requestId/transitions", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Record a capability-protected privacy request transition", params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["action", "message", "expectedVersion"], properties: { action: { type: "string", enum: transitionBody.shape.action.options }, message: { type: "string", minLength: 2, maxLength: 5000 }, expectedVersion: { type: "integer", minimum: 1 } } }, response: { 200: requestTransitionResponse } },
  }, async (request) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const body = transitionBody.parse(request.body); return await transitionAdministratorPrivacyRightsRequest({ actorIdentityId: await identity(request), requestId, ...body }); }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/admin/privacy-requests/:requestId/decision-requests", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration", "Privacy rights"], summary: "Propose a structured privacy-rights outcome", headers: commandHeaders,
      params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } },
      body: {
        type: "object", additionalProperties: false, required: ["outcome", "decisionSummary", "lawfulBasis", "scopeOutcomes"],
        properties: {
          outcome: { type: "string", enum: decisionProposalBody.shape.outcome.options },
          decisionSummary: { type: "string", minLength: 20, maxLength: 5000 },
          lawfulBasis: { type: "string", minLength: 20, maxLength: 2000 },
          scopeOutcomes: {
            type: "array", minItems: 1, maxItems: 100,
            items: { type: "object", additionalProperties: false, required: ["category", "action", "explanation"], properties: {
              category: { type: "string", minLength: 2, maxLength: 120 }, action: { type: "string", enum: scopeOutcome.shape.action.options }, explanation: { type: "string", minLength: 20, maxLength: 2000 },
            } },
          },
        },
      },
      response: { 200: decisionCommandResponse, 201: decisionCommandResponse },
    },
  }, async (request, reply) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const body = decisionProposalBody.parse(request.body); const result = await proposePrivacyRightsDecision({ actorIdentityId: await identity(request), requestId, ...body, commandKey: commandId(request) }); return reply.code(result.replayed ? 200 : 201).send(result); }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/admin/privacy-requests/:requestId/package-preparations", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration", "Privacy rights"], summary: "Record content-free canonical package preparation evidence", headers: commandHeaders,
      params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, required: ["expectedVersion"], properties: { expectedVersion: { type: "integer", minimum: 1 } } },
      response: { 200: { type: "object", additionalProperties: false, required: ["preparation", "replayed"], properties: { preparation: packagePreparationSchema, replayed: { type: "boolean" } } }, 201: { type: "object", additionalProperties: false, required: ["preparation", "replayed"], properties: { preparation: packagePreparationSchema, replayed: { type: "boolean" } } } },
    },
  }, async (request, reply) => {
    try { const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params); const { expectedVersion } = z.object({ expectedVersion: z.number().int().positive() }).parse(request.body); const result = await preparePrivacyRightsPackageEvidence({ actorIdentityId: await identity(request), requestId, expectedVersion, commandKey: commandId(request) }); return reply.code(result.replayed ? 200 : 201).send(result); }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/admin/privacy-package-preparations/:preparationId/deliveries", {
    preHandler:[app.authenticate],
    schema:{tags:["Administration","Privacy rights"],summary:"Authorize private delivery for an exact complete privacy-package preparation",headers:commandHeaders,params:{type:"object",additionalProperties:false,required:["preparationId"],properties:{preparationId:{type:"string",format:"uuid"}}},response:{200:{type:"object",additionalProperties:false,required:["delivery","replayed"],properties:{delivery:packageDeliverySchema,replayed:{type:"boolean"}}},201:{type:"object",additionalProperties:false,required:["delivery","replayed"],properties:{delivery:packageDeliverySchema,replayed:{type:"boolean"}}}}},
  },async(request,reply)=>{try{const{preparationId}=z.object({preparationId:z.string().uuid()}).parse(request.params);const result=await requestPrivacyPackageDelivery({actorIdentityId:await identity(request),preparationId,commandKey:commandId(request)});return reply.code(result.replayed?200:201).send(result);}catch(error){privacyError(error);}});

  app.post("/v1/admin/privacy-decision-requests/:decisionRequestId/decision", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Independently decide a proposed privacy-rights outcome", params: { type: "object", required: ["decisionRequestId"], properties: { decisionRequestId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["decision", "reviewReason"], properties: { decision: { type: "string", enum: decisionBody.shape.decision.options }, reviewReason: { type: "string", minLength: 20, maxLength: 2000 } } }, response: { 200: decisionCommandResponse } },
  }, async (request) => {
    try { const { decisionRequestId } = z.object({ decisionRequestId: z.string().uuid() }).parse(request.params); const body = decisionBody.parse(request.body); return await decidePrivacyRightsDecision({ actorIdentityId: await identity(request), decisionRequestId, ...body }); }
    catch (error) { privacyError(error); }
  });

  app.post("/v1/admin/privacy-requests/:requestId/distribution-treatment-requests", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Propose an exact policy-bound distribution privacy treatment", headers: commandHeaders,
      params: { type: "object", required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, required: ["targetType", "targetId", "decisionScopeCategory", "treatmentStatement"], properties: {
        targetType: { type: "string", enum: distributionTargetType.options }, targetId: { type: "string", format: "uuid" },
        decisionScopeCategory: { type: "string", minLength: 2, maxLength: 120 }, treatmentStatement: { type: "string", minLength: 20, maxLength: 2000 },
      } }, response: { 200: treatmentCommandResponse, 201: treatmentCommandResponse } },
  }, async (request, reply) => {
    try { const { requestId }=z.object({requestId:z.string().uuid()}).parse(request.params);const body=treatmentProposalBody.parse(request.body);
      const result=await proposeDistributionPrivacyTreatment({actorIdentityId:await identity(request),privacyRequestId:requestId,...body,commandKey:commandId(request)});
      return reply.code(result.replayed?200:201).send(result); } catch(error){privacyError(error);}
  });

  app.post("/v1/admin/distribution-privacy-treatment-requests/:treatmentRequestId/decision", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration", "Privacy rights"], summary: "Independently decide and execute a distribution privacy treatment",
      params: { type: "object", required: ["treatmentRequestId"], properties: { treatmentRequestId: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, required: ["decision", "reviewReason", "requesterVisibleSummary"], properties: {
        decision: { type: "string", enum: treatmentDecisionBody.shape.decision.options }, reviewReason: { type: "string", minLength: 20, maxLength: 2000 },
        requesterVisibleSummary: { type: "string", minLength: 20, maxLength: 2000 },
      } }, response: { 200: treatmentCommandResponse } },
  }, async(request)=>{
    try{const {treatmentRequestId}=z.object({treatmentRequestId:z.string().uuid()}).parse(request.params);const body=treatmentDecisionBody.parse(request.body);
      return await decideDistributionPrivacyTreatment({actorIdentityId:await identity(request),treatmentRequestId,...body});}catch(error){privacyError(error);}
  });
}
