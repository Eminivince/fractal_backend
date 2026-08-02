import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { AdministratorCapabilityError, requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { lockDataLifecycleAuthority } from "./postgres-data-lifecycle-lock.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class OrganizationDocumentLifecycleError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input") {
    super(message);
    this.name = "OrganizationDocumentLifecycleError";
  }
}

type RequestRow = {
  id: string; reference: string; document_id: string; organization_id: string; reason: string;
  retain_until_snapshot: Date; retention_policy_version_id_snapshot: string; version_count_snapshot: number;
  status: "pending" | "applied" | "rejected"; requested_by_identity_id: string; requested_by_legal_name: string;
  reviewed_by_identity_id: string | null; reviewed_by_legal_name: string | null; decision_reason: string | null;
  requested_at: Date; reviewed_at: Date | null; applied_at: Date | null;
};

const requestSelect = `SELECT request.*,requester.legal_name AS requested_by_legal_name,reviewer.legal_name AS reviewed_by_legal_name
  FROM fractal.organization_document_disposition_requests request
  JOIN fractal.identities requester ON requester.id=request.requested_by_identity_id
  LEFT JOIN fractal.identities reviewer ON reviewer.id=request.reviewed_by_identity_id`;

function text(value: string, label: string, minimum: number, maximum: number) {
  const normalized=value.trim();
  if(normalized.length<minimum||normalized.length>maximum) throw new OrganizationDocumentLifecycleError(`${label} must contain ${minimum} to ${maximum} characters.`,"invalid_input");
  return normalized;
}
function reference() { return `ODSP-${new Date().toISOString().slice(0,10).replaceAll("-","")}-${randomUUID().replaceAll("-","").slice(0,8).toUpperCase()}`; }
const lock = lockDataLifecycleAuthority;
async function capability(client:PoolClient,identityId:string){
  try{await requireAdministratorCapability(client,identityId,"data_lifecycle_manage");}
  catch(error){if(error instanceof AdministratorCapabilityError)throw new OrganizationDocumentLifecycleError("Data lifecycle management capability is required.","forbidden");throw error;}
}
function mapRequest(row:RequestRow){return{id:row.id,reference:row.reference,documentId:row.document_id,organizationId:row.organization_id,action:"delete_all_version_objects" as const,reason:row.reason,retainUntil:row.retain_until_snapshot.toISOString(),retentionPolicyVersionId:row.retention_policy_version_id_snapshot,versionCount:row.version_count_snapshot,status:row.status,requestedBy:{id:row.requested_by_identity_id,legalName:row.requested_by_legal_name},reviewedBy:row.reviewed_by_identity_id&&row.reviewed_by_legal_name?{id:row.reviewed_by_identity_id,legalName:row.reviewed_by_legal_name}:null,decisionReason:row.decision_reason,requestedAt:row.requested_at.toISOString(),reviewedAt:row.reviewed_at?.toISOString()??null,appliedAt:row.applied_at?.toISOString()??null};}

async function documentFacts(client:PoolClient,documentId:string,lockRow=false){
  const result=await client.query<{id:string;organization_id:string;title:string;status:string;retention_binding_status:string;retain_until:Date;retention_policy_version_id:string|null;version_count:number}>(`SELECT document.id,document.organization_id,document.title,document.status,document.retention_binding_status,document.retain_until,document.retention_policy_version_id,(SELECT count(*)::integer FROM fractal.organization_document_versions version WHERE version.document_id=document.id) AS version_count FROM fractal.organization_documents document WHERE document.id=$1${lockRow?" FOR UPDATE OF document":""}`,[documentId]);
  if(!result.rows[0])throw new OrganizationDocumentLifecycleError("Organization document not found.","not_found");
  return result.rows[0];
}

