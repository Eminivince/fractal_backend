import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import {
  organizationDocumentCategories,
  organizationDocumentRetentionBases,
  parseOrganizationDocumentRetentionPolicy,
  type OrganizationDocumentCategory,
  type OrganizationDocumentRetentionBasis,
} from "../modules/offerings/domain/organization-document-retention-policy.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { lockDataLifecycleAuthority } from "./postgres-data-lifecycle-lock.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";

export { organizationDocumentCategories, organizationDocumentRetentionBases };
export type { OrganizationDocumentCategory, OrganizationDocumentRetentionBasis };

export class OrganizationDocumentError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "invalid_input" | "invalid_state" | "policy_unavailable",
  ) {
    super(message);
    this.name = "OrganizationDocumentError";
  }
}

type DocumentVersionRow = {
  document_id: string; organization_id: string; title: string; category: OrganizationDocumentCategory; reference: string | null;
  status: "active" | "archived"; current_version_number: number; retention_basis: OrganizationDocumentRetentionBasis;
  retain_until: Date; document_created_at: Date; archived_at: Date | null; archive_reason: string | null;
  retention_binding_status: "legacy_declared" | "governed"; retention_policy_version_id: string | null;
  retention_policy_version_number: number | null; retention_policy_reference: string | null; retention_policy_name: string | null;
  retention_policy_schema_version: string | null; retention_policy_jurisdiction_code: string | null;
  retention_policy_legal_basis_reference: string | null; retention_days: number | null;
  disposition_status: "cleanup_requested" | "completed" | "failed" | null;
  version_id: string; version_number: number; filename: string; mime_type: string; storage_key: string;
  content_sha256: string; bytes: string; version_retain_until: Date; version_created_at: Date; download_count: string; last_downloaded_at: Date | null;
};

function clean(value: string, field: string, min: number, max: number) {
  const result = value.trim();
  if (result.length < min || result.length > max) throw new OrganizationDocumentError(`${field} must contain ${min} to ${max} characters`, "invalid_input");
  return result;
}
function sha(value: string) {
  const result = value.trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(result)) throw new OrganizationDocumentError("contentSha256 must be a SHA-256 hash", "invalid_input");
  return result;
}
function byteCount(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 15 * 1024 * 1024) throw new OrganizationDocumentError("bytes must be a positive safe integer no greater than 15MB", "invalid_input");
  return value;
}

async function event(client: PoolClient, input: { documentId: string; type: "created" | "version_added" | "archived"; fromStatus: string | null; toStatus: "active" | "archived"; versionId?: string; actorId: string; reason: string }) {
  await client.query(
    `INSERT INTO fractal.organization_document_events
      (id,document_id,sequence,event_type,from_status,to_status,document_version_id,actor_identity_id,reason)
     SELECT $1,$2,COALESCE(max(sequence),0)+1,$3,$4,$5,$6,$7,$8
       FROM fractal.organization_document_events WHERE document_id=$2`,
    [randomUUID(), input.documentId, input.type, input.fromStatus, input.toStatus, input.versionId ?? null, input.actorId, input.reason],
  );
}

async function retentionAuthority(client: PoolClient, organizationId: string, category?: OrganizationDocumentCategory, basis?: OrganizationDocumentRetentionBasis) {
  const organization = await client.query<{ jurisdiction_code: string | null }>("SELECT jurisdiction_code FROM fractal.organizations WHERE id=$1", [organizationId]);
  if (!organization.rows[0]) throw new OrganizationDocumentError("Organization not found", "not_found");
  const jurisdictionCode = organization.rows[0].jurisdiction_code;
  if (!jurisdictionCode) throw new OrganizationDocumentError("Document creation is unavailable until the organization has an approved jurisdiction.", "policy_unavailable");
  const binding = await readActivePlatformConfigurationForBinding(client, "organization.document.retention_policy");
  if (!binding) throw new OrganizationDocumentError("Document creation is unavailable until an approved organization-document retention policy is active.", "policy_unavailable");
  const policy = parseOrganizationDocumentRetentionPolicy(binding.value);
  const jurisdiction = policy.jurisdictions[jurisdictionCode];
  if (!jurisdiction) throw new OrganizationDocumentError(`The active document-retention policy does not cover ${jurisdictionCode}.`, "policy_unavailable");
  const retentionDays = category && basis ? jurisdiction.rules[category][basis].retentionDays : null;
  return { binding, policy, jurisdiction, jurisdictionCode, retentionDays };
}

