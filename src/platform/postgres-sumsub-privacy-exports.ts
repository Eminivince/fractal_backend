import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { parsePrivacyPackagePolicy } from "../modules/privacy/domain/privacy-package-policy.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import {
  AdministratorCapabilityError,
  requireAdministratorCapability,
} from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";

const MANAGE_CAPABILITY = "privacy_request_manage";
const COLLECT_CAPABILITY = "privacy_external_collect";
const PACKAGE_POLICY_KEY = "privacy.rights.package_policy";
const SUMSUB_SOURCE_KEY = "external.identity_verification.provider";
const MAX_EXPORT_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

type ExportStatus = "staged" | "cleanup_requested" | "destroyed" | "cleanup_failed";

type ExportRow = {
  id: string;
  reference: string;
  privacy_request_id: string;
  requester_identity_id: string;
  request_type: "access" | "portability";
  source_key: typeof SUMSUB_SOURCE_KEY;
  identity_verification_application_id: string;
  applicant_id: string;
  external_user_id: string;
  inspection_id: string;
  report_reference: string;
  entry_count: number;
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
  package_policy_configuration_key: typeof PACKAGE_POLICY_KEY;
  package_policy_version_id: string;
  package_policy_version_number: number;
  package_policy_projection_version: number;
  package_policy_value_sha256: string;
  status: ExportStatus;
  command_key: string;
  uploaded_by_identity_id: string;
  uploaded_at: Date;
  retain_until: Date;
  destroyed_at: Date | null;
  failure_category: "cleanup_failed" | null;
};

export type AuthorizedSumsubPrivacyExportUpload = {
  exportId: string;
  actorIdentityId: string;
  privacyRequestId: string;
  requesterIdentityId: string;
  requestType: "access" | "portability";
  identityVerificationApplicationId: string;
  applicantId: string;
  externalUserId: string;
  inspectionId: string;
  reportReference: string;
  generatedAt: Date;
  downloadedAt: Date;
  settingsSha256: string;
  commandKey: string;
  packagePolicy: {
    versionId: string;
    versionNumber: number;
    projectionVersion: number;
    valueSha256: string;
    packageRetentionHours: number;
  };
  existing: ExportRow | null;
};

export class SumsubPrivacyExportError extends Error {
  constructor(
    message: string,
    readonly code:
      | "invalid_input"
      | "forbidden"
      | "not_found"
      | "conflict"
      | "policy_unavailable",
  ) {
    super(message);
    this.name = "SumsubPrivacyExportError";
  }
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new SumsubPrivacyExportError(
      `${label} must contain 1 to ${maximum} characters.`,
      "invalid_input",
    );
  }
  return normalized;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function exactSha256(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new SumsubPrivacyExportError(`${label} must be a SHA-256 value.`, "invalid_input");
  }
  return normalized;
}

function validDate(value: Date, label: string): Date {
  if (!Number.isFinite(value.getTime())) {
    throw new SumsubPrivacyExportError(`${label} is invalid.`, "invalid_input");
  }
  return value;
}

