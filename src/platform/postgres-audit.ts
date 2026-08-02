import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { stableJsonStringify } from "../utils/idempotency.js";

export interface AuditEventInput {
  scopeKey: string;
  organizationId?: string;
  actorId?: string;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  reason?: string;
  payload: Record<string, unknown>;
  occurredAt?: Date;
}

export interface AppendedAuditEvent {
  id: string;
  sequence: number;
  canonicalHash: string;
  parentHash: string | null;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

/**
 * Locks a per-scope chain head before calculating the next hash. This makes
 * concurrent audit appends deterministic without relying on application-level
 * ordering or a best-effort event emitter.
 */
export async function appendPostgresAuditEvent(
  client: PoolClient,
  input: AuditEventInput,
): Promise<AppendedAuditEvent> {
  const initialHash = "0".repeat(64);
  await client.query(
    `INSERT INTO fractal.audit_chain_heads (scope_key, latest_sequence, latest_hash)
     VALUES ($1, 0, $2)
     ON CONFLICT (scope_key) DO NOTHING`,
    [input.scopeKey, initialHash],
  );
  const headResult = await client.query<{ latest_hash: string }>(
    `SELECT latest_hash FROM fractal.audit_chain_heads WHERE scope_key = $1 FOR UPDATE`,
    [input.scopeKey],
  );
  const parentHash = headResult.rows[0]?.latest_hash;
  if (!parentHash) throw new Error("Unable to lock audit-chain head");

  const id = randomUUID();
  const occurredAt = input.occurredAt ?? new Date();
  const canonicalHash = sha256({
    id,
    scopeKey: input.scopeKey,
    organizationId: input.organizationId ?? null,
    actorId: input.actorId ?? null,
    actorType: input.actorType,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    reason: input.reason ?? null,
    payload: input.payload,
    parentHash,
    occurredAt: occurredAt.toISOString(),
  });
  const inserted = await client.query<{ sequence: string }>(
    `INSERT INTO fractal.audit_events
       (id, scope_key, organization_id, actor_id, actor_type, action, entity_type, entity_id, reason, payload, parent_hash, canonical_hash, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING sequence`,
    [
      id,
      input.scopeKey,
      input.organizationId ?? null,
      input.actorId ?? null,
      input.actorType,
      input.action,
      input.entityType,
      input.entityId,
      input.reason ?? null,
      input.payload,
      parentHash,
      canonicalHash,
      occurredAt,
    ],
  );
  const sequence = Number(inserted.rows[0]?.sequence);
  if (!Number.isSafeInteger(sequence)) throw new Error("Audit event sequence was not returned");

  await client.query(
    `UPDATE fractal.audit_chain_heads
        SET latest_sequence = $1, latest_hash = $2, updated_at = now()
      WHERE scope_key = $3`,
    [sequence, canonicalHash, input.scopeKey],
  );
  return { id, sequence, canonicalHash, parentHash: parentHash === initialHash ? null : parentHash };
}
