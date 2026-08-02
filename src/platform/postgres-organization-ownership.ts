import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class OrganizationOwnershipTransferError extends Error {}

type TransferRow = {
  id: string;
  organization_id: string;
  source_membership_id: string;
  target_membership_id: string;
  source_identity_id: string;
  target_identity_id: string;
  source_name: string;
  target_name: string;
  reason: string;
  status: "pending" | "accepted" | "rejected" | "cancelled" | "expired";
  expires_at: Date;
  decided_at: Date | null;
  decision_reason: string | null;
  created_at: Date;
};

const OWNERSHIP_TRANSFER_EXPIRY_REASON = "The ownership transfer acceptance window expired";

async function recordExpiredTransfer(
  client: PoolClient,
  transfer: { id: string; organization_id: string; source_membership_id: string; target_membership_id: string },
) {
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `organization:${transfer.organization_id}`,
    organizationId: transfer.organization_id,
    actorType: "system",
    action: "organization.ownership_transfer.expired",
    entityType: "organization_ownership_transfer",
    entityId: transfer.id,
    reason: OWNERSHIP_TRANSFER_EXPIRY_REASON,
    payload: {
      sourceMembershipId: transfer.source_membership_id,
      targetMembershipId: transfer.target_membership_id,
    },
  });
  await appendOutboxEvent(client, {
    aggregateType: "organization_ownership_transfer",
    aggregateId: transfer.id,
    eventType: "organization.ownership_transfer.expired",
    payload: { organizationId: transfer.organization_id, auditEventId: audit.id },
  });
}

async function expireStaleTransfer(client: PoolClient, organizationId: string) {
  const expired = await client.query<{
    id: string;
    organization_id: string;
    source_membership_id: string;
    target_membership_id: string;
  }>(
    `UPDATE fractal.organization_ownership_transfer_requests
        SET status = 'expired', decided_at = now(), decision_reason = $2, updated_at = now()
      WHERE organization_id = $1 AND status = 'pending' AND expires_at <= now()
      RETURNING id, organization_id, source_membership_id, target_membership_id`,
    [organizationId, OWNERSHIP_TRANSFER_EXPIRY_REASON],
  );
  for (const transfer of expired.rows) await recordExpiredTransfer(client, transfer);
  return expired.rowCount ?? 0;
}

