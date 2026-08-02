import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { AdministratorCapabilityError, requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import type { DistributionLifecycleTargetType } from "./postgres-distribution-lifecycle.js";

const capability = "privacy_request_manage";
const lockKey = 5_014_907_332;
export type DistributionPrivacyTreatmentType = "correction" | "erasure" | "restriction" | "objection";

export class DistributionPrivacyTreatmentError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input") {
    super(message);
    this.name = "DistributionPrivacyTreatmentError";
  }
}

type TreatmentRow = {
  id: string; reference: string; privacy_request_id: string; privacy_decision_request_id: string;
  requester_identity_id: string; organization_id: string; target_type: DistributionLifecycleTargetType;
  treatment_type: DistributionPrivacyTreatmentType; policy_treatment_mode: string; decision_scope_category: string;
  decision_scope_action: string; treatment_statement: string; status: "pending" | "approved" | "rejected";
  proposed_by_identity_id: string; proposer_name: string; reviewed_by_identity_id: string | null; reviewer_name: string | null;
  review_reason: string | null; requester_visible_summary: string | null; proposed_at: Date; reviewed_at: Date | null;
  execution_id: string | null; execution_result: string | null; lawful_basis: string | null; policy_reference: string;
  retain_until: Date; legal_hold_active: boolean | null; executed_at: Date | null;
};

const treatmentSelect = `SELECT treatment.*,proposer.legal_name AS proposer_name,reviewer.legal_name AS reviewer_name,
  execution.id AS execution_id,execution.execution_result,execution.lawful_basis,execution.legal_hold_active,execution.executed_at,
  binding.policy_reference,binding.retain_until
  FROM fractal.distribution_privacy_treatment_requests treatment
  JOIN fractal.identities proposer ON proposer.id=treatment.proposed_by_identity_id
  LEFT JOIN fractal.identities reviewer ON reviewer.id=treatment.reviewed_by_identity_id
  LEFT JOIN fractal.distribution_privacy_treatment_executions execution ON execution.treatment_request_id=treatment.id
  JOIN fractal.distribution_lifecycle_policy_bindings binding ON binding.id=treatment.lifecycle_binding_id`;

function normalized(value: string, label: string, minimum: number, maximum: number) {
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) throw new DistributionPrivacyTreatmentError(`${label} must contain ${minimum} to ${maximum} characters.`, "invalid_input");
  return result;
}

async function requireCapability(client: PoolClient, identityId: string) {
  try { await requireAdministratorCapability(client, identityId, capability); }
  catch (error) {
    if (error instanceof AdministratorCapabilityError) throw new DistributionPrivacyTreatmentError("Privacy rights management capability is required.", "forbidden");
    throw error;
  }
}

function mapTreatment(row: TreatmentRow, staff = true) {
  return {
    id: row.id, reference: row.reference, privacyRequestId: row.privacy_request_id,
    privacyDecisionRequestId: row.privacy_decision_request_id, targetType: row.target_type,
    treatmentType: row.treatment_type, policyTreatmentMode: row.policy_treatment_mode,
    decisionScopeCategory: row.decision_scope_category, decisionScopeAction: row.decision_scope_action,
    treatmentStatement: staff ? row.treatment_statement : row.requester_visible_summary!, status: row.status, policyReference: row.policy_reference,
    retainUntil: row.retain_until.toISOString(), proposedBy: { id: row.proposed_by_identity_id, legalName: row.proposer_name },
    reviewedBy: row.reviewed_by_identity_id && row.reviewer_name ? { id: row.reviewed_by_identity_id, legalName: row.reviewer_name } : null,
    reviewReason: staff ? row.review_reason : null, requesterVisibleSummary: row.requester_visible_summary,
    proposedAt: row.proposed_at.toISOString(), reviewedAt: row.reviewed_at?.toISOString() ?? null,
    execution: row.execution_id ? {
      id: row.execution_id, result: row.execution_result!, lawfulBasis: row.lawful_basis!, legalHoldActive: row.legal_hold_active!,
      executedAt: row.executed_at!.toISOString(),
    } : null,
  };
}

export async function listDistributionPrivacyTreatments(client: PoolClient, privacyRequestId: string, staff: boolean) {
  const result = await client.query<TreatmentRow>(`${treatmentSelect} WHERE treatment.privacy_request_id=$1${staff ? "" : " AND treatment.status='approved'"} ORDER BY treatment.proposed_at,treatment.id`, [privacyRequestId]);
  return result.rows.map((row) => mapTreatment(row, staff));
}

