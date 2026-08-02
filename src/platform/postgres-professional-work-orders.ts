import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class ProfessionalWorkOrderError extends Error {}

type WorkOrderRow = { id: string; reference: string; issuer_organization_id: string; professional_firm_organization_id: string; asset_application_request_id: string; title: string; scope: string; exclusions: string; confidentiality: "restricted" | "confidential"; response_due_at: Date; delivery_due_at: Date; fee_minor: string; currency: string; status: "invited" | "clarification_requested" | "accepted" | "declined" | "conflict_flagged" | "in_progress" | "cancelled"; invited_by_identity_id: string; invited_at: Date; decided_by_identity_id: string | null; decided_at: Date | null; decision_reason: string | null };
type DeliverableRow = { id: string; work_order_id: string; version: number; title: string; submission_summary: string; status: "submitted" | "revision_requested" | "accepted" | "rejected"; submitted_by_identity_id: string; submitted_at: Date; reviewed_by_identity_id: string | null; reviewed_at: Date | null; review_notes: string | null; evidence_documents: Array<{ id: string; filename: string; mimeType: string; contentSha256: string; bytes: string | number; uploadedAt: string }> };

function text(value: string, field: string, min: number, max: number) { const result = value.trim(); if (result.length < min || result.length > max) throw new ProfessionalWorkOrderError(`${field} must be between ${min} and ${max} characters`); return result; }
function map(row: WorkOrderRow) { return { id: row.id, reference: row.reference, issuerOrganizationId: row.issuer_organization_id, professionalFirmOrganizationId: row.professional_firm_organization_id, assetApplicationRequestId: row.asset_application_request_id, title: row.title, scope: row.scope, exclusions: row.exclusions, confidentiality: row.confidentiality, responseDueAt: row.response_due_at.toISOString(), deliveryDueAt: row.delivery_due_at.toISOString(), feeMinor: row.fee_minor, currency: row.currency, status: row.status, invitedByIdentityId: row.invited_by_identity_id, invitedAt: row.invited_at.toISOString(), decidedByIdentityId: row.decided_by_identity_id, decidedAt: row.decided_at?.toISOString() ?? null, decisionReason: row.decision_reason }; }

