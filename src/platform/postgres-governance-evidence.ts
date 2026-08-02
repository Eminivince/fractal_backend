import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class GovernanceEvidenceError extends Error {}

type EvidenceRow = {
  id: string; organization_id: string; offering_id: string; evidence_kind: "allocation_policy";
  filename: string; mime_type: string; storage_key: string; content_sha256: string; bytes: string;
  uploaded_by_identity_id: string; created_at: Date;
};

function normalized(value: string, field: string, max: number) {
  const result = value.trim();
  if (!result || result.length > max) throw new GovernanceEvidenceError(`${field} is required and must be at most ${max} characters`);
  return result;
}

function hash(value: string) {
  const result = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new GovernanceEvidenceError("contentSha256 must be a SHA-256 hash");
  return result;
}

function size(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 15 * 1024 * 1024) throw new GovernanceEvidenceError("bytes must be a positive safe integer no greater than 15MB");
  return value;
}

function map(row: EvidenceRow) {
  return {
    id: row.id, organizationId: row.organization_id, offeringId: row.offering_id, evidenceKind: row.evidence_kind,
    filename: row.filename, mimeType: row.mime_type, storageKey: row.storage_key, contentSha256: row.content_sha256,
    bytes: row.bytes, uploadedByIdentityId: row.uploaded_by_identity_id, createdAt: row.created_at.toISOString(),
  };
}

export async function recordAllocationPolicyEvidence(input: {
  organizationId: string; offeringId: string; uploadedByIdentityId: string; filename: string; mimeType: string;
  storageKey: string; contentSha256: string; bytes: number;
}): Promise<{ evidenceDocumentId: string; contentSha256: string }> {
  const filename = normalized(input.filename, "filename", 240);
  const mimeType = normalized(input.mimeType, "mimeType", 160).toLowerCase();
  const storageKey = normalized(input.storageKey, "storageKey", 2_000);
  const contentSha256 = hash(input.contentSha256);
  const bytes = size(input.bytes);
  const evidenceDocumentId = randomUUID();
  await withPostgresTransaction(async (client) => {
    const offering = await client.query<{ id: string }>(
      "SELECT id FROM fractal.offering_products WHERE id = $1 AND organization_id = $2 AND status = 'published' FOR SHARE",
      [input.offeringId, input.organizationId],
    );
    if (!offering.rows[0]) throw new GovernanceEvidenceError("Allocation policy evidence requires a published offering in the organization");
    await client.query(
      `INSERT INTO fractal.governance_evidence_documents
       (id, organization_id, offering_id, evidence_kind, filename, mime_type, storage_key, content_sha256, bytes, uploaded_by_identity_id)
       VALUES ($1,$2,$3,'allocation_policy',$4,$5,$6,$7,$8,$9)`,
      [evidenceDocumentId, input.organizationId, input.offeringId, filename, mimeType, storageKey, contentSha256, bytes, input.uploadedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.uploadedByIdentityId,
      actorType: "user", action: "offering.allocation_policy_evidence.recorded", entityType: "governance_evidence_document", entityId: evidenceDocumentId,
      payload: { offeringId: input.offeringId, evidenceKind: "allocation_policy", filename, mimeType, contentSha256, bytes },
    });
    await appendOutboxEvent(client, { aggregateType: "governance_evidence_document", aggregateId: evidenceDocumentId, eventType: "offering.allocation_policy_evidence.recorded", payload: { organizationId: input.organizationId, offeringId: input.offeringId, auditEventId: audit.id } });
  });
  return { evidenceDocumentId, contentSha256 };
}

export async function getGovernanceEvidenceDocument(evidenceDocumentId: string) {
  const result = await requirePostgres().query<EvidenceRow>("SELECT * FROM fractal.governance_evidence_documents WHERE id = $1", [evidenceDocumentId]);
  return result.rows[0] ? map(result.rows[0]) : null;
}

export async function listAllocationPolicyEvidence(input: { organizationId: string; offeringId?: string }) {
  const result = await requirePostgres().query<EvidenceRow>(
    `SELECT * FROM fractal.governance_evidence_documents
      WHERE organization_id = $1 AND evidence_kind = 'allocation_policy' AND ($2::uuid IS NULL OR offering_id = $2)
      ORDER BY created_at DESC, id DESC`,
    [input.organizationId, input.offeringId ?? null],
  );
  return result.rows.map(map);
}
