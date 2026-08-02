import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { parsePrivacyContentProfile } from "../modules/privacy/domain/privacy-content-profile.js";
import {
  buildPrivacyPackageArchiveV2,
  parsePrivacyPackageArchiveV2,
  PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
  PRIVACY_PACKAGE_JSON_FORMAT_V1,
  type PrivacyPackageArtifactInput,
} from "../modules/privacy/domain/privacy-package-archive.js";
import { deleteStoredFile, persistPrivacyPackageBinary, retrieveFile } from "../services/storage.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import { AdministratorCapabilityError, requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import {
  collectCanonicalPrivacySourceSections,
  type PrivacyExternalSnapshotManifestItem,
  type PrivacyPackageSourceManifest,
} from "./postgres-privacy-package-preparations.js";
import { loadPrivacyExternalSnapshotSections } from "./postgres-privacy-external-snapshots.js";

const CAPABILITY = "privacy_request_manage";
export class PrivacyPackageDeliveryError extends Error {
  constructor(message: string, readonly code: "invalid_input" | "forbidden" | "not_found" | "conflict" | "unavailable") { super(message); }
}

type DeliveryStatus = "queued" | "materializing" | "available" | "failed" | "expired" | "cleanup_requested" | "destroyed" | "cleanup_failed";
type DeliveryRow = {
  id: string; reference: string; preparation_id: string; privacy_request_id: string; requester_identity_id: string;
  status: DeliveryStatus; canonical_format: string; source_manifest_sha256: string; content_sha256: string | null;
  byte_count: number | null; storage_key: string | null; requested_at: Date; retrieval_expires_at: Date; retain_until: Date;
  generated_at: Date | null; available_at: Date | null; expired_at: Date | null; destroyed_at: Date | null;
  failure_category: string | null; attempts: number;
};

type ClaimedDelivery = DeliveryRow & {
  request_reference: string; request_type: "access" | "portability"; preparation_reference: string;
  policy_reference: string; content_profile_reference: string; content_profile_value: unknown;
  maximum_bytes: number; maximum_artifacts: number; source_manifest: PrivacyPackageSourceManifest[];
  external_snapshot_manifest: PrivacyExternalSnapshotManifestItem[];
};

function sha256(value: Buffer | string) { return createHash("sha256").update(value).digest("hex"); }
function commandKey(value: string) {
  const key = value.trim();
  if (!key || key.length > 200) throw new PrivacyPackageDeliveryError("Command key must contain 1 to 200 characters.", "invalid_input");
  return key;
}
function reference() { return `PRD-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`; }
async function requireCapability(client: PoolClient, actorIdentityId: string) {
  try { await requireAdministratorCapability(client, actorIdentityId, CAPABILITY); }
  catch (error) {
    if (error instanceof AdministratorCapabilityError) throw new PrivacyPackageDeliveryError("Privacy rights management capability is required.", "forbidden");
    throw error;
  }
}
function mapDelivery(row: DeliveryRow) {
  return {
    id: row.id, reference: row.reference, preparationId: row.preparation_id, privacyRequestId: row.privacy_request_id,
    status: row.status, canonicalFormat: row.canonical_format, contentSha256: row.content_sha256, byteCount: row.byte_count,
    requestedAt: row.requested_at.toISOString(), retrievalExpiresAt: row.retrieval_expires_at.toISOString(),
    retainUntil: row.retain_until.toISOString(), generatedAt: row.generated_at?.toISOString() ?? null,
    availableAt: row.available_at?.toISOString() ?? null, expiredAt: row.expired_at?.toISOString() ?? null,
    destroyedAt: row.destroyed_at?.toISOString() ?? null, failureCategory: row.failure_category,
  };
}

