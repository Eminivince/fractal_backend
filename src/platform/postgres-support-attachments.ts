import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  parseSupportCaseDataPolicy,
  type SupportAttachmentClassification,
} from "../modules/support/domain/support-data-policy.js";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import { isSupportAttachmentUnavailable } from "./postgres-support-evidence-lifecycle.js";

export class SupportAttachmentError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "forbidden"
      | "invalid_input"
      | "policy_unavailable"
      | "conflict",
  ) {
    super(message);
    this.name = "SupportAttachmentError";
  }
}

export class SupportAttachmentReplayError extends Error {
  constructor(readonly attachment: ReturnType<typeof mapAttachment>) {
    super("Support attachment command replayed.");
    this.name = "SupportAttachmentReplayError";
  }
}

type AttachmentRow = {
  id: string;
  case_id: string;
  uploaded_by_identity_id: string;
  command_key: string;
  uploader_legal_name: string;
  visibility: "requester" | "internal";
  classification: SupportAttachmentClassification;
  filename: string;
  mime_type: string;
  bytes: number;
  content_sha256: string;
  storage_key: string;
  scanner: "clamav_instream";
  scanned_at: Date;
  policy_version_id: string;
  policy_version_number: number;
  policy_projection_version: number;
  policy_value_sha256: string;
  policy_reference: string;
  policy_name: string;
  retention_days: number;
  uploaded_at: Date;
  retention_due_at: Date;
};

const attachmentSelect = `
  SELECT attachment.*, uploader.legal_name AS uploader_legal_name
    FROM fractal.support_case_attachments attachment
    JOIN fractal.identities uploader ON uploader.id=attachment.uploaded_by_identity_id`;

function mapAttachment(row: AttachmentRow) {
  return {
    id: row.id,
    caseId: row.case_id,
    uploadedBy: {
      id: row.uploaded_by_identity_id,
      legalName: row.uploader_legal_name,
    },
    visibility: row.visibility,
    classification: row.classification,
    filename: row.filename,
    mimeType: row.mime_type,
    bytes: row.bytes,
    contentSha256: row.content_sha256,
    scan: {
      status: "clean" as const,
      scanner: row.scanner,
      scannedAt: row.scanned_at.toISOString(),
    },
    policy: {
      versionId: row.policy_version_id,
      versionNumber: row.policy_version_number,
      projectionVersion: row.policy_projection_version,
      valueSha256: row.policy_value_sha256,
      reference: row.policy_reference,
      name: row.policy_name,
    },
    retentionDays: row.retention_days,
    uploadedAt: row.uploaded_at.toISOString(),
    retentionDueAt: row.retention_due_at.toISOString(),
  };
}

async function caseRequester(
  client: PoolClient,
  caseId: string,
): Promise<string> {
  const result = await client.query<{ requester_identity_id: string }>(
    "SELECT requester_identity_id FROM fractal.support_cases WHERE id=$1",
    [caseId],
  );
  if (!result.rows[0])
    throw new SupportAttachmentError("Support case not found.", "not_found");
  return result.rows[0].requester_identity_id;
}

async function authorizeCase(
  client: PoolClient,
  input: { caseId: string; actorIdentityId: string; staff: boolean },
) {
  const requesterId = await caseRequester(client, input.caseId);
  if (input.staff)
    await requireAdministratorCapability(
      client,
      input.actorIdentityId,
      "support_case_manage",
    );
  else if (requesterId !== input.actorIdentityId)
    throw new SupportAttachmentError("Support case not found.", "not_found");
  return requesterId;
}

function filename(value: string): string {
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > 240 ||
    /[\0-\x1f\x7f]/.test(normalized)
  ) {
    throw new SupportAttachmentError(
      "Filename must contain 1 to 240 safe characters.",
      "invalid_input",
    );
  }
  return normalized;
}

async function requireAttachmentPolicy(
  client: PoolClient,
  input: { mimeType: string; bytes?: number },
) {
  const binding = await readActivePlatformConfigurationForBinding(
    client,
    "support.case.data_policy",
  );
  if (!binding)
    throw new SupportAttachmentError(
      "Support attachments are unavailable until an approved data policy is active.",
      "policy_unavailable",
    );
  const policy = parseSupportCaseDataPolicy(binding.value);
  const normalizedMime = input.mimeType.trim().toLowerCase();
  if (!policy.allowedMimeTypes.includes(normalizedMime as never))
    throw new SupportAttachmentError(
      "This file type is not allowed by the active support data policy.",
      "invalid_input",
    );
  if (
    input.bytes !== undefined &&
    (input.bytes < 1 || input.bytes > policy.maximumBytes)
  )
    throw new SupportAttachmentError(
      "This file exceeds the active support data-policy size limit.",
      "invalid_input",
    );
  return { binding, policy, normalizedMime };
}

