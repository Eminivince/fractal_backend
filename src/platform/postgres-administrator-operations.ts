import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import { revokeAllAuthSessionsForIdentityInTransaction } from "./auth-sessions.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { enqueueAdministratorActivationDelivery } from "./postgres-auth-email-deliveries.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

const ADMINISTRATOR_BOOTSTRAP_LOCK = "fractal.administrator_bootstrap";
const ADMINISTRATOR_RECOVERY_LOCK = "fractal.administrator_recovery";
const RECOVERY_WINDOW_MINUTES = 30;

export class AdministratorOperationsError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_input" | "sealed" | "conflict" | "not_found" | "forbidden" | "expired",
  ) {
    super(message);
    this.name = "AdministratorOperationsError";
  }
}

export interface AdministratorBootstrapMember {
  email: string;
  legalName: string;
}

export interface AdministratorBootstrapResult {
  cohortId: string;
  identityIds: string[];
  cohortSize: number;
  sealedAt: string;
}

export interface AdministratorRecoveryRequest {
  id: string;
  targetIdentityId: string;
  incidentReference: string;
  status: "pending" | "applied" | "expired";
  requestedAt: string;
  expiresAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

export interface AdministratorOperationsStatus {
  bootstrap: null | {
    cohortId: string;
    cohortSize: number;
    sealedAt: string;
  };
  recovery: {
    pendingCount: number;
    overduePendingCount: number;
    appliedCount: number;
    expiredCount: number;
    earliestPendingExpiry: string | null;
  };
}

type RecoveryRow = {
  id: string;
  target_identity_id: string;
  incident_reference: string;
  status: "pending" | "applied" | "expired";
  requested_by: string;
  requester_key_fingerprint: string;
  requested_at: Date;
  expires_at: Date;
  reviewed_at: Date | null;
  applied_at: Date | null;
};

function requiredText(value: string, field: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new AdministratorOperationsError(`${field} must contain between ${minimum} and ${maximum} characters.`, "invalid_input");
  }
  return normalized;
}

function normalizedEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AdministratorOperationsError("Each bootstrap or recovery email address must be valid.", "invalid_input");
  }
  return email;
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

function normalizedFingerprint(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new AdministratorOperationsError(`${field} is not a valid authorization-key fingerprint.`, "invalid_input");
  }
  return normalized;
}

function validateUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(normalized)) {
    throw new AdministratorOperationsError(`${field} must be a UUID.`, "invalid_input");
  }
  return normalized;
}

function mapRecovery(row: RecoveryRow): AdministratorRecoveryRequest {
  return {
    id: row.id,
    targetIdentityId: row.target_identity_id,
    incidentReference: row.incident_reference,
    status: row.status,
    requestedAt: row.requested_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    appliedAt: row.applied_at?.toISOString() ?? null,
  };
}

async function appendRecoveryExpiredEvidence(client: PoolClient, row: Pick<RecoveryRow, "id" | "target_identity_id">): Promise<void> {
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `identity:${row.target_identity_id}`,
    actorType: "system",
    action: "identity.administrator_recovery.expired",
    entityType: "administrator_recovery_request",
    entityId: row.id,
    payload: {},
  });
  await appendOutboxEvent(client, {
    aggregateType: "administrator_recovery_request",
    aggregateId: row.id,
    eventType: "identity.administrator_recovery.expired",
    payload: { targetIdentityId: row.target_identity_id, auditEventId: audit.id },
  });
}

async function expireStaleRecoveryRequests(client: PoolClient): Promise<void> {
  const expired = await client.query<Pick<RecoveryRow, "id" | "target_identity_id">>(
    `UPDATE fractal.administrator_recovery_requests
        SET status = 'expired', reviewed_at = now()
      WHERE status = 'pending' AND expires_at <= now()
      RETURNING id, target_identity_id`,
  );
  for (const row of expired.rows) await appendRecoveryExpiredEvidence(client, row);
}