export async function getOrganizationDocumentRetentionOptions(organizationId: string) {
  return withPostgresTransaction(async (client) => {
    const authority = await retentionAuthority(client, organizationId);
    return {
      policy: {
        versionId: authority.binding.versionId,
        versionNumber: authority.binding.versionNumber,
        reference: authority.policy.policyReference,
        name: authority.policy.policyName,
        schemaVersion: authority.policy.schemaVersion,
        jurisdictionCode: authority.jurisdictionCode,
        legalBasisReference: authority.jurisdiction.legalBasisReference,
      },
      rules: organizationDocumentCategories.flatMap((category) => organizationDocumentRetentionBases.map((retentionBasis) => ({
        category,
        retentionBasis,
        retentionDays: authority.jurisdiction.rules[category][retentionBasis].retentionDays,
      }))),
    };
  });
}

export async function createOrganizationDocument(input: {
  documentId?: string; organizationId: string; actorIdentityId: string; title: string; category: OrganizationDocumentCategory;
  reference?: string; retentionBasis: OrganizationDocumentRetentionBasis; filename: string; mimeType: string;
  storageKey: string; contentSha256: string; bytes: number;
}) {
  const documentId = input.documentId ?? randomUUID(); const versionId = randomUUID();
  const title = clean(input.title, "title", 2, 240); const filename = clean(input.filename, "filename", 1, 240);
  const mimeType = clean(input.mimeType, "mimeType", 3, 160).toLowerCase(); const storageKey = clean(input.storageKey, "storageKey", 1, 2000);
  const contentSha256 = sha(input.contentSha256); const bytes = byteCount(input.bytes);
  const reference = input.reference?.trim() ? clean(input.reference, "reference", 1, 120) : null;
  await withPostgresTransaction(async (client) => {
    const authority = await retentionAuthority(client, input.organizationId, input.category, input.retentionBasis);
    const createdAt = new Date();
    const retainUntil = new Date(createdAt.getTime() + authority.retentionDays! * 86_400_000);
    await client.query(`INSERT INTO fractal.organization_documents
      (id,organization_id,title,category,reference,current_version_id,current_version_number,retention_basis,retain_until,created_by_identity_id,created_at,
       retention_binding_status,retention_configuration_key,retention_policy_version_id,retention_policy_version_number,retention_policy_projection_version,
       retention_policy_value_sha256,retention_policy_reference,retention_policy_name,retention_policy_schema_version,retention_policy_jurisdiction_code,
       retention_policy_legal_basis_reference,retention_days)
      VALUES ($1,$2,$3,$4,$5,NULL,1,$6,$7,$8,$9,'governed',$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
      [documentId,input.organizationId,title,input.category,reference,input.retentionBasis,retainUntil,input.actorIdentityId,createdAt,
        authority.binding.configurationKey,authority.binding.versionId,authority.binding.versionNumber,authority.binding.projectionVersion,
        authority.binding.valueSha256,authority.policy.policyReference,authority.policy.policyName,authority.policy.schemaVersion,
        authority.jurisdictionCode,authority.jurisdiction.legalBasisReference,authority.retentionDays]);
    await client.query(`INSERT INTO fractal.organization_document_versions
      (id,document_id,organization_id,version_number,filename,mime_type,storage_key,content_sha256,bytes,retain_until,uploaded_by_identity_id,created_at)
      VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10,$11)`, [versionId,documentId,input.organizationId,filename,mimeType,storageKey,contentSha256,bytes,retainUntil,input.actorIdentityId,createdAt]);
    await event(client,{documentId,type:"created",fromStatus:null,toStatus:"active",versionId,actorId:input.actorIdentityId,reason:"The first immutable organization document version was recorded under an approved retention policy."});
    await client.query("UPDATE fractal.organization_documents SET current_version_id=$2 WHERE id=$1",[documentId,versionId]);
    const audit = await appendPostgresAuditEvent(client,{scopeKey:`organization:${input.organizationId}`,organizationId:input.organizationId,actorId:input.actorIdentityId,actorType:"user",action:"organization.document.created",entityType:"organization_document",entityId:documentId,payload:{category:input.category,versionNumber:1,contentSha256,retainUntil:retainUntil.toISOString(),retentionPolicyVersionId:authority.binding.versionId}});
    await appendOutboxEvent(client,{aggregateType:"organization_document",aggregateId:documentId,eventType:"organization.document.created",payload:{organizationId:input.organizationId,versionId,auditEventId:audit.id}});
  });
  return { documentId, versionId, versionNumber: 1, contentSha256 };
}

export async function addOrganizationDocumentVersion(input: { documentId: string; organizationId: string; actorIdentityId: string; filename: string; mimeType: string; storageKey: string; contentSha256: string; bytes: number; reason: string }) {
  const versionId=randomUUID(); const filename=clean(input.filename,"filename",1,240); const mimeType=clean(input.mimeType,"mimeType",3,160).toLowerCase();
  const storageKey=clean(input.storageKey,"storageKey",1,2000); const contentSha256=sha(input.contentSha256); const bytes=byteCount(input.bytes); const reason=clean(input.reason,"reason",10,1000);
  return withPostgresTransaction(async(client)=>{
    const result=await client.query<{current_version_number:number;retain_until:Date;status:string;retention_binding_status:string;retention_days:number|null}>("SELECT current_version_number,retain_until,status,retention_binding_status,retention_days FROM fractal.organization_documents WHERE id=$1 AND organization_id=$2 FOR UPDATE",[input.documentId,input.organizationId]);
    const document=result.rows[0]; if(!document) throw new OrganizationDocumentError("Organization document not found","not_found");
    if(document.status!=="active") throw new OrganizationDocumentError("Archived organization documents cannot receive a new version","invalid_state");
    if(document.retention_binding_status!=="governed"||!document.retention_days) throw new OrganizationDocumentError("Legacy-declared documents cannot receive new versions because they lack an approved retention-policy binding.","invalid_state");
    const createdAt=new Date(); const policyDue=new Date(createdAt.getTime()+document.retention_days*86_400_000);
    const retainUntil=policyDue>document.retain_until?policyDue:document.retain_until; const versionNumber=document.current_version_number+1;
    await client.query(`INSERT INTO fractal.organization_document_versions
      (id,document_id,organization_id,version_number,filename,mime_type,storage_key,content_sha256,bytes,retain_until,uploaded_by_identity_id,created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,[versionId,input.documentId,input.organizationId,versionNumber,filename,mimeType,storageKey,contentSha256,bytes,retainUntil,input.actorIdentityId,createdAt]);
    await event(client,{documentId:input.documentId,type:"version_added",fromStatus:"active",toStatus:"active",versionId,actorId:input.actorIdentityId,reason});
    await client.query("UPDATE fractal.organization_documents SET current_version_id=$2,current_version_number=$3,retain_until=$4 WHERE id=$1",[input.documentId,versionId,versionNumber,retainUntil]);
    const audit=await appendPostgresAuditEvent(client,{scopeKey:`organization:${input.organizationId}`,organizationId:input.organizationId,actorId:input.actorIdentityId,actorType:"user",action:"organization.document.version_added",entityType:"organization_document",entityId:input.documentId,reason,payload:{versionId,versionNumber,contentSha256,retainUntil:retainUntil.toISOString()}});
    await appendOutboxEvent(client,{aggregateType:"organization_document",aggregateId:input.documentId,eventType:"organization.document.version_added",payload:{organizationId:input.organizationId,versionId,versionNumber,auditEventId:audit.id}});
    return {documentId:input.documentId,versionId,versionNumber,contentSha256};
  });
}