export async function createProfessionalWorkOrder(input: { issuerOrganizationId: string; invitedByIdentityId: string; professionalFirmOrganizationId: string; assetApplicationRequestId: string; assignedFirmMembershipId: string; reference: string; title: string; scope: string; exclusions: string; confidentiality: "restricted" | "confidential"; responseDueAt: Date; deliveryDueAt: Date; feeMinor: number; currency: string }) {
  const workOrderId = randomUUID(); const reference = text(input.reference, "reference", 1, 200); const title = text(input.title, "title", 2, 240); const scope = text(input.scope, "scope", 20, 5000); const exclusions = text(input.exclusions, "exclusions", 2, 5000); const currency = input.currency.trim().toUpperCase();
  if (!Number.isSafeInteger(input.feeMinor) || input.feeMinor < 0 || !/^[A-Z]{3}$/.test(currency)) throw new ProfessionalWorkOrderError("feeMinor or currency is invalid"); if (input.responseDueAt >= input.deliveryDueAt) throw new ProfessionalWorkOrderError("responseDueAt must precede deliveryDueAt");
  await withPostgresTransaction(async (client) => {
    await client.query(`INSERT INTO fractal.professional_work_orders (id, reference, issuer_organization_id, professional_firm_organization_id, asset_application_request_id, title, scope, exclusions, confidentiality, response_due_at, delivery_due_at, fee_minor, currency, status, invited_by_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'invited',$14)`, [workOrderId, reference, input.issuerOrganizationId, input.professionalFirmOrganizationId, input.assetApplicationRequestId, title, scope, exclusions, input.confidentiality, input.responseDueAt, input.deliveryDueAt, input.feeMinor, currency, input.invitedByIdentityId]);
    await client.query("INSERT INTO fractal.professional_work_order_assignments (id, work_order_id, firm_membership_id, assigned_by_identity_id) VALUES ($1,$2,$3,$4)", [randomUUID(), workOrderId, input.assignedFirmMembershipId, input.invitedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.issuerOrganizationId}`, organizationId: input.issuerOrganizationId, actorId: input.invitedByIdentityId, actorType: "user", action: "professional_work_order.invited", entityType: "professional_work_order", entityId: workOrderId, payload: { reference, assetApplicationRequestId: input.assetApplicationRequestId, professionalFirmOrganizationId: input.professionalFirmOrganizationId } });
    await client.query("INSERT INTO fractal.professional_work_order_events (id, work_order_id, actor_identity_id, event_type, payload) VALUES ($1,$2,$3,'invited',$4)", [randomUUID(), workOrderId, input.invitedByIdentityId, { auditEventId: audit.id, assignedFirmMembershipId: input.assignedFirmMembershipId }]);
    await appendOutboxEvent(client, { aggregateType: "professional_work_order", aggregateId: workOrderId, eventType: "professional_work_order.invited", payload: { issuerOrganizationId: input.issuerOrganizationId, professionalFirmOrganizationId: input.professionalFirmOrganizationId, auditEventId: audit.id } });
  });
  return { workOrderId };
}

async function assertAssigned(client: Parameters<Parameters<typeof withPostgresTransaction>[0]>[0], workOrderId: string, identityId: string) {
  const result = await client.query("SELECT 1 FROM fractal.professional_work_order_assignments assignment JOIN fractal.professional_firm_memberships membership ON membership.id = assignment.firm_membership_id WHERE assignment.work_order_id = $1 AND assignment.revoked_at IS NULL AND membership.identity_id = $2 AND membership.status = 'active'", [workOrderId, identityId]);
  if (!result.rowCount) throw new ProfessionalWorkOrderError("You are not assigned to this professional work order");
}

async function getActiveAssignedWorkOrder(client: Parameters<Parameters<typeof withPostgresTransaction>[0]>[0], workOrderId: string, identityId: string) {
  const result = await client.query<Pick<WorkOrderRow, "id" | "reference" | "issuer_organization_id" | "status">>(
    "SELECT id, reference, issuer_organization_id, status FROM fractal.professional_work_orders WHERE id = $1 FOR UPDATE",
    [workOrderId],
  );
  const workOrder = result.rows[0];
  if (!workOrder) throw new ProfessionalWorkOrderError("Professional work order not found");
  await assertAssigned(client, workOrderId, identityId);
  if (workOrder.status !== "accepted" && workOrder.status !== "in_progress") {
    throw new ProfessionalWorkOrderError("Deliverables can only be added to an accepted active work order");
  }
  return workOrder;
}

export async function respondToProfessionalWorkOrder(input: { workOrderId: string; actorIdentityId: string; response: "clarification_requested" | "accept" | "decline" | "conflict"; reason?: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<WorkOrderRow>("SELECT * FROM fractal.professional_work_orders WHERE id = $1 FOR UPDATE", [input.workOrderId]); const workOrder = result.rows[0]; if (!workOrder) throw new ProfessionalWorkOrderError("Professional work order not found"); await assertAssigned(client, workOrder.id, input.actorIdentityId);
    const reason = input.reason?.trim();
    if (input.response === "clarification_requested") { if (workOrder.status !== "invited") throw new ProfessionalWorkOrderError("This work order is no longer awaiting an initial response"); if (!reason) throw new ProfessionalWorkOrderError("A clarification request is required"); await client.query("UPDATE fractal.professional_work_orders SET status = 'clarification_requested' WHERE id = $1", [workOrder.id]); }
    else { if (workOrder.status !== "invited" && workOrder.status !== "clarification_requested") throw new ProfessionalWorkOrderError("This work order is no longer awaiting a response"); if ((input.response === "decline" || input.response === "conflict") && !reason) throw new ProfessionalWorkOrderError("A reason is required"); const declaration = input.response === "conflict" ? "conflict" : "no_conflict"; await client.query("INSERT INTO fractal.professional_work_order_conflicts (id, work_order_id, declared_by_identity_id, declaration, notes) VALUES ($1,$2,$3,$4,$5)", [randomUUID(), workOrder.id, input.actorIdentityId, declaration, input.response === "conflict" ? text(reason!, "reason", 2, 2000) : null]); const status = input.response === "accept" ? "accepted" : input.response === "conflict" ? "conflict_flagged" : "declined"; await client.query("UPDATE fractal.professional_work_orders SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4 WHERE id = $1", [workOrder.id, status, input.actorIdentityId, input.response === "accept" ? null : text(reason!, "reason", 2, 2000)]); }
    const eventType = input.response === "accept" ? "accepted" : input.response; const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${workOrder.issuer_organization_id}`, organizationId: workOrder.issuer_organization_id, actorId: input.actorIdentityId, actorType: "user", action: `professional_work_order.${eventType}`, entityType: "professional_work_order", entityId: workOrder.id, reason: reason || undefined, payload: { reference: workOrder.reference, professionalFirmOrganizationId: workOrder.professional_firm_organization_id } }); await client.query("INSERT INTO fractal.professional_work_order_events (id, work_order_id, actor_identity_id, event_type, reason, payload) VALUES ($1,$2,$3,$4,$5,$6)", [randomUUID(), workOrder.id, input.actorIdentityId, eventType, reason ?? null, { auditEventId: audit.id }]); await appendOutboxEvent(client, { aggregateType: "professional_work_order", aggregateId: workOrder.id, eventType: `professional_work_order.${eventType}`, payload: { issuerOrganizationId: workOrder.issuer_organization_id, auditEventId: audit.id } }); return { workOrderId: workOrder.id, status: input.response === "accept" ? "accepted" : input.response === "decline" ? "declined" : input.response };
  });
}