export async function proposeOrganizationOwnershipTransfer(input: {
  organizationId: string;
  requestedByIdentityId: string;
  targetMembershipId: string;
  reason: string;
  expiresAt: Date;
  commandKey?: string;
}) {
  const reason = input.reason.trim();
  if (reason.length < 10 || reason.length > 2000) throw new OrganizationOwnershipTransferError("Transfer reason must be between 10 and 2000 characters");
  if (input.expiresAt.getTime() < Date.now() + 60 * 60 * 1_000 || input.expiresAt.getTime() > Date.now() + 30 * 86_400_000) {
    throw new OrganizationOwnershipTransferError("Ownership transfer expiry must be between one hour and 30 days");
  }
  return runPostgresIdempotentCommand({
    actorIdentityId: input.requestedByIdentityId,
    scopeKey: `organization:${input.organizationId}`,
    route: "organization.ownership-transfer.propose",
    commandKey: input.commandKey,
    payload: { targetMembershipId: input.targetMembershipId, reason, expiresAt: input.expiresAt.toISOString() },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await expireStaleTransfer(client, input.organizationId);
      const source = await client.query<{ id: string; role: string; status: string }>(
        `SELECT id, role, status FROM fractal.organization_memberships
          WHERE organization_id = $1 AND identity_id = $2
          FOR UPDATE`, [input.organizationId, input.requestedByIdentityId],
      );
      if (source.rows[0]?.role !== "owner" || source.rows[0]?.status !== "active") {
        throw new OrganizationOwnershipTransferError("Only an active organization owner can propose ownership transfer");
      }
      const target = await client.query<{ identity_id: string; role: string; status: string }>(
        `SELECT identity_id, role, status FROM fractal.organization_memberships
          WHERE id = $1 AND organization_id = $2
          FOR UPDATE`, [input.targetMembershipId, input.organizationId],
      );
      if (!target.rows[0] || target.rows[0].status !== "active" || target.rows[0].role === "owner") {
        throw new OrganizationOwnershipTransferError("Ownership can be transferred only to an active non-owner member");
      }
      if (target.rows[0].identity_id === input.requestedByIdentityId) throw new OrganizationOwnershipTransferError("Ownership transfer requires a different target member");
      const transferId = randomUUID();
      await client.query(
        `INSERT INTO fractal.organization_ownership_transfer_requests
           (id, organization_id, source_membership_id, target_membership_id, requested_by_identity_id, reason, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [transferId, input.organizationId, source.rows[0].id, input.targetMembershipId, input.requestedByIdentityId, reason, input.expiresAt],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId,
        actorId: input.requestedByIdentityId, actorType: "identity", action: "organization.ownership_transfer.proposed",
        entityType: "organization_ownership_transfer", entityId: transferId, reason,
        payload: { sourceMembershipId: source.rows[0].id, targetMembershipId: input.targetMembershipId, expiresAt: input.expiresAt.toISOString() },
      });
      await appendOutboxEvent(client, {
        aggregateType: "organization_ownership_transfer", aggregateId: transferId,
        eventType: "organization.ownership_transfer.proposed",
        payload: { organizationId: input.organizationId, targetIdentityId: target.rows[0].identity_id, auditEventId: audit.id },
      });
      return { status: 201, body: { transferId, status: "pending" as const, expiresAt: input.expiresAt.toISOString() } };
    },
  });
}

export async function decideOrganizationOwnershipTransfer(input: {
  transferId: string;
  organizationId: string;
  actorIdentityId: string;
  action: "accept" | "reject" | "cancel";
  reason: string;
  commandKey?: string;
}) {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 2000) throw new OrganizationOwnershipTransferError("Decision reason must be between 5 and 2000 characters");
  return runPostgresIdempotentCommand<{
    transferId: string;
    status: "accepted" | "rejected" | "cancelled" | "expired";
  }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `organization:${input.organizationId}`,
    route: `organization.ownership-transfer.${input.action}`,
    commandKey: input.commandKey,
    payload: { transferId: input.transferId, reason },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      const result = await client.query<TransferRow>(
        `SELECT transfer.*, source.identity_id AS source_identity_id, target.identity_id AS target_identity_id,
                source_identity.legal_name AS source_name, target_identity.legal_name AS target_name
           FROM fractal.organization_ownership_transfer_requests transfer
           JOIN fractal.organization_memberships source ON source.id = transfer.source_membership_id
           JOIN fractal.organization_memberships target ON target.id = transfer.target_membership_id
           JOIN fractal.identities source_identity ON source_identity.id = source.identity_id
           JOIN fractal.identities target_identity ON target_identity.id = target.identity_id
          WHERE transfer.id = $1 AND transfer.organization_id = $2
          FOR UPDATE OF transfer, source, target`,
        [input.transferId, input.organizationId],
      );
      const transfer = result.rows[0];
      if (!transfer) throw new OrganizationOwnershipTransferError("Ownership transfer not found");
      if (transfer.status !== "pending") throw new OrganizationOwnershipTransferError(`Ownership transfer is already ${transfer.status}`);
      if (transfer.expires_at <= new Date()) {
        const expired = await client.query<{
          id: string;
          organization_id: string;
          source_membership_id: string;
          target_membership_id: string;
        }>(
          `UPDATE fractal.organization_ownership_transfer_requests
              SET status = 'expired', decided_at = now(), decision_reason = $2, updated_at = now()
            WHERE id = $1 AND status = 'pending'
            RETURNING id, organization_id, source_membership_id, target_membership_id`,
          [transfer.id, OWNERSHIP_TRANSFER_EXPIRY_REASON],
        );
        if (expired.rows[0]) await recordExpiredTransfer(client, expired.rows[0]);
        return { status: 410, body: { transferId: transfer.id, status: "expired" as const } };
      }
      if (input.action === "cancel" && input.actorIdentityId !== transfer.source_identity_id) throw new OrganizationOwnershipTransferError("Only the proposing owner can cancel this transfer");
      if ((input.action === "accept" || input.action === "reject") && input.actorIdentityId !== transfer.target_identity_id) {
        throw new OrganizationOwnershipTransferError("Only the nominated successor can accept or reject this transfer");
      }
      let status: "accepted" | "rejected" | "cancelled";
      if (input.action === "accept") {
        await client.query("UPDATE fractal.organization_memberships SET role = 'owner' WHERE id = $1 AND status = 'active' AND role <> 'owner'", [transfer.target_membership_id]);
        await client.query("UPDATE fractal.organization_memberships SET role = 'administrator' WHERE id = $1 AND status = 'active' AND role = 'owner'", [transfer.source_membership_id]);
        status = "accepted";
      } else status = input.action === "reject" ? "rejected" : "cancelled";
      const updated = await client.query(
        `UPDATE fractal.organization_ownership_transfer_requests
            SET status = $2, accepted_by_identity_id = CASE WHEN $2 = 'accepted' THEN $3::uuid ELSE NULL::uuid END,
                decided_at = now(), decision_reason = $4, updated_at = now()
          WHERE id = $1 RETURNING id`,
        [transfer.id, status, input.actorIdentityId, reason],
      );
      if (!updated.rows[0]) throw new OrganizationOwnershipTransferError("Ownership transfer could not be finalized");
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId,
        actorId: input.actorIdentityId, actorType: "identity", action: `organization.ownership_transfer.${status}`,
        entityType: "organization_ownership_transfer", entityId: transfer.id, reason,
        payload: { sourceMembershipId: transfer.source_membership_id, targetMembershipId: transfer.target_membership_id },
      });
      await appendOutboxEvent(client, {
        aggregateType: "organization_ownership_transfer", aggregateId: transfer.id,
        eventType: `organization.ownership_transfer.${status}`,
        payload: { organizationId: input.organizationId, auditEventId: audit.id },
      });
      return { status: 200, body: { transferId: transfer.id, status } };
    },
  });
}

export async function expireOrganizationOwnershipTransfers(organizationId: string) {
  return withPostgresTransaction((client) => expireStaleTransfer(client, organizationId));
}
