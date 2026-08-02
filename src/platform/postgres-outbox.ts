import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";

interface OutboxEventBaseInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  occurredAt?: Date;
}

export type OutboxPrivacyAttribution =
  | { kind: "audit_event"; additionalSubjectIdentityIds?: readonly string[] }
  | { kind: "subjects"; subjectIdentityIds: readonly string[] }
  | { kind: "technical_no_subject" };

export type OutboxEventInput = OutboxEventBaseInput & (
  | {
      payload: Record<string, unknown> & { auditEventId: string };
      privacy?: Extract<OutboxPrivacyAttribution, { kind: "audit_event" }>;
    }
  | {
      payload: Record<string, unknown>;
      privacy: Exclude<OutboxPrivacyAttribution, { kind: "audit_event" }>;
    }
);

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function canonicalIdentityIds(values: readonly string[]): string[] {
  if (values.length > 25) throw new Error("Outbox privacy attribution cannot contain more than 25 identities");
  const ids = [...new Set(values.map((value) => value.trim().toLowerCase()))].sort();
  if (ids.length !== values.length || ids.some((value) => !uuidPattern.test(value))) {
    throw new Error("Outbox privacy subject identities must be unique UUIDs");
  }
  return ids;
}

async function resolvePrivacyAttribution(client: PoolClient, input: OutboxEventInput): Promise<{
  classification: "subject_attributed" | "technical_no_subject";
  subjectIdentityIds: string[];
  basis: "audit_event_actor" | "audit_event_actor_and_explicit_subjects" | "audit_event_actor_and_authoritative_subjects"
    | "audit_event_actor_explicit_and_authoritative_subjects" | "audit_event_authoritative_subjects"
    | "audit_event_nonhuman" | "explicit_subjects" | "explicit_and_authoritative_subjects"
    | "authoritative_subjects" | "explicit_technical";
}> {
  const authoritative = await client.query<{ subject_ids: string[] }>(
    "SELECT fractal.resolve_outbox_privacy_subjects($1,$2) AS subject_ids",
    [input.aggregateType, input.aggregateId],
  );
  const authoritativeSubjectIdentityIds = canonicalIdentityIds(authoritative.rows[0]?.subject_ids ?? []);
  if (input.privacy?.kind === "subjects") {
    const explicitSubjectIdentityIds = canonicalIdentityIds(input.privacy.subjectIdentityIds);
    const subjectIdentityIds = canonicalIdentityIds([...new Set([...explicitSubjectIdentityIds, ...authoritativeSubjectIdentityIds])]);
    if (!subjectIdentityIds.length) throw new Error("Subject-attributed outbox events require at least one identity");
    return {
      classification: "subject_attributed",
      subjectIdentityIds,
      basis: authoritativeSubjectIdentityIds.length ? "explicit_and_authoritative_subjects" : "explicit_subjects",
    };
  }
  if (input.privacy?.kind === "technical_no_subject") {
    if (authoritativeSubjectIdentityIds.length) {
      return { classification: "subject_attributed", subjectIdentityIds: authoritativeSubjectIdentityIds, basis: "authoritative_subjects" };
    }
    return { classification: "technical_no_subject", subjectIdentityIds: [], basis: "explicit_technical" };
  }

  const rawAuditEventId = input.payload.auditEventId;
  if (typeof rawAuditEventId !== "string") throw new Error("Audited outbox events require an audit event UUID");
  const auditEventId = rawAuditEventId.trim().toLowerCase();
  if (!uuidPattern.test(auditEventId)) throw new Error("Audited outbox events require a valid audit event UUID");
  const audit = await client.query<{ actor_id: string | null; actor_type: string }>(
    "SELECT actor_id, actor_type FROM fractal.audit_events WHERE id=$1 FOR SHARE",
    [auditEventId],
  );
  const event = audit.rows[0];
  if (!event) throw new Error("Outbox privacy attribution requires an existing immutable audit event");
  const additional = canonicalIdentityIds(input.privacy?.additionalSubjectIdentityIds ?? []);
  const subjectIdentityIds = canonicalIdentityIds([...new Set([
    ...(event.actor_id ? [event.actor_id] : []), ...additional, ...authoritativeSubjectIdentityIds,
  ])]);
  if (subjectIdentityIds.length) {
    const hasActor = event.actor_id !== null;
    const hasExplicit = additional.length > 0;
    const hasAuthoritative = authoritativeSubjectIdentityIds.length > 0;
    const basis = hasActor && hasExplicit && hasAuthoritative ? "audit_event_actor_explicit_and_authoritative_subjects"
      : hasActor && hasAuthoritative ? "audit_event_actor_and_authoritative_subjects"
        : !hasActor && hasAuthoritative ? "audit_event_authoritative_subjects"
          : hasActor && hasExplicit ? "audit_event_actor_and_explicit_subjects"
            : "audit_event_actor";
    return {
      classification: "subject_attributed",
      subjectIdentityIds,
      basis,
    };
  }
  if (event.actor_type === "user") throw new Error("A user-authored audit event cannot omit its actor identity");
  return { classification: "technical_no_subject", subjectIdentityIds: [], basis: "audit_event_nonhuman" };
}

