import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres } from "../db/postgres.js";
import type { ClaimedOutboxEvent } from "../platform/postgres-outbox.js";

export const securityEventTypes = [
  "auth.session.created",
  "auth.session.rotated",
  "auth.session.revoked",
  "auth.session.refresh_reuse_detected",
] as const;

function stringPayloadValue(payload: Record<string, unknown>, key: string): string {
  const value = payload[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Security event ${key} is missing or invalid`);
  }
  return value;
}

export async function projectSecurityEvent(client: PoolClient, event: ClaimedOutboxEvent): Promise<void> {
  if (!securityEventTypes.includes(event.eventType as (typeof securityEventTypes)[number])) {
    throw new Error(`Unsupported security event type: ${event.eventType}`);
  }
  const subjectId = stringPayloadValue(event.payload, "subjectId");
  const auditEventId = stringPayloadValue(event.payload, "auditEventId");
  await client.query(
    `INSERT INTO fractal.security_notifications
       (id, outbox_event_id, audit_event_id, subject_id, session_id, event_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (outbox_event_id) DO NOTHING`,
    [randomUUID(), event.id, auditEventId, subjectId, event.aggregateId, event.eventType],
  );
}

export async function listSecurityEvents(subjectId: string) {
  const result = await requirePostgres().query<{
    id: string;
    event_type: string;
    session_id: string;
    created_at: Date;
    read_at: Date | null;
  }>(
    `SELECT id, event_type, session_id, created_at, read_at
       FROM fractal.security_notifications
      WHERE subject_id = $1
      ORDER BY created_at DESC, id DESC
      LIMIT 100`,
    [subjectId],
  );
  return result.rows;
}
