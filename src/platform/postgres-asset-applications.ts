import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class AssetApplicationError extends Error {}

type EvidenceRow = { id: string; organization_id: string; filename: string; mime_type: string; storage_key: string; content_sha256: string; bytes: string; uploaded_by_identity_id: string; created_at: Date };
type RequestRow = { id: string; organization_id: string; application_reference: string; application_version: number; asset_name: string; asset_type: string; country_code: string; state: string; city: string; summary: string; material_change_summary: string | null; requested_capacity_minor: string; currency: string; dossier_evidence_document_id: string; dossier_hash: string; status: "submitted" | "approved" | "rejected"; submitted_by_identity_id: string; submitted_at: Date; decided_by_identity_id: string | null; decided_at: Date | null; decision_reason: string | null; approved_application_version_id: string | null };
type ReviewItemRow = { id: string; organization_id: string; application_request_id: string; category: string; title: string; request_message: string; required: boolean; status: "open" | "responded" | "verified" | "rejected"; response_message: string | null; response_evidence_document_id: string | null; responded_by_identity_id: string | null; responded_at: Date | null; reviewed_by_identity_id: string | null; reviewed_at: Date | null; review_notes: string | null; opened_by_identity_id: string; opened_at: Date };

function text(value: string, field: string, min: number, max: number) { const result = value.trim(); if (result.length < min || result.length > max) throw new AssetApplicationError(`${field} must be between ${min} and ${max} characters`); return result; }
function hash(value: string) { const result = value.trim().toLowerCase(); if (!/^[a-f0-9]{64}$/.test(result)) throw new AssetApplicationError("contentSha256 must be a SHA-256 hash"); return result; }
function amount(value: number) { if (!Number.isSafeInteger(value) || value <= 0) throw new AssetApplicationError("requestedCapacityMinor must be a positive safe integer"); return value; }
function mapEvidence(row: EvidenceRow) { return { id: row.id, organizationId: row.organization_id, filename: row.filename, mimeType: row.mime_type, storageKey: row.storage_key, contentSha256: row.content_sha256, bytes: row.bytes, uploadedByIdentityId: row.uploaded_by_identity_id, createdAt: row.created_at.toISOString() }; }
function mapRequest(row: RequestRow) { return { id: row.id, organizationId: row.organization_id, applicationReference: row.application_reference, applicationVersion: row.application_version, assetName: row.asset_name, assetType: row.asset_type, countryCode: row.country_code, state: row.state, city: row.city, summary: row.summary, materialChangeSummary: row.material_change_summary, requestedCapacityMinor: row.requested_capacity_minor, currency: row.currency, dossierEvidenceDocumentId: row.dossier_evidence_document_id, dossierHash: row.dossier_hash, status: row.status, submittedByIdentityId: row.submitted_by_identity_id, submittedAt: row.submitted_at.toISOString(), decidedByIdentityId: row.decided_by_identity_id, decidedAt: row.decided_at?.toISOString() ?? null, decisionReason: row.decision_reason, approvedApplicationVersionId: row.approved_application_version_id }; }
function mapReviewItem(row: ReviewItemRow) { return { id: row.id, organizationId: row.organization_id, applicationRequestId: row.application_request_id, category: row.category, title: row.title, requestMessage: row.request_message, required: row.required, status: row.status, responseMessage: row.response_message, responseEvidenceDocumentId: row.response_evidence_document_id, respondedByIdentityId: row.responded_by_identity_id, respondedAt: row.responded_at?.toISOString() ?? null, reviewedByIdentityId: row.reviewed_by_identity_id, reviewedAt: row.reviewed_at?.toISOString() ?? null, reviewNotes: row.review_notes, openedByIdentityId: row.opened_by_identity_id, openedAt: row.opened_at.toISOString() }; }