export async function requestPrivacyPackageDelivery(input: {
  actorIdentityId: string; preparationId: string; commandKey: string;
}) {
  return withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('privacy-package-delivery:' || $1,0))", [input.preparationId]);
    await requireCapability(client, input.actorIdentityId);
    const key = commandKey(input.commandKey);
    const replay = await client.query<DeliveryRow>("SELECT * FROM fractal.privacy_rights_package_deliveries WHERE requested_by_identity_id=$1 AND command_key=$2", [input.actorIdentityId, key]);
    if (replay.rows[0]) {
      if (replay.rows[0].preparation_id !== input.preparationId) throw new PrivacyPackageDeliveryError("This command key was already used for another delivery.", "conflict");
      return { delivery: mapDelivery(replay.rows[0]), replayed: true };
    }
    const preparation = await client.query<{
      id: string; privacy_request_id: string; requester_identity_id: string; deliverable: boolean; canonical_format: string;
      source_manifest_sha256: string; requester_retrieval_hours: number; package_retention_hours: number; current: boolean;
      prepared_by_identity_id: string;
    }>("SELECT id,privacy_request_id,requester_identity_id,deliverable,canonical_format,source_manifest_sha256,requester_retrieval_hours,package_retention_hours,prepared_by_identity_id,fractal.privacy_package_preparation_is_current(id) AS current FROM fractal.privacy_rights_package_preparations WHERE id=$1 FOR UPDATE", [input.preparationId]);
    const row = preparation.rows[0];
    if (!row) throw new PrivacyPackageDeliveryError("Privacy package preparation not found.", "not_found");
    if (!row.deliverable) throw new PrivacyPackageDeliveryError("This preparation has incomplete coverage and cannot be delivered.", "conflict");
    if (!row.current) throw new PrivacyPackageDeliveryError("The approved package policy, content profile, or source inventory changed after preparation.", "conflict");
    if (input.actorIdentityId === row.prepared_by_identity_id) throw new PrivacyPackageDeliveryError("A different capable administrator must authorize package delivery.", "conflict");
    if (input.actorIdentityId === row.requester_identity_id) throw new PrivacyPackageDeliveryError("A requester cannot authorize delivery of their own privacy package.", "forbidden");
    const id = randomUUID(); const requestedAt = new Date();
    const retrievalExpiresAt = new Date(requestedAt.getTime() + row.requester_retrieval_hours * 3_600_000);
    const retainUntil = new Date(requestedAt.getTime() + row.package_retention_hours * 3_600_000);
    const inserted = await client.query<DeliveryRow>(`INSERT INTO fractal.privacy_rights_package_deliveries
      (id,reference,preparation_id,privacy_request_id,requester_identity_id,status,canonical_format,source_manifest_sha256,
       command_key,requested_by_identity_id,requested_at,retrieval_expires_at,retain_until)
      VALUES($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [id,reference(),row.id,row.privacy_request_id,row.requester_identity_id,row.canonical_format,row.source_manifest_sha256,key,input.actorIdentityId,requestedAt,retrievalExpiresAt,retainUntil]);
    const audit = await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${row.privacy_request_id}`,actorId:input.actorIdentityId,actorType:"user",action:"privacy.request.package_delivery_requested",entityType:"privacy_rights_package_delivery",entityId:id,reason:"A different capable administrator authorized materialization of an exact complete privacy-package preparation.",payload:{preparationId:row.id,sourceManifestSha256:row.source_manifest_sha256,retrievalExpiresAt:retrievalExpiresAt.toISOString(),retainUntil:retainUntil.toISOString()}});
    await appendOutboxEvent(client,{aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,eventType:"privacy.request.package_delivery_requested",payload:{deliveryId:id,preparationId:row.id,auditEventId:audit.id}});
    return { delivery: mapDelivery(inserted.rows[0]!), replayed: false };
  });
}

export async function claimPrivacyPackageDelivery(workerId: string, claimTimeoutSeconds = 300): Promise<ClaimedDelivery | null> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<ClaimedDelivery>(`WITH candidate AS (
      SELECT id FROM fractal.privacy_rights_package_deliveries
       WHERE status IN('queued','materializing') AND (status='queued' OR claimed_at<now()-($1*interval '1 second'))
       ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE fractal.privacy_rights_package_deliveries delivery SET status='materializing',claimed_by=$2,claimed_at=now(),attempts=attempts+1
      FROM candidate,fractal.privacy_rights_package_preparations preparation,fractal.privacy_rights_requests request,
           fractal.platform_configuration_versions profile
      WHERE delivery.id=candidate.id AND preparation.id=delivery.preparation_id AND request.id=delivery.privacy_request_id
        AND profile.id=preparation.content_profile_version_id
      RETURNING delivery.*,request.reference AS request_reference,request.request_type,preparation.reference AS preparation_reference,
        preparation.policy_reference,preparation.content_profile_reference,profile.proposed_value AS content_profile_value,
        preparation.maximum_bytes,preparation.maximum_artifacts,preparation.source_manifest,preparation.external_snapshot_manifest`,
      [claimTimeoutSeconds, workerId]);
    return result.rows[0] ?? null;
  });
}

async function markFailed(deliveryId: string, workerId: string, category: "stale_preparation" | "collection_failed" | "storage_failed" | "finalization_failed") {
  await withPostgresTransaction(async (client) => {
    await client.query(`UPDATE fractal.privacy_rights_package_deliveries SET status='failed',claimed_by=NULL,claimed_at=NULL,failure_category=$3
      WHERE id=$1 AND status='materializing' AND claimed_by=$2`, [deliveryId,workerId,category]);
  });
}