async function eligible(client:PoolClient,documentId:string){
  const document=await documentFacts(client,documentId,true);
  if(document.status!=="archived")throw new OrganizationDocumentLifecycleError("The document must be archived before disposition can be proposed.","conflict");
  if(document.retention_binding_status!=="governed"||!document.retention_policy_version_id)throw new OrganizationDocumentLifecycleError("Legacy-declared documents are not eligible for governed disposition.","conflict");
  if(document.retain_until.getTime()>Date.now())throw new OrganizationDocumentLifecycleError("The approved retention period has not elapsed.","conflict");
  if((await client.query("SELECT 1 FROM fractal.organization_document_dispositions WHERE document_id=$1",[documentId])).rowCount)throw new OrganizationDocumentLifecycleError("This document already has a governed disposition.","conflict");
  if((await client.query(`SELECT 1 FROM fractal.data_legal_holds WHERE released_at IS NULL AND ((target_type='organization_document' AND target_id=$1) OR (target_type='organization' AND target_id=$2))`,[document.id,document.organization_id])).rowCount)throw new OrganizationDocumentLifecycleError("This document is protected by an active legal hold.","conflict");
  if((await client.query(`SELECT 1 FROM fractal.data_legal_hold_change_requests WHERE status='pending' AND change_type='impose' AND ((target_type='organization_document' AND target_id=$1) OR (target_type='organization' AND target_id=$2))`,[document.id,document.organization_id])).rowCount)throw new OrganizationDocumentLifecycleError("This document is protected by a pending legal hold request.","conflict");
  return document;
}

export async function proposeOrganizationDocumentDisposition(input:{actorIdentityId:string;documentId:string;reason:string;commandKey:string}){
  return withPostgresTransaction(async(client)=>{
    await lock(client);await capability(client,input.actorIdentityId);const reason=text(input.reason,"Disposition reason",20,2000);const commandKey=text(input.commandKey,"Command key",1,200);
    const replay=await client.query<RequestRow>(`${requestSelect} WHERE request.requested_by_identity_id=$1 AND request.command_key=$2`,[input.actorIdentityId,commandKey]);
    if(replay.rows[0]){if(replay.rows[0].document_id!==input.documentId||replay.rows[0].reason!==reason)throw new OrganizationDocumentLifecycleError("This command key was already used for a different disposition request.","conflict");return{request:mapRequest(replay.rows[0]),replayed:true};}
    const document=await eligible(client,input.documentId);const id=randomUUID();
    await client.query(`INSERT INTO fractal.organization_document_disposition_requests(id,reference,document_id,organization_id,action,reason,command_key,retain_until_snapshot,retention_policy_version_id_snapshot,version_count_snapshot,requested_by_identity_id) VALUES($1,$2,$3,$4,'delete_all_version_objects',$5,$6,$7,$8,$9,$10)`,[id,reference(),document.id,document.organization_id,reason,commandKey,document.retain_until,document.retention_policy_version_id,document.version_count,input.actorIdentityId]);
    const audit=await appendPostgresAuditEvent(client,{scopeKey:`organization:${document.organization_id}`,organizationId:document.organization_id,actorId:input.actorIdentityId,actorType:"user",action:"organization.document.disposition.proposed",entityType:"organization_document_disposition_request",entityId:id,reason:"Retention-gated organization document disposition was proposed.",payload:{documentId:document.id,versionCount:document.version_count,retainUntil:document.retain_until.toISOString()}});
    await appendOutboxEvent(client,{aggregateType:"organization_document_disposition_request",aggregateId:id,eventType:"organization.document.disposition.proposed",payload:{documentId:document.id,organizationId:document.organization_id,auditEventId:audit.id}});
    const row=await client.query<RequestRow>(`${requestSelect} WHERE request.id=$1`,[id]);return{request:mapRequest(row.rows[0]!),replayed:false};
  });
}