async function lockHistoricalAdministratorByEmail(client: PoolClient, email: string): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `SELECT identity.id
       FROM fractal.identities identity
      WHERE identity.email = $1
        AND EXISTS (
          SELECT 1 FROM fractal.identity_role_assignments assignment
           WHERE assignment.identity_id = identity.id AND assignment.role = 'admin'
        )
      FOR UPDATE`,
    [email],
  );
  const identity = result.rows[0];
  if (!identity) throw new AdministratorOperationsError("A historical administrator identity was not found.", "not_found");
  return identity;
}

async function lockHistoricalAdministratorById(client: PoolClient, identityId: string): Promise<void> {
  const result = await client.query(
    `SELECT identity.id
       FROM fractal.identities identity
      WHERE identity.id = $1
        AND EXISTS (
          SELECT 1 FROM fractal.identity_role_assignments assignment
           WHERE assignment.identity_id = identity.id AND assignment.role = 'admin'
        )
      FOR UPDATE`,
    [identityId],
  );
  if (result.rowCount !== 1) {
    throw new AdministratorOperationsError("The recovery target has no historical administrator authority.", "forbidden");
  }
}

/** Hashes an injected operations secret without ever persisting or logging it. */
export function administratorOperationsKeyFingerprint(key: string): string {
  if (Buffer.byteLength(key, "utf8") < 32) {
    throw new AdministratorOperationsError("Administrator operations keys must contain at least 32 bytes.", "invalid_input");
  }
  return createHash("sha256").update(key, "utf8").digest("hex");
}

/**
 * Creates the only permitted initial administrator cohort and seals the path
 * permanently. It refuses any environment with current or historical admin
 * assignments so it cannot become a second provisioning mechanism.
 */
export async function bootstrapAdministratorCohort(input: {
  members: AdministratorBootstrapMember[];
  initiatedBy: string;
}): Promise<AdministratorBootstrapResult> {
  if (input.members.length < 3 || input.members.length > 5) {
    throw new AdministratorOperationsError("The initial administrator cohort must contain between 3 and 5 members.", "invalid_input");
  }
  const initiatedBy = requiredText(input.initiatedBy, "Initiating operator", 3, 200);
  const members = input.members.map((member) => ({
    email: normalizedEmail(member.email),
    legalName: requiredText(member.legalName, "Administrator legal name", 1, 200),
  })).sort((left, right) => left.email.localeCompare(right.email));
  if (new Set(members.map((member) => member.email)).size !== members.length) {
    throw new AdministratorOperationsError("The initial administrator cohort contains a duplicate email address.", "invalid_input");
  }

  return withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ADMINISTRATOR_BOOTSTRAP_LOCK]);
    const sealed = await client.query("SELECT 1 FROM fractal.administrator_bootstrap_state");
    if (sealed.rowCount) throw new AdministratorOperationsError("Initial administrator bootstrap is permanently sealed.", "sealed");
    const historicalAdministrator = await client.query(
      "SELECT 1 FROM fractal.identity_role_assignments WHERE role = 'admin' LIMIT 1",
    );
    if (historicalAdministrator.rowCount) {
      throw new AdministratorOperationsError("Administrator history already exists; initial bootstrap is forbidden.", "sealed");
    }
    const existingIdentity = await client.query<{ email: string }>(
      "SELECT email FROM fractal.identities WHERE email = ANY($1::text[]) LIMIT 1 FOR UPDATE",
      [members.map((member) => member.email)],
    );
    if (existingIdentity.rowCount) {
      throw new AdministratorOperationsError("A bootstrap cohort email is already attached to an identity.", "conflict");
    }

    const cohortId = randomUUID();
    const cohortFingerprint = fingerprint(members);
    const state = await client.query<{ sealed_at: Date }>(
      `INSERT INTO fractal.administrator_bootstrap_state
         (singleton, cohort_id, cohort_size, cohort_fingerprint, initiated_by)
       VALUES (TRUE, $1, $2, $3, $4)
       RETURNING sealed_at`,
      [cohortId, members.length, cohortFingerprint, initiatedBy],
    );
    const identityIds: string[] = [];
    for (const member of members) {
      const identityId = randomUUID();
      identityIds.push(identityId);
      await client.query(
        `INSERT INTO fractal.identities
           (id, email, legal_name, status, password_hash, email_verified_at, credential_invalidated_at)
         VALUES ($1, $2, $3, 'active', NULL, NULL, now())`,
        [identityId, member.email, member.legalName],
      );
      await client.query(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global')`,
        [randomUUID(), identityId],
      );
      const capabilities = await client.query<{ capability_key: string }>(
        "SELECT capability_key FROM fractal.administrator_capability_definitions WHERE status = 'active' ORDER BY capability_key",
      );
      for (const capability of capabilities.rows) {
        await client.query(
          `INSERT INTO fractal.administrator_capability_assignments (id, identity_id, capability_key)
           VALUES ($1, $2, $3)`,
          [randomUUID(), identityId, capability.capability_key],
        );
      }
      await enqueueAdministratorActivationDelivery(client, identityId);
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `identity:${identityId}`,
        actorType: "operator",
        action: "identity.administrator_bootstrap.provisioned",
        entityType: "identity",
        entityId: identityId,
        payload: { cohortId },
      });
      await appendOutboxEvent(client, {
        aggregateType: "identity",
        aggregateId: identityId,
        eventType: "identity.administrator_bootstrap.provisioned",
        payload: { cohortId, auditEventId: audit.id },
      });
    }
    const cohortAudit = await appendPostgresAuditEvent(client, {
      scopeKey: `administrator-bootstrap:${cohortId}`,
      actorType: "operator",
      action: "identity.administrator_bootstrap.sealed",
      entityType: "administrator_bootstrap_cohort",
      entityId: cohortId,
      payload: { cohortSize: members.length, cohortFingerprint, initiatedBy },
    });
    await appendOutboxEvent(client, {
      aggregateType: "administrator_bootstrap_cohort",
      aggregateId: cohortId,
      eventType: "identity.administrator_bootstrap.sealed",
      payload: { cohortSize: members.length, auditEventId: cohortAudit.id },
    });
    const sealedAt = state.rows[0]?.sealed_at;
    if (!sealedAt) throw new Error("Administrator bootstrap seal timestamp was not returned");
    return { cohortId, identityIds, cohortSize: members.length, sealedAt: sealedAt.toISOString() };
  });
}