export async function listIssuerProfessionalWorkOrders(issuerOrganizationId: string) { return (await requirePostgres().query<WorkOrderRow>("SELECT * FROM fractal.professional_work_orders WHERE issuer_organization_id = $1 ORDER BY invited_at DESC, id DESC", [issuerOrganizationId])).rows.map(map); }
export async function listAssignedProfessionalWorkOrders(identityId: string) { return (await requirePostgres().query<WorkOrderRow>("SELECT DISTINCT work_order.* FROM fractal.professional_work_orders work_order JOIN fractal.professional_work_order_assignments assignment ON assignment.work_order_id = work_order.id AND assignment.revoked_at IS NULL JOIN fractal.professional_firm_memberships membership ON membership.id = assignment.firm_membership_id WHERE membership.identity_id = $1 AND membership.status = 'active' ORDER BY work_order.invited_at DESC, work_order.id DESC", [identityId])).rows.map(map); }

/**
 * Validate the professional's current assignment and work-order state before
 * a browser is allowed to persist a binary. The write path repeats this check
 * transactionally because storage and PostgreSQL cannot share one commit.
 */
export async function assertProfessionalDeliverableEvidenceUploadAllowed(input: { workOrderId: string; identityId: string }): Promise<void> {
  const result = await requirePostgres().query<Pick<WorkOrderRow, "status">>(
    `SELECT work_order.status
       FROM fractal.professional_work_orders work_order
       JOIN fractal.professional_work_order_assignments assignment
         ON assignment.work_order_id = work_order.id AND assignment.revoked_at IS NULL
       JOIN fractal.professional_firm_memberships membership
         ON membership.id = assignment.firm_membership_id
      WHERE work_order.id = $1 AND membership.identity_id = $2 AND membership.status = 'active'`,
    [input.workOrderId, input.identityId],
  );
  const workOrder = result.rows[0];
  if (!workOrder) throw new ProfessionalWorkOrderError("You are not assigned to this professional work order");
  if (workOrder.status !== "accepted" && workOrder.status !== "in_progress") {
    throw new ProfessionalWorkOrderError("Deliverables can only be added to an accepted active work order");
  }
}

