import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import {
  parsePrivacyExternalAttestationSet,
  type ExternalPrivacyAttestationKeyRing,
  type ExternalPrivacyAttestationRuntimeDescriptor,
} from "../modules/privacy/domain/privacy-external-attestation-set.js";
import {
  externalPrivacySourceKeys,
  type ExternalPrivacySourceKey,
  type PrivacyExternalAdapterPolicy,
} from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import {
  requiredExternalPrivacyCoverage,
} from "../modules/privacy/domain/privacy-external-coverage.js";
import { parsePrivacyPackagePolicy } from "../modules/privacy/domain/privacy-package-policy.js";
import type {
  PrivacyPackageArtifactInput,
  PrivacyPackageArtifactManifestItem,
} from "../modules/privacy/domain/privacy-package-archive.js";
import {
  buildPrivacyExternalSnapshotArchiveV2,
  parsePrivacyExternalSnapshotArchiveV2,
  PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2,
} from "../modules/privacy/domain/privacy-external-snapshot-archive.js";
import {
  deleteStoredFile,
  persistPrivacyExternalSnapshotBinary,
  retrieveFile,
} from "../services/storage.js";
import {
  collectPublicChainPrivacyRecords,
  CHAIN_PRIVACY_OUTPUT_FIELDS,
  ChainPrivacyAdapterError,
} from "../services/privacy-external-chain-adapter.js";
import {
  collectResendPrivacyRecords,
  ResendPrivacyAdapterError,
} from "../services/privacy-external-resend-adapter.js";
import {
  collectSumsubPrivacyRecords,
  SUMSUB_PRIVACY_OUTPUT_FIELDS,
  SumsubPrivacyAdapterError,
} from "../services/privacy-external-sumsub-adapter.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import {
  AdministratorCapabilityError,
  requireAdministratorCapability,
} from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import {
  readActiveExternalPrivacyAdapterPolicyForBinding,
} from "./privacy-external-adapter-runtime.js";
import {
  EXTERNAL_PRIVACY_ATTESTATION_SET_KEY,
  readActiveExternalPrivacyAttestationReadiness,
} from "./privacy-external-attestation-runtime.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import { queryResendPrivacyDeliveryReferencesForIdentity } from "./postgres-resend-privacy-references.js";
import { queryChainPrivacyRecordsForIdentity } from "./postgres-chain-privacy-references.js";
import {
  enqueueStorageCleanupTask,
  markStorageCleanupTaskCompletedInline,
} from "./postgres-storage-cleanup.js";
import {
  queueSumsubPrivacyExportCleanupAfterSnapshot,
  sumsubPrivacyScanEvidenceSha256,
} from "./postgres-sumsub-privacy-exports.js";
import type {
  CanonicalPrivacySourceSection,
  PrivacyExternalSnapshotManifestItem,
} from "./postgres-privacy-package-preparations.js";

const MANAGE_CAPABILITY = "privacy_request_manage";
const COLLECT_CAPABILITY = "privacy_external_collect";
const PACKAGE_POLICY_KEY = "privacy.rights.package_policy";
const PRIVACY_EXTERNAL_SNAPSHOT_JSON_FORMAT_V1 =
  "application/vnd.fractal.privacy-external-snapshot+json;version=1" as const;

type SnapshotStatus =
  | "queued"
  | "collecting"
  | "available"
  | "failed"
  | "expired"
  | "cleanup_requested"
  | "destroyed"
  | "cleanup_failed";

type SnapshotRow = {
  id: string;
  reference: string;
  privacy_request_id: string;
  requester_identity_id: string;
  request_type: "access" | "portability";
  source_key: ExternalPrivacySourceKey;
  status: SnapshotStatus;
  adapter_policy_version_id: string;
  adapter_policy_version_number: number;
  adapter_policy_projection_version: number;
  adapter_policy_value_sha256: string;
  source_policy: PrivacyExternalAdapterPolicy["sources"][number];
  attestation_version_id: string;
  attestation_version_number: number;
  attestation_projection_version: number;
  attestation_value_sha256: string;
  source_attestation: ReturnType<typeof parsePrivacyExternalAttestationSet>["attestations"][number];
  package_policy_version_id: string;
  package_policy_version_number: number;
  package_policy_projection_version: number;
  package_policy_value_sha256: string;
  requested_by_identity_id: string;
  requested_at: Date;
  retain_until: Date;
  claimed_by: string | null;
  claimed_at: Date | null;
  attempts: number;
  record_count: number | null;
  byte_count: number | null;
  content_sha256: string | null;
  storage_key: string | null;
  collected_at: Date | null;
  expires_at: Date | null;
  expired_at: Date | null;
  destroyed_at: Date | null;
  failure_category: string | null;
  provider_export_id: string | null;
  canonical_format:
    | "application/vnd.fractal.privacy-external-snapshot+json;version=1"
    | typeof PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2;
  artifact_count: number;
  artifact_manifest: Array<{
    sourceKey: string;
    componentKey: string;
    path: string;
    mediaType: string;
    byteCount: number;
    sha256: string;
  }>;
};

type SumsubProviderExportSnapshotRow = {
  id: string;
  privacy_request_id: string;
  requester_identity_id: string;
  request_type: "access" | "portability";
  applicant_id: string;
  external_user_id: string;
  inspection_id: string;
  report_reference: string;
  entry_count: 1;
  sensitive_tier: "higher_sensitive_data";
  generated_at: Date;
  downloaded_at: Date;
  content_sha256: string;
  byte_count: number;
  settings_sha256: string;
  scanner: "clamav_instream";
  scanned_at: Date;
  malware_scan_evidence_sha256: string;
  storage_key: string;
  package_policy_version_id: string;
  package_policy_value_sha256: string;
  status: "staged" | "cleanup_requested";
  retain_until: Date;
};

type RuntimeOptions = {
  runtimeRegistry?: readonly ExternalPrivacyAttestationRuntimeDescriptor[];
  applicationReleaseSha256?: string;
  keyRing?: ExternalPrivacyAttestationKeyRing;
  keyRingErrors?: readonly string[];
  now?: Date;
};

