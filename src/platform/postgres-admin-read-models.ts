import { Buffer } from "node:buffer";
import { requirePostgres } from "../db/postgres.js";
import type { Role } from "../utils/constants.js";

export interface AdminAccessIdentity {
  id: string;
  email: string;
  legalName: string;
  status: "active" | "disabled";
  globalRole: Role | null;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AdminAuditEvent {
  sequence: number;
  id: string;
  scopeKey: string | null;
  actorId: string | null;
  actorName: string | null;
  actorEmail: string | null;
  actorType: string;
  action: string;
  entityType: string;
  entityId: string;
  reason: string | null;
  canonicalHash: string;
  occurredAt: string;
}

type AccessCursor = { createdAt: string; id: string };

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeAdminAccessCursor(value: string): AccessCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<AccessCursor>;
    if (!parsed.id || !parsed.createdAt || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("invalid");
    return { id: parsed.id, createdAt: parsed.createdAt };
  } catch {
    throw new Error("Invalid access-register cursor");
  }
}

export async function listAdminAccessIdentities(input: {
  query?: string;
  cursor?: AccessCursor;
  limit: number;
}): Promise<{ identities: AdminAccessIdentity[]; nextCursor: string | null }> {
  const query = input.query?.trim() || null;
  const cursorCreatedAt = input.cursor?.createdAt ?? null;
  const cursorId = input.cursor?.id ?? null;
  const result = await requirePostgres().query<{
    id: string;
    email: string;
    legal_name: string;
    status: "active" | "disabled";
    global_role: Role | null;
    email_verified_at: Date | null;
    created_at: Date;
    updated_at: Date;
    cursor_created_at: string;
  }>(
    `SELECT identity.id, identity.email, identity.legal_name, identity.status,
            active_role.role AS global_role, identity.email_verified_at,
            identity.created_at, identity.updated_at,
            to_char(identity.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
       FROM fractal.identities identity
       LEFT JOIN LATERAL (
         SELECT role
           FROM fractal.identity_role_assignments
          WHERE identity_id = identity.id
            AND scope_type = 'global'
            AND revoked_at IS NULL
          ORDER BY granted_at DESC, id DESC
          LIMIT 1
       ) active_role ON TRUE
      WHERE ($1::text IS NULL OR identity.email ILIKE '%' || $1 || '%' OR identity.legal_name ILIKE '%' || $1 || '%')
        AND ($2::timestamptz IS NULL OR (identity.created_at, identity.id) < ($2::timestamptz, $3::uuid))
      ORDER BY identity.created_at DESC, identity.id DESC
      LIMIT $4`,
    [query, cursorCreatedAt, cursorId, input.limit + 1],
  );
  const hasNextPage = result.rows.length > input.limit;
  const page = result.rows.slice(0, input.limit);
  const identities = page.map((row) => ({
    id: row.id,
    email: row.email,
    legalName: row.legal_name,
    status: row.status,
    globalRole: row.global_role,
    emailVerifiedAt: row.email_verified_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }));
  const last = identities.at(-1);
  const lastRow = page.at(-1);
  return {
    identities,
    nextCursor: hasNextPage && last && lastRow
      ? encodeCursor({ createdAt: lastRow.cursor_created_at, id: last.id })
      : null,
  };
}

export async function listAdminAuditEvents(input: {
  query?: string;
  action?: string;
  scopeKey?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
  beforeSequence?: number;
  limit: number;
}): Promise<{ events: AdminAuditEvent[]; nextCursor: string | null }> {
  const query = input.query?.trim() || null;
  const result = await requirePostgres().query<{
    sequence: string;
    id: string;
    scope_key: string | null;
    actor_id: string | null;
    actor_name: string | null;
    actor_email: string | null;
    actor_type: string;
    action: string;
    entity_type: string;
    entity_id: string;
    reason: string | null;
    canonical_hash: string;
    occurred_at: Date;
  }>(
    `SELECT event.sequence, event.id, event.scope_key, event.actor_id,
            actor.legal_name AS actor_name, actor.email AS actor_email,
            event.actor_type, event.action, event.entity_type, event.entity_id,
            event.reason, event.canonical_hash, event.occurred_at
       FROM fractal.audit_events event
       LEFT JOIN fractal.identities actor ON actor.id = event.actor_id
      WHERE ($1::text IS NULL OR event.action ILIKE '%' || $1 || '%'
             OR event.entity_id ILIKE '%' || $1 || '%'
             OR event.scope_key ILIKE '%' || $1 || '%'
             OR event.reason ILIKE '%' || $1 || '%'
             OR actor.email ILIKE '%' || $1 || '%'
             OR actor.legal_name ILIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR event.action = $2)
        AND ($3::text IS NULL OR event.scope_key = $3)
        AND ($4::uuid IS NULL OR event.actor_id = $4)
        AND ($5::timestamptz IS NULL OR event.occurred_at >= $5)
        AND ($6::timestamptz IS NULL OR event.occurred_at <= $6)
        AND ($7::bigint IS NULL OR event.sequence < $7)
      ORDER BY event.sequence DESC
      LIMIT $8`,
    [
      query,
      input.action ?? null,
      input.scopeKey ?? null,
      input.actorId ?? null,
      input.from ?? null,
      input.to ?? null,
      input.beforeSequence ?? null,
      input.limit + 1,
    ],
  );
  const hasNextPage = result.rows.length > input.limit;
  const events = result.rows.slice(0, input.limit).map((row) => ({
    sequence: Number(row.sequence),
    id: row.id,
    scopeKey: row.scope_key,
    actorId: row.actor_id,
    actorName: row.actor_name,
    actorEmail: row.actor_email,
    actorType: row.actor_type,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    reason: row.reason,
    canonicalHash: row.canonical_hash,
    occurredAt: row.occurred_at.toISOString(),
  }));
  const last = events.at(-1);
  return { events, nextCursor: hasNextPage && last ? String(last.sequence) : null };
}
