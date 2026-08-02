import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class OfferingPublicationEvidenceError extends Error {}

export type OfferingPublicationEvidenceKind = "agreement" | "disclosure_bundle";

type EvidenceRow = {
  id: string; organization_id: string; evidence_kind: OfferingPublicationEvidenceKind; filename: string; mime_type: string;
  storage_key: string; content_sha256: string; bytes: string; uploaded_by_identity_id: string; created_at: Date;
};

function text(value: string, field: string, max: number) {
  const result = value.trim();
  if (!result || result.length > max) throw new OfferingPublicationEvidenceError(`${field} is required and must be at most ${max} characters`);
  return result;
}

function hash(value: string) {
  const result = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new OfferingPublicationEvidenceError("contentSha256 must be a SHA-256 hash");
  return result;
}

function size(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 15 * 1024 * 1024) throw new OfferingPublicationEvidenceError("bytes must be a positive safe integer no greater than 15MB");
  return value;
}

function map(row: EvidenceRow) {
  return {
    id: row.id, organizationId: row.organization_id, evidenceKind: row.evidence_kind, filename: row.filename,
    mimeType: row.mime_type, storageKey: row.storage_key, contentSha256: row.content_sha256, bytes: row.bytes,
    uploadedByIdentityId: row.uploaded_by_identity_id, createdAt: row.created_at.toISOString(),
  };
}

export async function recordOfferingPublicationEvidence(input: {
  organizationId: string; evidenceKind: OfferingPublicationEvidenceKind; uploadedByIdentityId: string; filename: string;
  mimeType: string; storageKey: string; contentSha256: string; bytes: number;
}) {
  const evidenceDocumentId = randomUUID();
  const filename = text(input.filename, "filename", 240);
  const mimeType = text(input.mimeType, "mimeType", 160).toLowerCase();
  const storageKey = text(input.storageKey, "storageKey", 2_000);
  const contentSha256 = hash(input.contentSha256);
  const bytes = size(input.bytes);
  await withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO fractal.offering_publication_evidence_documents
       (id, organization_id, evidence_kind, filename, mime_type, storage_key, content_sha256, bytes, uploaded_by_identity_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [evidenceDocumentId, input.organizationId, input.evidenceKind, filename, mimeType, storageKey, contentSha256, bytes, input.uploadedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.uploadedByIdentityId,
      actorType: "user", action: "offering.publication_evidence.recorded", entityType: "offering_publication_evidence_document", entityId: evidenceDocumentId,
      payload: { evidenceKind: input.evidenceKind, filename, mimeType, contentSha256, bytes },
    });
    await appendOutboxEvent(client, { aggregateType: "offering_publication_evidence_document", aggregateId: evidenceDocumentId, eventType: "offering.publication_evidence.recorded", payload: { organizationId: input.organizationId, auditEventId: audit.id } });
  });
  return { evidenceDocumentId, contentSha256 };
}

export async function getOfferingPublicationEvidence(evidenceDocumentId: string) {
  const result = await requirePostgres().query<EvidenceRow>("SELECT * FROM fractal.offering_publication_evidence_documents WHERE id = $1", [evidenceDocumentId]);
  return result.rows[0] ? map(result.rows[0]) : null;
}

export async function listOfferingPublicationEvidence(input: { organizationId: string; evidenceKind?: OfferingPublicationEvidenceKind }) {
  const result = await requirePostgres().query<EvidenceRow>(
    `SELECT * FROM fractal.offering_publication_evidence_documents
      WHERE organization_id = $1 AND ($2::text IS NULL OR evidence_kind = $2)
      ORDER BY created_at DESC, id DESC`,
    [input.organizationId, input.evidenceKind ?? null],
  );
  return result.rows.map(map);
}