export async function createAdministratorRecoveryRequest(input: {
  targetEmail: string;
  incidentReference: string;
  reason: string;
  requestedBy: string;
  requesterKeyFingerprint: string;
}): Promise<AdministratorRecoveryRequest> {
  const targetEmail = normalizedEmail(input.targetEmail);
  const incidentReference = requiredText(input.incidentReference, "Incident reference", 6, 200);
  const reason = requiredText(input.reason, "Recovery reason", 20, 2000);
  const requestedBy = requiredText(input.requestedBy, "Requesting operator", 3, 200);
  const requesterKeyFingerprint = normalizedFingerprint(input.requesterKeyFingerprint, "Requester key fingerprint");

  return withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ADMINISTRATOR_RECOVERY_LOCK]);
    await expireStaleRecoveryRequests(client);
    const target = await lockHistoricalAdministratorByEmail(client, targetEmail);
    const pending = await client.query(
      "SELECT 1 FROM fractal.administrator_recovery_requests WHERE target_identity_id = $1 AND status = 'pending'",
      [target.id],
    );
    if (pending.rowCount) throw new AdministratorOperationsError("A recovery request is already pending for this identity.", "conflict");

    const requestId = randomUUID();
    const inserted = await client.query<RecoveryRow>(
      `INSERT INTO fractal.administrator_recovery_requests
         (id, target_identity_id, incident_reference, reason, requested_by,
          requester_key_fingerprint, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + ($7 * interval '1 minute'))
       RETURNING id, target_identity_id, incident_reference, status, requested_by,
                 requester_key_fingerprint, requested_at, expires_at, reviewed_at, applied_at`,
      [requestId, target.id, incidentReference, reason, requestedBy, requesterKeyFingerprint, RECOVERY_WINDOW_MINUTES],
    );
    const row = inserted.rows[0];
    if (!row) throw new Error("Administrator recovery request was not returned");
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${target.id}`,
      actorType: "operator",
      action: "identity.administrator_recovery.requested",
      entityType: "administrator_recovery_request",
      entityId: requestId,
      reason,
      payload: { incidentReference, requestedBy, expiresAt: row.expires_at.toISOString() },
    });
    await appendOutboxEvent(client, {
      aggregateType: "administrator_recovery_request",
      aggregateId: requestId,
      eventType: "identity.administrator_recovery.requested",
      payload: { targetIdentityId: target.id, auditEventId: audit.id },
    });
    return mapRecovery(row);
  });
}

export async function approveAdministratorRecoveryRequest(input: {
  requestId: string;
  approvedBy: string;
  approverKeyFingerprint: string;
}): Promise<{ request: AdministratorRecoveryRequest; activationDeliveryId: string; revokedSessionCount: number }> {
  const requestId = validateUuid(input.requestId, "Recovery request ID");
  const approvedBy = requiredText(input.approvedBy, "Approving operator", 3, 200);
  const approverKeyFingerprint = normalizedFingerprint(input.approverKeyFingerprint, "Approver key fingerprint");

  const result = await withPostgresTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [ADMINISTRATOR_RECOVERY_LOCK]);
    const locked = await client.query<RecoveryRow>(
      `SELECT id, target_identity_id, incident_reference, status, requested_by,
              requester_key_fingerprint, requested_at, expires_at, reviewed_at, applied_at
         FROM fractal.administrator_recovery_requests
        WHERE id = $1
        FOR UPDATE`,
      [requestId],
    );
    const request = locked.rows[0];
    if (!request) throw new AdministratorOperationsError("Administrator recovery request was not found.", "not_found");
    if (request.status !== "pending") {
      throw new AdministratorOperationsError("Administrator recovery request is no longer pending.", "conflict");
    }
    if (request.expires_at.getTime() <= Date.now()) {
      await client.query(
        "UPDATE fractal.administrator_recovery_requests SET status = 'expired', reviewed_at = now() WHERE id = $1",
        [request.id],
      );
      await appendRecoveryExpiredEvidence(client, request);
      return { expired: true as const };
    }
    if (approvedBy === request.requested_by) {
      throw new AdministratorOperationsError("The requesting operator cannot approve the same recovery.", "forbidden");
    }
    if (approverKeyFingerprint === request.requester_key_fingerprint.trim()) {
      throw new AdministratorOperationsError("Recovery approval requires a distinct authorization key.", "forbidden");
    }

    await lockHistoricalAdministratorById(client, request.target_identity_id);
    const cancelledAccess = await client.query<{ id: string }>(
      `UPDATE fractal.identity_access_change_requests
          SET status = 'cancelled'
        WHERE target_identity_id = $1 AND status = 'pending'
        RETURNING id`,
      [request.target_identity_id],
    );
    await client.query(
      `UPDATE fractal.identity_role_assignments
          SET revoked_at = now()
        WHERE identity_id = $1 AND scope_type = 'global' AND revoked_at IS NULL`,
      [request.target_identity_id],
    );
    await client.query(
      `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type, granted_at)
       VALUES ($1, $2, 'admin', 'global', now())
       ON CONFLICT (identity_id, role, scope_type, scope_id)
       DO UPDATE SET revoked_at = NULL, granted_at = now()`,
      [randomUUID(), request.target_identity_id],
    );
    await client.query(
      `UPDATE fractal.identities
          SET status = 'active', password_hash = NULL, email_verified_at = NULL,
              credential_invalidated_at = now(),
              email_verification_token_hash = NULL, email_verification_expires_at = NULL,
              password_reset_token_hash = NULL, password_reset_expires_at = NULL, password_reset_purpose = NULL,
              updated_at = now()
        WHERE id = $1`,
      [request.target_identity_id],
    );
    const revokedSessionCount = await revokeAllAuthSessionsForIdentityInTransaction(
      client,
      request.target_identity_id,
      "administrator_break_glass_recovery",
    );
    await client.query("DELETE FROM fractal.auth_step_up_grants WHERE identity_id = $1", [request.target_identity_id]);
    await client.query(
      `UPDATE fractal.totp_factors
          SET secret_ciphertext = $2, confirmed_at = NULL, last_used_counter = NULL,
              disabled_at = now(), updated_at = now()
        WHERE identity_id = $1`,
      [request.target_identity_id, `disabled:administrator-recovery:${randomUUID()}`],
    );
    await client.query(
      `UPDATE fractal.totp_recovery_codes
          SET replaced_at = now()
        WHERE identity_id = $1 AND used_at IS NULL AND replaced_at IS NULL`,
      [request.target_identity_id],
    );
    await client.query(
      `UPDATE fractal.auth_email_deliveries
          SET status = 'terminal', claimed_at = NULL, claimed_by = NULL,
              terminal_at = now(), last_error = 'superseded by administrator recovery',
              updated_at = now()
        WHERE identity_id = $1 AND status IN ('requested', 'failed')`,
      [request.target_identity_id],
    );
    const activationDeliveryId = await enqueueAdministratorActivationDelivery(client, request.target_identity_id);
    const updated = await client.query<RecoveryRow>(
      `UPDATE fractal.administrator_recovery_requests
          SET status = 'applied', approved_by = $2, approver_key_fingerprint = $3,
              reviewed_at = now(), applied_at = now()
        WHERE id = $1
        RETURNING id, target_identity_id, incident_reference, status, requested_by,
                  requester_key_fingerprint, requested_at, expires_at, reviewed_at, applied_at`,
      [request.id, approvedBy, approverKeyFingerprint],
    );
    const applied = updated.rows[0];
    if (!applied) throw new Error("Applied administrator recovery request was not returned");
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${request.target_identity_id}`,
      actorType: "operator",
      action: "identity.administrator_recovery.applied",
      entityType: "administrator_recovery_request",
      entityId: request.id,
      payload: {
        incidentReference: request.incident_reference,
        approvedBy,
        cancelledAccessRequestCount: cancelledAccess.rowCount ?? 0,
        revokedSessionCount,
        activationDeliveryId,
      },
    });
    await appendOutboxEvent(client, {
      aggregateType: "administrator_recovery_request",
      aggregateId: request.id,
      eventType: "identity.administrator_recovery.applied",
      payload: { targetIdentityId: request.target_identity_id, activationDeliveryId, auditEventId: audit.id },
    });
    return {
      expired: false as const,
      request: mapRecovery(applied),
      activationDeliveryId,
      revokedSessionCount,
    };
  });

  if (result.expired) {
    throw new AdministratorOperationsError("Administrator recovery request expired before approval.", "expired");
  }
  return result;
}

