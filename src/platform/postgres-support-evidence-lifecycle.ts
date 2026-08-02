import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { AdministratorCapabilityError, requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { lockDataLifecycleAuthority } from "./postgres-data-lifecycle-lock.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export type LegalHoldTargetType = "identity" | "support_case" | "support_attachment" | "organization" | "organization_document" | "distribution_declaration" | "distribution_payout_exception" | "distribution_tax_remittance";
export type LegalHoldReasonCategory = "litigation" | "regulatory_request" | "audit" | "investigation" | "complaint" | "security_incident";
export type SupportEvidenceHoldScope = "attachment" | "case" | "requester_identity";

export class SupportEvidenceLifecycleError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input") {
    super(message);
    this.name = "SupportEvidenceLifecycleError";
  }
}

type HoldChangeRow = {
  id: string; reference: string; target_type: LegalHoldTargetType; target_id: string; change_type: "impose" | "release";
  reason_category: LegalHoldReasonCategory; reason: string; command_key: string; status: "pending" | "applied" | "rejected";
  requested_by_identity_id: string; requested_by_legal_name: string; reviewed_by_identity_id: string | null;
  reviewed_by_legal_name: string | null; decision_reason: string | null; requested_at: Date; reviewed_at: Date | null; applied_at: Date | null;
};

type HoldRow = {
  id: string; reference: string; target_type: LegalHoldTargetType; target_id: string; reason_category: LegalHoldReasonCategory;
  reason: string; imposed_by_identity_id: string; imposed_by_legal_name: string; imposed_at: Date; released_at: Date | null;
};

type DispositionRequestRow = {
  id: string; reference: string; attachment_id: string; reason: string; command_key: string; retention_due_at_snapshot: Date;
  status: "pending" | "applied" | "rejected"; requested_by_identity_id: string; requested_by_legal_name: string;
  reviewed_by_identity_id: string | null; reviewed_by_legal_name: string | null; decision_reason: string | null;
  requested_at: Date; reviewed_at: Date | null; applied_at: Date | null;
};

type DispositionRow = { id: string; status: "cleanup_requested" | "completed" | "failed"; approved_at: Date; completed_at: Date | null; failed_at: Date | null };

const holdChangeSelect = `
  SELECT request.*, requester.legal_name AS requested_by_legal_name, reviewer.legal_name AS reviewed_by_legal_name
  FROM fractal.data_legal_hold_change_requests request
  JOIN fractal.identities requester ON requester.id=request.requested_by_identity_id
  LEFT JOIN fractal.identities reviewer ON reviewer.id=request.reviewed_by_identity_id`;

const dispositionRequestSelect = `
  SELECT request.*, requester.legal_name AS requested_by_legal_name, reviewer.legal_name AS reviewed_by_legal_name
  FROM fractal.support_attachment_disposition_requests request
  JOIN fractal.identities requester ON requester.id=request.requested_by_identity_id
  LEFT JOIN fractal.identities reviewer ON reviewer.id=request.reviewed_by_identity_id`;

function normalizedText(value: string, field: string, minimum: number, maximum: number) {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new SupportEvidenceLifecycleError(`${field} must contain ${minimum} to ${maximum} characters.`, "invalid_input");
  return normalized;
}

function commandKey(value: string) { return normalizedText(value, "Command key", 1, 200); }