type SnapshotWorkerLogger = {
  error: (value: unknown, message?: string) => void;
};

export class PrivacyExternalSnapshotError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "forbidden" | "not_found" | "conflict" | "policy_unavailable" | "unavailable",
  ) {
    super(message);
    this.name = "PrivacyExternalSnapshotError";
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function reference(now = new Date()): string {
  return `PXS-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new PrivacyExternalSnapshotError(`${label} must contain 1 to ${maximum} characters.`, "invalid_input");
  }
  return normalized;
}

function mapSnapshot(row: SnapshotRow) {
  return {
    id: row.id,
    reference: row.reference,
    privacyRequestId: row.privacy_request_id,
    requestType: row.request_type,
    sourceKey: row.source_key,
    status: row.status,
    recordCount: row.record_count,
    byteCount: row.byte_count,
    canonicalFormat: row.canonical_format,
    artifactCount: row.artifact_count,
    requestedAt: row.requested_at.toISOString(),
    collectedAt: row.collected_at?.toISOString() ?? null,
    expiresAt: row.expires_at?.toISOString() ?? null,
    expiredAt: row.expired_at?.toISOString() ?? null,
    destroyedAt: row.destroyed_at?.toISOString() ?? null,
    failureCategory: row.failure_category,
  };
}

function sumsubPolicyMatchesCollector(
  sourcePolicy: PrivacyExternalAdapterPolicy["sources"][number],
): boolean {
  const outputFields = sourcePolicy.fields
    .filter((field) => field.handling === "include")
    .map((field) => field.outputField)
    .filter((field): field is string => Boolean(field))
    .sort();
  const referenceFields = [...sourcePolicy.correlation.referenceFields].sort();
  return sourcePolicy.collectionMode === "live_api"
    && sourcePolicy.correlation.mode === "exact_provider_reference"
    && stableJsonStringify(referenceFields)
      === stableJsonStringify([
        "applicantId",
        "externalUserId",
        "inspectionId",
        "reportReference",
      ])
    && stableJsonStringify(sourcePolicy.coverage)
      === stableJsonStringify(requiredExternalPrivacyCoverage(
        "external.identity_verification.provider",
      ))
    && stableJsonStringify(outputFields)
      === stableJsonStringify([...SUMSUB_PRIVACY_OUTPUT_FIELDS].sort());
}

function resendPolicyMatchesCollector(
  sourcePolicy: PrivacyExternalAdapterPolicy["sources"][number],
): boolean {
  const outputFields = sourcePolicy.fields
    .filter((field) => field.handling === "include")
    .map((field) => field.outputField)
    .sort();
  return sourcePolicy.collectionMode === "live_api"
    && sourcePolicy.correlation.mode === "exact_provider_reference"
    && sourcePolicy.correlation.referenceFields.includes("providerMessageId")
    && stableJsonStringify(sourcePolicy.coverage)
      === stableJsonStringify(requiredExternalPrivacyCoverage(
        "external.resend.delivery",
      ))
    && stableJsonStringify(outputFields) === stableJsonStringify(["createdAt", "lastEvent"]);
}

function chainPolicyMatchesCollector(
  sourcePolicy: PrivacyExternalAdapterPolicy["sources"][number],
): boolean {
  const outputFields = sourcePolicy.fields
    .filter((field) => field.handling === "include")
    .map((field) => field.outputField)
    .sort();
  return sourcePolicy.collectionMode === "public_immutable_disclosure"
    && sourcePolicy.correlation.mode === "exact_wallet_binding"
    && sourcePolicy.correlation.referenceFields.includes("walletAddress")
    && stableJsonStringify(sourcePolicy.coverage)
      === stableJsonStringify(requiredExternalPrivacyCoverage(
        "external.chain.public_records",
      ))
    && sourcePolicy.rights.access.mode === "immutable_disclosure"
    && sourcePolicy.rights.portability.mode === "collect"
    && stableJsonStringify(outputFields) === stableJsonStringify(CHAIN_PRIVACY_OUTPUT_FIELDS);
}

async function requireCapabilities(client: PoolClient, actorIdentityId: string): Promise<void> {
  try {
    await requireAdministratorCapability(client, actorIdentityId, MANAGE_CAPABILITY);
    await requireAdministratorCapability(client, actorIdentityId, COLLECT_CAPABILITY);
  } catch (error) {
    if (error instanceof AdministratorCapabilityError) {
      throw new PrivacyExternalSnapshotError(
        "Privacy management and external collection capabilities are required.",
        "forbidden",
      );
    }
    throw error;
  }
}

async function readGovernedBindings(client: PoolClient, options: RuntimeOptions) {
  const adapter = await readActiveExternalPrivacyAdapterPolicyForBinding(client, options.runtimeRegistry);
  if (!adapter) {
    throw new PrivacyExternalSnapshotError("No approved external privacy adapter policy is active.", "policy_unavailable");
  }
  const attestationBinding = await readActivePlatformConfigurationForBinding(
    client,
    EXTERNAL_PRIVACY_ATTESTATION_SET_KEY,
  );
  if (!attestationBinding) {
    throw new PrivacyExternalSnapshotError("No approved external privacy attestation set is active.", "policy_unavailable");
  }
  const attestationSet = parsePrivacyExternalAttestationSet(attestationBinding.value);
  const readiness = await readActiveExternalPrivacyAttestationReadiness(client, {
    policy: adapter.policy,
    policyBinding: adapter.binding,
    runtimeRegistry: options.runtimeRegistry,
    applicationReleaseSha256: options.applicationReleaseSha256,
    keyRing: options.keyRing,
    keyRingErrors: options.keyRingErrors,
    now: options.now,
  });
  const packageBinding = await readActivePlatformConfigurationForBinding(client, PACKAGE_POLICY_KEY);
  if (!packageBinding) {
    throw new PrivacyExternalSnapshotError("No approved privacy package policy is active.", "policy_unavailable");
  }
  let packagePolicy;
  try {
    packagePolicy = parsePrivacyPackagePolicy(packageBinding.value);
  } catch {
    throw new PrivacyExternalSnapshotError("The active privacy package policy is invalid.", "policy_unavailable");
  }
  return { adapter, attestationBinding, attestationSet, readiness, packageBinding, packagePolicy };
}

export async function requestPrivacyExternalSnapshot(input: {
  actorIdentityId: string;
  privacyRequestId: string;
  sourceKey: ExternalPrivacySourceKey;
  providerExportId?: string;
  commandKey: string;
  runtimeOptions?: RuntimeOptions;
}) {
  if (!externalPrivacySourceKeys.includes(input.sourceKey)) {
    throw new PrivacyExternalSnapshotError("External privacy source is invalid.", "invalid_input");
  }
  const providerExportId = input.providerExportId?.trim().toLowerCase() ?? null;
  if (
    (input.sourceKey === "external.identity_verification.provider")
      !== Boolean(providerExportId)
    || (providerExportId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(providerExportId))
  ) {
    throw new PrivacyExternalSnapshotError(
      "The Sumsub source requires one valid staged provider-export ID. Other sources cannot use it.",
      "invalid_input",
    );
  }
  return withPostgresTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('privacy-external-snapshot:' || $1,0))",
      [input.privacyRequestId],
    );
    await requireCapabilities(client, input.actorIdentityId);
    const commandKey = boundedText(input.commandKey, "Command key", 200);
    const replay = await client.query<SnapshotRow>(
      `SELECT * FROM fractal.privacy_external_collection_snapshots
        WHERE requested_by_identity_id=$1 AND command_key=$2`,
      [input.actorIdentityId, commandKey],
    );
    if (replay.rows[0]) {
      if (
        replay.rows[0].privacy_request_id !== input.privacyRequestId
        || replay.rows[0].source_key !== input.sourceKey
        || replay.rows[0].provider_export_id !== providerExportId
      ) {
        throw new PrivacyExternalSnapshotError(
          "This command key was already used for another external snapshot.",
          "conflict",
        );
      }
      return { snapshot: mapSnapshot(replay.rows[0]), replayed: true };
    }

    const request = await client.query<{
      id: string;
      requester_identity_id: string;
      request_type: string;
      status: string;
      assigned_to_identity_id: string | null;
    }>(
      `SELECT id,requester_identity_id,request_type,status,assigned_to_identity_id
         FROM fractal.privacy_rights_requests WHERE id=$1 FOR UPDATE`,
      [input.privacyRequestId],
    );
    const requestRow = request.rows[0];
    if (!requestRow) {
      throw new PrivacyExternalSnapshotError("Privacy-rights request not found.", "not_found");
    }
    if (
      requestRow.status !== "in_review"
      || requestRow.assigned_to_identity_id !== input.actorIdentityId
      || !["access", "portability"].includes(requestRow.request_type)
    ) {
      throw new PrivacyExternalSnapshotError(
        "The assigned owner can collect external data only for an in-review access or portability request.",
        "conflict",
      );
    }

    const now = input.runtimeOptions?.now ?? new Date();
    if (providerExportId) {
      const providerExport = await client.query(
        `SELECT 1
           FROM fractal.privacy_external_provider_exports
          WHERE id=$1
            AND privacy_request_id=$2
            AND requester_identity_id=$3
            AND request_type=$4
            AND source_key=$5
            AND status='staged'
            AND retain_until>$6
          FOR SHARE`,
        [
          providerExportId,
          requestRow.id,
          requestRow.requester_identity_id,
          requestRow.request_type,
          input.sourceKey,
          now,
        ],
      );
      if (!providerExport.rowCount) {
        throw new PrivacyExternalSnapshotError(
          "The selected Sumsub provider export is not current for this request.",
          "conflict",
        );
      }
    }
    const governed = await readGovernedBindings(client, { ...input.runtimeOptions, now });
    const sourcePolicy = governed.adapter.policy.sources.find((source) => source.sourceKey === input.sourceKey);
    const sourceRuntime = governed.adapter.runtime.sources.find((source) => source.sourceKey === input.sourceKey);
    const sourceReadiness = governed.readiness.sources.find((source) => source.sourceKey === input.sourceKey);
    const sourceAttestation = governed.attestationSet.attestations.find(
      (attestation) => attestation.payload.sourceKey === input.sourceKey,
    );
    const right = sourcePolicy?.rights[requestRow.request_type as "access" | "portability"];
    if (
      !sourcePolicy
      || !sourceAttestation
      || (
        right?.mode !== "collect"
        && !(
          input.sourceKey === "external.chain.public_records"
          && right?.mode === "immutable_disclosure"
        )
      )
      || sourceRuntime?.status !== "runtime_compatible"
      || sourceReadiness?.status !== "valid"
    ) {
      throw new PrivacyExternalSnapshotError(
        "The source does not have a valid collect operation, runtime, and signed production attestation.",
        "policy_unavailable",
      );
    }
    const retainUntil = new Date(
      now.getTime() + governed.packagePolicy.packageRetentionHours * 3_600_000,
    );
    const id = randomUUID();
    const inserted = await client.query<SnapshotRow>(
      `INSERT INTO fractal.privacy_external_collection_snapshots(
         id,reference,privacy_request_id,requester_identity_id,request_type,source_key,status,
         adapter_policy_configuration_key,adapter_policy_version_id,adapter_policy_version_number,
         adapter_policy_projection_version,adapter_policy_value_sha256,source_policy,
         attestation_configuration_key,attestation_version_id,attestation_version_number,
         attestation_projection_version,attestation_value_sha256,source_attestation,
         package_policy_configuration_key,package_policy_version_id,package_policy_version_number,
         package_policy_projection_version,package_policy_value_sha256,
         command_key,requested_by_identity_id,requested_at,retain_until,provider_export_id
       ) VALUES(
         $1,$2,$3,$4,$5,$6,'queued',
         'privacy.external_source.adapter_policy',$7,$8,$9,$10,$11,
         'privacy.external_source.attestation_set',$12,$13,$14,$15,$16,
         'privacy.rights.package_policy',$17,$18,$19,$20,
         $21,$22,$23,$24,$25
       ) RETURNING *`,
      [
        id,
        reference(now),
        requestRow.id,
        requestRow.requester_identity_id,
        requestRow.request_type,
        input.sourceKey,
        governed.adapter.binding.versionId,
        governed.adapter.binding.versionNumber,
        governed.adapter.binding.projectionVersion,
        governed.adapter.binding.valueSha256,
        JSON.stringify(sourcePolicy),
        governed.attestationBinding.versionId,
        governed.attestationBinding.versionNumber,
        governed.attestationBinding.projectionVersion,
        governed.attestationBinding.valueSha256,
        JSON.stringify(sourceAttestation),
        governed.packageBinding.versionId,
        governed.packageBinding.versionNumber,
        governed.packageBinding.projectionVersion,
        governed.packageBinding.valueSha256,
        commandKey,
        input.actorIdentityId,
        now,
        retainUntil,
        providerExportId,
      ],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `privacy-request:${requestRow.id}`,
      actorId: input.actorIdentityId,
      actorType: "user",
      action: "privacy.request.external_snapshot_requested",
      entityType: "privacy_external_collection_snapshot",
      entityId: id,
      reason: "The assigned owner requested subject-bound external collection under exact active policy and attestation bindings.",
      payload: {
        sourceKey: input.sourceKey,
        adapterPolicyValueSha256: governed.adapter.binding.valueSha256,
        attestationValueSha256: governed.attestationBinding.valueSha256,
        retainUntil: retainUntil.toISOString(),
        providerExportId,
      },
    });
    await appendOutboxEvent(client, {
      aggregateType: "privacy_rights_request",
      aggregateId: requestRow.id,
      eventType: "privacy.request.external_snapshot_requested",
      payload: { snapshotId: id, sourceKey: input.sourceKey, auditEventId: audit.id },
    });
    return { snapshot: mapSnapshot(inserted.rows[0]!), replayed: false };
  });
}

export async function listOwnPrivacyExternalSnapshots(input: {
  actorIdentityId: string;
  privacyRequestId: string;
}) {
  return withPostgresTransaction(async (client) => {
    const owned = await client.query(
      `SELECT 1 FROM fractal.privacy_rights_requests
        WHERE id=$1 AND requester_identity_id=$2`,
      [input.privacyRequestId, input.actorIdentityId],
    );
    if (!owned.rowCount) {
      throw new PrivacyExternalSnapshotError("Privacy-rights request not found.", "not_found");
    }
    const rows = await client.query<SnapshotRow>(
      `SELECT * FROM fractal.privacy_external_collection_snapshots
        WHERE privacy_request_id=$1 ORDER BY requested_at,id`,
      [input.privacyRequestId],
    );
    return rows.rows.map(mapSnapshot);
  });
}

export async function listAdministratorPrivacyExternalSnapshots(input: {
  actorIdentityId: string;
  privacyRequestId: string;
}) {
  return withPostgresTransaction(async (client) => {
    try {
      await requireAdministratorCapability(client, input.actorIdentityId, MANAGE_CAPABILITY);
    } catch (error) {
      if (error instanceof AdministratorCapabilityError) {
        throw new PrivacyExternalSnapshotError("Privacy management capability is required.", "forbidden");
      }
      throw error;
    }
    const rows = await client.query<SnapshotRow>(
      `SELECT * FROM fractal.privacy_external_collection_snapshots
        WHERE privacy_request_id=$1 ORDER BY requested_at,id`,
      [input.privacyRequestId],
    );
    return rows.rows.map(mapSnapshot);
  });
}

export async function claimPrivacyExternalSnapshot(
  workerId: string,
  claimTimeoutSeconds = 300,
  supportedSourceKeys: readonly ExternalPrivacySourceKey[] = ["external.resend.delivery"],
): Promise<SnapshotRow | null> {
  const normalizedWorkerId = boundedText(workerId, "Worker ID", 200);
  if (!Number.isInteger(claimTimeoutSeconds) || claimTimeoutSeconds < 30 || claimTimeoutSeconds > 3_600) {
    throw new PrivacyExternalSnapshotError("Claim timeout must be between 30 and 3600 seconds.", "invalid_input");
  }
  if (
    supportedSourceKeys.length < 1
    || new Set(supportedSourceKeys).size !== supportedSourceKeys.length
    || supportedSourceKeys.some((sourceKey) => !externalPrivacySourceKeys.includes(sourceKey))
  ) {
    throw new PrivacyExternalSnapshotError("Worker source support is invalid.", "invalid_input");
  }
  return withPostgresTransaction(async (client) => {
    const result = await client.query<SnapshotRow>(
      `WITH candidate AS (
         SELECT id FROM fractal.privacy_external_collection_snapshots
          WHERE status IN('queued','collecting')
            AND source_key=ANY($3::text[])
            AND (status='queued' OR claimed_at<now()-($1*interval '1 second'))
          ORDER BY requested_at,id
          FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE fractal.privacy_external_collection_snapshots snapshot
          SET status='collecting',claimed_by=$2,claimed_at=now(),attempts=attempts+1
         FROM candidate
        WHERE snapshot.id=candidate.id
       RETURNING snapshot.*`,
      [claimTimeoutSeconds, normalizedWorkerId, supportedSourceKeys],
    );
    return result.rows[0] ?? null;
  });
}

async function markSnapshotFailed(
  snapshotId: string,
  workerId: string,
  category: "policy_changed" | "attestation_changed" | "reference_unavailable" | "provider_failed" | "storage_failed" | "finalization_failed",
): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const failed = await client.query<{ privacy_request_id: string; source_key: string }>(
      `UPDATE fractal.privacy_external_collection_snapshots
          SET status='failed',claimed_by=NULL,claimed_at=NULL,failure_category=$3
        WHERE id=$1 AND status='collecting' AND claimed_by=$2
        RETURNING privacy_request_id,source_key`,
      [snapshotId, workerId, category],
    );
    const row = failed.rows[0];
    if (!row) return;
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `privacy-request:${row.privacy_request_id}`,
      actorType: "worker",
      action: "privacy.request.external_snapshot_failed",
      entityType: "privacy_external_collection_snapshot",
      entityId: snapshotId,
      reason: "The external snapshot failed closed before it became package evidence.",
      payload: { sourceKey: row.source_key, failureCategory: category, workerId },
    });
    await appendOutboxEvent(client, {
      aggregateType: "privacy_rights_request",
      aggregateId: row.privacy_request_id,
      eventType: "privacy.request.external_snapshot_failed",
      payload: { snapshotId, sourceKey: row.source_key, failureCategory: category, auditEventId: audit.id },
    });
  });
}

export async function materializeOnePrivacyExternalSnapshot(input: {
  workerId: string;
  resendApiKey?: string;
  sumsubAppToken?: string;
  sumsubSecretKey?: string;
  supportedSourceKeys?: readonly ExternalPrivacySourceKey[];
  runtimeOptions?: RuntimeOptions;
  collect?: typeof collectResendPrivacyRecords;
  collectChain?: typeof collectPublicChainPrivacyRecords;
  collectSumsub?: typeof collectSumsubPrivacyRecords;
  retrieve?: typeof retrieveFile;
  store?: typeof persistPrivacyExternalSnapshotBinary;
  logger?: SnapshotWorkerLogger;
}): Promise<boolean> {
  const supportedSourceKeys = input.supportedSourceKeys
    ?? (input.resendApiKey
      ? ["external.resend.delivery"] as const
      : ["external.chain.public_records"] as const);
  const snapshot = await claimPrivacyExternalSnapshot(
    input.workerId,
    300,
    supportedSourceKeys,
  );
  if (!snapshot) return false;
  const now = input.runtimeOptions?.now ?? new Date();
  let governed: Awaited<ReturnType<typeof readGovernedBindings>>;
  try {
    governed = await withPostgresTransaction((client) =>
      readGovernedBindings(client, { ...input.runtimeOptions, now }));
  } catch {
    await markSnapshotFailed(snapshot.id, input.workerId, "attestation_changed");
    return true;
  }
  if (
    governed.adapter.binding.versionId !== snapshot.adapter_policy_version_id
    || stableJsonStringify(
      governed.adapter.policy.sources.find((source) => source.sourceKey === snapshot.source_key),
    ) !== stableJsonStringify(snapshot.source_policy)
  ) {
    await markSnapshotFailed(snapshot.id, input.workerId, "policy_changed");
    return true;
  }
  const activeAttestation = governed.attestationSet.attestations.find(
    (attestation) => attestation.payload.sourceKey === snapshot.source_key,
  );
  const readiness = governed.readiness.sources.find((source) => source.sourceKey === snapshot.source_key);
  if (
    governed.attestationBinding.versionId !== snapshot.attestation_version_id
    || readiness?.status !== "valid"
    || !activeAttestation
    || stableJsonStringify(activeAttestation) !== stableJsonStringify(snapshot.source_attestation)
  ) {
    await markSnapshotFailed(snapshot.id, input.workerId, "attestation_changed");
    return true;
  }
  let records: Record<string, unknown>[];
  let artifacts: PrivacyPackageArtifactInput[] = [];
  if (snapshot.source_key === "external.resend.delivery") {
    if (!input.resendApiKey || !resendPolicyMatchesCollector(snapshot.source_policy)) {
      await markSnapshotFailed(snapshot.id, input.workerId, "policy_changed");
      return true;
    }
    const references = await queryResendPrivacyDeliveryReferencesForIdentity(
      requirePostgres(),
      snapshot.requester_identity_id,
    );
    if (!references.length) {
      await markSnapshotFailed(snapshot.id, input.workerId, "reference_unavailable");
      return true;
    }
    try {
      records = await (input.collect ?? collectResendPrivacyRecords)({
        apiKey: input.resendApiKey,
        references,
        timeoutMs: snapshot.source_policy.execution.timeoutMs,
        maximumRecords: snapshot.source_policy.execution.maximumRecords,
        maximumBytes: snapshot.source_policy.execution.maximumBytes,
      });
    } catch (error) {
      await markSnapshotFailed(
        snapshot.id,
        input.workerId,
        error instanceof ResendPrivacyAdapterError ? "provider_failed" : "provider_failed",
      );
      return true;
    }
    if (!records.length) {
      await markSnapshotFailed(snapshot.id, input.workerId, "reference_unavailable");
      return true;
    }
  } else if (snapshot.source_key === "external.chain.public_records") {
    if (!chainPolicyMatchesCollector(snapshot.source_policy)) {
      await markSnapshotFailed(snapshot.id, input.workerId, "policy_changed");
      return true;
    }
    try {
      const references = await withPostgresTransaction(async (client) => {
        await client.query(
          "SELECT set_config('statement_timeout',$1,true)",
          [`${snapshot.source_policy.execution.timeoutMs}ms`],
        );
        return queryChainPrivacyRecordsForIdentity(
          client,
          snapshot.requester_identity_id,
        );
      });
      records = (input.collectChain ?? collectPublicChainPrivacyRecords)({
        records: references,
        maximumRecords: snapshot.source_policy.execution.maximumRecords,
        maximumBytes: snapshot.source_policy.execution.maximumBytes,
      });
    } catch (error) {
      await markSnapshotFailed(
        snapshot.id,
        input.workerId,
        error instanceof ChainPrivacyAdapterError ? "provider_failed" : "reference_unavailable",
      );
      return true;
    }
  } else if (snapshot.source_key === "external.identity_verification.provider") {
    const maximumArtifacts = governed.packagePolicy.maximumArtifacts ?? 0;
    if (
      !input.sumsubAppToken
      || !input.sumsubSecretKey
      || !snapshot.provider_export_id
      || !sumsubPolicyMatchesCollector(snapshot.source_policy)
      || governed.packagePolicy.canonicalFormat
        !== "application/vnd.fractal.privacy-package+tar;version=2"
      || maximumArtifacts < 1
    ) {
      await markSnapshotFailed(snapshot.id, input.workerId, "policy_changed");
      return true;
    }
    const providerExport = await withPostgresTransaction(async (client) => {
      const result = await client.query<SumsubProviderExportSnapshotRow>(
        `SELECT id,privacy_request_id,requester_identity_id,request_type,
                applicant_id,external_user_id,inspection_id,report_reference,
                entry_count,sensitive_tier,generated_at,downloaded_at,
                content_sha256,byte_count,settings_sha256,scanner,scanned_at,
                malware_scan_evidence_sha256,storage_key,
                package_policy_version_id,package_policy_value_sha256,status,
                retain_until
           FROM fractal.privacy_external_provider_exports
          WHERE id=$1
            AND privacy_request_id=$2
            AND requester_identity_id=$3
            AND request_type=$4
            AND source_key=$5
            AND status='staged'
            AND retain_until>$6
            AND package_policy_version_id=$7
            AND package_policy_value_sha256=$8
          FOR SHARE`,
        [
          snapshot.provider_export_id,
          snapshot.privacy_request_id,
          snapshot.requester_identity_id,
          snapshot.request_type,
          snapshot.source_key,
          now,
          snapshot.package_policy_version_id,
          snapshot.package_policy_value_sha256,
        ],
      );
      return result.rows[0] ?? null;
    });
    if (!providerExport) {
      await markSnapshotFailed(snapshot.id, input.workerId, "reference_unavailable");
      return true;
    }
    let providerExportContent: Buffer;
    try {
      const file = await (input.retrieve ?? retrieveFile)(providerExport.storage_key);
      if (file.redirectUrl) {
        throw new PrivacyExternalSnapshotError(
          "The staged Sumsub export cannot use a redirect.",
          "unavailable",
        );
      }
      if (
        file.buffer.byteLength !== providerExport.byte_count
        || sha256(file.buffer) !== providerExport.content_sha256
        || sumsubPrivacyScanEvidenceSha256({
          scanner: providerExport.scanner,
          scannedAt: providerExport.scanned_at,
          contentSha256: providerExport.content_sha256,
          byteCount: providerExport.byte_count,
        }) !== providerExport.malware_scan_evidence_sha256
      ) {
        throw new PrivacyExternalSnapshotError(
          "The staged Sumsub export evidence does not match its stored object.",
          "unavailable",
        );
      }
      providerExportContent = file.buffer;
    } catch {
      await markSnapshotFailed(snapshot.id, input.workerId, "reference_unavailable");
      return true;
    }
    try {
      const collection = await (input.collectSumsub ?? collectSumsubPrivacyRecords)({
        appToken: input.sumsubAppToken,
        secretKey: input.sumsubSecretKey,
        reference: {
          applicantId: providerExport.applicant_id,
          externalUserId: providerExport.external_user_id,
          inspectionId: providerExport.inspection_id,
        },
        providerExport: {
          reportReference: providerExport.report_reference,
          applicantId: providerExport.applicant_id,
          externalUserId: providerExport.external_user_id,
          entryCount: providerExport.entry_count,
          generatedAt: providerExport.generated_at.toISOString(),
          downloadedAt: providerExport.downloaded_at.toISOString(),
          sensitiveTier: providerExport.sensitive_tier,
          content: providerExportContent,
          sha256: providerExport.content_sha256,
          settingsSha256: providerExport.settings_sha256,
          malwareScanEvidenceSha256:
            providerExport.malware_scan_evidence_sha256,
        },
        timeoutMs: snapshot.source_policy.execution.timeoutMs,
        maximumRecords: snapshot.source_policy.execution.maximumRecords,
        maximumBytes: snapshot.source_policy.execution.maximumBytes,
        maximumArtifacts,
        now,
      });
      records = collection.records;
      artifacts = collection.artifacts;
    } catch (error) {
      const category = error instanceof SumsubPrivacyAdapterError
        && [
          "invalid_input",
          "correlation_mismatch",
          "provider_export_missing",
        ].includes(error.category)
        ? "reference_unavailable"
        : "provider_failed";
      await markSnapshotFailed(snapshot.id, input.workerId, category);
      return true;
    }
  } else {
    await markSnapshotFailed(snapshot.id, input.workerId, "policy_changed");
    return true;
  }
  let canonicalFormat:
    | typeof PRIVACY_EXTERNAL_SNAPSHOT_JSON_FORMAT_V1
    | typeof PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2;
  let artifactManifest: PrivacyPackageArtifactManifestItem[];
  let content: Buffer;
  if (snapshot.source_key === "external.identity_verification.provider") {
    const archive = buildPrivacyExternalSnapshotArchiveV2({
      sourceKey: snapshot.source_key,
      records,
      artifacts,
    });
    canonicalFormat = PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2;
    artifactManifest = archive.artifactManifest;
    content = archive.buffer;
  } else {
    canonicalFormat = PRIVACY_EXTERNAL_SNAPSHOT_JSON_FORMAT_V1;
    artifactManifest = [];
    content = Buffer.from(
      stableJsonStringify({ sourceKey: snapshot.source_key, records }),
      "utf8",
    );
  }
  let persisted: Awaited<ReturnType<typeof persistPrivacyExternalSnapshotBinary>>;
  try {
    persisted = await (input.store ?? persistPrivacyExternalSnapshotBinary)({
      snapshotId: snapshot.id,
      content,
    });
    if (persisted.sha256 !== sha256(content) || persisted.bytes !== content.byteLength) {
      throw new PrivacyExternalSnapshotError("Snapshot storage evidence does not match the canonical content.", "unavailable");
    }
  } catch {
    await markSnapshotFailed(snapshot.id, input.workerId, "storage_failed");
    return true;
  }

  const observedAt = Date.parse(snapshot.source_attestation.payload.observedAt);
  const attestationExpiresAt = Date.parse(snapshot.source_attestation.payload.expiresAt);
  const evidenceExpiresAt = observedAt + snapshot.source_policy.execution.evidenceMaximumAgeSeconds * 1_000;
  const expiresAt = new Date(Math.min(attestationExpiresAt, evidenceExpiresAt, snapshot.retain_until.getTime()));
  try {
    await withPostgresTransaction(async (client) => {
      const finalized = await client.query<{ privacy_request_id: string }>(
        `UPDATE fractal.privacy_external_collection_snapshots snapshot
            SET status='available',claimed_by=NULL,claimed_at=NULL,
                record_count=$3,byte_count=$4,content_sha256=$5,storage_key=$6,
                collected_at=$7,expires_at=$8,canonical_format=$9,
                artifact_count=$10,artifact_manifest=$11
          WHERE snapshot.id=$1 AND snapshot.status='collecting' AND snapshot.claimed_by=$2
            AND snapshot.adapter_policy_version_id=(
              SELECT active_version_id FROM fractal.platform_configuration_active_versions
               WHERE configuration_key=snapshot.adapter_policy_configuration_key
            )
            AND snapshot.attestation_version_id=(
              SELECT active_version_id FROM fractal.platform_configuration_active_versions
               WHERE configuration_key=snapshot.attestation_configuration_key
            )
          RETURNING privacy_request_id`,
        [
          snapshot.id,
          input.workerId,
          records.length,
          persisted.bytes,
          persisted.sha256,
          persisted.storageKey,
          now,
          expiresAt,
          canonicalFormat,
          artifactManifest.length,
          JSON.stringify(artifactManifest),
        ],
      );
      const row = finalized.rows[0];
      if (!row) {
        throw new PrivacyExternalSnapshotError("Snapshot bindings changed before finalization.", "conflict");
      }
      if (snapshot.provider_export_id) {
        await queueSumsubPrivacyExportCleanupAfterSnapshot(client, {
          providerExportId: snapshot.provider_export_id,
          snapshotId: snapshot.id,
          now,
        });
      }
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `privacy-request:${row.privacy_request_id}`,
        actorType: "worker",
        action: "privacy.request.external_snapshot_available",
        entityType: "privacy_external_collection_snapshot",
        entityId: snapshot.id,
        reason: "The worker stored exact subject-bound external records and verified their canonical hash.",
        payload: {
          sourceKey: snapshot.source_key,
          recordCount: records.length,
          byteCount: persisted.bytes,
          contentSha256: persisted.sha256,
          canonicalFormat,
          artifactCount: artifactManifest.length,
          expiresAt: expiresAt.toISOString(),
        },
      });
      await appendOutboxEvent(client, {
        aggregateType: "privacy_rights_request",
        aggregateId: row.privacy_request_id,
        eventType: "privacy.request.external_snapshot_available",
        payload: {
          snapshotId: snapshot.id,
          sourceKey: snapshot.source_key,
          contentSha256: persisted.sha256,
          auditEventId: audit.id,
        },
      });
    });
  } catch (error) {
    input.logger?.error(
      {
        err: error,
        snapshotId: snapshot.id,
        sourceKey: snapshot.source_key,
        workerId: input.workerId,
      },
      "External privacy snapshot finalization failed",
    );
    const cleanupTaskId = await enqueueStorageCleanupTask({
      storageKey: persisted.storageKey,
      source: "privacy_external_snapshot_finalization",
      metadataError: "Snapshot finalization failed after private object persistence.",
    });
    try {
      await deleteStoredFile(persisted.storageKey);
      await markStorageCleanupTaskCompletedInline(cleanupTaskId);
    } catch {
      // The durable cleanup task remains available for the cleanup worker.
    }
    await markSnapshotFailed(snapshot.id, input.workerId, "finalization_failed");
  }
  return true;
}

export async function expireAndQueuePrivacyExternalSnapshotCleanup(
  now = new Date(),
  limit = 100,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new PrivacyExternalSnapshotError("Expiry batch size must be between 1 and 1000.", "invalid_input");
  }
  return withPostgresTransaction(async (client) => {
    const expired = await client.query<{ id: string; privacy_request_id: string; source_key: string }>(
      `WITH candidates AS (
         SELECT id FROM fractal.privacy_external_collection_snapshots
          WHERE status='available' AND expires_at<=$1 AND retain_until>$1
          ORDER BY expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE fractal.privacy_external_collection_snapshots snapshot
          SET status='expired',expired_at=$1
         FROM candidates WHERE snapshot.id=candidates.id
       RETURNING snapshot.id,snapshot.privacy_request_id,snapshot.source_key`,
      [now, limit],
    );
    for (const snapshot of expired.rows) {
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `privacy-request:${snapshot.privacy_request_id}`,
        actorType: "worker",
        action: "privacy.request.external_snapshot_expired",
        entityType: "privacy_external_collection_snapshot",
        entityId: snapshot.id,
        reason: "The snapshot evidence window elapsed. The snapshot cannot support a new package.",
        payload: { sourceKey: snapshot.source_key, expiredAt: now.toISOString() },
      });
      await appendOutboxEvent(client, {
        aggregateType: "privacy_rights_request",
        aggregateId: snapshot.privacy_request_id,
        eventType: "privacy.request.external_snapshot_expired",
        payload: { snapshotId: snapshot.id, sourceKey: snapshot.source_key, auditEventId: audit.id },
      });
    }

    const due = await client.query<{
      id: string; storage_key: string; privacy_request_id: string; source_key: string;
    }>(
      `SELECT snapshot.id,snapshot.storage_key,snapshot.privacy_request_id,snapshot.source_key
         FROM fractal.privacy_external_collection_snapshots snapshot
        WHERE snapshot.status IN('available','expired')
          AND snapshot.retain_until<=$1
          AND NOT EXISTS(
            SELECT 1
              FROM fractal.privacy_rights_package_preparations preparation
              JOIN fractal.privacy_rights_package_deliveries delivery
                ON delivery.preparation_id=preparation.id
             WHERE delivery.status IN('queued','materializing')
               AND preparation.external_snapshot_manifest @>
                 jsonb_build_array(jsonb_build_object('snapshotId',snapshot.id::text))
          )
        ORDER BY snapshot.retain_until,snapshot.id
        FOR UPDATE SKIP LOCKED LIMIT $2`,
      [now, limit],
    );
    for (const snapshot of due.rows) {
      await client.query(
        `INSERT INTO fractal.storage_cleanup_tasks(
           id,storage_key,source,metadata_error,purpose,privacy_external_collection_snapshot_id
         ) VALUES($1,$2,'privacy_external_snapshot_retention_expiry',
           'Approved external snapshot retention elapsed.','privacy_external_snapshot',$3)`,
        [randomUUID(), snapshot.storage_key, snapshot.id],
      );
      await client.query(
        `UPDATE fractal.privacy_external_collection_snapshots
            SET status='cleanup_requested',expired_at=COALESCE(expired_at,$2)
          WHERE id=$1`,
        [snapshot.id, now],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `privacy-request:${snapshot.privacy_request_id}`,
        actorType: "worker",
        action: "privacy.request.external_snapshot_cleanup_requested",
        entityType: "privacy_external_collection_snapshot",
        entityId: snapshot.id,
        reason: "The approved snapshot retention period elapsed. Durable private-object deletion is queued.",
        payload: { sourceKey: snapshot.source_key, requestedAt: now.toISOString() },
      });
      await appendOutboxEvent(client, {
        aggregateType: "privacy_rights_request",
        aggregateId: snapshot.privacy_request_id,
        eventType: "privacy.request.external_snapshot_cleanup_requested",
        payload: { snapshotId: snapshot.id, sourceKey: snapshot.source_key, auditEventId: audit.id },
      });
    }
    return { expired: expired.rowCount ?? 0, cleanupQueued: due.rowCount ?? 0 };
  });
}

export async function loadPrivacyExternalSnapshotSections(
  manifest: readonly PrivacyExternalSnapshotManifestItem[],
  retrieve: typeof retrieveFile = retrieveFile,
): Promise<Map<string, CanonicalPrivacySourceSection>> {
  const sections = new Map<string, CanonicalPrivacySourceSection>();
  for (const item of manifest) {
    const stored = await withPostgresTransaction(async (client) => {
      const result = await client.query<{
        storage_key: string;
        canonical_format:
          | typeof PRIVACY_EXTERNAL_SNAPSHOT_JSON_FORMAT_V1
          | typeof PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2;
        artifact_count: number;
        artifact_manifest: PrivacyPackageArtifactManifestItem[];
      }>(
        `SELECT storage_key,canonical_format,artifact_count,artifact_manifest
           FROM fractal.privacy_external_collection_snapshots
          WHERE id=$1 AND reference=$2 AND source_key=$3 AND status='available'
            AND content_sha256=$4 AND record_count=$5 AND byte_count=$6
            AND collected_at=$7 AND expires_at=$8 AND expires_at>now()`,
        [
          item.snapshotId,
          item.snapshotReference,
          item.sourceKey,
          item.contentSha256,
          item.recordCount,
          item.byteCount,
          item.collectedAt,
          item.expiresAt,
        ],
      );
      if (!result.rows[0]) {
        throw new PrivacyExternalSnapshotError("An external snapshot is no longer current.", "conflict");
      }
      return result.rows[0];
    });
    const file = await retrieve(stored.storage_key);
    if (file.redirectUrl) {
      throw new PrivacyExternalSnapshotError("External snapshots cannot use a redirect.", "unavailable");
    }
    if (file.buffer.byteLength !== item.byteCount || sha256(file.buffer) !== item.contentSha256) {
      throw new PrivacyExternalSnapshotError("Stored external snapshot integrity verification failed.", "unavailable");
    }
    if (stored.canonical_format === PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2) {
      let parsed;
      try {
        parsed = parsePrivacyExternalSnapshotArchiveV2(file.buffer);
      } catch {
        throw new PrivacyExternalSnapshotError(
          "Stored external snapshot archive validation failed.",
          "unavailable",
        );
      }
      const parsedManifest = parsed.artifacts.map((artifact) => ({
        sourceKey: artifact.sourceKey,
        componentKey: artifact.componentKey,
        path: artifact.path,
        mediaType: artifact.mediaType,
        byteCount: artifact.byteCount,
        sha256: artifact.sha256,
      }));
      if (
        parsed.sourceKey !== item.sourceKey
        || parsed.records.length !== item.recordCount
        || parsed.artifacts.length !== stored.artifact_count
        || stableJsonStringify(parsedManifest)
          !== stableJsonStringify(stored.artifact_manifest)
      ) {
        throw new PrivacyExternalSnapshotError(
          "Stored external snapshot archive does not match its manifest.",
          "unavailable",
        );
      }
      sections.set(item.sourceKey, {
        sourceKey: item.sourceKey,
        records: parsed.records,
        artifacts: parsed.artifacts.map((artifact) => ({
          sourceKey: artifact.sourceKey,
          componentKey: artifact.componentKey,
          mediaType: artifact.mediaType,
          content: artifact.content,
        })),
        canonicalContent: parsed.canonicalContent,
        contentSha256: item.contentSha256,
        byteCount: item.byteCount,
      });
      continue;
    }
    if (
      stored.canonical_format !== PRIVACY_EXTERNAL_SNAPSHOT_JSON_FORMAT_V1
      || stored.artifact_count !== 0
      || stableJsonStringify(stored.artifact_manifest) !== "[]"
    ) {
      throw new PrivacyExternalSnapshotError(
        "Stored external snapshot format evidence is invalid.",
        "unavailable",
      );
    }
    let text: string;
    let value: unknown;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(file.buffer);
      value = JSON.parse(text);
    } catch {
      throw new PrivacyExternalSnapshotError("Stored external snapshot is not canonical JSON.", "unavailable");
    }
    if (
      !value
      || typeof value !== "object"
      || Array.isArray(value)
      || (value as { sourceKey?: unknown }).sourceKey !== item.sourceKey
      || !Array.isArray((value as { records?: unknown }).records)
    ) {
      throw new PrivacyExternalSnapshotError("Stored external snapshot has an invalid shape.", "unavailable");
    }
    const records = (value as { records: unknown[] }).records;
    if (
      records.length !== item.recordCount
      || records.some((record) => !record || typeof record !== "object" || Array.isArray(record))
      || stableJsonStringify(value) !== text
    ) {
      throw new PrivacyExternalSnapshotError("Stored external snapshot does not match its manifest.", "unavailable");
    }
    sections.set(item.sourceKey, {
      sourceKey: item.sourceKey,
      records: records as Record<string, unknown>[],
      canonicalContent: text,
      contentSha256: item.contentSha256,
      byteCount: item.byteCount,
    });
  }
  if (sections.size !== manifest.length) {
    throw new PrivacyExternalSnapshotError("External snapshot manifest contains duplicate sources.", "conflict");
  }
  return sections;
}
