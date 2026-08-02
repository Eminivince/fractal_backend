import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres } from "../db/postgres.js";
import type { Role } from "../utils/constants.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { PostgresIdempotencyConflictError, runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { revokeAllAuthSessionsForSubjectInTransaction } from "./auth-sessions.js";

export type IdentityAccessChangeType = "change_role" | "suspend" | "restore";
export type IdentityAccessChangeStatus = "pending" | "applied" | "rejected" | "cancelled";

export class IdentityAccessGovernanceError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "conflict"
      | "forbidden"
      | "invalid_state"
      | "last_administrator",
  ) {
    super(message);
    this.name = "IdentityAccessGovernanceError";
  }
}

export interface IdentityAccessChangeRequest {
  id: string;
  targetIdentity: { id: string; email: string; legalName: string };
  changeType: IdentityAccessChangeType;
  priorRole: Role | null;
  proposedRole: Role | null;
  priorStatus: "active" | "disabled";
  reason: string;
  status: IdentityAccessChangeStatus;
  requestedBy: { id: string; email: string; legalName: string };
  reviewedBy: { id: string; email: string; legalName: string } | null;
  decisionReason: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  appliedAt: string | null;
}

type AccessRequestRow = {
  id: string;
  target_identity_id: string;
  target_email: string;
  target_legal_name: string;
  change_type: IdentityAccessChangeType;
  prior_role: Role | null;
  proposed_role: Role | null;
  prior_status: "active" | "disabled";
  reason: string;
  status: IdentityAccessChangeStatus;
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
  cursor_requested_at: string;
};

type IdentityState = {
  id: string;
  email: string;
  legalName: string;
  status: "active" | "disabled";
  role: Role;
};

const requestSelect = `
  SELECT request.id, request.target_identity_id,
         target.email AS target_email, target.legal_name AS target_legal_name,
         request.change_type, request.prior_role, request.proposed_role, request.prior_status,
         request.reason, request.status, request.requested_by_identity_id,
         requester.email AS requester_email, requester.legal_name AS requester_legal_name,
         request.reviewed_by_identity_id,
         reviewer.email AS reviewer_email, reviewer.legal_name AS reviewer_legal_name,
         request.decision_reason, request.requested_at, request.reviewed_at, request.applied_at,
         to_char(request.requested_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_requested_at
    FROM fractal.identity_access_change_requests request
    JOIN fractal.identities target ON target.id = request.target_identity_id
    JOIN fractal.identities requester ON requester.id = request.requested_by_identity_id
    LEFT JOIN fractal.identities reviewer ON reviewer.id = request.reviewed_by_identity_id`;