export async function appendOutboxEvent(client: PoolClient, input: OutboxEventInput): Promise<string> {
  const id = randomUUID();
  const privacy = await resolvePrivacyAttribution(client, input);
  await client.query(
    `INSERT INTO fractal.outbox_events
       (id, aggregate_type, aggregate_id, event_type, payload, occurred_at,
        privacy_classification, privacy_subject_identity_ids, privacy_attribution_basis)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9)`,
    [
      id, input.aggregateType, input.aggregateId, input.eventType, input.payload, input.occurredAt ?? new Date(),
      privacy.classification, privacy.subjectIdentityIds, privacy.basis,
    ],
  );
  return id;
}

export interface ClaimedOutboxEvent {
  id: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  occurredAt: Date;
  attempts: number;
}

export async function claimOutboxEvents(input: {
  workerId: string;
  eventTypes: readonly string[];
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedOutboxEvent[]> {
  if (input.eventTypes.length === 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      aggregate_type: string;
      aggregate_id: string;
      event_type: string;
      payload: Record<string, unknown>;
      occurred_at: Date;
      attempts: number;
    }>(
      `WITH candidates AS (
         SELECT id
           FROM fractal.outbox_events
          WHERE published_at IS NULL
            AND event_type = ANY($1::text[])
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($2 * interval '1 second'))
          ORDER BY occurred_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE fractal.outbox_events event
          SET claimed_at = now(), claimed_by = $4, attempts = event.attempts + 1
         FROM candidates
        WHERE event.id = candidates.id
       RETURNING event.id, event.aggregate_type, event.aggregate_id, event.event_type,
                 event.payload, event.occurred_at, event.attempts`,
      [input.eventTypes, input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((event) => ({
      id: event.id,
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      eventType: event.event_type,
      payload: event.payload,
      occurredAt: event.occurred_at,
      attempts: event.attempts,
    }));
  });
}

export async function markOutboxEventPublished(client: PoolClient, eventId: string, workerId: string): Promise<void> {
  const result = await client.query(
    `UPDATE fractal.outbox_events
        SET published_at = now(), claimed_at = NULL, claimed_by = NULL, last_error = NULL
      WHERE id = $1 AND claimed_by = $2 AND published_at IS NULL`,
    [eventId, workerId],
  );
  if (result.rowCount !== 1) throw new Error(`Outbox event ${eventId} is no longer claimed by this worker`);
}

export async function markOutboxEventForRetry(input: {
  eventId: string;
  workerId: string;
  retryAt: Date;
  error: unknown;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await withPostgresTransaction(async (client) => {
    await client.query(
      `UPDATE fractal.outbox_events
          SET claimed_at = NULL, claimed_by = NULL, next_attempt_at = $3, last_error = $4
        WHERE id = $1 AND claimed_by = $2 AND published_at IS NULL`,
      [input.eventId, input.workerId, input.retryAt, message.slice(0, 2_000)],
    );
  });
}