/** Reject unauthorized or policy-ineligible uploads before malware scanning or storage work. */
export async function authorizeSupportCaseAttachmentUpload(input: {
  caseId: string;
  actorIdentityId: string;
  staff: boolean;
  visibility: "requester" | "internal";
  mimeType: string;
}) {
  return withPostgresTransaction(async (client) => {
    await authorizeCase(client, input);
    if (!input.staff && input.visibility !== "requester")
      throw new SupportAttachmentError(
        "Requester attachments must remain requester-visible.",
        "forbidden",
      );
    await requireAttachmentPolicy(client, input);
  });
}

export async function recordSupportCaseAttachment(input: {
  caseId: string;
  actorIdentityId: string;
  staff: boolean;
  visibility: "requester" | "internal";
  commandKey: string;
  classification: SupportAttachmentClassification;
  filename: string;
  mimeType: string;
  bytes: number;
  contentSha256: string;
  storageKey: string;
  scanner: "clamav_instream";
  scannedAt: Date;
}) {
  return withPostgresTransaction(async (client) => {
    await authorizeCase(client, input);
    if (!input.staff && input.visibility !== "requester")
      throw new SupportAttachmentError(
        "Requester attachments must remain requester-visible.",
        "forbidden",
      );
    const { binding, policy, normalizedMime } = await requireAttachmentPolicy(
      client,
      input,
    );
    if (!/^[0-9a-f]{64}$/.test(input.contentSha256))
      throw new SupportAttachmentError(
        "Attachment integrity digest is invalid.",
        "invalid_input",
      );
    const retentionDays =
      policy.classifications[input.classification].retentionDays;
    const uploadedAt = new Date(
      Math.max(Date.now(), input.scannedAt.getTime()),
    );
    const retentionDueAt = new Date(
      uploadedAt.getTime() + retentionDays * 86_400_000,
    );
    const id = randomUUID();
    const normalizedFilename = filename(input.filename);
    const commandKey = input.commandKey.trim();
    if (!commandKey || commandKey.length > 200)
      throw new SupportAttachmentError(
        "A valid attachment command key is required.",
        "invalid_input",
      );
    const replay = await client.query<AttachmentRow>(
      `${attachmentSelect} WHERE attachment.case_id=$1 AND attachment.uploaded_by_identity_id=$2 AND attachment.command_key=$3`,
      [input.caseId, input.actorIdentityId, commandKey],
    );
    if (replay.rows[0]) {
      const prior = replay.rows[0];
      if (
        prior.visibility !== input.visibility ||
        prior.classification !== input.classification ||
        prior.filename !== normalizedFilename ||
        prior.mime_type !== normalizedMime ||
        prior.bytes !== input.bytes ||
        prior.content_sha256 !== input.contentSha256
      ) {
        throw new SupportAttachmentError(
          "This attachment command key was already used with different content or metadata.",
          "conflict",
        );
      }
      throw new SupportAttachmentReplayError(mapAttachment(prior));
    }
    await client.query(
      `INSERT INTO fractal.support_case_attachments
        (id,case_id,uploaded_by_identity_id,command_key,visibility,classification,filename,mime_type,bytes,content_sha256,storage_key,
         scan_status,scanner,scanned_at,policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,
         policy_reference,policy_name,retention_days,uploaded_at,retention_due_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'clean',$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)`,
      [
        id,
        input.caseId,
        input.actorIdentityId,
        commandKey,
        input.visibility,
        input.classification,
        normalizedFilename,
        normalizedMime,
        input.bytes,
        input.contentSha256,
        input.storageKey,
        input.scanner,
        input.scannedAt,
        binding.versionId,
        binding.versionNumber,
        binding.projectionVersion,
        binding.valueSha256,
        policy.policyReference,
        policy.policyName,
        retentionDays,
        uploadedAt,
        retentionDueAt,
      ],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `support-case:${input.caseId}`,
      actorId: input.actorIdentityId,
      actorType: "user",
      action: "support.case.attachment_recorded",
      entityType: "support_case_attachment",
      entityId: id,
      reason: "Malware-screened support attachment metadata recorded.",
      payload: {
        caseId: input.caseId,
        visibility: input.visibility,
        classification: input.classification,
        bytes: input.bytes,
        contentSha256: input.contentSha256,
        policyVersionId: binding.versionId,
      },
    });
    await appendOutboxEvent(client, {
      aggregateType: "support_case",
      aggregateId: input.caseId,
      eventType: "support.case.attachment_recorded",
      payload: {
        attachmentId: id,
        visibility: input.visibility,
        auditEventId: audit.id,
      },
    });
    const row = await client.query<AttachmentRow>(
      `${attachmentSelect} WHERE attachment.id=$1`,
      [id],
    );
    return { attachment: mapAttachment(row.rows[0]!) };
  });
}