export async function archiveOrganizationDocument(input:{documentId:string;organizationId:string;actorIdentityId:string;reason:string}) {
  const reason=clean(input.reason,"reason",10,1000);
  return withPostgresTransaction(async(client)=>{
    const result=await client.query<{status:string}>("SELECT status FROM fractal.organization_documents WHERE id=$1 AND organization_id=$2 FOR UPDATE",[input.documentId,input.organizationId]);
    if(!result.rows[0]) throw new OrganizationDocumentError("Organization document not found","not_found");
    if(result.rows[0].status!=="active") throw new OrganizationDocumentError("Organization document is already archived","invalid_state");
    await event(client,{documentId:input.documentId,type:"archived",fromStatus:"active",toStatus:"archived",actorId:input.actorIdentityId,reason});
    await client.query("UPDATE fractal.organization_documents SET status='archived',archived_by_identity_id=$2,archived_at=now(),archive_reason=$3 WHERE id=$1",[input.documentId,input.actorIdentityId,reason]);
    const audit=await appendPostgresAuditEvent(client,{scopeKey:`organization:${input.organizationId}`,organizationId:input.organizationId,actorId:input.actorIdentityId,actorType:"user",action:"organization.document.archived",entityType:"organization_document",entityId:input.documentId,reason,payload:{status:"archived"}});
    await appendOutboxEvent(client,{aggregateType:"organization_document",aggregateId:input.documentId,eventType:"organization.document.archived",payload:{organizationId:input.organizationId,auditEventId:audit.id}});
    return {documentId:input.documentId,status:"archived" as const};
  });
}