export async function decideOrganizationDocumentDisposition(input:{actorIdentityId:string;requestId:string;decision:"approve"|"reject";decisionReason:string}){
  return withPostgresTransaction(async(client)=>{
    await lock(client);await capability(client,input.actorIdentityId);const result=await client.query<RequestRow>(`${requestSelect} WHERE request.id=$1 FOR UPDATE OF request`,[input.requestId]);const request=result.rows[0];
    if(!request)throw new OrganizationDocumentLifecycleError("Organization document disposition request not found.","not_found");const desired=input.decision==="approve"?"applied":"rejected";
    if(request.status!=="pending"){if(request.status===desired)return{request:mapRequest(request),replayed:true};throw new OrganizationDocumentLifecycleError("This disposition request already has a different terminal decision.","conflict");}
    if(request.requested_by_identity_id===input.actorIdentityId)throw new OrganizationDocumentLifecycleError("The proposer cannot decide the same disposition request.","forbidden");
    const decisionReason=text(input.decisionReason,"Decision reason",20,2000);const now=new Date();let document=await documentFacts(client,request.document_id,true);
    if(input.decision==="approve"){
      document=await eligible(client,request.document_id);
      if(document.retain_until.getTime()!==request.retain_until_snapshot.getTime()||document.retention_policy_version_id!==request.retention_policy_version_id_snapshot||document.version_count!==request.version_count_snapshot)throw new OrganizationDocumentLifecycleError("The document retention or version evidence changed after this disposition was proposed.","conflict");
      await client.query("UPDATE fractal.organization_document_disposition_requests SET status='applied',reviewed_by_identity_id=$2,decision_reason=$3,reviewed_at=$4,applied_at=$4 WHERE id=$1",[request.id,input.actorIdentityId,decisionReason,now]);
      const dispositionId=randomUUID();await client.query(`INSERT INTO fractal.organization_document_dispositions(id,document_id,organization_id,disposition_request_id,expected_version_count,status,approved_at) VALUES($1,$2,$3,$4,$5,'cleanup_requested',$6)`,[dispositionId,document.id,document.organization_id,request.id,document.version_count,now]);
      await client.query(`INSERT INTO fractal.storage_cleanup_tasks(id,storage_key,source,metadata_error,purpose,organization_document_disposition_id,organization_document_version_id)
        SELECT gen_random_uuid(),version.storage_key,'organization-document-disposition',$2,'organization_document_disposition',$3,version.id FROM fractal.organization_document_versions version WHERE version.document_id=$1`,[document.id,`Governed disposition ${request.reference} approved.`,dispositionId]);
    }else await client.query("UPDATE fractal.organization_document_disposition_requests SET status='rejected',reviewed_by_identity_id=$2,decision_reason=$3,reviewed_at=$4 WHERE id=$1",[request.id,input.actorIdentityId,decisionReason,now]);
    const action=input.decision==="approve"?"organization.document.disposition.approved":"organization.document.disposition.rejected";const audit=await appendPostgresAuditEvent(client,{scopeKey:`organization:${document.organization_id}`,organizationId:document.organization_id,actorId:input.actorIdentityId,actorType:"user",action,entityType:"organization_document_disposition_request",entityId:request.id,reason:"An independent reviewer decided a retention-gated organization document disposition.",payload:{documentId:document.id,decision:input.decision,versionCount:document.version_count}});
    await appendOutboxEvent(client,{aggregateType:"organization_document_disposition_request",aggregateId:request.id,eventType:action,payload:{documentId:document.id,organizationId:document.organization_id,auditEventId:audit.id}});const updated=await client.query<RequestRow>(`${requestSelect} WHERE request.id=$1`,[request.id]);return{request:mapRequest(updated.rows[0]!),replayed:false};
  });
}