export async function readSupportCaseAttachments(
  client: PoolClient,
  input: { caseId: string; actorIdentityId: string; staff: boolean },
) {
  await authorizeCase(client, input);
  const result = await client.query<AttachmentRow>(
    `${attachmentSelect} WHERE attachment.case_id=$1 AND ($2::boolean OR attachment.visibility='requester') ORDER BY attachment.uploaded_at,attachment.id`,
    [input.caseId, input.staff],
  );
  return result.rows.map(mapAttachment);
}

export async function getSupportCaseAttachmentForDownload(input: {
  attachmentId: string;
  actorIdentityId: string;
  staff: boolean;
}) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<AttachmentRow>(
      `${attachmentSelect} WHERE attachment.id=$1`,
      [input.attachmentId],
    );
    const attachment = result.rows[0];
    if (!attachment)
      throw new SupportAttachmentError(
        "Support attachment not found.",
        "not_found",
      );
    await authorizeCase(client, {
      caseId: attachment.case_id,
      actorIdentityId: input.actorIdentityId,
      staff: input.staff,
    });
    if (!input.staff && attachment.visibility !== "requester")
      throw new SupportAttachmentError(
        "Support attachment not found.",
        "not_found",
      );
    if (await isSupportAttachmentUnavailable(client, attachment.id))
      throw new SupportAttachmentError(
        "Support attachment is unavailable because governed disposition has begun.",
        "conflict",
      );
    return { ...mapAttachment(attachment), storageKey: attachment.storage_key };
  });
}

export async function recordSupportCaseAttachmentDownload(input: {
  attachmentId: string;
  actorIdentityId: string;
  staff: boolean;
  verifiedSha256: string;
}) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<AttachmentRow>(
      `${attachmentSelect} WHERE attachment.id=$1`,
      [input.attachmentId],
    );
    const attachment = result.rows[0];
    if (!attachment)
      throw new SupportAttachmentError(
        "Support attachment not found.",
        "not_found",
      );
    await authorizeCase(client, {
      caseId: attachment.case_id,
      actorIdentityId: input.actorIdentityId,
      staff: input.staff,
    });
    if (!input.staff && attachment.visibility !== "requester")
      throw new SupportAttachmentError(
        "Support attachment not found.",
        "not_found",
      );
    if (await isSupportAttachmentUnavailable(client, attachment.id))
      throw new SupportAttachmentError(
        "Support attachment is unavailable because governed disposition has begun.",
        "conflict",
      );
    if (attachment.content_sha256 !== input.verifiedSha256)
      throw new SupportAttachmentError(
        "Support attachment failed integrity validation.",
        "invalid_input",
      );
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO fractal.support_case_attachment_access_events
      (id,attachment_id,actor_identity_id,access_type,content_sha256,integrity_verified)
      VALUES ($1,$2,$3,'downloaded',$4,true)`,
      [
        eventId,
        input.attachmentId,
        input.actorIdentityId,
        input.verifiedSha256,
      ],
    );
    await appendPostgresAuditEvent(client, {
      scopeKey: `support-case:${attachment.case_id}`,
      actorId: input.actorIdentityId,
      actorType: "user",
      action: "support.case.attachment_downloaded",
      entityType: "support_case_attachment",
      entityId: input.attachmentId,
      reason:
        "Authorized support attachment download completed after byte-integrity verification.",
      payload: {
        accessEventId: eventId,
        contentSha256: input.verifiedSha256,
        staff: input.staff,
      },
    });
  });
}