function mapRequest(row: AccessRequestRow): IdentityAccessChangeRequest {
  return {
    id: row.id,
    targetIdentity: { id: row.target_identity_id, email: row.target_email, legalName: row.target_legal_name },
    changeType: row.change_type,
    priorRole: row.prior_role,
    proposedRole: row.proposed_role,
    priorStatus: row.prior_status,
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

async function lockIdentityState(client: PoolClient, identityId: string): Promise<IdentityState> {
  const identity = await client.query<{
    id: string; email: string; legal_name: string; status: "active" | "disabled";
  }>("SELECT id, email, legal_name, status FROM fractal.identities WHERE id = $1 FOR UPDATE", [identityId]);
  const row = identity.rows[0];
  if (!row) throw new IdentityAccessGovernanceError("Identity not found.", "not_found");
  const activeRoles = await client.query<{ role: Role }>(
    `SELECT role FROM fractal.identity_role_assignments
      WHERE identity_id = $1 AND scope_type = 'global' AND revoked_at IS NULL
      ORDER BY granted_at DESC, id DESC
      FOR UPDATE`,
    [identityId],
  );
  if (activeRoles.rows.length !== 1) {
    throw new IdentityAccessGovernanceError(
      "The identity does not have exactly one active global role and requires data-integrity review.",
      "invalid_state",
    );
  }
  return { id: row.id, email: row.email, legalName: row.legal_name, status: row.status, role: activeRoles.rows[0]!.role };
}

async function isActiveAdministrator(client: PoolClient, identityId: string): Promise<boolean> {
  const result = await client.query(
    `SELECT 1
       FROM fractal.identities identity
       JOIN fractal.identity_role_assignments assignment
         ON assignment.identity_id = identity.id
        AND assignment.scope_type = 'global'
        AND assignment.role = 'admin'
        AND assignment.revoked_at IS NULL
      WHERE identity.id = $1 AND identity.status = 'active'`,
    [identityId],
  );
  return Boolean(result.rows[0]);
}

async function assertActiveAdministrator(client: PoolClient, identityId: string): Promise<void> {
  if (!await isActiveAdministrator(client, identityId)) {
    throw new IdentityAccessGovernanceError("Active administrator authority is required.", "forbidden");
  }
}

async function readRequest(client: PoolClient, requestId: string): Promise<IdentityAccessChangeRequest> {
  const result = await client.query<AccessRequestRow>(`${requestSelect} WHERE request.id = $1`, [requestId]);
  const row = result.rows[0];
  if (!row) throw new IdentityAccessGovernanceError("Access change request not found.", "not_found");
  return mapRequest(row);
}

function commandExpiry(): Date {
  return new Date(Date.now() + 24 * 60 * 60 * 1_000);
}

export async function createIdentityAccessChangeRequest(input: {
  actorIdentityId: string;
  targetIdentityId: string;
  changeType: IdentityAccessChangeType;
  proposedRole?: Role;
  reason: string;
  commandKey: string;
}): Promise<{ request: IdentityAccessChangeRequest; replayed: boolean }> {
  try {
    const result = await runPostgresIdempotentCommand<{ request: IdentityAccessChangeRequest }>({
      actorIdentityId: input.actorIdentityId,
      scopeKey: `identity:${input.actorIdentityId}`,
      route: "POST:/v1/admin/access-change-requests",
      commandKey: input.commandKey,
      payload: {
        targetIdentityId: input.targetIdentityId,
        changeType: input.changeType,
        proposedRole: input.proposedRole ?? null,
        reason: input.reason,
      },
      expiresAt: commandExpiry(),
      execute: async (client) => {
        await assertActiveAdministrator(client, input.actorIdentityId);
        if (input.actorIdentityId === input.targetIdentityId) {
          throw new IdentityAccessGovernanceError("Administrators cannot propose changes to their own access.", "forbidden");
        }
        const target = await lockIdentityState(client, input.targetIdentityId);
        if (input.changeType === "change_role") {
          if (target.status !== "active") throw new IdentityAccessGovernanceError("A disabled identity must be restored before its role can change.", "invalid_state");
          if (!input.proposedRole || input.proposedRole === target.role) {
            throw new IdentityAccessGovernanceError("Choose a role different from the identity's current role.", "invalid_state");
          }
        } else if (input.proposedRole) {
          throw new IdentityAccessGovernanceError("A proposed role is valid only for a role change.", "invalid_state");
        } else if (input.changeType === "suspend" && target.status !== "active") {
          throw new IdentityAccessGovernanceError("The identity is already disabled.", "invalid_state");
        } else if (input.changeType === "restore" && target.status !== "disabled") {
          throw new IdentityAccessGovernanceError("The identity is already active.", "invalid_state");
        }

        const id = randomUUID();
        try {
          await client.query(
            `INSERT INTO fractal.identity_access_change_requests
               (id, target_identity_id, change_type, prior_role, proposed_role, prior_status, reason, requested_by_identity_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [id, target.id, input.changeType, target.role, input.proposedRole ?? null, target.status, input.reason, input.actorIdentityId],
          );
        } catch (error) {
          const databaseError = error as { code?: string; constraint?: string };
          if (databaseError.code === "23505" && databaseError.constraint === "identity_access_change_target_pending_unique_idx") {
            throw new IdentityAccessGovernanceError("This identity already has a pending access change.", "conflict");
          }
          throw error;
        }
        const audit = await appendPostgresAuditEvent(client, {
          scopeKey: `identity:${target.id}`,
          actorId: input.actorIdentityId,
          actorType: "user",
          action: "identity.access_change.requested",
          entityType: "identity_access_change_request",
          entityId: id,
          reason: input.reason,
          payload: { changeType: input.changeType, priorRole: target.role, proposedRole: input.proposedRole ?? null, priorStatus: target.status },
        });
        await appendOutboxEvent(client, {
          aggregateType: "identity_access_change_request",
          aggregateId: id,
          eventType: "identity.access_change.requested",
          payload: { targetIdentityId: target.id, requestedByIdentityId: input.actorIdentityId, auditEventId: audit.id },
        });
        return { body: { request: await readRequest(client, id) }, status: 201 };
      },
    });
    return { request: result.body.request, replayed: result.replayed };
  } catch (error) {
    if (error instanceof PostgresIdempotencyConflictError) throw error;
    throw error;
  }
}

export async function decideIdentityAccessChangeRequest(input: {
  actorIdentityId: string;
  requestId: string;
  decision: "approve" | "reject";
  reason: string;
  commandKey: string;
}): Promise<{ request: IdentityAccessChangeRequest; replayed: boolean }> {
  const result = await runPostgresIdempotentCommand<{ request: IdentityAccessChangeRequest }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `identity:${input.actorIdentityId}`,
    route: `POST:/v1/admin/access-change-requests/${input.requestId}/decision`,
    commandKey: input.commandKey,
    payload: { decision: input.decision, reason: input.reason },
    expiresAt: commandExpiry(),
    execute: async (client) => {
      // One transaction-wide lane protects the last-active-admin invariant
      // across different target rows.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('fractal.administrator_authority_governance'))");
      await assertActiveAdministrator(client, input.actorIdentityId);
      const locked = await client.query<{
        id: string; target_identity_id: string; change_type: IdentityAccessChangeType;
        prior_role: Role | null; proposed_role: Role | null; prior_status: "active" | "disabled";
        status: IdentityAccessChangeStatus; requested_by_identity_id: string;
      }>(
        `SELECT id, target_identity_id, change_type, prior_role, proposed_role, prior_status, status, requested_by_identity_id
           FROM fractal.identity_access_change_requests WHERE id = $1 FOR UPDATE`,
        [input.requestId],
      );
      const request = locked.rows[0];
      if (!request) throw new IdentityAccessGovernanceError("Access change request not found.", "not_found");
      if (request.status !== "pending") throw new IdentityAccessGovernanceError("This access change has already been decided.", "conflict");
      if (request.requested_by_identity_id === input.actorIdentityId) {
        throw new IdentityAccessGovernanceError("The requesting administrator cannot review the same access change.", "forbidden");
      }
      if (request.target_identity_id === input.actorIdentityId) {
        throw new IdentityAccessGovernanceError("Administrators cannot approve or reject changes to their own access.", "forbidden");
      }
      if (!await isActiveAdministrator(client, request.requested_by_identity_id)) {
        throw new IdentityAccessGovernanceError(
          "The requesting administrator is no longer active. Reject this request and submit a fresh proposal.",
          "conflict",
        );
      }

      if (input.decision === "reject") {
        await client.query(
          `UPDATE fractal.identity_access_change_requests
              SET status = 'rejected', reviewed_by_identity_id = $2,
                  decision_reason = $3, reviewed_at = now()
            WHERE id = $1`,
          [request.id, input.actorIdentityId, input.reason],
        );
      } else {
        const target = await lockIdentityState(client, request.target_identity_id);
        if (target.status !== request.prior_status || target.role !== request.prior_role) {
          throw new IdentityAccessGovernanceError(
            "The target identity changed after this request was created. Reject it and submit a fresh request.",
            "conflict",
          );
        }

        const removesAdministrator = target.role === "admin"
          && (request.change_type === "suspend" || (request.change_type === "change_role" && request.proposed_role !== "admin"));
        if (removesAdministrator) {
          const administrators = await client.query<{ count: string }>(
            `SELECT count(DISTINCT identity.id)::text AS count
               FROM fractal.identities identity
               JOIN fractal.identity_role_assignments assignment
                 ON assignment.identity_id = identity.id
                AND assignment.scope_type = 'global'
                AND assignment.role = 'admin'
                AND assignment.revoked_at IS NULL
              WHERE identity.status = 'active'`,
          );
          if (Number(administrators.rows[0]?.count ?? 0) <= 2) {
            throw new IdentityAccessGovernanceError(
              "This change would leave fewer than two active administrators and make independent access governance inoperable.",
              "last_administrator",
            );
          }
          const capabilityQuorums = await client.query<{ capability_key: string; remaining_count: string }>(
            `SELECT target.capability_key,
                    count(DISTINCT remaining.identity_id) FILTER (
                      WHERE remaining_identity.id IS NOT NULL AND remaining_role.identity_id IS NOT NULL
                    )::text AS remaining_count
               FROM fractal.administrator_capability_assignments target
               LEFT JOIN fractal.administrator_capability_assignments remaining
                 ON remaining.capability_key = target.capability_key
                AND remaining.revoked_at IS NULL
                AND remaining.identity_id <> target.identity_id
               LEFT JOIN fractal.identities remaining_identity
                 ON remaining_identity.id = remaining.identity_id
                AND remaining_identity.status = 'active'
               LEFT JOIN fractal.identity_role_assignments remaining_role
                 ON remaining_role.identity_id = remaining.identity_id
                AND remaining_role.scope_type = 'global'
                AND remaining_role.role = 'admin'
                AND remaining_role.revoked_at IS NULL
              WHERE target.identity_id = $1
                AND target.revoked_at IS NULL
              GROUP BY target.capability_key`,
            [target.id],
          );
          const unsafeCapability = capabilityQuorums.rows.find((row) => Number(row.remaining_count) < 2);
          if (unsafeCapability) {
            throw new IdentityAccessGovernanceError(
              `This change would leave fewer than two active administrators with the ${unsafeCapability.capability_key} capability.`,
              "last_administrator",
            );
          }
        }

        if (request.change_type === "change_role") {
          if (!request.proposed_role) throw new IdentityAccessGovernanceError("The approved role is missing.", "invalid_state");
          await client.query(
            `UPDATE fractal.identity_role_assignments SET revoked_at = now()
              WHERE identity_id = $1 AND scope_type = 'global' AND revoked_at IS NULL`,
            [target.id],
          );
          await client.query(
            `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type, granted_at)
             VALUES ($1, $2, $3, 'global', now())
             ON CONFLICT (identity_id, role, scope_type, scope_id)
             DO UPDATE SET revoked_at = NULL, granted_at = now()`,
            [randomUUID(), target.id, request.proposed_role],
          );
          await client.query(
            "UPDATE fractal.identities SET credential_invalidated_at = now(), updated_at = now() WHERE id = $1",
            [target.id],
          );
          if (request.proposed_role !== "admin") {
            await client.query(
              `UPDATE fractal.administrator_capability_assignments
                  SET revoked_at = now(), revoked_by_access_change_request_id = $2
                WHERE identity_id = $1 AND revoked_at IS NULL`,
              [target.id, request.id],
            );
          }
          await revokeAllAuthSessionsForSubjectInTransaction(client, target.id, "administrator_role_change");
        } else if (request.change_type === "suspend") {
          await client.query(
            `UPDATE fractal.identities
                SET status = 'disabled', credential_invalidated_at = now(),
                    password_reset_token_hash = NULL, password_reset_expires_at = NULL,
                    password_reset_purpose = NULL,
                    email_verification_token_hash = NULL, email_verification_expires_at = NULL,
                    updated_at = now()
              WHERE id = $1`,
            [target.id],
          );
          await client.query(
            `UPDATE fractal.administrator_capability_assignments
                SET revoked_at = now(), revoked_by_access_change_request_id = $2
              WHERE identity_id = $1 AND revoked_at IS NULL`,
            [target.id, request.id],
          );
          await revokeAllAuthSessionsForSubjectInTransaction(client, target.id, "administrator_suspension");
        } else {
          await client.query(
            "UPDATE fractal.identities SET status = 'active', credential_invalidated_at = now(), updated_at = now() WHERE id = $1",
            [target.id],
          );
        }
        await client.query(
          `UPDATE fractal.identity_access_change_requests
              SET status = 'applied', reviewed_by_identity_id = $2,
                  decision_reason = $3, reviewed_at = now(), applied_at = now()
            WHERE id = $1`,
          [request.id, input.actorIdentityId, input.reason],
        );
      }

      const action = input.decision === "approve" ? "identity.access_change.applied" : "identity.access_change.rejected";
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `identity:${request.target_identity_id}`,
        actorId: input.actorIdentityId,
        actorType: "user",
        action,
        entityType: "identity_access_change_request",
        entityId: request.id,
        reason: input.reason,
        payload: { changeType: request.change_type, priorRole: request.prior_role, proposedRole: request.proposed_role, priorStatus: request.prior_status },
      });
      await appendOutboxEvent(client, {
        aggregateType: "identity_access_change_request",
        aggregateId: request.id,
        eventType: action,
        payload: { targetIdentityId: request.target_identity_id, reviewedByIdentityId: input.actorIdentityId, auditEventId: audit.id },
      });
      return { body: { request: await readRequest(client, request.id) }, status: 200 };
    },
  });
  return { request: result.body.request, replayed: result.replayed };
}

type RequestCursor = { requestedAt: string; id: string };

function encodeRequestCursor(value: RequestCursor): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

export function decodeIdentityAccessRequestCursor(value: string): RequestCursor {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<RequestCursor>;
    if (!parsed.id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id) || !parsed.requestedAt || Number.isNaN(Date.parse(parsed.requestedAt))) throw new Error("invalid");
    return { id: parsed.id, requestedAt: parsed.requestedAt };
  } catch {
    throw new IdentityAccessGovernanceError("The access-change cursor is invalid.", "invalid_state");
  }
}

export async function listIdentityAccessChangeRequests(input: {
  status?: IdentityAccessChangeStatus;
  query?: string;
  cursor?: RequestCursor;
  limit: number;
}): Promise<{ requests: IdentityAccessChangeRequest[]; nextCursor: string | null }> {
  const query = input.query?.trim() || null;
  const result = await requirePostgres().query<AccessRequestRow>(
    `${requestSelect}
      WHERE ($1::text IS NULL OR request.status = $1)
        AND ($2::text IS NULL OR target.email ILIKE '%' || $2 || '%' OR target.legal_name ILIKE '%' || $2 || '%')
        AND ($3::timestamptz IS NULL OR (request.requested_at, request.id) < ($3::timestamptz, $4::uuid))
      ORDER BY request.requested_at DESC, request.id DESC
      LIMIT $5`,
    [input.status ?? null, query, input.cursor?.requestedAt ?? null, input.cursor?.id ?? null, input.limit + 1],
  );
  const hasNextPage = result.rows.length > input.limit;
  const page = result.rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    requests: page.map(mapRequest),
    nextCursor: hasNextPage && last ? encodeRequestCursor({ requestedAt: last.cursor_requested_at, id: last.id }) : null,
  };
}