export async function readOrganizationDocumentLifecycle(input:{actorIdentityId:string;documentId:string}){
  return withPostgresTransaction(async(client)=>{
    await capability(client,input.actorIdentityId);const document=await documentFacts(client,input.documentId);
    const holds=await client.query<{id:string;reference:string;target_type:"organization"|"organization_document";target_id:string;reason_category:string;reason:string;imposed_at:Date;imposed_by_identity_id:string;legal_name:string}>(`SELECT hold.id,hold.reference,hold.target_type,hold.target_id,request.reason_category,request.reason,hold.imposed_at,request.requested_by_identity_id AS imposed_by_identity_id,identity.legal_name FROM fractal.data_legal_holds hold JOIN fractal.data_legal_hold_change_requests request ON request.id=hold.imposed_by_change_request_id JOIN fractal.identities identity ON identity.id=request.requested_by_identity_id WHERE hold.released_at IS NULL AND ((hold.target_type='organization_document' AND hold.target_id=$1) OR (hold.target_type='organization' AND hold.target_id=$2)) ORDER BY hold.imposed_at,hold.id`,[document.id,document.organization_id]);
    const pendingHolds=await client.query<{id:string;reference:string;target_type:string;target_id:string;change_type:string;reason_category:string;reason:string;status:string;requested_at:Date;requested_by_identity_id:string;legal_name:string}>(`SELECT request.id,request.reference,request.target_type,request.target_id,request.change_type,request.reason_category,request.reason,request.status,request.requested_at,request.requested_by_identity_id,identity.legal_name FROM fractal.data_legal_hold_change_requests request JOIN fractal.identities identity ON identity.id=request.requested_by_identity_id WHERE request.status='pending' AND ((request.target_type='organization_document' AND request.target_id=$1) OR (request.target_type='organization' AND request.target_id=$2)) ORDER BY request.requested_at,request.id`,[document.id,document.organization_id]);
    const pendingDisposition=await client.query<RequestRow>(`${requestSelect} WHERE request.document_id=$1 AND request.status='pending'`,[document.id]);
    const disposition=await client.query<{id:string;status:string;approved_at:Date;completed_at:Date|null;failed_at:Date|null}>("SELECT id,status,approved_at,completed_at,failed_at FROM fractal.organization_document_dispositions WHERE document_id=$1",[document.id]);
    return{documentId:document.id,organizationId:document.organization_id,title:document.title,status:document.status,retentionBindingStatus:document.retention_binding_status,retainUntil:document.retain_until.toISOString(),retentionElapsed:document.retain_until.getTime()<=Date.now(),versionCount:document.version_count,activeHolds:holds.rows.map(row=>({id:row.id,reference:row.reference,targetType:row.target_type,targetId:row.target_id,reasonCategory:row.reason_category,reason:row.reason,imposedAt:row.imposed_at.toISOString(),imposedBy:{id:row.imposed_by_identity_id,legalName:row.legal_name}})),pendingHoldChanges:pendingHolds.rows.map(row=>({id:row.id,reference:row.reference,targetType:row.target_type,targetId:row.target_id,changeType:row.change_type,reasonCategory:row.reason_category,reason:row.reason,status:row.status,requestedAt:row.requested_at.toISOString(),requestedBy:{id:row.requested_by_identity_id,legalName:row.legal_name}})),pendingDispositionRequest:pendingDisposition.rows[0]?mapRequest(pendingDisposition.rows[0]):null,disposition:disposition.rows[0]?{id:disposition.rows[0].id,status:disposition.rows[0].status,approvedAt:disposition.rows[0].approved_at.toISOString(),completedAt:disposition.rows[0].completed_at?.toISOString()??null,failedAt:disposition.rows[0].failed_at?.toISOString()??null}:null};
  });
}

export async function listOrganizationDocumentsForLifecycle(input:{actorIdentityId:string;status?:"active"|"archived";limit:number}){
  return withPostgresTransaction(async(client)=>{await capability(client,input.actorIdentityId);const result=await client.query<{id:string;organization_id:string;title:string;status:string;retention_binding_status:string;retain_until:Date;version_count:number;disposition_status:string|null}>(`SELECT document.id,document.organization_id,document.title,document.status,document.retention_binding_status,document.retain_until,count(version.id)::integer AS version_count,disposition.status AS disposition_status FROM fractal.organization_documents document JOIN fractal.organization_document_versions version ON version.document_id=document.id LEFT JOIN fractal.organization_document_dispositions disposition ON disposition.document_id=document.id WHERE ($1::text IS NULL OR document.status=$1) GROUP BY document.id,disposition.status ORDER BY document.retain_until,document.id LIMIT $2`,[input.status??null,input.limit]);return{documents:result.rows.map(row=>({id:row.id,organizationId:row.organization_id,title:row.title,status:row.status,retentionBindingStatus:row.retention_binding_status,retainUntil:row.retain_until.toISOString(),retentionElapsed:row.retain_until.getTime()<=Date.now(),versionCount:row.version_count,dispositionStatus:row.disposition_status}))};});
}