export async function recordAssetApplicationEvidence(input: { organizationId: string; uploadedByIdentityId: string; filename: string; mimeType: string; storageKey: string; contentSha256: string; bytes: number }) {
  const evidenceDocumentId = randomUUID();
  const filename = text(input.filename, "filename", 1, 240); const mimeType = text(input.mimeType, "mimeType", 1, 160).toLowerCase(); const storageKey = text(input.storageKey, "storageKey", 1, 2000); const contentSha256 = hash(input.contentSha256);
  if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > 15 * 1024 * 1024) throw new AssetApplicationError("bytes must be a positive safe integer no greater than 15MB");
  await withPostgresTransaction(async (client) => {
    await client.query(`INSERT INTO fractal.asset_application_evidence_documents (id, organization_id, filename, mime_type, storage_key, content_sha256, bytes, uploaded_by_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [evidenceDocumentId, input.organizationId, filename, mimeType, storageKey, contentSha256, input.bytes, input.uploadedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.uploadedByIdentityId, actorType: "user", action: "asset_application.evidence.recorded", entityType: "asset_application_evidence_document", entityId: evidenceDocumentId, payload: { filename, mimeType, contentSha256, bytes: input.bytes } });
    await appendOutboxEvent(client, { aggregateType: "asset_application_evidence_document", aggregateId: evidenceDocumentId, eventType: "asset_application.evidence.recorded", payload: { organizationId: input.organizationId, auditEventId: audit.id } });
  });
  return { evidenceDocumentId, contentSha256 };
}

export async function submitAssetApplicationRequest(input: { organizationId: string; submittedByIdentityId: string; applicationReference: string; applicationVersion: number; assetName: string; assetType: string; countryCode: string; state: string; city: string; summary: string; materialChangeSummary?: string; requestedCapacityMinor: number; currency: string; dossierEvidenceDocumentId: string }) {
  const requestId = randomUUID(); const applicationReference = text(input.applicationReference, "applicationReference", 1, 200); const assetName = text(input.assetName, "assetName", 2, 200); const assetType = text(input.assetType, "assetType", 2, 120); const state = text(input.state, "state", 2, 120); const city = text(input.city, "city", 2, 120); const summary = text(input.summary, "summary", 20, 5000); const requestedCapacityMinor = amount(input.requestedCapacityMinor); const countryCode = input.countryCode.trim().toUpperCase(); const currency = input.currency.trim().toUpperCase();
  if (!Number.isSafeInteger(input.applicationVersion) || input.applicationVersion <= 0) throw new AssetApplicationError("applicationVersion must be a positive safe integer");
  const materialChangeSummary = input.applicationVersion > 1 ? text(input.materialChangeSummary ?? "", "materialChangeSummary", 20, 2000) : undefined;
  if (input.applicationVersion === 1 && input.materialChangeSummary?.trim()) throw new AssetApplicationError("materialChangeSummary is only allowed on an amended application");
  if (!/^[A-Z]{2}$/.test(countryCode) || !/^[A-Z]{3}$/.test(currency)) throw new AssetApplicationError("countryCode and currency are invalid");
  await withPostgresTransaction(async (client) => {
    const verifiedOrganization = await client.query(
      `SELECT 1 FROM fractal.organizations
        WHERE id = $1 AND status = 'active' AND verification_status = 'verified'
          AND verification_expires_at > now() FOR SHARE`,
      [input.organizationId],
    );
    if (verifiedOrganization.rowCount !== 1) throw new AssetApplicationError("Organization verification must be current before starting a new asset application");
    const evidence = await client.query<{ content_sha256: string }>("SELECT content_sha256 FROM fractal.asset_application_evidence_documents WHERE id = $1 AND organization_id = $2 FOR SHARE", [input.dossierEvidenceDocumentId, input.organizationId]);
    if (!evidence.rows[0]) throw new AssetApplicationError("Application dossier evidence must belong to this organization");
    await client.query(`INSERT INTO fractal.asset_application_requests (id, organization_id, application_reference, application_version, asset_name, asset_type, country_code, state, city, summary, material_change_summary, requested_capacity_minor, currency, dossier_evidence_document_id, dossier_hash, status, submitted_by_identity_id, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'submitted',$16,now())`, [requestId, input.organizationId, applicationReference, input.applicationVersion, assetName, assetType, countryCode, state, city, summary, materialChangeSummary ?? null, requestedCapacityMinor, currency, input.dossierEvidenceDocumentId, evidence.rows[0].content_sha256, input.submittedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.submittedByIdentityId, actorType: "user", action: "asset_application.submitted", entityType: "asset_application_request", entityId: requestId, payload: { applicationReference, applicationVersion: input.applicationVersion, assetName, requestedCapacityMinor: String(requestedCapacityMinor), currency } });
    await appendOutboxEvent(client, { aggregateType: "asset_application_request", aggregateId: requestId, eventType: "asset_application.submitted", payload: { organizationId: input.organizationId, auditEventId: audit.id } });
  });
  return { requestId };
}

export async function decideAssetApplicationRequest(input: { requestId: string; decidedByIdentityId: string; approve: boolean; reason?: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<RequestRow>("SELECT * FROM fractal.asset_application_requests WHERE id = $1 FOR UPDATE", [input.requestId]); const request = result.rows[0];
    if (!request) throw new AssetApplicationError("Asset application request not found"); if (request.status !== "submitted") throw new AssetApplicationError("Asset application request has already been decided"); if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new AssetApplicationError("A different person must approve or reject this request");
    const reason = input.reason?.trim(); if (!input.approve && !reason) throw new AssetApplicationError("A rejection reason is required");
    const unresolved = await client.query<{ count: string }>("SELECT count(*) FROM fractal.asset_application_review_items WHERE application_request_id = $1 AND required AND status <> 'verified'", [request.id]);
    if (input.approve && Number(unresolved.rows[0]?.count ?? 0) > 0) throw new AssetApplicationError("Required diligence items must be verified before approval");
    const status = input.approve ? "approved" : "rejected"; const approvedApplicationVersionId = input.approve ? randomUUID() : null;
    if (approvedApplicationVersionId) await client.query(`INSERT INTO fractal.approved_asset_application_versions (id, application_request_id, organization_id, application_reference, application_version, asset_name, asset_type, country_code, state, city, summary, requested_capacity_minor, currency, dossier_evidence_document_id, dossier_hash, approved_by_identity_id, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,now())`, [approvedApplicationVersionId, request.id, request.organization_id, request.application_reference, request.application_version, request.asset_name, request.asset_type, request.country_code, request.state, request.city, request.summary, request.requested_capacity_minor, request.currency, request.dossier_evidence_document_id, request.dossier_hash, input.decidedByIdentityId]);
    await client.query("UPDATE fractal.asset_application_requests SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4, approved_application_version_id = $5 WHERE id = $1", [request.id, status, input.decidedByIdentityId, input.approve ? reason ?? null : text(reason!, "reason", 1, 2000), approvedApplicationVersionId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${request.organization_id}`, organizationId: request.organization_id, actorId: input.decidedByIdentityId, actorType: "user", action: `asset_application.${status}`, entityType: "asset_application_request", entityId: request.id, reason: reason ?? undefined, payload: { applicationReference: request.application_reference, approvedApplicationVersionId } });
    await appendOutboxEvent(client, { aggregateType: "asset_application_request", aggregateId: request.id, eventType: `asset_application.${status}`, payload: { organizationId: request.organization_id, approvedApplicationVersionId, auditEventId: audit.id } });
    return { requestId: request.id, status, ...(approvedApplicationVersionId ? { approvedApplicationVersionId } : {}) };
  });
}

