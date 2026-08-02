import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export interface ClaimedStorageCleanupTask {
  id: string;
  storageKey: string;
  source: string;
  attempts: number;
  governedDispositionId: string | null;
  organizationDocumentDispositionId: string | null;
  privacyPackageDeliveryId: string | null;
  privacyExternalCollectionSnapshotId: string | null;
  privacyExternalProviderExportId: string | null;
}

function text(value: string, field: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) throw new Error(`${field} is invalid`);
  return normalized;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 2_000) || "Unknown error";
}

/** Persist cleanup intent before attempting an opportunistic inline delete. */
export async function enqueueStorageCleanupTask(input: {
  storageKey: string;
  source: string;
  metadataError: unknown;
}): Promise<string> {
  const id = randomUUID();
  await withPostgresTransaction(async (client) => {
    await client.query(
      `INSERT INTO fractal.storage_cleanup_tasks (id, storage_key, source, metadata_error)
       VALUES ($1, $2, $3, $4)`,
      [id, text(input.storageKey, "storageKey", 2_000), text(input.source, "source", 120), errorMessage(input.metadataError)],
    );
  });
  return id;
}

export async function claimStorageCleanupTasks(input: {
  workerId: string;
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedStorageCleanupTask[]> {
  if (input.limit <= 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      storage_key: string;
      source: string;
      attempts: number;
      governed_disposition_id: string | null;
      organization_document_disposition_id: string | null;
      privacy_package_delivery_id: string | null;
      privacy_external_collection_snapshot_id: string | null;
      privacy_external_provider_export_id: string | null;
    }>(
      `WITH candidates AS (
         SELECT id
           FROM fractal.storage_cleanup_tasks
          WHERE completed_at IS NULL
            AND failed_at IS NULL
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($1 * interval '1 second'))
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE fractal.storage_cleanup_tasks task
          SET claimed_at = now(), claimed_by = $3, attempts = task.attempts + 1
         FROM candidates
        WHERE task.id = candidates.id
       RETURNING task.id, task.storage_key, task.source, task.attempts, task.governed_disposition_id,
         task.organization_document_disposition_id,task.privacy_package_delivery_id,
         task.privacy_external_collection_snapshot_id,
         task.privacy_external_provider_export_id`,
      [input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((task) => ({
      id: task.id,
      storageKey: task.storage_key,
      source: task.source,
      attempts: task.attempts,
      governedDispositionId: task.governed_disposition_id,
      organizationDocumentDispositionId: task.organization_document_disposition_id,
      privacyPackageDeliveryId: task.privacy_package_delivery_id,
      privacyExternalCollectionSnapshotId: task.privacy_external_collection_snapshot_id,
      privacyExternalProviderExportId: task.privacy_external_provider_export_id,
    }));
  });
}

export async function markStorageCleanupTaskCompleted(client: PoolClient, taskId: string, workerId: string): Promise<void> {
  const result = await client.query<{
    governed_disposition_id: string | null;
    organization_document_disposition_id: string | null;
    privacy_package_delivery_id: string | null;
    privacy_external_collection_snapshot_id: string | null;
    privacy_external_provider_export_id: string | null;
  }>(
    `UPDATE fractal.storage_cleanup_tasks
        SET completed_at = now(), claimed_at = NULL, claimed_by = NULL, last_error = NULL
      WHERE id = $1 AND claimed_by = $2 AND completed_at IS NULL AND failed_at IS NULL
      RETURNING governed_disposition_id,organization_document_disposition_id,privacy_package_delivery_id,
        privacy_external_collection_snapshot_id,privacy_external_provider_export_id`,
    [taskId, workerId],
  );
  if (result.rowCount !== 1) throw new Error(`Storage cleanup task ${taskId} is no longer claimed by this worker`);
  const dispositionId = result.rows[0]?.governed_disposition_id;
  if (dispositionId) {
    const disposition = await client.query<{ attachment_id: string; case_id: string; content_sha256: string }>(
      `UPDATE fractal.support_attachment_dispositions disposition SET status='completed',completed_at=now()
       FROM fractal.support_case_attachments attachment
       WHERE disposition.id=$1 AND disposition.status='cleanup_requested' AND attachment.id=disposition.attachment_id
       RETURNING disposition.attachment_id,attachment.case_id,disposition.content_sha256`, [dispositionId]);
    const row = disposition.rows[0];
    if (!row) throw new Error(`Governed disposition ${dispositionId} cannot be completed`);
    const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${row.case_id}`, actorType: "worker",
      action: "support.attachment.disposition.completed", entityType: "support_attachment_disposition", entityId: dispositionId,
      reason: "The governed object deletion completed.", payload: { attachmentId: row.attachment_id, contentSha256: row.content_sha256, cleanupTaskId: taskId, workerId } });
    await appendOutboxEvent(client, { aggregateType: "support_attachment_disposition", aggregateId: dispositionId,
      eventType: "support.attachment.disposition.completed", payload: { attachmentId: row.attachment_id, auditEventId: audit.id } });
  }
  const organizationDispositionId = result.rows[0]?.organization_document_disposition_id;
  if (organizationDispositionId) {
    const disposition = await client.query<{ document_id: string; organization_id: string }>(
      `UPDATE fractal.organization_document_dispositions disposition SET status='completed',completed_at=now()
        WHERE disposition.id=$1 AND disposition.status='cleanup_requested'
          AND NOT EXISTS (SELECT 1 FROM fractal.storage_cleanup_tasks task WHERE task.organization_document_disposition_id=disposition.id AND task.completed_at IS NULL)
        RETURNING disposition.document_id,disposition.organization_id`, [organizationDispositionId]);
    const row=disposition.rows[0];
    if(row){
      const audit=await appendPostgresAuditEvent(client,{scopeKey:`organization:${row.organization_id}`,organizationId:row.organization_id,actorType:"worker",action:"organization.document.disposition.completed",entityType:"organization_document_disposition",entityId:organizationDispositionId,reason:"Every governed organization-document version object was deleted.",payload:{documentId:row.document_id,cleanupTaskId:taskId,workerId}});
      await appendOutboxEvent(client,{aggregateType:"organization_document_disposition",aggregateId:organizationDispositionId,eventType:"organization.document.disposition.completed",payload:{documentId:row.document_id,organizationId:row.organization_id,auditEventId:audit.id}});
    }
  }
  const privacyPackageDeliveryId=result.rows[0]?.privacy_package_delivery_id;
  if(privacyPackageDeliveryId){
    const delivery=await client.query<{privacy_request_id:string}>(`UPDATE fractal.privacy_rights_package_deliveries SET status='destroyed',destroyed_at=now()
      WHERE id=$1 AND status='cleanup_requested' RETURNING privacy_request_id`,[privacyPackageDeliveryId]);
    const row=delivery.rows[0];
    if(!row) throw new Error(`Privacy package delivery ${privacyPackageDeliveryId} cannot be completed`);
    const audit=await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${row.privacy_request_id}`,actorType:"worker",action:"privacy.request.package_delivery_destroyed",entityType:"privacy_rights_package_delivery",entityId:privacyPackageDeliveryId,reason:"The retained privacy-package object was deleted after its approved retention period.",payload:{cleanupTaskId:taskId,workerId}});
    await appendOutboxEvent(client,{aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,eventType:"privacy.request.package_delivery_destroyed",payload:{deliveryId:privacyPackageDeliveryId,auditEventId:audit.id}});
  }
  const privacyExternalSnapshotId=result.rows[0]?.privacy_external_collection_snapshot_id;
  if(privacyExternalSnapshotId){
    const snapshot=await client.query<{privacy_request_id:string;source_key:string}>(
      `UPDATE fractal.privacy_external_collection_snapshots
          SET status='destroyed',destroyed_at=now()
        WHERE id=$1 AND status='cleanup_requested'
        RETURNING privacy_request_id,source_key`,
      [privacyExternalSnapshotId],
    );
    const row=snapshot.rows[0];
    if(!row) throw new Error(`External privacy snapshot ${privacyExternalSnapshotId} cannot be completed`);
    const audit=await appendPostgresAuditEvent(client,{
      scopeKey:`privacy-request:${row.privacy_request_id}`,actorType:"worker",
      action:"privacy.request.external_snapshot_destroyed",
      entityType:"privacy_external_collection_snapshot",entityId:privacyExternalSnapshotId,
      reason:"The retained external snapshot object was deleted after its approved retention period.",
      payload:{sourceKey:row.source_key,cleanupTaskId:taskId,workerId},
    });
    await appendOutboxEvent(client,{
      aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,
      eventType:"privacy.request.external_snapshot_destroyed",
      payload:{snapshotId:privacyExternalSnapshotId,sourceKey:row.source_key,auditEventId:audit.id},
    });
  }
  const privacyExternalProviderExportId=result.rows[0]?.privacy_external_provider_export_id;
  if(privacyExternalProviderExportId){
    const providerExport=await client.query<{
      privacy_request_id:string;
      requester_identity_id:string;
      reference:string;
    }>(
      `UPDATE fractal.privacy_external_provider_exports
          SET status='destroyed',destroyed_at=now()
        WHERE id=$1 AND status='cleanup_requested'
        RETURNING privacy_request_id,requester_identity_id,reference`,
      [privacyExternalProviderExportId],
    );
    const row=providerExport.rows[0];
    if(!row) throw new Error(`External provider export ${privacyExternalProviderExportId} cannot be completed`);
    const audit=await appendPostgresAuditEvent(client,{
      scopeKey:`privacy-request:${row.privacy_request_id}`,actorType:"worker",
      action:"privacy.request.sumsub_provider_export_destroyed",
      entityType:"privacy_external_provider_export",entityId:privacyExternalProviderExportId,
      reason:"The retained Sumsub provider-export object was deleted after its approved retention period.",
      payload:{reference:row.reference,cleanupTaskId:taskId,workerId},
    });
    await appendOutboxEvent(client,{
      aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,
      eventType:"privacy.request.sumsub_provider_export_destroyed",
      payload:{providerExportId:privacyExternalProviderExportId,auditEventId:audit.id},
      privacy:{kind:"subjects",subjectIdentityIds:[row.requester_identity_id]},
    });
  }
}

