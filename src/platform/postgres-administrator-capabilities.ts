import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres } from "../db/postgres.js";
import { revokeAllAuthSessionsForSubjectInTransaction } from "./auth-sessions.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export type AdministratorCapabilityChangeType = "grant" | "revoke";
export type AdministratorCapabilityChangeStatus = "pending" | "applied" | "rejected" | "cancelled";

export class AdministratorCapabilityError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden" | "conflict" | "invalid_state" | "last_capable_administrator",
  ) {
    super(message);
    this.name = "AdministratorCapabilityError";
  }
}

export interface AdministratorCapabilityChangeRequest {
  id: string;
  targetIdentity: { id: string; email: string; legalName: string };
  capabilityKey: string;
  capabilityLabel: string;
  changeType: AdministratorCapabilityChangeType;
  priorEnabled: boolean;
  reason: string;
  status: AdministratorCapabilityChangeStatus;
  requestedBy: { id: string; email: string; legalName: string };
  reviewedBy: { id: string; email: string; legalName: string } | null;
  decisionReason: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

type CapabilityChangeRow = {
  id: string;
  target_identity_id: string;
  target_email: string;
  target_legal_name: string;
  capability_key: string;
  capability_label: string;
  change_type: AdministratorCapabilityChangeType;
  prior_enabled: boolean;
  reason: string;
  status: AdministratorCapabilityChangeStatus;
  requested_by_identity_id: string;
  requester_email: string;
  requester_legal_name: string;
  reviewed_by_identity_id: string | null;
  reviewer_email: string | null;
  reviewer_legal_name: string | null;
  decision_reason: string | null;
  requested_at: Date;
  reviewed_at: Date | null;
  applied_at: Date | null;
};

const capabilityChangeSelect = `
  SELECT request.id, request.target_identity_id,
         target.email AS target_email, target.legal_name AS target_legal_name,
         request.capability_key, definition.label AS capability_label,
         request.change_type, request.prior_enabled, request.reason, request.status,
         request.requested_by_identity_id,
         requester.email AS requester_email, requester.legal_name AS requester_legal_name,
         request.reviewed_by_identity_id,
         reviewer.email AS reviewer_email, reviewer.legal_name AS reviewer_legal_name,
         request.decision_reason, request.requested_at, request.reviewed_at, request.applied_at
    FROM fractal.administrator_capability_change_requests request
    JOIN fractal.administrator_capability_definitions definition
      ON definition.capability_key = request.capability_key
    JOIN fractal.identities target ON target.id = request.target_identity_id
    JOIN fractal.identities requester ON requester.id = request.requested_by_identity_id
    LEFT JOIN fractal.identities reviewer ON reviewer.id = request.reviewed_by_identity_id`;

function mapCapabilityChange(row: CapabilityChangeRow): AdministratorCapabilityChangeRequest {
  return {
    id: row.id,
    targetIdentity: { id: row.target_identity_id, email: row.target_email, legalName: row.target_legal_name },
    capabilityKey: row.capability_key,
    capabilityLabel: row.capability_label,
    changeType: row.change_type,
    priorEnabled: row.prior_enabled,
    reason: row.reason,
    status: row.status,
    requestedBy: { id: row.requested_by_identity_id, email: row.requester_email, legalName: row.requester_legal_name },
    reviewedBy: row.reviewed_by_identity_id && row.reviewer_email && row.reviewer_legal_name
      ? { id: row.reviewed_by_identity_id, email: row.reviewer_email, legalName: row.reviewer_legal_name }
      : null,
    decisionReason: row.decision_reason,
    requestedAt: row.requested_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    appliedAt: row.applied_at?.toISOString() ?? null,
  };
}

async function activeAdministrator(client: PoolClient, identityId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM fractal.identities identity
       JOIN fractal.identity_role_assignments role
         ON role.identity_id = identity.id
        AND role.scope_type = 'global'
        AND role.role = 'admin'
        AND role.revoked_at IS NULL
      WHERE identity.id = $1 AND identity.status = 'active'`,
    [identityId],
  );
  return Boolean(result.rows[0]);
}

async function assertActiveAdministrator(client: PoolClient, identityId: string): Promise<void> {
  if (!await activeAdministrator(client, identityId)) {
    throw new AdministratorCapabilityError("Active administrator authority is required.", "forbidden");
  }
}

async function capabilityEnabled(client: PoolClient, identityId: string, capabilityKey: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM fractal.administrator_capability_assignments assignment
       JOIN fractal.administrator_capability_definitions definition
         ON definition.capability_key = assignment.capability_key
        AND definition.status = 'active'
      WHERE assignment.identity_id = $1
        AND assignment.capability_key = $2
        AND assignment.revoked_at IS NULL`,
    [identityId, capabilityKey],
  );
  return Boolean(result.rows[0]);
}