function reference(now: Date): string {
  return `PVE-${now.toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

export function mapSumsubPrivacyExport(row: ExportRow) {
  return {
    id: row.id,
    reference: row.reference,
    privacyRequestId: row.privacy_request_id,
    requestType: row.request_type,
    sourceKey: row.source_key,
    reportReference: row.report_reference,
    entryCount: row.entry_count,
    sensitiveTier: row.sensitive_tier,
    status: row.status,
    byteCount: row.byte_count,
    contentSha256: row.content_sha256,
    scan: {
      status: "clean" as const,
      scanner: row.scanner,
      scannedAt: row.scanned_at.toISOString(),
      evidenceSha256: row.malware_scan_evidence_sha256,
    },
    generatedAt: row.generated_at.toISOString(),
    downloadedAt: row.downloaded_at.toISOString(),
    uploadedAt: row.uploaded_at.toISOString(),
    retainUntil: row.retain_until.toISOString(),
    destroyedAt: row.destroyed_at?.toISOString() ?? null,
    failureCategory: row.failure_category,
  };
}

async function requireCapabilities(client: PoolClient, actorIdentityId: string): Promise<void> {
  try {
    await requireAdministratorCapability(client, actorIdentityId, MANAGE_CAPABILITY);
    await requireAdministratorCapability(client, actorIdentityId, COLLECT_CAPABILITY);
  } catch (error) {
    if (error instanceof AdministratorCapabilityError) {
      throw new SumsubPrivacyExportError(
        "Privacy management and external collection capabilities are required.",
        "forbidden",
      );
    }
    throw error;
  }
}

function sameReplay(
  row: ExportRow,
  input: {
    privacyRequestId: string;
    reportReference: string;
    generatedAt: Date;
    downloadedAt: Date;
    settingsSha256: string;
  },
): boolean {
  return row.privacy_request_id === input.privacyRequestId
    && row.report_reference === input.reportReference
    && row.generated_at.getTime() === input.generatedAt.getTime()
    && row.downloaded_at.getTime() === input.downloadedAt.getTime()
    && row.settings_sha256 === input.settingsSha256;
}

export function sumsubPrivacyScanEvidenceSha256(input: {
  scanner: "clamav_instream";
  scannedAt: Date;
  contentSha256: string;
  byteCount: number;
}): string {
  return sha256(stableJsonStringify({
    schemaVersion: "sumsub-privacy-export-malware-scan-v1",
    scanner: input.scanner,
    scannedAt: input.scannedAt.toISOString(),
    contentSha256: input.contentSha256,
    byteCount: input.byteCount,
    outcome: "clean",
  }));
}

export async function authorizeSumsubPrivacyExportUpload(input: {
  actorIdentityId: string;
  privacyRequestId: string;
  reportReference: string;
  generatedAt: Date;
  downloadedAt: Date;
  settingsSha256: string;
  commandKey: string;
  now?: Date;
}): Promise<AuthorizedSumsubPrivacyExportUpload> {
  const now = validDate(input.now ?? new Date(), "Current time");
  const reportReference = boundedText(input.reportReference, "Report reference", 500);
  const commandKey = boundedText(input.commandKey, "Command key", 200);
  const generatedAt = validDate(input.generatedAt, "Generated time");
  const downloadedAt = validDate(input.downloadedAt, "Downloaded time");
  const settingsSha256 = exactSha256(input.settingsSha256, "Settings SHA-256");
  if (
    generatedAt.getTime() > downloadedAt.getTime()
    || downloadedAt.getTime() > now.getTime() + MAX_CLOCK_SKEW_MS
    || downloadedAt.getTime() < now.getTime() - MAX_EXPORT_AGE_MS
  ) {
    throw new SumsubPrivacyExportError(
      "The Sumsub export times are outside the allowed 24-hour staging window.",
      "invalid_input",
    );
  }

  return withPostgresTransaction(async (client) => {
    await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('sumsub-privacy-export:' || $1 || ':' || $2,0))",
      [input.actorIdentityId, commandKey],
    );
    await requireCapabilities(client, input.actorIdentityId);
    const replay = await client.query<ExportRow>(
      `SELECT *
         FROM fractal.privacy_external_provider_exports
        WHERE uploaded_by_identity_id=$1 AND command_key=$2`,
      [input.actorIdentityId, commandKey],
    );
    if (replay.rows[0]) {
      if (!sameReplay(replay.rows[0], {
        privacyRequestId: input.privacyRequestId,
        reportReference,
        generatedAt,
        downloadedAt,
        settingsSha256,
      })) {
        throw new SumsubPrivacyExportError(
          "This command key was already used for another Sumsub export.",
          "conflict",
        );
      }
      const row = replay.rows[0];
      return {
        exportId: row.id,
        actorIdentityId: input.actorIdentityId,
        privacyRequestId: row.privacy_request_id,
        requesterIdentityId: row.requester_identity_id,
        requestType: row.request_type,
        identityVerificationApplicationId: row.identity_verification_application_id,
        applicantId: row.applicant_id,
        externalUserId: row.external_user_id,
        inspectionId: row.inspection_id,
        reportReference,
        generatedAt,
        downloadedAt,
        settingsSha256,
        commandKey,
        packagePolicy: {
          versionId: row.package_policy_version_id,
          versionNumber: row.package_policy_version_number,
          projectionVersion: row.package_policy_projection_version,
          valueSha256: row.package_policy_value_sha256,
          packageRetentionHours: Math.round(
            (row.retain_until.getTime() - row.uploaded_at.getTime()) / 3_600_000,
          ),
        },
        existing: row,
      };
    }

    const request = await client.query<{
      id: string;
      requester_identity_id: string;
      request_type: string;
      status: string;
      assigned_to_identity_id: string | null;
    }>(
      `SELECT id,requester_identity_id,request_type,status,assigned_to_identity_id
         FROM fractal.privacy_rights_requests
        WHERE id=$1
        FOR SHARE`,
      [input.privacyRequestId],
    );
    const requestRow = request.rows[0];
    if (!requestRow) {
      throw new SumsubPrivacyExportError("Privacy-rights request not found.", "not_found");
    }
    if (
      requestRow.status !== "in_review"
      || requestRow.assigned_to_identity_id !== input.actorIdentityId
      || !["access", "portability"].includes(requestRow.request_type)
    ) {
      throw new SumsubPrivacyExportError(
        "The assigned owner can stage an export only for an in-review access or portability request.",
        "conflict",
      );
    }

    const application = await client.query<{
      id: string;
      external_user_id: string;
      applicant_id: string | null;
      inspection_id: string | null;
    }>(
      `SELECT id,external_user_id,applicant_id,inspection_id
         FROM fractal.provider_identity_verification_applications
        WHERE identity_id=$1
          AND provider='sumsub'
          AND status='ready'
        FOR SHARE`,
      [requestRow.requester_identity_id],
    );
    const applicationRow = application.rows[0];
    if (!applicationRow?.applicant_id || !applicationRow.inspection_id) {
      throw new SumsubPrivacyExportError(
        "The requester does not have an exact ready Sumsub applicant and inspection binding.",
        "conflict",
      );
    }

    const binding = await readActivePlatformConfigurationForBinding(client, PACKAGE_POLICY_KEY);
    if (!binding) {
      throw new SumsubPrivacyExportError(
        "No approved privacy package policy is active.",
        "policy_unavailable",
      );
    }
    let packagePolicy;
    try {
      packagePolicy = parsePrivacyPackagePolicy(binding.value);
    } catch {
      throw new SumsubPrivacyExportError(
        "The active privacy package policy is invalid.",
        "policy_unavailable",
      );
    }
    if (
      packagePolicy.schemaVersion !== "privacy-package-policy-v2"
      || packagePolicy.canonicalFormat
        !== "application/vnd.fractal.privacy-package+tar;version=2"
      || !packagePolicy.maximumArtifacts
    ) {
      throw new SumsubPrivacyExportError(
        "The active privacy package policy does not permit governed binary artifacts.",
        "policy_unavailable",
      );
    }
    return {
      exportId: randomUUID(),
      actorIdentityId: input.actorIdentityId,
      privacyRequestId: requestRow.id,
      requesterIdentityId: requestRow.requester_identity_id,
      requestType: requestRow.request_type as "access" | "portability",
      identityVerificationApplicationId: applicationRow.id,
      applicantId: applicationRow.applicant_id,
      externalUserId: applicationRow.external_user_id,
      inspectionId: applicationRow.inspection_id,
      reportReference,
      generatedAt,
      downloadedAt,
      settingsSha256,
      commandKey,
      packagePolicy: {
        versionId: binding.versionId,
        versionNumber: binding.versionNumber,
        projectionVersion: binding.projectionVersion,
        valueSha256: binding.valueSha256,
        packageRetentionHours: packagePolicy.packageRetentionHours,
      },
      existing: null,
    };
  });
}

export async function recordSumsubPrivacyExportUpload(input: {
  authorization: AuthorizedSumsubPrivacyExportUpload;
  storageKey: string;
  contentSha256: string;
  byteCount: number;
  scanner: "clamav_instream";
  scannedAt: Date;
  malwareScanEvidenceSha256: string;
  uploadedAt?: Date;
}) {
  if (input.authorization.existing) {
    throw new SumsubPrivacyExportError("The Sumsub export command is already complete.", "conflict");
  }
  const storageKey = boundedText(input.storageKey, "Storage key", 2_000);
  const contentSha256 = exactSha256(input.contentSha256, "Content SHA-256");
  const malwareScanEvidenceSha256 = exactSha256(
    input.malwareScanEvidenceSha256,
    "Malware-scan evidence SHA-256",
  );
  if (input.byteCount < 1 || input.byteCount > 100 * 1024 * 1024) {
    throw new SumsubPrivacyExportError(
      "Sumsub export size is outside the governed limit.",
      "invalid_input",
    );
  }
  const scannedAt = validDate(input.scannedAt, "Scan time");
  const uploadedAt = validDate(input.uploadedAt ?? new Date(), "Upload time");
  if (
    scannedAt.getTime() < input.authorization.downloadedAt.getTime()
    || scannedAt.getTime() > uploadedAt.getTime()
  ) {
    throw new SumsubPrivacyExportError(
      "Sumsub export scan time is invalid.",
      "invalid_input",
    );
  }
  const expectedScanEvidence = sumsubPrivacyScanEvidenceSha256({
    scanner: input.scanner,
    scannedAt,
    contentSha256,
    byteCount: input.byteCount,
  });
  if (malwareScanEvidenceSha256 !== expectedScanEvidence) {
    throw new SumsubPrivacyExportError(
      "Sumsub export scan evidence does not match the stored object.",
      "invalid_input",
    );
  }
  const retainUntil = new Date(
    uploadedAt.getTime()
      + input.authorization.packagePolicy.packageRetentionHours * 3_600_000,
  );

  return withPostgresTransaction(async (client) => {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('sumsub-privacy-export:' || $1 || ':' || $2,0))",
      [input.authorization.actorIdentityId, input.authorization.commandKey],
    );
    await requireCapabilities(client, input.authorization.actorIdentityId);
    const existing = await client.query<ExportRow>(
      `SELECT *
         FROM fractal.privacy_external_provider_exports
        WHERE uploaded_by_identity_id=$1 AND command_key=$2`,
      [input.authorization.actorIdentityId, input.authorization.commandKey],
    );
    if (existing.rows[0]) {
      if (
        !sameReplay(existing.rows[0], input.authorization)
        || existing.rows[0].content_sha256 !== contentSha256
        || existing.rows[0].byte_count !== input.byteCount
      ) {
        throw new SumsubPrivacyExportError(
          "This command key was completed with different Sumsub export evidence.",
          "conflict",
        );
      }
      throw new SumsubPrivacyExportError(
        "A concurrent request completed this Sumsub export command. Retry the command.",
        "conflict",
      );
    }

    const inserted = await client.query<ExportRow>(
      `INSERT INTO fractal.privacy_external_provider_exports(
         id,reference,privacy_request_id,requester_identity_id,request_type,source_key,
         identity_verification_application_id,applicant_id,external_user_id,inspection_id,
         report_reference,entry_count,sensitive_tier,generated_at,downloaded_at,
         content_sha256,byte_count,settings_sha256,scanner,scanned_at,
         malware_scan_evidence_sha256,storage_key,
         package_policy_configuration_key,package_policy_version_id,
         package_policy_version_number,package_policy_projection_version,
         package_policy_value_sha256,status,command_key,uploaded_by_identity_id,
         uploaded_at,retain_until
       ) VALUES(
         $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,'higher_sensitive_data',$12,$13,
         $14,$15,$16,$17,$18,$19,$20,'privacy.rights.package_policy',$21,$22,$23,
         $24,'staged',$25,$26,$27,$28
       )
       RETURNING *`,
      [
        input.authorization.exportId,
        reference(uploadedAt),
        input.authorization.privacyRequestId,
        input.authorization.requesterIdentityId,
        input.authorization.requestType,
        SUMSUB_SOURCE_KEY,
        input.authorization.identityVerificationApplicationId,
        input.authorization.applicantId,
        input.authorization.externalUserId,
        input.authorization.inspectionId,
        input.authorization.reportReference,
        input.authorization.generatedAt,
        input.authorization.downloadedAt,
        contentSha256,
        input.byteCount,
        input.authorization.settingsSha256,
        input.scanner,
        scannedAt,
        malwareScanEvidenceSha256,
        storageKey,
        input.authorization.packagePolicy.versionId,
        input.authorization.packagePolicy.versionNumber,
        input.authorization.packagePolicy.projectionVersion,
        input.authorization.packagePolicy.valueSha256,
        input.authorization.commandKey,
        input.authorization.actorIdentityId,
        uploadedAt,
        retainUntil,
      ],
    );
    const row = inserted.rows[0]!;
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `privacy-request:${row.privacy_request_id}`,
      actorId: input.authorization.actorIdentityId,
      actorType: "user",
      action: "privacy.request.sumsub_provider_export_staged",
      entityType: "privacy_external_provider_export",
      entityId: row.id,
      reason: "The assigned owner staged one exact higher-sensitive Sumsub export after malware scanning.",
      payload: {
        reference: row.reference,
        reportReference: row.report_reference,
        contentSha256: row.content_sha256,
        settingsSha256: row.settings_sha256,
        malwareScanEvidenceSha256: row.malware_scan_evidence_sha256,
        retainUntil: row.retain_until.toISOString(),
      },
    });
    await appendOutboxEvent(client, {
      aggregateType: "privacy_rights_request",
      aggregateId: row.privacy_request_id,
      eventType: "privacy.request.sumsub_provider_export_staged",
      payload: { providerExportId: row.id, reference: row.reference, auditEventId: audit.id },
      privacy: {
        kind: "subjects",
        subjectIdentityIds: [row.requester_identity_id],
      },
    });
    return { providerExport: mapSumsubPrivacyExport(row), replayed: false };
  });
}

export async function listAdministratorSumsubPrivacyExports(input: {
  actorIdentityId: string;
  privacyRequestId: string;
}) {
  return withPostgresTransaction(async (client) => {
    await requireCapabilities(client, input.actorIdentityId);
    const request = await client.query(
      "SELECT 1 FROM fractal.privacy_rights_requests WHERE id=$1",
      [input.privacyRequestId],
    );
    if (!request.rowCount) {
      throw new SumsubPrivacyExportError("Privacy-rights request not found.", "not_found");
    }
    const exports = await client.query<ExportRow>(
      `SELECT *
         FROM fractal.privacy_external_provider_exports
        WHERE privacy_request_id=$1
        ORDER BY uploaded_at,id`,
      [input.privacyRequestId],
    );
    return exports.rows.map(mapSumsubPrivacyExport);
  });
}

export async function expireAndQueueSumsubPrivacyExportCleanup(
  limit: number,
  now = new Date(),
): Promise<number> {
  if (limit < 1) return 0;
  return withPostgresTransaction(async (client) => {
    const expired = await client.query<ExportRow>(
      `SELECT *
         FROM fractal.privacy_external_provider_exports
        WHERE status='staged' AND retain_until<=$1
        ORDER BY retain_until,id
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [now, limit],
    );
    for (const row of expired.rows) {
      const taskId = randomUUID();
      await client.query(
        `INSERT INTO fractal.storage_cleanup_tasks(
           id,storage_key,source,metadata_error,purpose,
           privacy_external_provider_export_id
         ) VALUES(
           $1,$2,'sumsub_privacy_export_retention',
           'Approved Sumsub provider-export retention elapsed.',
           'privacy_external_provider_export',$3
         )`,
        [taskId, row.storage_key, row.id],
      );
      await client.query(
        `UPDATE fractal.privacy_external_provider_exports
            SET status='cleanup_requested'
          WHERE id=$1 AND status='staged'`,
        [row.id],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `privacy-request:${row.privacy_request_id}`,
        actorType: "worker",
        action: "privacy.request.sumsub_provider_export_cleanup_requested",
        entityType: "privacy_external_provider_export",
        entityId: row.id,
        reason: "The approved Sumsub provider-export retention period elapsed.",
        payload: { reference: row.reference, cleanupTaskId: taskId },
      });
      await appendOutboxEvent(client, {
        aggregateType: "privacy_rights_request",
        aggregateId: row.privacy_request_id,
        eventType: "privacy.request.sumsub_provider_export_cleanup_requested",
        payload: { providerExportId: row.id, cleanupTaskId: taskId, auditEventId: audit.id },
        privacy: {
          kind: "subjects",
          subjectIdentityIds: [row.requester_identity_id],
        },
      });
    }
    return expired.rows.length;
  });
}