/** Mark a newly queued task complete after the request path deleted it inline. */
export async function markStorageCleanupTaskCompletedInline(taskId: string): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `UPDATE fractal.storage_cleanup_tasks
          SET completed_at = now(), last_error = NULL
        WHERE id = $1 AND claimed_at IS NULL AND completed_at IS NULL AND failed_at IS NULL`,
      [taskId],
    );
    if (result.rowCount !== 1) throw new Error(`Storage cleanup task ${taskId} cannot be completed inline`);
  });
}

export async function markStorageCleanupTaskForRetry(input: {
  taskId: string;
  workerId: string;
  retryAt: Date;
  error: unknown;
  terminal: boolean;
}): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{
      governed_disposition_id: string | null;
      organization_document_disposition_id: string | null;
      privacy_package_delivery_id: string | null;
      privacy_external_collection_snapshot_id: string | null;
      privacy_external_provider_export_id: string | null;
    }>(
      `UPDATE fractal.storage_cleanup_tasks
          SET claimed_at = NULL,
              claimed_by = NULL,
              next_attempt_at = CASE WHEN $4 THEN next_attempt_at ELSE $3 END,
              failed_at = CASE WHEN $4 THEN now() ELSE NULL END,
              last_error = $5
        WHERE id = $1 AND claimed_by = $2 AND completed_at IS NULL AND failed_at IS NULL
        RETURNING governed_disposition_id,organization_document_disposition_id,privacy_package_delivery_id,
          privacy_external_collection_snapshot_id,privacy_external_provider_export_id`,
      [input.taskId, input.workerId, input.retryAt, input.terminal, errorMessage(input.error)],
    );
    if (result.rowCount !== 1) throw new Error(`Storage cleanup task ${input.taskId} is no longer claimed by this worker`);
    const dispositionId = result.rows[0]?.governed_disposition_id;
    if (input.terminal && dispositionId) {
      const disposition = await client.query<{ attachment_id: string; case_id: string; content_sha256: string }>(
        `UPDATE fractal.support_attachment_dispositions disposition SET status='failed',failed_at=now()
         FROM fractal.support_case_attachments attachment
         WHERE disposition.id=$1 AND disposition.status='cleanup_requested' AND attachment.id=disposition.attachment_id
         RETURNING disposition.attachment_id,attachment.case_id,disposition.content_sha256`, [dispositionId]);
      const row = disposition.rows[0];
      if (!row) throw new Error(`Governed disposition ${dispositionId} cannot be marked failed`);
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${row.case_id}`, actorType: "worker",
        action: "support.attachment.disposition.failed", entityType: "support_attachment_disposition", entityId: dispositionId,
        reason: "The governed object deletion exhausted its retry budget.", payload: { attachmentId: row.attachment_id, contentSha256: row.content_sha256, cleanupTaskId: input.taskId, workerId: input.workerId } });
      await appendOutboxEvent(client, { aggregateType: "support_attachment_disposition", aggregateId: dispositionId,
        eventType: "support.attachment.disposition.failed", payload: { attachmentId: row.attachment_id, auditEventId: audit.id } });
    }
    const organizationDispositionId=result.rows[0]?.organization_document_disposition_id;
    if(input.terminal&&organizationDispositionId){
      const disposition=await client.query<{document_id:string;organization_id:string}>(`UPDATE fractal.organization_document_dispositions SET status='failed',failed_at=now() WHERE id=$1 AND status='cleanup_requested' RETURNING document_id,organization_id`,[organizationDispositionId]);
      const row=disposition.rows[0];
      if(row){const audit=await appendPostgresAuditEvent(client,{scopeKey:`organization:${row.organization_id}`,organizationId:row.organization_id,actorType:"worker",action:"organization.document.disposition.failed",entityType:"organization_document_disposition",entityId:organizationDispositionId,reason:"At least one governed organization-document object deletion exhausted its retry budget.",payload:{documentId:row.document_id,cleanupTaskId:input.taskId,workerId:input.workerId}});await appendOutboxEvent(client,{aggregateType:"organization_document_disposition",aggregateId:organizationDispositionId,eventType:"organization.document.disposition.failed",payload:{documentId:row.document_id,organizationId:row.organization_id,auditEventId:audit.id}});}
    }
    const privacyPackageDeliveryId=result.rows[0]?.privacy_package_delivery_id;
    if(input.terminal&&privacyPackageDeliveryId){
      const delivery=await client.query<{privacy_request_id:string}>(`UPDATE fractal.privacy_rights_package_deliveries SET status='cleanup_failed',failure_category='cleanup_failed'
        WHERE id=$1 AND status='cleanup_requested' RETURNING privacy_request_id`,[privacyPackageDeliveryId]);
      const row=delivery.rows[0];
      if(row){const audit=await appendPostgresAuditEvent(client,{scopeKey:`privacy-request:${row.privacy_request_id}`,actorType:"worker",action:"privacy.request.package_delivery_cleanup_failed",entityType:"privacy_rights_package_delivery",entityId:privacyPackageDeliveryId,reason:"Privacy-package deletion exhausted its retry budget and requires incident response.",payload:{cleanupTaskId:input.taskId,workerId:input.workerId}});await appendOutboxEvent(client,{aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,eventType:"privacy.request.package_delivery_cleanup_failed",payload:{deliveryId:privacyPackageDeliveryId,auditEventId:audit.id}});}
    }
    const privacyExternalSnapshotId=result.rows[0]?.privacy_external_collection_snapshot_id;
    if(input.terminal&&privacyExternalSnapshotId){
      const snapshot=await client.query<{privacy_request_id:string;source_key:string}>(
        `UPDATE fractal.privacy_external_collection_snapshots
            SET status='cleanup_failed',failure_category='cleanup_failed'
          WHERE id=$1 AND status='cleanup_requested'
          RETURNING privacy_request_id,source_key`,
        [privacyExternalSnapshotId],
      );
      const row=snapshot.rows[0];
      if(row){
        const audit=await appendPostgresAuditEvent(client,{
          scopeKey:`privacy-request:${row.privacy_request_id}`,actorType:"worker",
          action:"privacy.request.external_snapshot_cleanup_failed",
          entityType:"privacy_external_collection_snapshot",entityId:privacyExternalSnapshotId,
          reason:"External snapshot deletion exhausted its retry budget and requires incident response.",
          payload:{sourceKey:row.source_key,cleanupTaskId:input.taskId,workerId:input.workerId},
        });
        await appendOutboxEvent(client,{
          aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,
          eventType:"privacy.request.external_snapshot_cleanup_failed",
          payload:{snapshotId:privacyExternalSnapshotId,sourceKey:row.source_key,auditEventId:audit.id},
        });
      }
    }
    const privacyExternalProviderExportId=result.rows[0]?.privacy_external_provider_export_id;
    if(input.terminal&&privacyExternalProviderExportId){
      const providerExport=await client.query<{
        privacy_request_id:string;
        requester_identity_id:string;
        reference:string;
      }>(
        `UPDATE fractal.privacy_external_provider_exports
            SET status='cleanup_failed',failure_category='cleanup_failed'
          WHERE id=$1 AND status='cleanup_requested'
          RETURNING privacy_request_id,requester_identity_id,reference`,
        [privacyExternalProviderExportId],
      );
      const row=providerExport.rows[0];
      if(row){
        const audit=await appendPostgresAuditEvent(client,{
          scopeKey:`privacy-request:${row.privacy_request_id}`,actorType:"worker",
          action:"privacy.request.sumsub_provider_export_cleanup_failed",
          entityType:"privacy_external_provider_export",entityId:privacyExternalProviderExportId,
          reason:"Sumsub provider-export deletion exhausted its retry budget and requires incident response.",
          payload:{reference:row.reference,cleanupTaskId:input.taskId,workerId:input.workerId},
        });
        await appendOutboxEvent(client,{
          aggregateType:"privacy_rights_request",aggregateId:row.privacy_request_id,
          eventType:"privacy.request.sumsub_provider_export_cleanup_failed",
          payload:{providerExportId:privacyExternalProviderExportId,auditEventId:audit.id},
          privacy:{kind:"subjects",subjectIdentityIds:[row.requester_identity_id]},
        });
      }
    }
  });
}