function mapDeliverable(row: DeliverableRow) { return { id: row.id, workOrderId: row.work_order_id, version: row.version, title: row.title, submissionSummary: row.submission_summary, status: row.status, submittedByIdentityId: row.submitted_by_identity_id, submittedAt: row.submitted_at.toISOString(), reviewedByIdentityId: row.reviewed_by_identity_id, reviewedAt: row.reviewed_at?.toISOString() ?? null, reviewNotes: row.review_notes, evidenceDocuments: row.evidence_documents.map((document) => ({ ...document, bytes: String(document.bytes) })) }; }

async function listProfessionalWorkOrderDeliverableRows(workOrderId: string) {
  return (await requirePostgres().query<DeliverableRow>(
    `SELECT deliverable.id, deliverable.work_order_id, deliverable.version, deliverable.title, deliverable.submission_summary,
            deliverable.status, deliverable.submitted_by_identity_id, deliverable.submitted_at, deliverable.reviewed_by_identity_id,
            deliverable.reviewed_at, deliverable.review_notes,
            COALESCE(jsonb_agg(jsonb_build_object('id', evidence.id, 'filename', evidence.filename, 'mimeType', evidence.mime_type,
              'contentSha256', evidence.content_sha256, 'bytes', evidence.bytes, 'uploadedAt', evidence.created_at) ORDER BY evidence.created_at, evidence.id)
              FILTER (WHERE evidence.id IS NOT NULL), '[]'::jsonb) AS evidence_documents
       FROM fractal.professional_deliverable_versions deliverable
       LEFT JOIN fractal.professional_deliverable_version_documents document ON document.deliverable_version_id = deliverable.id
       LEFT JOIN fractal.professional_deliverable_evidence_documents evidence ON evidence.id = document.evidence_document_id
      WHERE deliverable.work_order_id = $1
      GROUP BY deliverable.id
      ORDER BY deliverable.version DESC, deliverable.id DESC`,
    [workOrderId],
  )).rows;
}

export async function listAssignedProfessionalWorkOrderDeliverables(workOrderId: string, identityId: string) {
  const access = await requirePostgres().query("SELECT 1 FROM fractal.professional_work_order_assignments assignment JOIN fractal.professional_firm_memberships membership ON membership.id = assignment.firm_membership_id WHERE assignment.work_order_id = $1 AND assignment.revoked_at IS NULL AND membership.identity_id = $2 AND membership.status = 'active'", [workOrderId, identityId]);
  if (!access.rowCount) throw new ProfessionalWorkOrderError("You are not assigned to this professional work order");
  return (await listProfessionalWorkOrderDeliverableRows(workOrderId)).map(mapDeliverable);
}

export async function listIssuerProfessionalWorkOrderDeliverables(input: { issuerOrganizationId: string; workOrderId: string }) {
  const workOrder = await requirePostgres().query("SELECT 1 FROM fractal.professional_work_orders WHERE id = $1 AND issuer_organization_id = $2", [input.workOrderId, input.issuerOrganizationId]);
  if (!workOrder.rowCount) throw new ProfessionalWorkOrderError("Professional work order not found in this organization");
  return (await listProfessionalWorkOrderDeliverableRows(input.workOrderId)).map(mapDeliverable);
}

export async function getIssuerProfessionalDeliverableEvidence(input: { issuerOrganizationId: string; evidenceDocumentId: string }) {
  const result = await requirePostgres().query<{ id: string; filename: string; mime_type: string; storage_key: string; content_sha256: string }>(
    `SELECT evidence.id, evidence.filename, evidence.mime_type, evidence.storage_key, evidence.content_sha256
       FROM fractal.professional_deliverable_evidence_documents evidence
       JOIN fractal.professional_work_orders work_order ON work_order.id = evidence.work_order_id
      WHERE evidence.id = $1 AND work_order.issuer_organization_id = $2`,
    [input.evidenceDocumentId, input.issuerOrganizationId],
  );
  const evidence = result.rows[0];
  if (!evidence) throw new ProfessionalWorkOrderError("Professional deliverable evidence not found in this organization");
  return { id: evidence.id, filename: evidence.filename, mimeType: evidence.mime_type, storageKey: evidence.storage_key, contentSha256: evidence.content_sha256 };
}