export async function queueSumsubPrivacyExportCleanupAfterSnapshot(
  client: PoolClient,
  input: {
    providerExportId: string;
    snapshotId: string;
    now: Date;
  },
): Promise<void> {
  const exportResult = await client.query<ExportRow>(
    `SELECT *
       FROM fractal.privacy_external_provider_exports
      WHERE id=$1
      FOR UPDATE`,
    [input.providerExportId],
  );
  const row = exportResult.rows[0];
  if (!row || !["staged", "cleanup_requested"].includes(row.status)) {
    throw new SumsubPrivacyExportError(
      "The staged Sumsub provider export is no longer available for snapshot cleanup.",
      "conflict",
    );
  }
  if (row.status === "cleanup_requested") {
    const task = await client.query(
      `SELECT 1
         FROM fractal.storage_cleanup_tasks
        WHERE privacy_external_provider_export_id=$1
          AND storage_key=$2`,
      [row.id, row.storage_key],
    );
    if (!task.rowCount) {
      throw new SumsubPrivacyExportError(
        "The Sumsub provider export cleanup state has no durable task.",
        "conflict",
      );
    }
    return;
  }

  await client.query(
    `INSERT INTO fractal.storage_cleanup_tasks(
       id,storage_key,source,metadata_error,purpose,
       privacy_external_provider_export_id
     ) VALUES(
       $1,$2,'sumsub_privacy_snapshot_created',
       'The provider export is represented in an integrity-bound external snapshot.',
       'privacy_external_provider_export',$3
     )`,
    [randomUUID(), row.storage_key, row.id],
  );
  await client.query(
    `UPDATE fractal.privacy_external_provider_exports
        SET status='cleanup_requested'
      WHERE id=$1 AND status='staged'`,
    [row.id],
  );
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `privacy-request:${row.privacy_request_id}`,
    actorType: "worker",
    action: "privacy.request.sumsub_provider_export_cleanup_requested",
    entityType: "privacy_external_provider_export",
    entityId: row.id,
    reason: "The exact provider export is bound into the external snapshot. Durable staged-object deletion is queued.",
    payload: {
      snapshotId: input.snapshotId,
      requestedAt: input.now.toISOString(),
    },
  });
  await appendOutboxEvent(client, {
    aggregateType: "privacy_rights_request",
    aggregateId: row.privacy_request_id,
    eventType: "privacy.request.sumsub_provider_export_cleanup_requested",
    payload: {
      providerExportId: row.id,
      snapshotId: input.snapshotId,
      auditEventId: audit.id,
    },
    privacy: {
      kind: "subjects",
      subjectIdentityIds: [row.requester_identity_id],
    },
  });
}