function reference() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `DPT-${date}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

async function emit(client: PoolClient, input: { requestId: string; organizationId: string; actorId: string; action: string; treatmentId: string; payload: Record<string, unknown> }) {
  const privacyAudit = await appendPostgresAuditEvent(client, { scopeKey: `privacy-request:${input.requestId}`, actorId: input.actorId, actorType: "user", action: input.action,
    entityType: "distribution_privacy_treatment", entityId: input.treatmentId, reason: "A governed distribution privacy treatment changed state.", payload: input.payload });
  await appendPostgresAuditEvent(client, { scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.actorId, actorType: "user", action: input.action,
    entityType: "distribution_privacy_treatment", entityId: input.treatmentId, reason: "A governed distribution privacy treatment changed state.", payload: { ...input.payload, privacyAuditEventId: privacyAudit.id } });
  await appendOutboxEvent(client, { aggregateType: "distribution_privacy_treatment", aggregateId: input.treatmentId, eventType: input.action, payload: { ...input.payload, privacyRequestId: input.requestId, auditEventId: privacyAudit.id } });
}

export async function proposeDistributionPrivacyTreatment(input: {
  actorIdentityId: string; privacyRequestId: string; targetType: DistributionLifecycleTargetType; targetId: string;
  decisionScopeCategory: string; treatmentStatement: string; commandKey: string;
}) {
  return withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]); await requireCapability(client, input.actorIdentityId);
    const scopeCategory = normalized(input.decisionScopeCategory, "Decision scope category", 2, 120);
    const statement = normalized(input.treatmentStatement, "Treatment statement", 20, 2_000);
    const commandKey = normalized(input.commandKey, "Command key", 1, 200);
    const replay = await client.query<TreatmentRow>(`${treatmentSelect} WHERE treatment.proposed_by_identity_id=$1 AND treatment.command_key=$2`, [input.actorIdentityId, commandKey]);
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.privacy_request_id!==input.privacyRequestId || row.target_type!==input.targetType || row.decision_scope_category!==scopeCategory || row.treatment_statement!==statement)
        throw new DistributionPrivacyTreatmentError("This command key was already used for a different treatment proposal.", "conflict");
      return { treatment: mapTreatment(row), replayed: true };
    }
    const authority = await client.query<{
      requester_identity_id: string; request_type: DistributionPrivacyTreatmentType; decision_id: string; decision_action: string;
      lifecycle_binding_id: string; organization_id: string; policy_treatment_mode: string;
    }>(`SELECT request.requester_identity_id,request.request_type,decision.id AS decision_id,scope.item->>'action' AS decision_action,
              binding.id AS lifecycle_binding_id,binding.organization_id,
              CASE request.request_type WHEN 'correction' THEN binding.correction_treatment WHEN 'erasure' THEN binding.erasure_treatment
                WHEN 'restriction' THEN binding.restriction_treatment WHEN 'objection' THEN binding.objection_treatment END AS policy_treatment_mode
         FROM fractal.privacy_rights_requests request
         JOIN LATERAL (SELECT * FROM fractal.privacy_rights_decision_requests item
           WHERE item.privacy_request_id=request.id AND item.status='applied' AND item.requested_by_identity_id=$5 ORDER BY item.applied_at DESC,item.id DESC LIMIT 1) decision ON true
         JOIN LATERAL jsonb_array_elements(decision.scope_outcomes) scope(item) ON lower(scope.item->>'category')=lower($4)
         JOIN fractal.distribution_lifecycle_policy_bindings binding ON binding.target_type=$2 AND binding.target_id=$3
        WHERE request.id=$1 AND request.request_type IN('correction','erasure','restriction','objection')`,
      [input.privacyRequestId,input.targetType,input.targetId,scopeCategory,input.actorIdentityId]);
    const row=authority.rows[0];
    if(!row) throw new DistributionPrivacyTreatmentError("No exact applied privacy decision and governed subject-involving distribution target match this proposal.","conflict");
    const id=randomUUID();
    await client.query(`INSERT INTO fractal.distribution_privacy_treatment_requests(
      id,reference,privacy_request_id,privacy_decision_request_id,lifecycle_binding_id,requester_identity_id,organization_id,target_type,target_id,
      treatment_type,policy_treatment_mode,decision_scope_category,decision_scope_action,treatment_statement,command_key,proposed_by_identity_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [id,reference(),input.privacyRequestId,row.decision_id,row.lifecycle_binding_id,row.requester_identity_id,row.organization_id,input.targetType,input.targetId,
      row.request_type,row.policy_treatment_mode,scopeCategory,row.decision_action,statement,commandKey,input.actorIdentityId]);
    await emit(client,{requestId:input.privacyRequestId,organizationId:row.organization_id,actorId:input.actorIdentityId,action:"privacy.distribution_treatment.proposed",treatmentId:id,
      payload:{targetType:input.targetType,treatmentType:row.request_type,decisionRequestId:row.decision_id,policyTreatmentMode:row.policy_treatment_mode}});
    const created=await client.query<TreatmentRow>(`${treatmentSelect} WHERE treatment.id=$1`,[id]);
    return {treatment:mapTreatment(created.rows[0]!),replayed:false};
  });
}