export async function recordProfessionalDeliverableEvidence(input: { workOrderId: string; uploadedByIdentityId: string; filename: string; mimeType: string; storageKey: string; contentSha256: string; bytes: number }) {
  const id = randomUUID();
  await withPostgresTransaction(async (client) => {
    const workOrder = await getActiveAssignedWorkOrder(client, input.workOrderId, input.uploadedByIdentityId);
    const filename = text(input.filename, "filename", 1, 240); const mimeType = text(input.mimeType, "mimeType", 1, 160); const storageKey = text(input.storageKey, "storageKey", 1, 2000);
    if (!/^[a-f0-9]{64}$/.test(input.contentSha256) || !Number.isSafeInteger(input.bytes) || input.bytes <= 0 || input.bytes > 15 * 1024 * 1024) throw new ProfessionalWorkOrderError("Deliverable evidence is invalid");
    await client.query("INSERT INTO fractal.professional_deliverable_evidence_documents (id, work_order_id, filename, mime_type, storage_key, content_sha256, bytes, uploaded_by_identity_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, input.workOrderId, filename, mimeType, storageKey, input.contentSha256, input.bytes, input.uploadedByIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${workOrder.issuer_organization_id}`, organizationId: workOrder.issuer_organization_id, actorId: input.uploadedByIdentityId, actorType: "user", action: "professional_deliverable.evidence_recorded", entityType: "professional_deliverable_evidence_document", entityId: id, payload: { workOrderId: workOrder.id, reference: workOrder.reference, filename, contentSha256: input.contentSha256, bytes: input.bytes } });
    await client.query("INSERT INTO fractal.professional_work_order_events (id, work_order_id, actor_identity_id, event_type, payload) VALUES ($1,$2,$3,'deliverable_evidence_recorded',$4)", [randomUUID(), workOrder.id, input.uploadedByIdentityId, { auditEventId: audit.id, evidenceDocumentId: id }]);
    await appendOutboxEvent(client, { aggregateType: "professional_work_order", aggregateId: workOrder.id, eventType: "professional_deliverable.evidence_recorded", payload: { issuerOrganizationId: workOrder.issuer_organization_id, workOrderId: workOrder.id, evidenceDocumentId: id, auditEventId: audit.id } });
  });
  return { evidenceDocumentId: id };
}

export async function submitProfessionalDeliverable(input: { workOrderId: string; submittedByIdentityId: string; title: string; submissionSummary: string; evidenceDocumentIds: string[] }) {
  const id = randomUUID();
  return withPostgresTransaction(async (client) => {
    const workOrder = await getActiveAssignedWorkOrder(client, input.workOrderId, input.submittedByIdentityId);
    if (!input.evidenceDocumentIds.length || new Set(input.evidenceDocumentIds).size !== input.evidenceDocumentIds.length) throw new ProfessionalWorkOrderError("A deliverable requires distinct evidence documents");
    const evidence = await client.query<{ id: string }>("SELECT id FROM fractal.professional_deliverable_evidence_documents WHERE work_order_id = $1 AND id = ANY($2::uuid[]) FOR SHARE", [input.workOrderId, input.evidenceDocumentIds]);
    if (evidence.rowCount !== input.evidenceDocumentIds.length) throw new ProfessionalWorkOrderError("Deliverable evidence must belong to this work order");
    const next = await client.query<{ version: number }>("SELECT COALESCE(MAX(version), 0) + 1 AS version FROM fractal.professional_deliverable_versions WHERE work_order_id = $1", [input.workOrderId]);
    const version = next.rows[0]!.version; const title = text(input.title, "title", 2, 240); const submissionSummary = text(input.submissionSummary, "submissionSummary", 2, 5000);
    await client.query("INSERT INTO fractal.professional_deliverable_versions (id, work_order_id, version, title, submission_summary, status, submitted_by_identity_id) VALUES ($1,$2,$3,$4,$5,'submitted',$6)", [id, input.workOrderId, version, title, submissionSummary, input.submittedByIdentityId]);
    for (const evidenceDocumentId of input.evidenceDocumentIds) await client.query("INSERT INTO fractal.professional_deliverable_version_documents (deliverable_version_id, evidence_document_id) VALUES ($1,$2)", [id, evidenceDocumentId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${workOrder.issuer_organization_id}`, organizationId: workOrder.issuer_organization_id, actorId: input.submittedByIdentityId, actorType: "user", action: "professional_deliverable.submitted", entityType: "professional_deliverable_version", entityId: id, payload: { workOrderId: workOrder.id, reference: workOrder.reference, version, evidenceDocumentIds: input.evidenceDocumentIds } });
    await client.query("INSERT INTO fractal.professional_work_order_events (id, work_order_id, actor_identity_id, event_type, payload) VALUES ($1,$2,$3,'deliverable_submitted',$4)", [randomUUID(), workOrder.id, input.submittedByIdentityId, { auditEventId: audit.id, deliverableVersionId: id, version }]);
    await appendOutboxEvent(client, { aggregateType: "professional_deliverable_version", aggregateId: id, eventType: "professional_deliverable.submitted", payload: { issuerOrganizationId: workOrder.issuer_organization_id, workOrderId: workOrder.id, deliverableVersionId: id, version, auditEventId: audit.id } });
    return { deliverableVersionId: id, version };
  });
}

export async function decideProfessionalDeliverable(input: { deliverableVersionId: string; reviewedByIdentityId: string; decision: "accepted" | "revision_requested" | "rejected"; notes: string }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string; work_order_id: string; submitted_by_identity_id: string; issuer_organization_id: string; reference: string }>("SELECT deliverable.id, deliverable.work_order_id, deliverable.submitted_by_identity_id, work_order.issuer_organization_id, work_order.reference FROM fractal.professional_deliverable_versions deliverable JOIN fractal.professional_work_orders work_order ON work_order.id = deliverable.work_order_id WHERE deliverable.id = $1 AND deliverable.status = 'submitted' FOR UPDATE OF deliverable, work_order", [input.deliverableVersionId]);
    const deliverable = result.rows[0];
    if (!deliverable) throw new ProfessionalWorkOrderError("Deliverable is not awaiting review");
    if (deliverable.submitted_by_identity_id === input.reviewedByIdentityId) throw new ProfessionalWorkOrderError("A different person must review this deliverable");
    const notes = text(input.notes, "notes", 2, 2000);
    await client.query("UPDATE fractal.professional_deliverable_versions SET status = $2, reviewed_by_identity_id = $3, reviewed_at = now(), review_notes = $4 WHERE id = $1", [deliverable.id, input.decision, input.reviewedByIdentityId, notes]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${deliverable.issuer_organization_id}`, organizationId: deliverable.issuer_organization_id, actorId: input.reviewedByIdentityId, actorType: "user", action: `professional_deliverable.${input.decision}`, entityType: "professional_deliverable_version", entityId: deliverable.id, reason: notes, payload: { workOrderId: deliverable.work_order_id, reference: deliverable.reference } });
    await client.query("INSERT INTO fractal.professional_work_order_events (id, work_order_id, actor_identity_id, event_type, reason, payload) VALUES ($1,$2,$3,$4,$5,$6)", [randomUUID(), deliverable.work_order_id, input.reviewedByIdentityId, `deliverable_${input.decision}`, notes, { auditEventId: audit.id, deliverableVersionId: deliverable.id }]);
    await appendOutboxEvent(client, { aggregateType: "professional_deliverable_version", aggregateId: deliverable.id, eventType: `professional_deliverable.${input.decision}`, payload: { issuerOrganizationId: deliverable.issuer_organization_id, workOrderId: deliverable.work_order_id, deliverableVersionId: deliverable.id, auditEventId: audit.id } });
    return { deliverableVersionId: deliverable.id, status: input.decision };
  });
}