function reference(prefix: "HLD" | "HLDA" | "DSP") {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function mapActor(id: string, legalName: string) { return { id, legalName }; }

function mapHoldChange(row: HoldChangeRow) {
  return {
    id: row.id, reference: row.reference, targetType: row.target_type, targetId: row.target_id, changeType: row.change_type,
    reasonCategory: row.reason_category, reason: row.reason, status: row.status,
    requestedBy: mapActor(row.requested_by_identity_id, row.requested_by_legal_name),
    reviewedBy: row.reviewed_by_identity_id && row.reviewed_by_legal_name ? mapActor(row.reviewed_by_identity_id, row.reviewed_by_legal_name) : null,
    decisionReason: row.decision_reason, requestedAt: row.requested_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null,
    appliedAt: row.applied_at?.toISOString() ?? null,
  };
}

function mapHold(row: HoldRow) {
  return { id: row.id, reference: row.reference, targetType: row.target_type, targetId: row.target_id, reasonCategory: row.reason_category,
    reason: row.reason, imposedBy: mapActor(row.imposed_by_identity_id, row.imposed_by_legal_name), imposedAt: row.imposed_at.toISOString(), releasedAt: row.released_at?.toISOString() ?? null };
}

function mapDispositionRequest(row: DispositionRequestRow) {
  return { id: row.id, reference: row.reference, attachmentId: row.attachment_id, action: "delete_object" as const, reason: row.reason,
    retentionDueAt: row.retention_due_at_snapshot.toISOString(), status: row.status,
    requestedBy: mapActor(row.requested_by_identity_id, row.requested_by_legal_name),
    reviewedBy: row.reviewed_by_identity_id && row.reviewed_by_legal_name ? mapActor(row.reviewed_by_identity_id, row.reviewed_by_legal_name) : null,
    decisionReason: row.decision_reason, requestedAt: row.requested_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null,
    appliedAt: row.applied_at?.toISOString() ?? null };
}

const lock = lockDataLifecycleAuthority;

async function requireCapability(client: PoolClient, identityId: string) {
  try { await requireAdministratorCapability(client, identityId, "data_lifecycle_manage"); }
  catch (error) {
    if (error instanceof AdministratorCapabilityError) throw new SupportEvidenceLifecycleError("Data lifecycle management capability is required.", "forbidden");
    throw error;
  }
}

async function assertTargetExists(client: PoolClient, targetType: LegalHoldTargetType, targetId: string) {
  const result = await client.query<{ exists: boolean }>("SELECT fractal.data_lifecycle_target_exists($1,$2) AS exists", [targetType, targetId]);
  if (!result.rows[0]?.exists) throw new SupportEvidenceLifecycleError("Legal hold target not found.", "not_found");
}

async function assertHoldChangeEligible(client: PoolClient, input: { targetType: LegalHoldTargetType; targetId: string; changeType: "impose" | "release" }) {
  await assertTargetExists(client, input.targetType, input.targetId);
  const pending = await client.query("SELECT 1 FROM fractal.data_legal_hold_change_requests WHERE target_type=$1 AND target_id=$2 AND status='pending'", [input.targetType, input.targetId]);
  if (pending.rowCount) throw new SupportEvidenceLifecycleError("A legal hold change is already pending for this target.", "conflict");
  const active = await client.query("SELECT 1 FROM fractal.data_legal_holds WHERE target_type=$1 AND target_id=$2 AND released_at IS NULL", [input.targetType, input.targetId]);
  if (input.changeType === "impose" && active.rowCount) throw new SupportEvidenceLifecycleError("An active legal hold already exists for this target.", "conflict");
  if (input.changeType === "release" && !active.rowCount) throw new SupportEvidenceLifecycleError("No active legal hold exists for this target.", "conflict");
}

async function targetScope(client: PoolClient, targetType: LegalHoldTargetType, targetId: string) {
  if (targetType === "identity") return `identity:${targetId}`;
  if (targetType === "support_case") return `support-case:${targetId}`;
  if (targetType === "organization") return `organization:${targetId}`;
  if (targetType === "organization_document") {
    const result = await client.query<{ organization_id: string }>("SELECT organization_id FROM fractal.organization_documents WHERE id=$1", [targetId]);
    if (!result.rows[0]) throw new SupportEvidenceLifecycleError("Organization document not found.", "not_found");
    return `organization:${result.rows[0].organization_id}`;
  }
  if (targetType === "distribution_declaration" || targetType === "distribution_payout_exception" || targetType === "distribution_tax_remittance") {
    const result = await client.query<{ organization_id: string }>(`SELECT organization_id FROM (
      SELECT organization_id FROM fractal.distribution_declaration_requests WHERE $1='distribution_declaration' AND id=$2
      UNION ALL SELECT organization_id FROM fractal.distribution_payout_exception_cases WHERE $1='distribution_payout_exception' AND id=$2
      UNION ALL SELECT organization_id FROM fractal.distribution_tax_remittance_requests WHERE $1='distribution_tax_remittance' AND id=$2
    ) target`, [targetType, targetId]);
    if (!result.rows[0]) throw new SupportEvidenceLifecycleError("Distribution lifecycle target not found.", "not_found");
    return `organization:${result.rows[0].organization_id}`;
  }
  const result = await client.query<{ case_id: string }>("SELECT case_id FROM fractal.support_case_attachments WHERE id=$1", [targetId]);
  if (!result.rows[0]) throw new SupportEvidenceLifecycleError("Support attachment not found.", "not_found");
  return `support-case:${result.rows[0].case_id}`;
}

export async function readDistributionLegalHoldLifecycle(input:{actorIdentityId:string;targetType:Extract<LegalHoldTargetType,"distribution_declaration"|"distribution_payout_exception"|"distribution_tax_remittance">;targetId:string}){
  return withPostgresTransaction(async(client)=>{await requireCapability(client,input.actorIdentityId);await assertTargetExists(client,input.targetType,input.targetId);
    const active=await client.query<HoldRow>(`SELECT hold_record.id,hold_record.reference,hold_record.target_type,hold_record.target_id,request.reason_category,request.reason,request.requested_by_identity_id AS imposed_by_identity_id,identity.legal_name AS imposed_by_legal_name,hold_record.imposed_at,hold_record.released_at FROM fractal.data_legal_holds hold_record JOIN fractal.data_legal_hold_change_requests request ON request.id=hold_record.imposed_by_change_request_id JOIN fractal.identities identity ON identity.id=request.requested_by_identity_id WHERE hold_record.target_type=$1 AND hold_record.target_id=$2 AND hold_record.released_at IS NULL ORDER BY hold_record.imposed_at,hold_record.id`,[input.targetType,input.targetId]);
    const pending=await client.query<HoldChangeRow>(`${holdChangeSelect} WHERE request.target_type=$1 AND request.target_id=$2 AND request.status='pending' ORDER BY request.requested_at,request.id`,[input.targetType,input.targetId]);
    const retention=await client.query<{policy_version_id:string;policy_reference:string;policy_name:string;jurisdiction_code:string;legal_basis_reference:string;record_class:string;retention_days:number;retention_started_at:Date;retain_until:Date}>("SELECT policy_version_id,policy_reference,policy_name,jurisdiction_code,legal_basis_reference,record_class,retention_days,retention_started_at,retain_until FROM fractal.distribution_lifecycle_policy_bindings WHERE target_type=$1 AND target_id=$2",[input.targetType,input.targetId]);
    const treatments=await client.query<{reference:string;treatment_type:string;policy_treatment_mode:string;requester_visible_summary:string;execution_result:string;legal_hold_active:boolean;executed_at:Date}>(`SELECT treatment.reference,treatment.treatment_type,treatment.policy_treatment_mode,treatment.requester_visible_summary,execution.execution_result,execution.legal_hold_active,execution.executed_at FROM fractal.distribution_privacy_treatment_requests treatment JOIN fractal.distribution_privacy_treatment_executions execution ON execution.treatment_request_id=treatment.id WHERE treatment.target_type=$1 AND treatment.target_id=$2 AND treatment.status='approved' ORDER BY execution.executed_at,treatment.id`,[input.targetType,input.targetId]);
    const policy=retention.rows[0];
    return{targetType:input.targetType,targetId:input.targetId,retentionPolicy:policy?{versionId:policy.policy_version_id,reference:policy.policy_reference,name:policy.policy_name,jurisdictionCode:policy.jurisdiction_code,legalBasisReference:policy.legal_basis_reference,recordClass:policy.record_class,retentionDays:policy.retention_days,retentionStartedAt:policy.retention_started_at.toISOString(),retainUntil:policy.retain_until.toISOString()}:null,privacyTreatments:treatments.rows.map(row=>({reference:row.reference,treatmentType:row.treatment_type,policyTreatmentMode:row.policy_treatment_mode,requesterVisibleSummary:row.requester_visible_summary,executionResult:row.execution_result,legalHoldActive:row.legal_hold_active,executedAt:row.executed_at.toISOString()})),activeHolds:active.rows.map(mapHold),pendingChanges:pending.rows.map(mapHoldChange)};
  });
}

async function dispositionExistsForTarget(client: PoolClient, targetType: LegalHoldTargetType, targetId: string) {
  const result = await client.query<{ exists: boolean }>("SELECT fractal.data_lifecycle_target_has_disposition($1,$2) AS exists", [targetType, targetId]);
  return result.rows[0]?.exists === true;
}

export async function proposeLegalHoldChange(input: { actorIdentityId: string; targetType: LegalHoldTargetType; targetId: string; changeType: "impose" | "release"; reasonCategory: LegalHoldReasonCategory; reason: string; commandKey: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const reason = normalizedText(input.reason, "Legal hold reason", 20, 2_000); const key = commandKey(input.commandKey);
    const replay = await client.query<HoldChangeRow>(`${holdChangeSelect} WHERE request.requested_by_identity_id=$1 AND request.command_key=$2`, [input.actorIdentityId, key]);
    if (replay.rows[0]) {
      const prior = replay.rows[0];
      if (prior.target_type !== input.targetType || prior.target_id !== input.targetId || prior.change_type !== input.changeType || prior.reason_category !== input.reasonCategory || prior.reason !== reason)
        throw new SupportEvidenceLifecycleError("This command key was already used for a different legal hold change.", "conflict");
      return { request: mapHoldChange(prior), replayed: true };
    }
    if (input.changeType === "impose" && await dispositionExistsForTarget(client, input.targetType, input.targetId))
      throw new SupportEvidenceLifecycleError("A legal hold cannot be imposed after governed disposition has begun for this scope.", "conflict");
    await assertHoldChangeEligible(client, input);
    const id = randomUUID();
    await client.query(`INSERT INTO fractal.data_legal_hold_change_requests
      (id,reference,target_type,target_id,change_type,reason_category,reason,command_key,requested_by_identity_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, reference("HLD"), input.targetType, input.targetId, input.changeType, input.reasonCategory, reason, key, input.actorIdentityId]);
    const scopeKey = await targetScope(client, input.targetType, input.targetId);
    const audit = await appendPostgresAuditEvent(client, { scopeKey, actorId: input.actorIdentityId, actorType: "user", action: "data.legal_hold_change.proposed",
      entityType: "data_legal_hold_change_request", entityId: id, reason: "A maker-checker legal hold change was proposed.", payload: { targetType: input.targetType, targetId: input.targetId, changeType: input.changeType, reasonCategory: input.reasonCategory } });
    await appendOutboxEvent(client, { aggregateType: "data_legal_hold_change_request", aggregateId: id, eventType: "data.legal_hold_change.proposed", payload: { targetType: input.targetType, targetId: input.targetId, changeType: input.changeType, auditEventId: audit.id } });
    const row = await client.query<HoldChangeRow>(`${holdChangeSelect} WHERE request.id=$1`, [id]);
    return { request: mapHoldChange(row.rows[0]!), replayed: false };
  });
}

export async function decideLegalHoldChange(input: { actorIdentityId: string; requestId: string; decision: "approve" | "reject"; decisionReason: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const result = await client.query<HoldChangeRow>(`${holdChangeSelect} WHERE request.id=$1 FOR UPDATE OF request`, [input.requestId]);
    const request = result.rows[0]; if (!request) throw new SupportEvidenceLifecycleError("Legal hold change request not found.", "not_found");
    const desired = input.decision === "approve" ? "applied" : "rejected";
    if (request.status !== "pending") {
      if (request.status === desired) return { request: mapHoldChange(request), replayed: true };
      throw new SupportEvidenceLifecycleError("This legal hold change already has a different terminal decision.", "conflict");
    }
    if (request.requested_by_identity_id === input.actorIdentityId) throw new SupportEvidenceLifecycleError("The proposer cannot decide the same legal hold change.", "forbidden");
    const decisionReason = normalizedText(input.decisionReason, "Decision reason", 20, 2_000); const now = new Date();
    if (input.decision === "approve") {
      if (request.change_type === "impose") {
        if (await dispositionExistsForTarget(client, request.target_type, request.target_id)) throw new SupportEvidenceLifecycleError("Governed disposition already began for this scope.", "conflict");
        const active = await client.query("SELECT 1 FROM fractal.data_legal_holds WHERE target_type=$1 AND target_id=$2 AND released_at IS NULL", [request.target_type, request.target_id]);
        if (active.rowCount) throw new SupportEvidenceLifecycleError("An active legal hold already exists for this target.", "conflict");
      } else {
        const active = await client.query("SELECT 1 FROM fractal.data_legal_holds WHERE target_type=$1 AND target_id=$2 AND released_at IS NULL", [request.target_type, request.target_id]);
        if (!active.rowCount) throw new SupportEvidenceLifecycleError("No active legal hold exists for this target.", "conflict");
      }
      await client.query(`UPDATE fractal.data_legal_hold_change_requests SET status='applied',reviewed_by_identity_id=$2,decision_reason=$3,reviewed_at=$4,applied_at=$4 WHERE id=$1`, [request.id, input.actorIdentityId, decisionReason, now]);
      if (request.change_type === "impose") {
        await client.query(`INSERT INTO fractal.data_legal_holds (id,reference,target_type,target_id,imposed_by_change_request_id,imposed_at) VALUES ($1,$2,$3,$4,$5,$6)`, [randomUUID(), reference("HLDA"), request.target_type, request.target_id, request.id, now]);
      } else {
        await client.query(`UPDATE fractal.data_legal_holds SET released_by_change_request_id=$3,released_at=$4 WHERE target_type=$1 AND target_id=$2 AND released_at IS NULL`, [request.target_type, request.target_id, request.id, now]);
      }
    } else {
      await client.query(`UPDATE fractal.data_legal_hold_change_requests SET status='rejected',reviewed_by_identity_id=$2,decision_reason=$3,reviewed_at=$4 WHERE id=$1`, [request.id, input.actorIdentityId, decisionReason, now]);
    }
    const scopeKey = await targetScope(client, request.target_type, request.target_id);
    const action = input.decision === "approve" ? `data.legal_hold.${request.change_type === "impose" ? "imposed" : "released"}` : "data.legal_hold_change.rejected";
    const audit = await appendPostgresAuditEvent(client, { scopeKey, actorId: input.actorIdentityId, actorType: "user", action, entityType: "data_legal_hold_change_request", entityId: request.id,
      reason: "An independent reviewer decided a legal hold change.", payload: { targetType: request.target_type, targetId: request.target_id, changeType: request.change_type, decision: input.decision } });
    await appendOutboxEvent(client, { aggregateType: "data_legal_hold_change_request", aggregateId: request.id, eventType: action, payload: { targetType: request.target_type, targetId: request.target_id, auditEventId: audit.id } });
    const updated = await client.query<HoldChangeRow>(`${holdChangeSelect} WHERE request.id=$1`, [request.id]);
    return { request: mapHoldChange(updated.rows[0]!), replayed: false };
  });
}

async function attachmentFacts(client: PoolClient, attachmentId: string, lockRow = false) {
  const result = await client.query<{ id: string; case_id: string; requester_identity_id: string; retention_due_at: Date; content_sha256: string; storage_key: string }>(
    `SELECT attachment.id,attachment.case_id,support_case.requester_identity_id,attachment.retention_due_at,attachment.content_sha256,attachment.storage_key
       FROM fractal.support_case_attachments attachment JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
      WHERE attachment.id=$1${lockRow ? " FOR UPDATE OF attachment" : ""}`, [attachmentId]);
  if (!result.rows[0]) throw new SupportEvidenceLifecycleError("Support attachment not found.", "not_found");
  return result.rows[0];
}

export async function resolveSupportEvidenceHoldTarget(input: { actorIdentityId: string; attachmentId: string; scope: SupportEvidenceHoldScope }) {
  return withPostgresTransaction(async (client) => {
    await requireCapability(client, input.actorIdentityId);
    const attachment = await attachmentFacts(client, input.attachmentId);
    if (input.scope === "case") return { targetType: "support_case" as const, targetId: attachment.case_id };
    if (input.scope === "requester_identity") return { targetType: "identity" as const, targetId: attachment.requester_identity_id };
    return { targetType: "support_attachment" as const, targetId: attachment.id };
  });
}

async function assertDispositionEligible(client: PoolClient, attachmentId: string) {
  const attachment = await attachmentFacts(client, attachmentId, true);
  if (attachment.retention_due_at.getTime() > Date.now()) throw new SupportEvidenceLifecycleError("The approved retention period has not elapsed.", "conflict");
  const disposition = await client.query("SELECT 1 FROM fractal.support_attachment_dispositions WHERE attachment_id=$1", [attachmentId]);
  if (disposition.rowCount) throw new SupportEvidenceLifecycleError("This attachment already has a governed disposition.", "conflict");
  const hold = await client.query(`SELECT 1 FROM fractal.data_legal_holds WHERE released_at IS NULL AND (
    (target_type='support_attachment' AND target_id=$1) OR (target_type='support_case' AND target_id=$2) OR (target_type='identity' AND target_id=$3))`, [attachment.id, attachment.case_id, attachment.requester_identity_id]);
  if (hold.rowCount) throw new SupportEvidenceLifecycleError("This attachment is protected by an active legal hold.", "conflict");
  const pendingHold = await client.query(`SELECT 1 FROM fractal.data_legal_hold_change_requests WHERE status='pending' AND change_type='impose' AND (
    (target_type='support_attachment' AND target_id=$1) OR (target_type='support_case' AND target_id=$2) OR (target_type='identity' AND target_id=$3))`,
    [attachment.id, attachment.case_id, attachment.requester_identity_id]);
  if (pendingHold.rowCount) throw new SupportEvidenceLifecycleError("This attachment is protected by a pending legal hold request.", "conflict");
  return attachment;
}

export async function proposeSupportAttachmentDisposition(input: { actorIdentityId: string; attachmentId: string; reason: string; commandKey: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const reason = normalizedText(input.reason, "Disposition reason", 20, 2_000); const key = commandKey(input.commandKey);
    const replay = await client.query<DispositionRequestRow>(`${dispositionRequestSelect} WHERE request.requested_by_identity_id=$1 AND request.command_key=$2`, [input.actorIdentityId, key]);
    if (replay.rows[0]) {
      if (replay.rows[0].attachment_id !== input.attachmentId || replay.rows[0].reason !== reason) throw new SupportEvidenceLifecycleError("This command key was already used for a different disposition request.", "conflict");
      return { request: mapDispositionRequest(replay.rows[0]), replayed: true };
    }
    const attachment = await assertDispositionEligible(client, input.attachmentId); const id = randomUUID();
    await client.query(`INSERT INTO fractal.support_attachment_disposition_requests
      (id,reference,attachment_id,action,reason,command_key,retention_due_at_snapshot,requested_by_identity_id)
      VALUES ($1,$2,$3,'delete_object',$4,$5,$6,$7)`, [id, reference("DSP"), input.attachmentId, reason, key, attachment.retention_due_at, input.actorIdentityId]);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${attachment.case_id}`, actorId: input.actorIdentityId, actorType: "user",
      action: "support.attachment.disposition.proposed", entityType: "support_attachment_disposition_request", entityId: id,
      reason: "Retention-gated support evidence disposition was proposed.", payload: { attachmentId: input.attachmentId, retentionDueAt: attachment.retention_due_at.toISOString(), contentSha256: attachment.content_sha256 } });
    await appendOutboxEvent(client, { aggregateType: "support_attachment_disposition_request", aggregateId: id, eventType: "support.attachment.disposition.proposed", payload: { attachmentId: input.attachmentId, auditEventId: audit.id } });
    const row = await client.query<DispositionRequestRow>(`${dispositionRequestSelect} WHERE request.id=$1`, [id]);
    return { request: mapDispositionRequest(row.rows[0]!), replayed: false };
  });
}

