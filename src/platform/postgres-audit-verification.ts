import { createHash } from "node:crypto";
import { requirePostgres } from "../db/postgres.js";
import { stableJsonStringify } from "../utils/idempotency.js";

export class PostgresAuditVerificationError extends Error {}

type AuditRow = {
  sequence: string; id: string; scope_key: string; organization_id: string | null; actor_id: string | null;
  actor_type: string; action: string; entity_type: string; entity_id: string; reason: string | null;
  payload: Record<string, unknown>; parent_hash: string | null; canonical_hash: string; occurred_at: Date;
};

function digest(input: unknown): string {
  return createHash("sha256").update(stableJsonStringify(input)).digest("hex");
}

export interface AuditScopeVerification {
  scopeKey: string;
  events: number;
  latestSequence: number | null;
  latestHash: string | null;
}

/** Verifies stored rows and the per-scope chain head independently of writers. */
export async function verifyPostgresAuditScope(scopeKey: string): Promise<AuditScopeVerification> {
  const normalized = scopeKey.trim();
  if (!normalized) throw new PostgresAuditVerificationError("scopeKey is required");
  const rows = await requirePostgres().query<AuditRow>(
    `SELECT sequence, id, scope_key, organization_id, actor_id, actor_type, action, entity_type, entity_id,
            reason, payload, parent_hash, canonical_hash, occurred_at
       FROM fractal.audit_events WHERE scope_key = $1 ORDER BY sequence`,
    [normalized],
  );
  const zero = "0".repeat(64);
  let parent = zero;
  let sequence: number | null = null;
  for (const row of rows.rows) {
    if (row.parent_hash !== parent) throw new PostgresAuditVerificationError(`Audit parent hash mismatch at sequence ${row.sequence}`);
    const expected = digest({
      id: row.id, scopeKey: normalized, organizationId: row.organization_id, actorId: row.actor_id,
      actorType: row.actor_type, action: row.action, entityType: row.entity_type, entityId: row.entity_id,
      reason: row.reason, payload: row.payload, parentHash: parent, occurredAt: row.occurred_at.toISOString(),
    });
    if (row.canonical_hash !== expected) throw new PostgresAuditVerificationError(`Audit canonical hash mismatch at sequence ${row.sequence}`);
    parent = row.canonical_hash;
    sequence = Number(row.sequence);
  }
  const head = await requirePostgres().query<{ latest_sequence: string; latest_hash: string }>(
    "SELECT latest_sequence, latest_hash FROM fractal.audit_chain_heads WHERE scope_key = $1", [normalized],
  );
  const storedHead = head.rows[0];
  if (!rows.rows.length) {
    if (storedHead) throw new PostgresAuditVerificationError("Audit chain head exists without scoped audit events");
    return { scopeKey: normalized, events: 0, latestSequence: null, latestHash: null };
  }
  if (!storedHead || Number(storedHead.latest_sequence) !== sequence || storedHead.latest_hash !== parent) {
    throw new PostgresAuditVerificationError("Audit chain head does not match scoped events");
  }
  return { scopeKey: normalized, events: rows.rows.length, latestSequence: sequence, latestHash: parent };
}

export async function verifyAllPostgresAuditScopes(): Promise<{ scopes: AuditScopeVerification[]; unverifiableLegacyEvents: number }> {
  const [scopes, legacy] = await Promise.all([
    requirePostgres().query<{ scope_key: string }>("SELECT DISTINCT scope_key FROM fractal.audit_events WHERE scope_key IS NOT NULL ORDER BY scope_key"),
    requirePostgres().query<{ count: string }>("SELECT count(*) AS count FROM fractal.audit_events WHERE scope_key IS NULL"),
  ]);
  const verified = await Promise.all(scopes.rows.map((row) => verifyPostgresAuditScope(row.scope_key)));
  return { scopes: verified, unverifiableLegacyEvents: Number(legacy.rows[0]?.count ?? 0) };
}