export async function requireAdministratorCapability(
  client: PoolClient,
  identityId: string,
  capabilityKey: string,
): Promise<void> {
  await assertActiveAdministrator(client, identityId);
  if (!await capabilityEnabled(client, identityId, capabilityKey)) {
    throw new AdministratorCapabilityError(`Administrator capability ${capabilityKey} is required.`, "forbidden");
  }
}

async function readCapabilityChange(client: PoolClient, requestId: string): Promise<AdministratorCapabilityChangeRequest> {
  const result = await client.query<CapabilityChangeRow>(`${capabilityChangeSelect} WHERE request.id = $1`, [requestId]);
  const row = result.rows[0];
  if (!row) throw new AdministratorCapabilityError("Administrator capability change request not found.", "not_found");
  return mapCapabilityChange(row);
}

export async function listAdministratorCapabilityRegister(input: {
  status?: AdministratorCapabilityChangeStatus;
  query?: string;
}) {
  const query = input.query?.trim() || null;
  const [definitions, assignments, requests] = await Promise.all([
    requirePostgres().query<{ capability_key: string; label: string; description: string; status: "active" | "retired" }>(
      `SELECT capability_key, label, description, status
         FROM fractal.administrator_capability_definitions
        ORDER BY capability_key`,
    ),
    requirePostgres().query<{ identity_id: string; email: string; legal_name: string; capability_key: string; granted_at: Date }>(
      `SELECT assignment.identity_id, identity.email, identity.legal_name,
              assignment.capability_key, assignment.granted_at
         FROM fractal.administrator_capability_assignments assignment
         JOIN fractal.identities identity ON identity.id = assignment.identity_id
        WHERE assignment.revoked_at IS NULL
          AND ($1::text IS NULL OR identity.email ILIKE '%' || $1 || '%'
               OR identity.legal_name ILIKE '%' || $1 || '%')
        ORDER BY identity.legal_name, identity.id, assignment.capability_key
        LIMIT 500`,
      [query],
    ),
    requirePostgres().query<CapabilityChangeRow>(
      `${capabilityChangeSelect}
        WHERE ($1::text IS NULL OR request.status = $1)
          AND ($2::text IS NULL OR target.email ILIKE '%' || $2 || '%'
               OR target.legal_name ILIKE '%' || $2 || '%'
               OR request.capability_key ILIKE '%' || $2 || '%')
        ORDER BY request.requested_at DESC, request.id DESC
        LIMIT 200`,
      [input.status ?? null, query],
    ),
  ]);
  return {
    capabilities: definitions.rows.map((row) => ({
      key: row.capability_key,
      label: row.label,
      description: row.description,
      status: row.status,
    })),
    assignments: assignments.rows.map((row) => ({
      identityId: row.identity_id,
      email: row.email,
      legalName: row.legal_name,
      capabilityKey: row.capability_key,
      grantedAt: row.granted_at.toISOString(),
    })),
    requests: requests.rows.map(mapCapabilityChange),
  };
}