export async function decideDistributionPrivacyTreatment(input:{actorIdentityId:string;treatmentRequestId:string;decision:"approve"|"reject";reviewReason:string;requesterVisibleSummary:string}){
  return withPostgresTransaction(async(client)=>{
    await client.query("SELECT pg_advisory_xact_lock($1)",[lockKey]);await requireCapability(client,input.actorIdentityId);
    const reason=normalized(input.reviewReason,"Review reason",20,2000);const summary=normalized(input.requesterVisibleSummary,"Requester-visible summary",20,2000);
    const current=await client.query<TreatmentRow>(`${treatmentSelect} WHERE treatment.id=$1 FOR UPDATE OF treatment`,[input.treatmentRequestId]);const row=current.rows[0];
    if(!row)throw new DistributionPrivacyTreatmentError("Distribution privacy treatment request not found.","not_found");
    const desired=input.decision==="approve"?"approved":"rejected";
    if(row.status!=="pending"){
      if(row.status===desired&&row.reviewed_by_identity_id===input.actorIdentityId&&row.review_reason===reason&&row.requester_visible_summary===summary)return{treatment:mapTreatment(row),replayed:true};
      throw new DistributionPrivacyTreatmentError("This treatment request already has a different terminal outcome.","conflict");
    }
    if(row.proposed_by_identity_id===input.actorIdentityId)throw new DistributionPrivacyTreatmentError("The treatment proposer cannot review the same request.","forbidden");
    const now=new Date();
    await client.query("UPDATE fractal.distribution_privacy_treatment_requests SET status=$2,reviewed_by_identity_id=$3,review_reason=$4,requester_visible_summary=$5,reviewed_at=$6 WHERE id=$1",
      [row.id,desired,input.actorIdentityId,reason,summary,now]);
    if(input.decision==="approve"){
      const executionResult=row.treatment_type==="correction"?"append_only_correction_recorded":row.treatment_type==="erasure"?"lawful_retention_confirmed":row.treatment_type==="restriction"?"mandatory_processing_restriction_applied":"objection_lawful_basis_review_recorded";
      await client.query(`INSERT INTO fractal.distribution_privacy_treatment_executions(id,treatment_request_id,execution_result,lawful_basis,policy_version_id,policy_value_sha256,policy_reference,retain_until,legal_hold_active,executed_by_identity_id,executed_at)
        SELECT $1,treatment.id,$2,decision.lawful_basis,binding.policy_version_id,binding.policy_value_sha256,binding.policy_reference,binding.retain_until,
          EXISTS(SELECT 1 FROM fractal.data_legal_holds hold_record WHERE hold_record.target_type=treatment.target_type AND hold_record.target_id=treatment.target_id AND hold_record.released_at IS NULL),$3,$4
        FROM fractal.distribution_privacy_treatment_requests treatment JOIN fractal.privacy_rights_decision_requests decision ON decision.id=treatment.privacy_decision_request_id
        JOIN fractal.distribution_lifecycle_policy_bindings binding ON binding.id=treatment.lifecycle_binding_id WHERE treatment.id=$5`,[randomUUID(),executionResult,input.actorIdentityId,now,row.id]);
    }
    await emit(client,{requestId:row.privacy_request_id,organizationId:row.organization_id,actorId:input.actorIdentityId,action:`privacy.distribution_treatment.${desired}`,treatmentId:row.id,
      payload:{targetType:row.target_type,treatmentType:row.treatment_type,decision:input.decision,executionRecorded:input.decision==="approve"}});
    const updated=await client.query<TreatmentRow>(`${treatmentSelect} WHERE treatment.id=$1`,[row.id]);return{treatment:mapTreatment(updated.rows[0]!),replayed:false};
  });
}