const documentVersionSelect=`SELECT document.id AS document_id,document.organization_id,document.title,document.category,document.reference,document.status,document.current_version_number,document.retention_basis,document.retain_until,document.created_at AS document_created_at,document.archived_at,document.archive_reason,
  document.retention_binding_status,document.retention_policy_version_id,document.retention_policy_version_number,document.retention_policy_reference,document.retention_policy_name,
  document.retention_policy_schema_version,document.retention_policy_jurisdiction_code,document.retention_policy_legal_basis_reference,document.retention_days,disposition.status AS disposition_status,
  version.id AS version_id,version.version_number,version.filename,version.mime_type,version.storage_key,version.content_sha256,version.bytes,version.retain_until AS version_retain_until,version.created_at AS version_created_at,
  count(access.id)::text AS download_count,max(access.occurred_at) AS last_downloaded_at
  FROM fractal.organization_documents document JOIN fractal.organization_document_versions version ON version.document_id=document.id
  LEFT JOIN fractal.organization_document_access_events access ON access.document_version_id=version.id
  LEFT JOIN fractal.organization_document_dispositions disposition ON disposition.document_id=document.id`;

export async function listOrganizationDocuments(organizationId:string) {
  const result=await requirePostgres().query<DocumentVersionRow>(`${documentVersionSelect} WHERE document.organization_id=$1
    GROUP BY document.id,version.id,disposition.status ORDER BY document.created_at DESC,document.id,version.version_number DESC`,[organizationId]);
  const documents=new Map<string,ReturnType<typeof mapDocument>>();
  for(const row of result.rows){const existing=documents.get(row.document_id);if(existing) existing.versions.push(mapVersion(row));else documents.set(row.document_id,mapDocument(row));}
  return [...documents.values()];
}
function mapVersion(row:DocumentVersionRow){return{id:row.version_id,versionNumber:row.version_number,filename:row.filename,mimeType:row.mime_type,contentSha256:row.content_sha256,bytes:row.bytes,retainUntil:row.version_retain_until.toISOString(),createdAt:row.version_created_at.toISOString(),downloadCount:Number(row.download_count),lastDownloadedAt:row.last_downloaded_at?.toISOString()??null};}
function mapDocument(row:DocumentVersionRow){return{id:row.document_id,organizationId:row.organization_id,title:row.title,category:row.category,reference:row.reference,status:row.status,currentVersionNumber:row.current_version_number,retentionBasis:row.retention_basis,retainUntil:row.retain_until.toISOString(),createdAt:row.document_created_at.toISOString(),archivedAt:row.archived_at?.toISOString()??null,archiveReason:row.archive_reason,retention:{bindingStatus:row.retention_binding_status,days:row.retention_days,policy:row.retention_policy_version_id?{versionId:row.retention_policy_version_id,versionNumber:row.retention_policy_version_number!,reference:row.retention_policy_reference!,name:row.retention_policy_name!,schemaVersion:row.retention_policy_schema_version!,jurisdictionCode:row.retention_policy_jurisdiction_code!,legalBasisReference:row.retention_policy_legal_basis_reference!}:null},dispositionStatus:row.disposition_status,versions:[mapVersion(row)]};}