export async function createAdministratorCapabilityChangeRequest(input: {
  actorIdentityId: string;
  targetIdentityId: string;
  capabilityKey: string;
  changeType: AdministratorCapabilityChangeType;
  reason: string;
  commandKey: string;
}) {
  const result = await runPostgresIdempotentCommand<{ request: AdministratorCapabilityChangeRequest }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `administrator-capability:${input.actorIdentityId}`,
    route: "POST:/v1/admin/capability-change-requests",
    commandKey: input.commandKey,
    payload: {
      targetIdentityId: input.targetIdentityId,
      capabilityKey: input.capabilityKey,
      changeType: input.changeType,
      reason: input.reason,
    },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await assertActiveAdministrator(client, input.actorIdentityId);
      if (input.actorIdentityId === input.targetIdentityId) {
        throw new AdministratorCapabilityError("Administrators cannot propose changes to their own capabilities.", "forbidden");
      }
      await assertActiveAdministrator(client, input.targetIdentityId);
      const definition = await client.query<{ status: string }>(
        "SELECT status FROM fractal.administrator_capability_definitions WHERE capability_key = $1 FOR SHARE",
        [input.capabilityKey],
      );
      if (!definition.rows[0]) throw new AdministratorCapabilityError("Administrator capability not found.", "not_found");
      if (definition.rows[0].status !== "active") throw new AdministratorCapabilityError("Administrator capability is not active.", "invalid_state");
      const priorEnabled = await capabilityEnabled(client, input.targetIdentityId, input.capabilityKey);
      if ((input.changeType === "grant") === priorEnabled) {
        throw new AdministratorCapabilityError(
          priorEnabled ? "The administrator already has this capability." : "The administrator does not have this capability.",
          "invalid_state",
        );
      }
      const id = randomUUID();
      try {
        await client.query(
          `INSERT INTO fractal.administrator_capability_change_requests
             (id, target_identity_id, capability_key, change_type, prior_enabled, reason, requested_by_identity_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, input.targetIdentityId, input.capabilityKey, input.changeType, priorEnabled, input.reason, input.actorIdentityId],
        );
      } catch (error) {
        const databaseError = error as { code?: string; constraint?: string };
        if (databaseError.code === "23505" && databaseError.constraint === "administrator_capability_change_pending_unique_idx") {
          throw new AdministratorCapabilityError("This administrator already has a pending change for that capability.", "conflict");
        }
        throw error;
      }
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `identity:${input.targetIdentityId}`,
        actorId: input.actorIdentityId,
        actorType: "user",
        action: "administrator.capability_change.requested",
        entityType: "administrator_capability_change_request",
        entityId: id,
        reason: input.reason,
        payload: { capabilityKey: input.capabilityKey, changeType: input.changeType, priorEnabled },
      });
      await appendOutboxEvent(client, {
        aggregateType: "administrator_capability_change_request",
        aggregateId: id,
        eventType: "administrator.capability_change.requested",
        payload: { targetIdentityId: input.targetIdentityId, capabilityKey: input.capabilityKey, auditEventId: audit.id },
      });
      return { status: 201, body: { request: await readCapabilityChange(client, id) } };
    },
  });
  return { request: result.body.request, replayed: result.replayed };
}

export async function decideAdministratorCapabilityChangeRequest(input: {
  actorIdentityId: string;
  requestId: string;
  decision: "approve" | "reject";
  reason: string;
  commandKey: string;
}) {
  const result = await runPostgresIdempotentCommand<{ request: AdministratorCapabilityChangeRequest }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `administrator-capability:${input.actorIdentityId}`,
    route: `POST:/v1/admin/capability-change-requests/${input.requestId}/decision`,
    commandKey: input.commandKey,
    payload: { decision: input.decision, reason: input.reason },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fractal.administrator_authority_governance'))");
      await assertActiveAdministrator(client, input.actorIdentityId);
      const locked = await client.query<{
        id: string;
        target_identity_id: string;
        capability_key: string;
        change_type: AdministratorCapabilityChangeType;
        prior_enabled: boolean;
        status: AdministratorCapabilityChangeStatus;
        requested_by_identity_id: string;
      }>(
        `SELECT id, target_identity_id, capability_key, change_type, prior_enabled, status, requested_by_identity_id
           FROM fractal.administrator_capability_change_requests
          WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const request = locked.rows[0];
      if (!request) throw new AdministratorCapabilityError("Administrator capability change request not found.", "not_found");
      if (request.status !== "pending") throw new AdministratorCapabilityError("This capability change has already been decided.", "conflict");
      if (request.requested_by_identity_id === input.actorIdentityId) {
        throw new AdministratorCapabilityError("The requesting administrator cannot review the same capability change.", "forbidden");
      }
      if (request.target_identity_id === input.actorIdentityId) {
        throw new AdministratorCapabilityError("Administrators cannot decide changes to their own capabilities.", "forbidden");
      }
      await assertActiveAdministrator(client, request.requested_by_identity_id);
      await assertActiveAdministrator(client, request.target_identity_id);

      if (input.decision === "reject") {
        await client.query(
          `UPDATE fractal.administrator_capability_change_requests
              SET status = 'rejected', reviewed_by_identity_id = $2,
                  decision_reason = $3, reviewed_at = now()
            WHERE id = $1`,
          [request.id, input.actorIdentityId, input.reason],
        );
      } else {
        const enabled = await capabilityEnabled(client, request.target_identity_id, request.capability_key);
        if (enabled !== request.prior_enabled) {
          throw new AdministratorCapabilityError("The target capability state changed after this request was submitted.", "conflict");
        }
        if (request.change_type === "revoke") {
          const remaining = await client.query<{ count: string }>(
            `SELECT count(DISTINCT assignment.identity_id)::text AS count
               FROM fractal.administrator_capability_assignments assignment
               JOIN fractal.identities identity ON identity.id = assignment.identity_id AND identity.status = 'active'
               JOIN fractal.identity_role_assignments role
                 ON role.identity_id = identity.id AND role.scope_type = 'global'
                AND role.role = 'admin' AND role.revoked_at IS NULL
              WHERE assignment.capability_key = $1
                AND assignment.revoked_at IS NULL
                AND assignment.identity_id <> $2`,
            [request.capability_key, request.target_identity_id],
          );
          if (Number(remaining.rows[0]?.count ?? 0) < 2) {
            throw new AdministratorCapabilityError(
              "This revocation would leave fewer than two active administrators with the capability.",
              "last_capable_administrator",
            );
          }
          await client.query(
            `UPDATE fractal.administrator_capability_assignments
                SET revoked_at = now(), revoked_by_capability_change_request_id = $3
              WHERE identity_id = $1 AND capability_key = $2 AND revoked_at IS NULL`,
            [request.target_identity_id, request.capability_key, request.id],
          );
        } else {
          await client.query(
            `INSERT INTO fractal.administrator_capability_assignments
               (id, identity_id, capability_key, granted_by_request_id)
             VALUES ($1, $2, $3, $4)`,
            [randomUUID(), request.target_identity_id, request.capability_key, request.id],
          );
        }
        await client.query(
          `UPDATE fractal.administrator_capability_change_requests
              SET status = 'applied', reviewed_by_identity_id = $2,
                  decision_reason = $3, reviewed_at = now(), applied_at = now()
            WHERE id = $1`,
          [request.id, input.actorIdentityId, input.reason],
        );
        await revokeAllAuthSessionsForSubjectInTransaction(client, request.target_identity_id, "administrator_capability_change");
      }

      const action = input.decision === "approve" ? "applied" : "rejected";
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `identity:${request.target_identity_id}`,
        actorId: input.actorIdentityId,
        actorType: "user",
        action: `administrator.capability_change.${action}`,
        entityType: "administrator_capability_change_request",
        entityId: request.id,
        reason: input.reason,
        payload: { capabilityKey: request.capability_key, changeType: request.change_type },
      });
      await appendOutboxEvent(client, {
        aggregateType: "administrator_capability_change_request",
        aggregateId: request.id,
        eventType: `administrator.capability_change.${action}`,
        payload: { targetIdentityId: request.target_identity_id, capabilityKey: request.capability_key, auditEventId: audit.id },
      });
      return { status: 200, body: { request: await readCapabilityChange(client, request.id) } };
    },
  });
  return { request: result.body.request, replayed: result.replayed };
}