export async function getAssetApplicationRequest(requestId: string) { const result = await requirePostgres().query<RequestRow>("SELECT * FROM fractal.asset_application_requests WHERE id = $1", [requestId]); return result.rows[0] ? mapRequest(result.rows[0]) : null; }
export async function listAssetApplicationRequests(organizationId: string) { return (await requirePostgres().query<RequestRow>("SELECT * FROM fractal.asset_application_requests WHERE organization_id = $1 ORDER BY submitted_at DESC, id DESC", [organizationId])).rows.map(mapRequest); }
export async function listApprovedAssetApplicationVersions(organizationId: string) { return (await requirePostgres().query<{ id: string; application_reference: string; application_version: number; asset_name: string; requested_capacity_minor: string; currency: string; approved_at: Date; is_current: boolean }>(`SELECT version.id, version.application_reference, version.application_version, version.asset_name, version.requested_capacity_minor, version.currency, version.approved_at,
  NOT EXISTS (SELECT 1 FROM fractal.asset_application_version_supersessions supersession WHERE supersession.superseded_application_version_id = version.id) AS is_current
  FROM fractal.approved_asset_application_versions version
  WHERE version.organization_id = $1 ORDER BY version.approved_at DESC, version.id DESC`, [organizationId])).rows.map((row) => ({ id: row.id, applicationReference: row.application_reference, applicationVersion: row.application_version, assetName: row.asset_name, requestedCapacityMinor: row.requested_capacity_minor, currency: row.currency, approvedAt: row.approved_at.toISOString(), isCurrent: row.is_current })); }
export async function getAssetApplicationEvidence(evidenceDocumentId: string) { const result = await requirePostgres().query<EvidenceRow>("SELECT * FROM fractal.asset_application_evidence_documents WHERE id = $1", [evidenceDocumentId]); return result.rows[0] ? mapEvidence(result.rows[0]) : null; }

export async function createAssetApplicationReviewItem(input: { organizationId: string; applicationRequestId: string; openedByIdentityId: string; category: string; title: string; requestMessage: string; required?: boolean }) {
  const reviewItemId = randomUUID(); const category = text(input.category, "category", 2, 80); const title = text(input.title, "title", 2, 200); const requestMessage = text(input.requestMessage, "requestMessage", 2, 2000);
  await withPostgresTransaction(async (client) => {
    const application = await client.query<RequestRow>("SELECT * FROM fractal.asset_application_requests WHERE id = $1 AND organization_id = $2 FOR SHARE", [input.applicationRequestId, input.organizationId]);
    if (!application.rows[0] || application.rows[0].status !== "submitted") throw new AssetApplicationError("Diligence items can only be opened for a submitted asset application");
    await client.query("INSERT INTO fractal.asset_application_review_items (id, organization_id, application_request_id, category, title, request_message, required, status, opened_by_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,'open',$8)", [reviewItemId, input.organizationId, input.applicationRequestId, category, title, requestMessage, input.required ?? true, input.openedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.openedByIdentityId, actorType: "user", action: "asset_application.review_item.opened", entityType: "asset_application_review_item", entityId: reviewItemId, payload: { applicationRequestId: input.applicationRequestId, category, required: input.required ?? true } });
    await appendOutboxEvent(client, { aggregateType: "asset_application_review_item", aggregateId: reviewItemId, eventType: "asset_application.review_item.opened", payload: { organizationId: input.organizationId, applicationRequestId: input.applicationRequestId, auditEventId: audit.id } });
  });
  return { reviewItemId };
}