export async function getOrganizationDocumentVersion(input:{documentId:string;versionId:string;organizationId:string}) {
  const result=await requirePostgres().query<{document_id:string;organization_id:string;version_id:string;filename:string;mime_type:string;storage_key:string;content_sha256:string}>(`SELECT document.id AS document_id,document.organization_id,version.id AS version_id,version.filename,version.mime_type,version.storage_key,version.content_sha256 FROM fractal.organization_documents document JOIN fractal.organization_document_versions version ON version.document_id=document.id LEFT JOIN fractal.organization_document_dispositions disposition ON disposition.document_id=document.id WHERE document.id=$1 AND version.id=$2 AND document.organization_id=$3 AND disposition.id IS NULL`,[input.documentId,input.versionId,input.organizationId]);
  const row=result.rows[0];return row?{documentId:row.document_id,organizationId:row.organization_id,versionId:row.version_id,filename:row.filename,mimeType:row.mime_type,storageKey:row.storage_key,contentSha256:row.content_sha256}:null;
}
export async function recordOrganizationDocumentDownload(input:{documentId:string;versionId:string;organizationId:string;actorIdentityId:string;contentSha256:string}) {
  await withPostgresTransaction(async (client) => {
    await lockDataLifecycleAuthority(client);
    const recorded = await client.query(`INSERT INTO fractal.organization_document_access_events (id,document_id,document_version_id,organization_id,accessed_by_identity_id,access_type,content_sha256)
      SELECT $1,$2,$3,$4,$5,'download',$6 WHERE NOT EXISTS (SELECT 1 FROM fractal.organization_document_dispositions WHERE document_id=$2)`,[randomUUID(),input.documentId,input.versionId,input.organizationId,input.actorIdentityId,sha(input.contentSha256)]);
    if (recorded.rowCount !== 1) throw new OrganizationDocumentError("This document is unavailable because governed disposition has begun.", "invalid_state");
  });
}
export async function listOrganizationDocumentAccessEvents(input:{documentId:string;organizationId:string}) {
  const result=await requirePostgres().query<{id:string;document_version_id:string;version_number:number;accessed_by_identity_id:string;legal_name:string;content_sha256:string;occurred_at:Date}>(`SELECT access.id,access.document_version_id,version.version_number,access.accessed_by_identity_id,identity.legal_name,access.content_sha256,access.occurred_at FROM fractal.organization_document_access_events access JOIN fractal.organization_document_versions version ON version.id=access.document_version_id JOIN fractal.identities identity ON identity.id=access.accessed_by_identity_id WHERE access.document_id=$1 AND access.organization_id=$2 ORDER BY access.occurred_at DESC,access.id DESC LIMIT 500`,[input.documentId,input.organizationId]);
  return result.rows.map(row=>({id:row.id,versionId:row.document_version_id,versionNumber:row.version_number,accessedBy:{id:row.accessed_by_identity_id,legalName:row.legal_name},contentSha256:row.content_sha256,occurredAt:row.occurred_at.toISOString()}));
}