export async function materializeOnePrivacyPackage(input: {
  workerId: string;
  store?: typeof persistPrivacyPackageBinary;
}): Promise<boolean> {
  const delivery = await claimPrivacyPackageDelivery(input.workerId);
  if (!delivery) return false;
  const canonicalFormat = delivery.canonical_format === PRIVACY_PACKAGE_JSON_FORMAT_V1
    || delivery.canonical_format === PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2
    ? delivery.canonical_format
    : null;
  if (!canonicalFormat) {
    await markFailed(delivery.id,input.workerId,"stale_preparation");
    return true;
  }
  let externalSections;
  try {
    externalSections = await loadPrivacyExternalSnapshotSections(delivery.external_snapshot_manifest);
  } catch {
    await markFailed(delivery.id,input.workerId,"stale_preparation");
    return true;
  }
  let content: Buffer;
  try {
    content = await withPostgresTransaction(async (client) => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      const freshness=await client.query<{current:boolean}>("SELECT fractal.privacy_package_preparation_is_current($1) AS current",[delivery.preparation_id]);
      if(freshness.rows[0]?.current!==true) throw new PrivacyPackageDeliveryError("The approved package policy, content profile, or source inventory changed after preparation.","conflict");
      const profile = parsePrivacyContentProfile(delivery.content_profile_value);
      const sections = await collectCanonicalPrivacySourceSections(client,delivery.requester_identity_id,delivery.request_type,profile,{
        excludePrivacyPackagePreparationId:delivery.preparation_id,excludePrivacyPackageDeliveryId:delivery.id,
      });
      for (const [sourceKey, section] of externalSections) {
        if (sections.has(sourceKey)) {
          throw new PrivacyPackageDeliveryError("A package source has more than one collector.", "conflict");
        }
        sections.set(sourceKey, section);
      }
      const expected = new Map(delivery.source_manifest.filter((item)=>item.status==="collected").map((item)=>[item.sourceKey,item]));
      if (sections.size !== expected.size) throw new PrivacyPackageDeliveryError("The preparation no longer matches the collector catalogue.", "conflict");
      for (const [sourceKey,section] of sections) {
        const item=expected.get(sourceKey);
        if(!item||item.contentSha256!==section.contentSha256||item.recordCount!==section.records.length||item.byteCount!==section.byteCount){
          throw new PrivacyPackageDeliveryError("Source data changed after preparation; a new preparation is required.","conflict");
        }
      }
      const packageDocument={schemaVersion:canonicalFormat===PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2
        ?"fractal-privacy-package-v2":"fractal-privacy-package-v1",canonicalFormat,
        deliveryReference:delivery.reference,preparationReference:delivery.preparation_reference,requestReference:delivery.request_reference,
        requestType:delivery.request_type,policyReference:delivery.policy_reference,contentProfileReference:delivery.content_profile_reference,
        sourceManifestSha256:delivery.source_manifest_sha256,generatedAt:delivery.requested_at.toISOString(),
        sections:[...sections.values()].sort((a,b)=>a.sourceKey.localeCompare(b.sourceKey)).map((section)=>({sourceKey:section.sourceKey,records:section.records}))};
      const artifacts:PrivacyPackageArtifactInput[]=[...sections.values()]
        .flatMap((section)=>section.artifacts??[]);
      if(artifacts.length>delivery.maximum_artifacts) throw new PrivacyPackageDeliveryError("The materialized package exceeds its approved artifact limit.","conflict");
      let buffer:Buffer;
      if(canonicalFormat===PRIVACY_PACKAGE_JSON_FORMAT_V1){
        if(artifacts.length) throw new PrivacyPackageDeliveryError("A JSON package cannot contain binary artifacts.","conflict");
        buffer=Buffer.from(stableJsonStringify(packageDocument),"utf8");
      }else if(canonicalFormat===PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2){
        buffer=buildPrivacyPackageArchiveV2({packageDocument,artifacts}).buffer;
      }else{
        throw new PrivacyPackageDeliveryError("The package format is not supported.","conflict");
      }
      if(buffer.byteLength>delivery.maximum_bytes) throw new PrivacyPackageDeliveryError("The materialized package exceeds its approved byte limit.","conflict");
      return buffer;
    });
  } catch (error) {
    await markFailed(delivery.id,input.workerId,error instanceof PrivacyPackageDeliveryError?"stale_preparation":"collection_failed");
    return true;
  }
  const store=input.store??persistPrivacyPackageBinary;
  let persisted: Awaited<ReturnType<typeof persistPrivacyPackageBinary>>;
  try { persisted=await store({deliveryId:delivery.id,content,canonicalFormat}); }
  catch { await markFailed(delivery.id,input.workerId,"storage_failed"); return true; }
  try {
    await withPostgresTransaction(async(client)=>{
      const finalized=await client.query<DeliveryRow>(`UPDATE fractal.privacy_rights_package_deliveries SET status='available',content_sha256=$3,byte_count=$4,
        storage_key=$5,generated_at=$6,available_at=now(),claimed_by=NULL,claimed_at=NULL WHERE id=$1 AND status='materializing' AND claimed_by=$2 RETURNING *`,
      [delivery.id,input.workerId,persisted.sha256,persisted.bytes,persisted.storageKey,delivery.requested_at]);
      if(!finalized.rows[0]) throw new PrivacyPackageDeliveryError("The delivery claim is no longer current.","conflict");
      const audit=await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${delivery.privacy_request_id}`,actorType:"worker",action:"privacy.request.package_delivery_available",entityType:"privacy_rights_package_delivery",entityId:delivery.id,reason:"The exact canonical package was persisted to private storage and bound to its verified content hash.",payload:{contentSha256:persisted.sha256,byteCount:persisted.bytes,retrievalExpiresAt:delivery.retrieval_expires_at.toISOString(),workerId:input.workerId}});
      await appendOutboxEvent(client,{aggregateType:"privacy_rights_request",aggregateId:delivery.privacy_request_id,eventType:"privacy.request.package_delivery_available",payload:{deliveryId:delivery.id,auditEventId:audit.id}});
    });
  } catch (error) {
    await withPostgresTransaction(async(client)=>{
      await client.query(`INSERT INTO fractal.storage_cleanup_tasks(id,storage_key,source,metadata_error,purpose,privacy_package_delivery_id)
        VALUES($1,$2,'privacy_package_finalization',$3,'privacy_package_delivery',$4)`,[randomUUID(),persisted.storageKey,error instanceof Error?error.message.slice(0,2000):"Delivery finalization failed",delivery.id]);
    });
    try { await deleteStoredFile(persisted.storageKey); } catch { /* durable cleanup task remains */ }
    await markFailed(delivery.id,input.workerId,"finalization_failed");
  }
  return true;
}

export async function listOwnPrivacyPackageDeliveries(input:{actorIdentityId:string;privacyRequestId:string}){
  return withPostgresTransaction(async(client)=>{
    const result=await client.query<DeliveryRow>("SELECT * FROM fractal.privacy_rights_package_deliveries WHERE privacy_request_id=$1 AND requester_identity_id=$2 ORDER BY requested_at,id",[input.privacyRequestId,input.actorIdentityId]);
    return result.rows.map(mapDelivery);
  });
}

export async function listAdministratorPrivacyPackageDeliveries(input:{actorIdentityId:string;privacyRequestId:string}){
  return withPostgresTransaction(async(client)=>{
    await requireCapability(client,input.actorIdentityId);
    const result=await client.query<DeliveryRow>("SELECT * FROM fractal.privacy_rights_package_deliveries WHERE privacy_request_id=$1 ORDER BY requested_at,id",[input.privacyRequestId]);
    return result.rows.map(mapDelivery);
  });
}

export async function downloadOwnPrivacyPackage(input:{actorIdentityId:string;deliveryId:string}){
  return withPostgresTransaction(async(client)=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('privacy-package-download:' || $1,0))",[input.deliveryId]);
    const result=await client.query<DeliveryRow>("SELECT * FROM fractal.privacy_rights_package_deliveries WHERE id=$1 AND requester_identity_id=$2 FOR UPDATE",[input.deliveryId,input.actorIdentityId]);
    const delivery=result.rows[0];
    if(!delivery) throw new PrivacyPackageDeliveryError("Privacy package delivery not found.","not_found");
    if(delivery.status!=="available"||new Date()>=delivery.retrieval_expires_at||!delivery.storage_key||!delivery.content_sha256||!delivery.byte_count){
      throw new PrivacyPackageDeliveryError("This privacy package is not available within its retrieval window.","conflict");
    }
    const stored=await retrieveFile(delivery.storage_key);
    if(stored.redirectUrl) throw new PrivacyPackageDeliveryError("Privacy packages cannot be served by redirect.","unavailable");
    if(stored.buffer.byteLength!==delivery.byte_count||sha256(stored.buffer)!==delivery.content_sha256) throw new PrivacyPackageDeliveryError("Stored privacy package integrity verification failed.","unavailable");
    if(delivery.canonical_format===PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2) {
      try { parsePrivacyPackageArchiveV2(stored.buffer); }
      catch { throw new PrivacyPackageDeliveryError("Stored privacy package archive verification failed.","unavailable"); }
    }
    const eventId=randomUUID();
    await client.query(`INSERT INTO fractal.privacy_rights_package_access_events
      (id,delivery_id,privacy_request_id,requester_identity_id,accessed_by_identity_id,access_type,content_sha256,bytes_served)
      VALUES($1,$2,$3,$4,$4,'download',$5,$6)`,[eventId,delivery.id,delivery.privacy_request_id,input.actorIdentityId,delivery.content_sha256,delivery.byte_count]);
    await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${delivery.privacy_request_id}`,actorId:input.actorIdentityId,actorType:"user",action:"privacy.request.package_downloaded",entityType:"privacy_rights_package_access_event",entityId:eventId,reason:"The owning authenticated requester downloaded the integrity-verified privacy package within its retrieval window.",payload:{deliveryId:delivery.id,contentSha256:delivery.content_sha256,bytesServed:delivery.byte_count}});
    return {delivery:mapDelivery(delivery),buffer:stored.buffer};
  });
}

