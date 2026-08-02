import { createHash, randomUUID } from "node:crypto";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class ProviderIdentityVerificationEvidenceConflictError extends Error {}

export interface SumsubIdentityVerificationEvidenceInput {
  externalEventId: string;
  externalUserId: string;
  applicantId: string;
  eventType: string;
  reviewStatus?: string;
  reviewAnswer?: "GREEN" | "RED";
  rejectLabels?: readonly string[];
  createdAtMs?: string;
  rawPayload: string;
  receivedAt?: Date;
}

export interface RecordedIdentityVerificationEvidence {
  id: string;
  identityId: string | null;
  duplicate: boolean;
}

export interface ReviewerIdentityVerificationEvidence {
  id: string;
  provider: string;
  externalEventId: string;
  applicantId: string;
  eventType: string;
  reviewStatus: string | null;
  reviewAnswer: "GREEN" | "RED" | null;
  rejectLabels: string[];
  providerCreatedAt: string | null;
  payloadHash: string;
  receivedAt: string;
  recordedAt: string;
}

function payloadHash(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

function providerCreatedAt(createdAtMs: string | undefined): Date | null {
  if (!createdAtMs || !/^\d{1,16}$/.test(createdAtMs)) return null;
  const milliseconds = Number(createdAtMs);
  const date = new Date(milliseconds);
  return Number.isFinite(milliseconds) && !Number.isNaN(date.getTime()) ? date : null;
}

/**
 * Records a verified provider callback as immutable evidence. A provider's
 * GREEN/RED answer deliberately does not approve, reject, or otherwise mutate
 * the governed investor-compliance profile: that remains a separate
 * authenticated maker/checker decision with its own evidence and audit trail.
 */
export async function recordSumsubIdentityVerificationEvidence(
  input: SumsubIdentityVerificationEvidenceInput,
): Promise<RecordedIdentityVerificationEvidence> {
  const externalEventId = input.externalEventId.trim();
  const externalUserId = input.externalUserId.trim();
  const applicantId = input.applicantId.trim();
  const eventType = input.eventType.trim();
  if (!externalEventId || !externalUserId || !applicantId || !eventType) {
    throw new Error("Sumsub identity-verification evidence is missing its correlation fields");
  }

  const hash = payloadHash(input.rawPayload);
  const receivedAt = input.receivedAt ?? new Date();
  const createdAt = providerCreatedAt(input.createdAtMs);
  const rejectLabels = [...new Set((input.rejectLabels ?? []).map((label) => label.trim()).filter(Boolean))];

  return withPostgresTransaction(async (client) => {
    const existing = await client.query<{ id: string; payload_hash: string; identity_id: string | null }>(
      `SELECT id, payload_hash, identity_id
         FROM fractal.provider_identity_verification_events
        WHERE provider = 'sumsub' AND external_event_id = $1
        FOR UPDATE`,
      [externalEventId],
    );
    const existingEvent = existing.rows[0];
    if (existingEvent) {
      if (existingEvent.payload_hash !== hash) {
        throw new ProviderIdentityVerificationEvidenceConflictError(
          "A Sumsub identity-verification event was replayed with a different payload",
        );
      }
      return { id: existingEvent.id, identityId: existingEvent.identity_id, duplicate: true };
    }

    const identity = await client.query<{ id: string }>(
      `SELECT id
         FROM fractal.identities
        WHERE status = 'active' AND (legacy_mongo_id = $1 OR id::text = $1)
        FOR SHARE`,
      [externalUserId],
    );
    const identityId = identity.rows[0]?.id ?? null;
    const id = randomUUID();
    await client.query(
      `INSERT INTO fractal.provider_identity_verification_events
         (id, provider, external_event_id, identity_id, external_user_id, applicant_id, event_type,
          review_status, review_answer, reject_labels, provider_created_at, payload_hash, received_at)
       VALUES ($1, 'sumsub', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        externalEventId,
        identityId,
        externalUserId,
        applicantId,
        eventType,
        input.reviewStatus?.trim() || null,
        input.reviewAnswer ?? null,
        JSON.stringify(rejectLabels),
        createdAt,
        hash,
        receivedAt,
      ],
    );

    const eventPayload = {
      provider: "sumsub",
      externalEventId,
      applicantId,
      eventType,
      reviewStatus: input.reviewStatus?.trim() || null,
      reviewAnswer: input.reviewAnswer ?? null,
      rejectLabelCount: rejectLabels.length,
      payloadHash: hash,
      matchedIdentity: Boolean(identityId),
    };
    const scopeKey = identityId ? `identity:${identityId}` : "provider:sumsub";
    await appendPostgresAuditEvent(client, {
      scopeKey,
      actorType: "provider",
      action: identityId ? "identity.verification_evidence.recorded" : "identity.verification_evidence.unmatched",
      entityType: "provider_identity_verification_event",
      entityId: id,
      payload: eventPayload,
      occurredAt: receivedAt,
    });
    await appendOutboxEvent(client, {
      aggregateType: "identity_verification_evidence",
      aggregateId: id,
      eventType: identityId ? "IdentityVerificationEvidenceRecorded" : "IdentityVerificationEvidenceUnmatched",
      payload: { ...eventPayload, identityId },
      privacy: identityId
        ? { kind: "subjects", subjectIdentityIds: [identityId] }
        : { kind: "technical_no_subject" },
      occurredAt: receivedAt,
    });

    return { id, identityId, duplicate: false };
  });
}

/**
 * Returns only canonical, correlation-safe evidence for the governed reviewer
 * path. The durable inbox retains the signed raw body; it must never be
 * exposed through a general governance API.
 */
export async function listIdentityVerificationEvidenceForReviewer(input: {
  identityId: string;
  accessedByIdentityId: string;
  limit?: number;
}): Promise<ReviewerIdentityVerificationEvidence[]> {
  const limit = input.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("Identity-verification evidence limit must be between 1 and 100");
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string; provider: string; external_event_id: string; applicant_id: string; event_type: string;
      review_status: string | null; review_answer: "GREEN" | "RED" | null; reject_labels: string[];
      provider_created_at: Date | null; payload_hash: string; received_at: Date; recorded_at: Date;
    }>(
      `SELECT id, provider, external_event_id, applicant_id, event_type, review_status, review_answer,
              reject_labels, provider_created_at, payload_hash, received_at, recorded_at
         FROM fractal.provider_identity_verification_events
        WHERE identity_id = $1
        ORDER BY received_at DESC, id DESC
        LIMIT $2`,
      [input.identityId, limit],
    );
    const evidence = result.rows.map((row) => ({
      id: row.id,
      provider: row.provider,
      externalEventId: row.external_event_id,
      applicantId: row.applicant_id,
      eventType: row.event_type,
      reviewStatus: row.review_status,
      reviewAnswer: row.review_answer,
      rejectLabels: row.reject_labels,
      providerCreatedAt: row.provider_created_at?.toISOString() ?? null,
      payloadHash: row.payload_hash,
      receivedAt: row.received_at.toISOString(),
      recordedAt: row.recorded_at.toISOString(),
    }));
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${input.identityId}`,
      actorId: input.accessedByIdentityId,
      actorType: "user",
      action: "identity.verification_evidence.viewed",
      entityType: "identity",
      entityId: input.identityId,
      payload: { evidenceCount: evidence.length },
    });
    return evidence;
  });
}