export async function respondToAssetApplicationReviewItem(input: { reviewItemId: string; respondedByIdentityId: string; responseMessage: string; responseEvidenceDocumentId: string }) {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<ReviewItemRow>("SELECT * FROM fractal.asset_application_review_items WHERE id = $1 FOR UPDATE", [input.reviewItemId]); const item = result.rows[0];
    if (!item) throw new AssetApplicationError("Asset application review item not found"); if (!["open", "rejected"].includes(item.status)) throw new AssetApplicationError("This diligence item is not awaiting an issuer response");
    const message = text(input.responseMessage, "responseMessage", 2, 2000); const evidence = await client.query<{ id: string }>("SELECT id FROM fractal.asset_application_evidence_documents WHERE id = $1 AND organization_id = $2 FOR SHARE", [input.responseEvidenceDocumentId, item.organization_id]); if (!evidence.rows[0]) throw new AssetApplicationError("Response evidence must belong to the application organization");
    await client.query("UPDATE fractal.asset_application_review_items SET status = 'responded', response_message = $2, response_evidence_document_id = $3, responded_by_identity_id = $4, responded_at = now(), reviewed_by_identity_id = NULL, reviewed_at = NULL, review_notes = NULL WHERE id = $1", [item.id, message, input.responseEvidenceDocumentId, input.respondedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${item.organization_id}`, organizationId: item.organization_id, actorId: input.respondedByIdentityId, actorType: "user", action: "asset_application.review_item.responded", entityType: "asset_application_review_item", entityId: item.id, payload: { applicationRequestId: item.application_request_id } });
    await appendOutboxEvent(client, { aggregateType: "asset_application_review_item", aggregateId: item.id, eventType: "asset_application.review_item.responded", payload: { organizationId: item.organization_id, applicationRequestId: item.application_request_id, auditEventId: audit.id } });
  });
}

export async function decideAssetApplicationReviewItem(input: { reviewItemId: string; reviewedByIdentityId: string; verify: boolean; notes?: string }) {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<ReviewItemRow>("SELECT * FROM fractal.asset_application_review_items WHERE id = $1 FOR UPDATE", [input.reviewItemId]); const item = result.rows[0];
    if (!item) throw new AssetApplicationError("Asset application review item not found"); if (item.status !== "responded") throw new AssetApplicationError("This diligence response is not awaiting review"); if (item.responded_by_identity_id === input.reviewedByIdentityId) throw new AssetApplicationError("A different person must verify or reject this diligence response");
    const notes = input.notes?.trim(); if (!input.verify && !notes) throw new AssetApplicationError("A rejection note is required"); const status = input.verify ? "verified" : "rejected";
    await client.query("UPDATE fractal.asset_application_review_items SET status = $2, reviewed_by_identity_id = $3, reviewed_at = now(), review_notes = $4 WHERE id = $1", [item.id, status, input.reviewedByIdentityId, input.verify ? notes ?? null : text(notes!, "notes", 1, 2000)]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${item.organization_id}`, organizationId: item.organization_id, actorId: input.reviewedByIdentityId, actorType: "user", action: `asset_application.review_item.${status}`, entityType: "asset_application_review_item", entityId: item.id, reason: notes ?? undefined, payload: { applicationRequestId: item.application_request_id } });
    await appendOutboxEvent(client, { aggregateType: "asset_application_review_item", aggregateId: item.id, eventType: `asset_application.review_item.${status}`, payload: { organizationId: item.organization_id, applicationRequestId: item.application_request_id, auditEventId: audit.id } });
  });
}

export async function listAssetApplicationReviewItems(input: { organizationId: string; applicationRequestId: string }) { return (await requirePostgres().query<ReviewItemRow>("SELECT * FROM fractal.asset_application_review_items WHERE organization_id = $1 AND application_request_id = $2 ORDER BY opened_at ASC, id ASC", [input.organizationId, input.applicationRequestId])).rows.map(mapReviewItem); }