/** Aggregate-only status suitable for a one-shot operations job. */
export async function readAdministratorOperationsStatus(): Promise<AdministratorOperationsStatus> {
  const bootstrap = await requirePostgres().query<{ cohort_id: string; cohort_size: number; sealed_at: Date }>(
    "SELECT cohort_id, cohort_size, sealed_at FROM fractal.administrator_bootstrap_state WHERE singleton = TRUE",
  );
  const recovery = await requirePostgres().query<{
    pending_count: number;
    overdue_pending_count: number;
    applied_count: number;
    expired_count: number;
    earliest_pending_expiry: Date | null;
  }>(
    `SELECT
       count(*) FILTER (WHERE status = 'pending' AND expires_at > now())::integer AS pending_count,
       count(*) FILTER (WHERE status = 'pending' AND expires_at <= now())::integer AS overdue_pending_count,
       count(*) FILTER (WHERE status = 'applied')::integer AS applied_count,
       count(*) FILTER (WHERE status = 'expired')::integer AS expired_count,
       min(expires_at) FILTER (WHERE status = 'pending' AND expires_at > now()) AS earliest_pending_expiry
     FROM fractal.administrator_recovery_requests`,
  );
  const bootstrapRow = bootstrap.rows[0];
  const recoveryRow = recovery.rows[0];
  return {
    bootstrap: bootstrapRow ? {
      cohortId: bootstrapRow.cohort_id,
      cohortSize: bootstrapRow.cohort_size,
      sealedAt: bootstrapRow.sealed_at.toISOString(),
    } : null,
    recovery: {
      pendingCount: recoveryRow?.pending_count ?? 0,
      overduePendingCount: recoveryRow?.overdue_pending_count ?? 0,
      appliedCount: recoveryRow?.applied_count ?? 0,
      expiredCount: recoveryRow?.expired_count ?? 0,
      earliestPendingExpiry: recoveryRow?.earliest_pending_expiry?.toISOString() ?? null,
    },
  };
}