export async function decideSupportAttachmentDisposition(input: { actorIdentityId: string; requestId: string; decision: "approve" | "reject"; decisionReason: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const result = await client.query<DispositionRequestRow>(`${dispositionRequestSelect} WHERE request.id=$1 FOR UPDATE OF request`, [input.requestId]);
    const request = result.rows[0]; if (!request) throw new SupportEvidenceLifecycleError("Support attachment disposition request not found.", "not_found");
    const desired = input.decision === "approve" ? "applied" : "rejected";
    if (request.status !== "pending") {
      if (request.status === desired) return { request: mapDispositionRequest(request), replayed: true };
      throw new SupportEvidenceLifecycleError("This disposition request already has a different terminal decision.", "conflict");
    }
    if (request.requested_by_identity_id === input.actorIdentityId) throw new SupportEvidenceLifecycleError("The proposer cannot decide the same disposition request.", "forbidden");
    const decisionReason = normalizedText(input.decisionReason, "Decision reason", 20, 2_000); const now = new Date();
    let attachment = await attachmentFacts(client, request.attachment_id, true);
    if (input.decision === "approve") {
      attachment = await assertDispositionEligible(client, request.attachment_id);
      if (attachment.retention_due_at.getTime() !== request.retention_due_at_snapshot.getTime()) throw new SupportEvidenceLifecycleError("The attachment retention deadline no longer matches the proposed disposition.", "conflict");
      await client.query(`UPDATE fractal.support_attachment_disposition_requests SET status='applied',reviewed_by_identity_id=$2,decision_reason=$3,reviewed_at=$4,applied_at=$4 WHERE id=$1`, [request.id, input.actorIdentityId, decisionReason, now]);
      const dispositionId = randomUUID();
      await client.query(`INSERT INTO fractal.support_attachment_dispositions (id,attachment_id,disposition_request_id,content_sha256,status,approved_at)
        VALUES ($1,$2,$3,$4,'cleanup_requested',$5)`, [dispositionId, request.attachment_id, request.id, attachment.content_sha256, now]);
      await client.query(`INSERT INTO fractal.storage_cleanup_tasks
        (id,storage_key,source,metadata_error,purpose,governed_disposition_id) VALUES ($1,$2,'support-attachment-disposition',$3,'governed_disposition',$4)`,
        [randomUUID(), attachment.storage_key, `Governed disposition ${request.reference} approved.`, dispositionId]);
    } else {
      await client.query(`UPDATE fractal.support_attachment_disposition_requests SET status='rejected',reviewed_by_identity_id=$2,decision_reason=$3,reviewed_at=$4 WHERE id=$1`, [request.id, input.actorIdentityId, decisionReason, now]);
    }
    const action = input.decision === "approve" ? "support.attachment.disposition.approved" : "support.attachment.disposition.rejected";
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${attachment.case_id}`, actorId: input.actorIdentityId, actorType: "user", action,
      entityType: "support_attachment_disposition_request", entityId: request.id, reason: "An independent reviewer decided a retention-gated support evidence disposition.",
      payload: { attachmentId: request.attachment_id, decision: input.decision, contentSha256: attachment.content_sha256 } });
    await appendOutboxEvent(client, { aggregateType: "support_attachment_disposition_request", aggregateId: request.id, eventType: action, payload: { attachmentId: request.attachment_id, auditEventId: audit.id } });
    const updated = await client.query<DispositionRequestRow>(`${dispositionRequestSelect} WHERE request.id=$1`, [request.id]);
    return { request: mapDispositionRequest(updated.rows[0]!), replayed: false };
  });
}

export async function readSupportAttachmentLifecycle(input: { actorIdentityId: string; attachmentId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireCapability(client, input.actorIdentityId); const attachment = await attachmentFacts(client, input.attachmentId);
    const holds = await client.query<HoldRow>(`SELECT hold_record.*,request.reason_category,request.reason,request.requested_by_identity_id AS imposed_by_identity_id,identity.legal_name AS imposed_by_legal_name
      FROM fractal.data_legal_holds hold_record JOIN fractal.data_legal_hold_change_requests request ON request.id=hold_record.imposed_by_change_request_id
      JOIN fractal.identities identity ON identity.id=request.requested_by_identity_id WHERE hold_record.released_at IS NULL AND (
        (hold_record.target_type='support_attachment' AND hold_record.target_id=$1) OR (hold_record.target_type='support_case' AND hold_record.target_id=$2)
        OR (hold_record.target_type='identity' AND hold_record.target_id=$3)) ORDER BY hold_record.imposed_at,hold_record.id`, [attachment.id, attachment.case_id, attachment.requester_identity_id]);
    const pendingHolds = await client.query<HoldChangeRow>(`${holdChangeSelect} WHERE request.status='pending' AND (
      (request.target_type='support_attachment' AND request.target_id=$1) OR (request.target_type='support_case' AND request.target_id=$2)
      OR (request.target_type='identity' AND request.target_id=$3)) ORDER BY request.requested_at,request.id`, [attachment.id, attachment.case_id, attachment.requester_identity_id]);
    const pendingDisposition = await client.query<DispositionRequestRow>(`${dispositionRequestSelect} WHERE request.attachment_id=$1 AND request.status='pending'`, [attachment.id]);
    const disposition = await client.query<DispositionRow>("SELECT id,status,approved_at,completed_at,failed_at FROM fractal.support_attachment_dispositions WHERE attachment_id=$1", [attachment.id]);
    return { attachmentId: attachment.id, retentionDueAt: attachment.retention_due_at.toISOString(), retentionElapsed: attachment.retention_due_at.getTime() <= Date.now(),
      activeHolds: holds.rows.map(mapHold), pendingHoldChanges: pendingHolds.rows.map(mapHoldChange), pendingDispositionRequest: pendingDisposition.rows[0] ? mapDispositionRequest(pendingDisposition.rows[0]) : null,
      disposition: disposition.rows[0] ? { id: disposition.rows[0].id, status: disposition.rows[0].status, approvedAt: disposition.rows[0].approved_at.toISOString(), completedAt: disposition.rows[0].completed_at?.toISOString() ?? null, failedAt: disposition.rows[0].failed_at?.toISOString() ?? null } : null };
  });
}

export async function isSupportAttachmentUnavailable(client: PoolClient, attachmentId: string) {
  const result = await client.query("SELECT 1 FROM fractal.support_attachment_dispositions WHERE attachment_id=$1", [attachmentId]);
  return Boolean(result.rowCount);
}
