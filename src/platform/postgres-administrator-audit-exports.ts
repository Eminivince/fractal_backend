import { createHash, randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

const MAX_AUDIT_EXPORT_BYTES = 25 * 1024 * 1024;

export class AdministratorAuditExportError extends Error {
  constructor(message: string, readonly code: "not_found" | "too_broad" | "integrity" | "invalid_input") {
    super(message);
    this.name = "AdministratorAuditExportError";
  }
}

export interface AdministratorAuditExportFilters {
  query?: string;
  action?: string;
  scopeKey?: string;
  actorId?: string;
  from?: Date;
  to?: Date;
}

export interface AdministratorAuditExportMetadata {
  id: string;
  requestedByIdentityId: string;
  requestedByLegalName: string;
  filters: Record<string, string | null>;
  sequenceHighWatermark: string;
  firstSequence: string | null;
  lastSequence: string | null;
  recordCount: number;
  contentSha256: string;
  createdAt: string;
}

type ExportRow = {
  id: string;
  requested_by_identity_id: string;
  requested_by_legal_name: string;
  filters: Record<string, string | null>;
  sequence_high_watermark: string;
  first_sequence: string | null;
  last_sequence: string | null;
  record_count: number;
  content_sha256: string;
  content: Record<string, unknown>;
  created_at: Date;
};

function normalizeFilters(input: AdministratorAuditExportFilters): Record<string, string | null> {
  const query = input.query?.trim() || null;
  const action = input.action?.trim() || null;
  const scopeKey = input.scopeKey?.trim() || null;
  if (query && query.length > 200) throw new AdministratorAuditExportError("Audit export query cannot exceed 200 characters.", "invalid_input");
  if (action && action.length > 200) throw new AdministratorAuditExportError("Audit export action cannot exceed 200 characters.", "invalid_input");
  if (scopeKey && scopeKey.length > 300) throw new AdministratorAuditExportError("Audit export scope cannot exceed 300 characters.", "invalid_input");
  if (input.from && input.to && input.from > input.to) throw new AdministratorAuditExportError("Audit export start must not follow its end.", "invalid_input");
  return {
    query,
    action,
    scopeKey,
    actorId: input.actorId ?? null,
    from: input.from?.toISOString() ?? null,
    to: input.to?.toISOString() ?? null,
  };
}

function mapMetadata(row: ExportRow): AdministratorAuditExportMetadata {
  return {
    id: row.id,
    requestedByIdentityId: row.requested_by_identity_id,
    requestedByLegalName: row.requested_by_legal_name,
    filters: row.filters,
    sequenceHighWatermark: row.sequence_high_watermark,
    firstSequence: row.first_sequence,
    lastSequence: row.last_sequence,
    recordCount: row.record_count,
    contentSha256: row.content_sha256,
    createdAt: row.created_at.toISOString(),
  };
}

const exportSelect = `
  SELECT export.id, export.requested_by_identity_id,
         requester.legal_name AS requested_by_legal_name,
         export.filters, export.sequence_high_watermark::text,
         export.first_sequence::text, export.last_sequence::text,
         export.record_count, export.content_sha256, export.content, export.created_at
    FROM fractal.administrator_audit_exports export
    JOIN fractal.identities requester ON requester.id = export.requested_by_identity_id`;

export async function createAdministratorAuditExport(input: {
  requestedByIdentityId: string;
  filters: AdministratorAuditExportFilters;
  maxRecords: number;
  commandKey: string;
}) {
  if (!Number.isInteger(input.maxRecords) || input.maxRecords < 1 || input.maxRecords > 5000) {
    throw new AdministratorAuditExportError("Audit exports must contain between 1 and 5000 records.", "invalid_input");
  }
  const filters = normalizeFilters(input.filters);
  const result = await runPostgresIdempotentCommand<{ export: AdministratorAuditExportMetadata }>({
    actorIdentityId: input.requestedByIdentityId,
    scopeKey: `administrator-audit-export:${input.requestedByIdentityId}`,
    route: "POST:/v1/admin/audit-exports",
    commandKey: input.commandKey,
    payload: { filters, maxRecords: input.maxRecords },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await requireAdministratorCapability(client, input.requestedByIdentityId, "audit_export");
      const highWatermark = await client.query<{ sequence: string }>(
        "SELECT COALESCE(max(sequence), 0)::text AS sequence FROM fractal.audit_events",
      );
      const sequenceHighWatermark = highWatermark.rows[0]?.sequence ?? "0";
      const rows = await client.query<{
        sequence: string;
        id: string;
        scope_key: string | null;
        organization_id: string | null;
        actor_id: string | null;
        actor_type: string;
        actor_legal_name: string | null;
        actor_email: string | null;
        action: string;
        entity_type: string;
        entity_id: string;
        reason: string | null;
        payload: Record<string, unknown>;
        parent_hash: string | null;
        canonical_hash: string;
        occurred_at: Date;
      }>(
        `SELECT event.sequence::text, event.id, event.scope_key, event.organization_id,
                event.actor_id, event.actor_type, actor.legal_name AS actor_legal_name,
                actor.email AS actor_email, event.action, event.entity_type, event.entity_id,
                event.reason, event.payload, event.parent_hash, event.canonical_hash, event.occurred_at
           FROM fractal.audit_events event
           LEFT JOIN fractal.identities actor ON actor.id = event.actor_id
          WHERE event.sequence <= $1::bigint
            AND ($2::text IS NULL OR event.action ILIKE '%' || $2 || '%'
                 OR event.entity_id ILIKE '%' || $2 || '%'
                 OR event.scope_key ILIKE '%' || $2 || '%'
                 OR event.reason ILIKE '%' || $2 || '%'
                 OR actor.email ILIKE '%' || $2 || '%'
                 OR actor.legal_name ILIKE '%' || $2 || '%')
            AND ($3::text IS NULL OR event.action = $3)
            AND ($4::text IS NULL OR event.scope_key = $4)
            AND ($5::uuid IS NULL OR event.actor_id = $5)
            AND ($6::timestamptz IS NULL OR event.occurred_at >= $6)
            AND ($7::timestamptz IS NULL OR event.occurred_at <= $7)
          ORDER BY event.sequence
          LIMIT $8`,
        [
          sequenceHighWatermark,
          filters.query,
          filters.action,
          filters.scopeKey,
          filters.actorId,
          filters.from,
          filters.to,
          input.maxRecords + 1,
        ],
      );
      if (rows.rows.length > input.maxRecords) {
        throw new AdministratorAuditExportError(
          `The selected audit evidence exceeds ${input.maxRecords} records. Narrow the scope or time range.`,
          "too_broad",
        );
      }
      const exportId = randomUUID();
      const createdAt = new Date();
      const events = rows.rows.map((row) => ({
        sequence: row.sequence,
        id: row.id,
        scopeKey: row.scope_key,
        organizationId: row.organization_id,
        actorId: row.actor_id,
        actorType: row.actor_type,
        actorLegalName: row.actor_legal_name,
        actorEmail: row.actor_email,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        reason: row.reason,
        payload: row.payload,
        parentHash: row.parent_hash,
        canonicalHash: row.canonical_hash,
        occurredAt: row.occurred_at.toISOString(),
      }));
      const document = {
        schemaVersion: "fractal.audit-export.v1",
        exportId,
        createdAt: createdAt.toISOString(),
        requestedByIdentityId: input.requestedByIdentityId,
        filters,
        sequenceHighWatermark,
        recordCount: events.length,
        firstSequence: events.at(0)?.sequence ?? null,
        lastSequence: events.at(-1)?.sequence ?? null,
        events,
      };
      const canonical = stableJsonStringify(document);
      if (Buffer.byteLength(canonical, "utf8") > MAX_AUDIT_EXPORT_BYTES) {
        throw new AdministratorAuditExportError(
          "The selected audit evidence exceeds the 25 MiB export limit. Narrow the scope or time range.",
          "too_broad",
        );
      }
      const contentSha256 = createHash("sha256").update(canonical).digest("hex");
      await client.query(
        `INSERT INTO fractal.administrator_audit_exports
           (id, requested_by_identity_id, filters, sequence_high_watermark, first_sequence,
            last_sequence, record_count, content_sha256, content, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          exportId,
          input.requestedByIdentityId,
          filters,
          sequenceHighWatermark,
          document.firstSequence,
          document.lastSequence,
          events.length,
          contentSha256,
          document,
          createdAt,
        ],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `administrator-audit-export:${exportId}`,
        actorId: input.requestedByIdentityId,
        actorType: "user",
        action: "administrator.audit_export.created",
        entityType: "administrator_audit_export",
        entityId: exportId,
        payload: {
          contentSha256,
          recordCount: events.length,
          sequenceHighWatermark,
          firstSequence: document.firstSequence,
          lastSequence: document.lastSequence,
          filters,
        },
      });
      await appendOutboxEvent(client, {
        aggregateType: "administrator_audit_export",
        aggregateId: exportId,
        eventType: "administrator.audit_export.created",
        payload: { contentSha256, recordCount: events.length, auditEventId: audit.id },
      });
      const stored = await client.query<ExportRow>(`${exportSelect} WHERE export.id = $1`, [exportId]);
      return { status: 201, body: { export: mapMetadata(stored.rows[0]!) } };
    },
  });
  return { export: result.body.export, replayed: result.replayed };
}

export async function listAdministratorAuditExports(input: { requestedByIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.requestedByIdentityId, "audit_export");
    const result = await client.query<ExportRow>(
      `${exportSelect} ORDER BY export.created_at DESC, export.id DESC LIMIT 100`,
    );
    return { exports: result.rows.map(mapMetadata) };
  });
}

export async function retrieveAdministratorAuditExport(input: {
  requestedByIdentityId: string;
  exportId: string;
}): Promise<{ metadata: AdministratorAuditExportMetadata; canonicalContent: string }> {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.requestedByIdentityId, "audit_export");
    const result = await client.query<ExportRow>(`${exportSelect} WHERE export.id = $1`, [input.exportId]);
    const row = result.rows[0];
    if (!row) throw new AdministratorAuditExportError("Administrator audit export not found.", "not_found");
    const canonicalContent = stableJsonStringify(row.content);
    const actualHash = createHash("sha256").update(canonicalContent).digest("hex");
    if (actualHash !== row.content_sha256) {
      throw new AdministratorAuditExportError("Administrator audit export failed integrity verification.", "integrity");
    }
    await appendPostgresAuditEvent(client, {
      scopeKey: `administrator-audit-export:${row.id}`,
      actorId: input.requestedByIdentityId,
      actorType: "user",
      action: "administrator.audit_export.retrieved",
      entityType: "administrator_audit_export",
      entityId: row.id,
      payload: { contentSha256: row.content_sha256, recordCount: row.record_count },
    });
    return { metadata: mapMetadata(row), canonicalContent };
  });
}