export async function expireAndQueuePrivacyPackageCleanup(now=new Date(),limit=100){
  if(!Number.isInteger(limit)||limit<1||limit>1_000) throw new PrivacyPackageDeliveryError("Expiry batch size must be between 1 and 1000.","invalid_input");
  return withPostgresTransaction(async(client)=>{
    const expired=await client.query<{id:string;privacy_request_id:string}>(`WITH candidates AS (
      SELECT id FROM fractal.privacy_rights_package_deliveries WHERE status='available' AND retrieval_expires_at<=$1 AND retain_until>$1
      ORDER BY retrieval_expires_at,id FOR UPDATE SKIP LOCKED LIMIT $2)
      UPDATE fractal.privacy_rights_package_deliveries delivery SET status='expired',expired_at=$1 FROM candidates
      WHERE delivery.id=candidates.id RETURNING delivery.id,delivery.privacy_request_id`,[now,limit]);
    for(const delivery of expired.rows){
      const audit=await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${delivery.privacy_request_id}`,actorType:"worker",action:"privacy.request.package_delivery_expired",entityType:"privacy_rights_package_delivery",entityId:delivery.id,reason:"The authenticated requester retrieval window elapsed; retained bytes are no longer downloadable.",payload:{expiredAt:now.toISOString()}});
      await appendOutboxEvent(client,{aggregateType:"privacy_rights_request",aggregateId:delivery.privacy_request_id,eventType:"privacy.request.package_delivery_expired",payload:{deliveryId:delivery.id,auditEventId:audit.id}});
    }
    const due=await client.query<{id:string;storage_key:string;privacy_request_id:string}>(`SELECT id,storage_key,privacy_request_id FROM fractal.privacy_rights_package_deliveries
      WHERE status IN('available','expired') AND retain_until<=$1 ORDER BY retain_until,id FOR UPDATE SKIP LOCKED LIMIT $2`,[now,limit]);
    for(const delivery of due.rows){
      await client.query(`INSERT INTO fractal.storage_cleanup_tasks(id,storage_key,source,metadata_error,purpose,privacy_package_delivery_id)
        VALUES($1,$2,'privacy_package_retention_expiry','Approved package retention elapsed.','privacy_package_delivery',$3)`,[randomUUID(),delivery.storage_key,delivery.id]);
      await client.query("UPDATE fractal.privacy_rights_package_deliveries SET status='cleanup_requested',expired_at=COALESCE(expired_at,$2) WHERE id=$1",[delivery.id,now]);
      const audit=await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${delivery.privacy_request_id}`,actorType:"worker",action:"privacy.request.package_delivery_cleanup_requested",entityType:"privacy_rights_package_delivery",entityId:delivery.id,reason:"The approved package retention period elapsed and durable private-object deletion was queued.",payload:{requestedAt:now.toISOString()}});
      await appendOutboxEvent(client,{aggregateType:"privacy_rights_request",aggregateId:delivery.privacy_request_id,eventType:"privacy.request.package_delivery_cleanup_requested",payload:{deliveryId:delivery.id,auditEventId:audit.id}});
    }
    return {expired:expired.rowCount??0,cleanupQueued:due.rowCount??0};
  });
}
