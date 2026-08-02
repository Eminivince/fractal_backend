import { createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import type { EmailPayload, EmailResult } from "../services/email.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import type { OrganizationMembershipRole } from "./tenant-access.js";

export class OrganizationInvitationError extends Error {}

const invitationRoles = ["administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"] as const;
export type OrganizationInvitationRole = (typeof invitationRoles)[number];

type InvitationRow = {
  id: string;
  organization_id: string;
  email: string;
  role: OrganizationInvitationRole;
  invited_by_identity_id: string;
  expires_at: Date;
  accepted_at: Date | null;
  revoked_at: Date | null;
  delivery_status: "requested" | "failed" | "sent" | "terminal" | "cancelled";
};

export interface ClaimedOrganizationInvitationDelivery {
  id: string;
  organizationId: string;
  attempts: number;
  generation: number;
}

export interface OrganizationInvitationDeliveryLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

function hashInvitationToken(token: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(token).digest("hex");
}

function stableInvitationToken(input: { invitationId: string; generation: number }): string {
  return createHmac(
    "sha256",
    env.EMAIL_DELIVERY_SECRET_KEY ?? env.JWT_SECRET,
  )
    .update("fractal-organization-invitation-v1")
    .update("\0")
    .update(input.invitationId)
    .update("\0")
    .update(String(input.generation))
    .digest("base64url");
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 320) {
    throw new OrganizationInvitationError("A valid invitation email is required");
  }
  return email;
}

function appUrl(path: string): string {
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}

async function requireInvitationAdministrator(client: PoolClient, organizationId: string, identityId: string) {
  const result = await client.query<{ legal_name: string; role: OrganizationMembershipRole }>(
    `SELECT organization.legal_name, membership.role
       FROM fractal.organization_memberships membership
       JOIN fractal.organizations organization ON organization.id = membership.organization_id
      WHERE membership.organization_id = $1
        AND membership.identity_id = $2
        AND membership.status = 'active'
        AND membership.revoked_at IS NULL
        AND membership.role IN ('owner', 'administrator')
        AND organization.status = 'active'
      FOR SHARE OF membership, organization`,
    [organizationId, identityId],
  );
  if (!result.rows[0]) throw new OrganizationInvitationError("Access denied to organization");
  return result.rows[0];
}

const managedMembershipRoles = ["administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"] as const;
type ManagedMembershipRole = (typeof managedMembershipRoles)[number];

function assertMayManageMembership(input: {
  actorIdentityId: string;
  actorRole: OrganizationMembershipRole;
  targetIdentityId: string;
  targetRole: OrganizationMembershipRole;
}) {
  if (input.actorIdentityId === input.targetIdentityId) {
    throw new OrganizationInvitationError("Use a separate authorized owner to change your own organization access");
  }
  if (input.targetRole === "owner") {
    throw new OrganizationInvitationError("Owner access requires the governed ownership-transfer workflow");
  }
  if (input.actorRole === "administrator" && input.targetRole === "administrator") {
    throw new OrganizationInvitationError("Only an organization owner can manage administrator access");
  }
}

export async function issueOrganizationInvitation(input: {
  organizationId: string;
  invitedByIdentityId: string;
  email: string;
  role: Exclude<OrganizationMembershipRole, "owner">;
  expiresAt: Date;
  commandKey?: string;
}) {
  const now = new Date();
  if (input.expiresAt.getTime() < now.getTime() + 60 * 60 * 1_000) throw new OrganizationInvitationError("Invitation expiry must be at least one hour in the future");
  if (input.expiresAt.getTime() > now.getTime() + 30 * 24 * 60 * 60 * 1_000) throw new OrganizationInvitationError("Invitation expiry cannot exceed 30 days");
  if (!invitationRoles.includes(input.role as OrganizationInvitationRole)) throw new OrganizationInvitationError("Invitation role is invalid");
  const email = normalizeEmail(input.email);
  const payload = { email, role: input.role, expiresAt: input.expiresAt.toISOString() };
  return runPostgresIdempotentCommand({
    actorIdentityId: input.invitedByIdentityId,
    scopeKey: `organization:${input.organizationId}`,
    route: "organization.invitation.issue",
    commandKey: input.commandKey,
    payload,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
    const invitationId = randomUUID();
    await requireInvitationAdministrator(client, input.organizationId, input.invitedByIdentityId);
    const target = await client.query<{ id: string; existing_membership_id: string | null }>(
      `SELECT identity.id, membership.id AS existing_membership_id
         FROM fractal.identities identity
         LEFT JOIN fractal.organization_memberships membership
           ON membership.identity_id = identity.id AND membership.organization_id = $1
        WHERE identity.email = $2
        FOR SHARE OF identity`,
      [input.organizationId, email],
    );
    if (target.rows[0]?.id === input.invitedByIdentityId) throw new OrganizationInvitationError("You cannot invite your own account");
    if (target.rows[0]?.existing_membership_id) throw new OrganizationInvitationError("This identity already has an organization membership");

    const existing = await client.query<InvitationRow>(
      `SELECT id, organization_id, email, role, invited_by_identity_id, expires_at,
              accepted_at, revoked_at, delivery_status
         FROM fractal.organization_invitations
        WHERE organization_id = $1 AND email = $2 AND accepted_at IS NULL AND revoked_at IS NULL
        FOR UPDATE`,
      [input.organizationId, email],
    );
    const prior = existing.rows[0];
    if (prior && prior.expires_at > now) throw new OrganizationInvitationError("An active invitation already exists for this email");
    if (prior) {
      await client.query(
        `UPDATE fractal.organization_invitations
            SET revoked_at = now(), revoked_by_identity_id = $2,
                revocation_reason = 'Expired invitation replaced by a new invitation',
                delivery_status = 'cancelled', delivery_claimed_at = NULL, delivery_claimed_by = NULL,
                updated_at = now()
          WHERE id = $1`,
        [prior.id, input.invitedByIdentityId],
      );
    }

    await client.query(
      `INSERT INTO fractal.organization_invitations
         (id, organization_id, email, role, token_hash, invited_by_identity_id, expires_at, delivery_status)
       VALUES ($1, $2, $3, $4, NULL, $5, $6, 'requested')`,
      [invitationId, input.organizationId, email, input.role, input.invitedByIdentityId, input.expiresAt],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`,
      organizationId: input.organizationId,
      actorId: input.invitedByIdentityId,
      actorType: "identity",
      action: "organization.invitation.issued",
      entityType: "organization_invitation",
      entityId: invitationId,
      payload: { role: input.role, expiresAt: input.expiresAt.toISOString(), deliveryStatus: "requested" },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_invitation",
      aggregateId: invitationId,
      eventType: "organization.invitation.issued",
      payload: { organizationId: input.organizationId, role: input.role, auditEventId: audit.id },
    });
    return { status: 201, body: { invitationId, deliveryStatus: "requested" as const } };
    },
  });
}

export async function revokeOrganizationInvitation(input: {
  invitationId: string;
  organizationId: string;
  revokedByIdentityId: string;
  reason: string;
}): Promise<{ invitationId: string; state: "revoked" }> {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 1000) throw new OrganizationInvitationError("Revocation reason must be between 5 and 1000 characters");
  return withPostgresTransaction(async (client) => {
    await requireInvitationAdministrator(client, input.organizationId, input.revokedByIdentityId);
    const result = await client.query<InvitationRow>(
      `SELECT id, organization_id, email, role, invited_by_identity_id, expires_at,
              accepted_at, revoked_at, delivery_status
         FROM fractal.organization_invitations
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [input.invitationId, input.organizationId],
    );
    const invitation = result.rows[0];
    if (!invitation) throw new OrganizationInvitationError("Invitation not found");
    if (invitation.accepted_at) throw new OrganizationInvitationError("An accepted invitation cannot be revoked; manage the membership instead");
    if (invitation.revoked_at) return { invitationId: invitation.id, state: "revoked" };
    await client.query(
      `UPDATE fractal.organization_invitations
          SET revoked_at = now(), revoked_by_identity_id = $2, revocation_reason = $3,
              delivery_status = 'cancelled', delivery_claimed_at = NULL, delivery_claimed_by = NULL,
              updated_at = now()
        WHERE id = $1`,
      [invitation.id, input.revokedByIdentityId, reason],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`,
      organizationId: input.organizationId,
      actorId: input.revokedByIdentityId,
      actorType: "identity",
      action: "organization.invitation.revoked",
      entityType: "organization_invitation",
      entityId: invitation.id,
      reason,
      payload: { role: invitation.role },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_invitation",
      aggregateId: invitation.id,
      eventType: "organization.invitation.revoked",
      payload: { organizationId: input.organizationId, auditEventId: audit.id },
    });
    return { invitationId: invitation.id, state: "revoked" };
  });
}

export async function resendOrganizationInvitation(input: {
  invitationId: string;
  organizationId: string;
  requestedByIdentityId: string;
  commandKey?: string;
}) {
  return runPostgresIdempotentCommand({
    actorIdentityId: input.requestedByIdentityId,
    scopeKey: `organization:${input.organizationId}`,
    route: "organization.invitation.resend",
    commandKey: input.commandKey,
    payload: { invitationId: input.invitationId },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await requireInvitationAdministrator(client, input.organizationId, input.requestedByIdentityId);
      const result = await client.query<InvitationRow & { delivery_sent_at: Date | null; updated_at: Date }>(
        `SELECT id, organization_id, email, role, invited_by_identity_id, expires_at,
                accepted_at, revoked_at, delivery_status, delivery_sent_at, updated_at
           FROM fractal.organization_invitations
          WHERE id = $1 AND organization_id = $2
          FOR UPDATE`,
        [input.invitationId, input.organizationId],
      );
      const invitation = result.rows[0];
      if (!invitation) throw new OrganizationInvitationError("Invitation not found");
      if (invitation.accepted_at || invitation.revoked_at || invitation.expires_at <= new Date()) {
        throw new OrganizationInvitationError("Only an active, unaccepted invitation can be resent");
      }
      const lastAttempt = invitation.delivery_sent_at ?? invitation.updated_at;
      if (lastAttempt.getTime() > Date.now() - 5 * 60 * 1_000) {
        throw new OrganizationInvitationError("Wait five minutes before resending this invitation");
      }
      await client.query(
        `UPDATE fractal.organization_invitations
            SET token_hash = NULL, delivery_status = 'requested', delivery_attempts = 0,
                delivery_generation = delivery_generation + 1,
                delivery_provider = NULL, delivery_provider_message_id = NULL,
                delivery_next_attempt_at = now(), delivery_claimed_at = NULL,
                delivery_claimed_by = NULL, delivery_sent_at = NULL,
                delivery_terminal_at = NULL, delivery_last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [invitation.id],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${input.organizationId}`,
        organizationId: input.organizationId,
        actorId: input.requestedByIdentityId,
        actorType: "identity",
        action: "organization.invitation.delivery_requested",
        entityType: "organization_invitation",
        entityId: invitation.id,
        payload: { role: invitation.role },
      });
      await appendOutboxEvent(client, {
        aggregateType: "organization_invitation",
        aggregateId: invitation.id,
        eventType: "organization.invitation.delivery_requested",
        payload: { organizationId: input.organizationId, auditEventId: audit.id },
      });
      return { status: 202, body: { invitationId: invitation.id, deliveryStatus: "requested" as const } };
    },
  });
}

export async function changeOrganizationMembershipRole(input: {
  membershipId: string;
  organizationId: string;
  changedByIdentityId: string;
  role: ManagedMembershipRole;
  reason: string;
}) {
  if (!managedMembershipRoles.includes(input.role)) throw new OrganizationInvitationError("Membership role is invalid");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 1000) throw new OrganizationInvitationError("Change reason must be between 5 and 1000 characters");
  return withPostgresTransaction(async (client) => {
    const actor = await requireInvitationAdministrator(client, input.organizationId, input.changedByIdentityId);
    const result = await client.query<{ id: string; identity_id: string; role: OrganizationMembershipRole; status: string }>(
      `SELECT id, identity_id, role, status
         FROM fractal.organization_memberships
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [input.membershipId, input.organizationId],
    );
    const membership = result.rows[0];
    if (!membership) throw new OrganizationInvitationError("Membership not found");
    if (membership.status === "revoked") throw new OrganizationInvitationError("A revoked membership cannot be changed");
    assertMayManageMembership({ actorIdentityId: input.changedByIdentityId, actorRole: actor.role, targetIdentityId: membership.identity_id, targetRole: membership.role });
    if (membership.role === input.role) return { membershipId: membership.id, role: input.role, status: membership.status };
    await client.query(`UPDATE fractal.organization_memberships SET role = $2 WHERE id = $1`, [membership.id, input.role]);
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId,
      actorId: input.changedByIdentityId, actorType: "identity", action: "organization.membership.role_changed",
      entityType: "organization_membership", entityId: membership.id, reason,
      payload: { previousRole: membership.role, role: input.role, targetIdentityId: membership.identity_id },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_membership", aggregateId: membership.id,
      eventType: "organization.membership.role_changed",
      payload: { organizationId: input.organizationId, previousRole: membership.role, role: input.role, auditEventId: audit.id },
    });
    return { membershipId: membership.id, role: input.role, status: membership.status };
  });
}

export async function changeOrganizationMembershipStatus(input: {
  membershipId: string;
  organizationId: string;
  changedByIdentityId: string;
  action: "suspend" | "restore" | "revoke";
  reason: string;
}) {
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 1000) throw new OrganizationInvitationError("Change reason must be between 5 and 1000 characters");
  return withPostgresTransaction(async (client) => {
    const actor = await requireInvitationAdministrator(client, input.organizationId, input.changedByIdentityId);
    const result = await client.query<{ id: string; identity_id: string; role: OrganizationMembershipRole; status: "active" | "suspended" | "revoked" }>(
      `SELECT id, identity_id, role, status
         FROM fractal.organization_memberships
        WHERE id = $1 AND organization_id = $2
        FOR UPDATE`,
      [input.membershipId, input.organizationId],
    );
    const membership = result.rows[0];
    if (!membership) throw new OrganizationInvitationError("Membership not found");
    assertMayManageMembership({ actorIdentityId: input.changedByIdentityId, actorRole: actor.role, targetIdentityId: membership.identity_id, targetRole: membership.role });
    if (membership.status === "revoked") throw new OrganizationInvitationError("A revoked membership cannot be restored or changed");
    const nextStatus = input.action === "restore" ? "active" : input.action === "suspend" ? "suspended" : "revoked";
    if (membership.status === nextStatus) return { membershipId: membership.id, role: membership.role, status: nextStatus };
    if (input.action === "restore" && membership.status !== "suspended") throw new OrganizationInvitationError("Only a suspended membership can be restored");
    await client.query(
      `UPDATE fractal.organization_memberships
          SET status = $2, revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE NULL END
        WHERE id = $1`,
      [membership.id, nextStatus],
    );
    const eventAction = input.action === "suspend" ? "suspended" : input.action === "restore" ? "restored" : "revoked";
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId,
      actorId: input.changedByIdentityId, actorType: "identity", action: `organization.membership.${eventAction}`,
      entityType: "organization_membership", entityId: membership.id, reason,
      payload: { previousStatus: membership.status, status: nextStatus, role: membership.role, targetIdentityId: membership.identity_id },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_membership", aggregateId: membership.id,
      eventType: `organization.membership.${eventAction}`,
      payload: { organizationId: input.organizationId, previousStatus: membership.status, status: nextStatus, auditEventId: audit.id },
    });
    return { membershipId: membership.id, role: membership.role, status: nextStatus };
  });
}

export async function resolveOrganizationInvitation(token: string): Promise<{ state: "requires_auth" | "invalid" | "expired" | "revoked" | "accepted" }> {
  if (token.length < 32 || token.length > 256) return { state: "invalid" };
  const result = await requirePostgres().query<InvitationRow>(
    `SELECT id, organization_id, email, role, invited_by_identity_id, expires_at,
            accepted_at, revoked_at, delivery_status
       FROM fractal.organization_invitations WHERE token_hash = $1`,
    [hashInvitationToken(token)],
  );
  const invitation = result.rows[0];
  if (!invitation || invitation.delivery_status !== "sent") return { state: "invalid" };
  if (invitation.accepted_at) return { state: "accepted" };
  if (invitation.revoked_at) return { state: "revoked" };
  if (invitation.expires_at <= new Date()) return { state: "expired" };
  return { state: "requires_auth" };
}

export async function inspectOrganizationInvitation(input: { token: string; identityId: string }) {
  if (input.token.length < 32 || input.token.length > 256) throw new OrganizationInvitationError("Invitation is invalid or expired");
  const result = await requirePostgres().query<InvitationRow & { organization_legal_name: string; inviter_legal_name: string }>(
    `SELECT invitation.id, invitation.organization_id, invitation.email, invitation.role,
            invitation.invited_by_identity_id, invitation.expires_at, invitation.accepted_at,
            invitation.revoked_at, invitation.delivery_status,
            organization.legal_name AS organization_legal_name,
            inviter.legal_name AS inviter_legal_name
       FROM fractal.organization_invitations invitation
       JOIN fractal.organizations organization ON organization.id = invitation.organization_id
       JOIN fractal.identities inviter ON inviter.id = invitation.invited_by_identity_id
       JOIN fractal.identities invitee ON invitee.id = $2
      WHERE invitation.token_hash = $1
        AND invitee.status = 'active'
        AND invitee.email_verified_at IS NOT NULL
        AND invitee.email = invitation.email`,
    [hashInvitationToken(input.token), input.identityId],
  );
  const invitation = result.rows[0];
  if (!invitation || invitation.delivery_status !== "sent" || invitation.revoked_at || invitation.accepted_at || invitation.expires_at <= new Date()) {
    throw new OrganizationInvitationError("Invitation is invalid or expired for this identity");
  }
  return {
    invitationId: invitation.id,
    organizationId: invitation.organization_id,
    organizationLegalName: invitation.organization_legal_name,
    inviterLegalName: invitation.inviter_legal_name,
    role: invitation.role,
    expiresAt: invitation.expires_at.toISOString(),
  };
}

export async function acceptOrganizationInvitation(input: {
  token: string;
  identityId: string;
}): Promise<{ organizationId: string; role: OrganizationMembershipRole; membershipId: string }> {
  if (input.token.length < 32 || input.token.length > 256) throw new OrganizationInvitationError("Invitation is invalid or expired");
  return withPostgresTransaction(async (client) => {
    const invitationResult = await client.query<InvitationRow>(
      `SELECT id, organization_id, email, role, invited_by_identity_id, expires_at,
              accepted_at, revoked_at, delivery_status
         FROM fractal.organization_invitations
        WHERE token_hash = $1
        FOR UPDATE`,
      [hashInvitationToken(input.token)],
    );
    const invitation = invitationResult.rows[0];
    if (!invitation || invitation.delivery_status !== "sent" || invitation.accepted_at || invitation.revoked_at || invitation.expires_at <= new Date()) {
      throw new OrganizationInvitationError("Invitation is invalid or expired");
    }
    const identityResult = await client.query<{ email: string; role: string | null }>(
      `SELECT identity.email, role.role
         FROM fractal.identities identity
         LEFT JOIN LATERAL (
           SELECT assignment.role FROM fractal.identity_role_assignments assignment
            WHERE assignment.identity_id = identity.id AND assignment.scope_type = 'global'
              AND assignment.revoked_at IS NULL ORDER BY assignment.granted_at DESC, assignment.id DESC LIMIT 1
         ) role ON TRUE
        WHERE identity.id = $1 AND identity.status = 'active' AND identity.email_verified_at IS NOT NULL
        FOR UPDATE OF identity`,
      [input.identityId],
    );
    const identity = identityResult.rows[0];
    if (!identity || identity.email !== invitation.email) throw new OrganizationInvitationError("Invitation is not valid for this identity");
    if (identity.role !== "issuer") throw new OrganizationInvitationError("This invitation requires an issuer-capacity account");
    const existingMembership = await client.query<{ id: string }>(
      `SELECT id FROM fractal.organization_memberships
        WHERE organization_id = $1 AND identity_id = $2
        FOR UPDATE`,
      [invitation.organization_id, input.identityId],
    );
    if (existingMembership.rows[0]) throw new OrganizationInvitationError("Identity already has organization access");

    const membershipId = randomUUID();
    await client.query(
      `INSERT INTO fractal.organization_memberships (id, organization_id, identity_id, role, status, invited_by_identity_id)
       VALUES ($1, $2, $3, $4, 'active', $5)`,
      [membershipId, invitation.organization_id, input.identityId, invitation.role, invitation.invited_by_identity_id],
    );
    await client.query(
      `UPDATE fractal.organization_invitations
          SET accepted_at = now(), accepted_by_identity_id = $2, updated_at = now()
        WHERE id = $1`,
      [invitation.id, input.identityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${invitation.organization_id}`,
      organizationId: invitation.organization_id,
      actorId: input.identityId,
      actorType: "identity",
      action: "organization.invitation.accepted",
      entityType: "organization_membership",
      entityId: membershipId,
      payload: { invitationId: invitation.id, role: invitation.role },
    });
    await appendOutboxEvent(client, {
      aggregateType: "organization_membership",
      aggregateId: membershipId,
      eventType: "organization.invitation.accepted",
      payload: { organizationId: invitation.organization_id, invitationId: invitation.id, role: invitation.role, auditEventId: audit.id },
    });
    return { organizationId: invitation.organization_id, role: invitation.role, membershipId };
  });
}

export async function claimOrganizationInvitationDeliveries(input: {
  workerId: string;
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedOrganizationInvitationDelivery[]> {
  if (input.limit <= 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      organization_id: string;
      delivery_attempts: number;
      delivery_generation: number;
    }>(
      `WITH candidates AS (
         SELECT id FROM fractal.organization_invitations
          WHERE delivery_status IN ('requested', 'failed')
            AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
            AND delivery_next_attempt_at <= now()
            AND (delivery_claimed_at IS NULL OR delivery_claimed_at < now() - ($1 * interval '1 second'))
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE fractal.organization_invitations invitation
          SET delivery_claimed_at = now(), delivery_claimed_by = $3,
              delivery_attempts = invitation.delivery_attempts + 1, updated_at = now()
         FROM candidates WHERE invitation.id = candidates.id
       RETURNING invitation.id, invitation.organization_id,
                 invitation.delivery_attempts, invitation.delivery_generation`,
      [input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      organizationId: row.organization_id,
      attempts: row.delivery_attempts,
      generation: row.delivery_generation,
    }));
  });
}

async function prepareClaimedInvitationDelivery(input: { delivery: ClaimedOrganizationInvitationDelivery; workerId: string }) {
  const token = stableInvitationToken({
    invitationId: input.delivery.id,
    generation: input.delivery.generation,
  });
  const result = await requirePostgres().query<{ email: string; role: OrganizationInvitationRole; expires_at: Date; organization_legal_name: string; inviter_legal_name: string }>(
    `UPDATE fractal.organization_invitations invitation
        SET token_hash = $3, updated_at = now()
       FROM fractal.organizations organization, fractal.identities inviter
      WHERE invitation.id = $1 AND invitation.delivery_claimed_by = $2
        AND invitation.delivery_generation = $4
        AND invitation.delivery_status IN ('requested', 'failed')
        AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL AND invitation.expires_at > now()
        AND organization.id = invitation.organization_id AND inviter.id = invitation.invited_by_identity_id
      RETURNING invitation.email, invitation.role, invitation.expires_at,
                organization.legal_name AS organization_legal_name, inviter.legal_name AS inviter_legal_name`,
    [
      input.delivery.id,
      input.workerId,
      hashInvitationToken(token),
      input.delivery.generation,
    ],
  );
  const invitation = result.rows[0];
  if (!invitation) throw new OrganizationInvitationError("Invitation delivery is no longer actionable");
  return { token, ...invitation };
}

function invitationEmailPayload(input: {
  invitationId: string;
  generation: number;
  email: string;
  role: OrganizationInvitationRole;
  expiresAt: Date;
  organizationLegalName: string;
  inviterLegalName: string;
  token: string;
}): EmailPayload {
  const link = appUrl(`/invitation?token=${encodeURIComponent(input.token)}`);
  const expiry = input.expiresAt.toISOString();
  const organization = escapeHtml(input.organizationLegalName);
  const inviter = escapeHtml(input.inviterLegalName);
  const role = input.role.replaceAll("_", " ");
  return {
    to: input.email,
    subject: `Invitation to join ${input.organizationLegalName} on Fractal`,
    text: `${input.inviterLegalName} invited you to join ${input.organizationLegalName} on Fractal as ${role}. Review and accept the one-time invitation before ${expiry}: ${link}\n\nUse the account registered to this email address. If you do not recognize this invitation, do not use the link.`,
    html: `<p><strong>${inviter}</strong> invited you to join <strong>${organization}</strong> on Fractal as <strong>${escapeHtml(role)}</strong>.</p><p>Review and accept the one-time invitation before ${escapeHtml(expiry)}:</p><p><a href="${escapeHtml(link)}">Review secure invitation</a></p><p>Use the account registered to this email address. If you do not recognize this invitation, do not use the link.</p>`,
    idempotencyKey: `fractal-invitation-${input.invitationId}-${input.generation}`,
  };
}

async function markInvitationDeliverySent(input: {
  delivery: ClaimedOrganizationInvitationDelivery;
  workerId: string;
  result: Extract<EmailResult, { status: "sent" }>;
}) {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{ organization_id: string }>(
      `UPDATE fractal.organization_invitations
          SET delivery_status = 'sent', delivery_sent_at = now(), delivery_claimed_at = NULL,
              delivery_claimed_by = NULL, delivery_last_error = NULL,
              delivery_provider = $3, delivery_provider_message_id = $4,
              updated_at = now()
        WHERE id = $1 AND delivery_claimed_by = $2
          AND delivery_generation = $5
          AND delivery_status IN ('requested', 'failed')
        RETURNING organization_id`, [
        input.delivery.id,
        input.workerId,
        input.result.provider,
        input.result.providerMessageId,
        input.delivery.generation,
      ]);
    const row = result.rows[0];
    if (!row) throw new OrganizationInvitationError("Invitation delivery cannot be marked sent");
    await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${row.organization_id}`, organizationId: row.organization_id, actorType: "worker",
      action: "organization.invitation.delivered", entityType: "organization_invitation", entityId: input.delivery.id,
      payload: {
        attempts: input.delivery.attempts,
        provider: input.result.provider,
        deliveryGeneration: input.delivery.generation,
      },
    });
  });
}

async function markInvitationDeliveryFailed(input: { delivery: ClaimedOrganizationInvitationDelivery; workerId: string; terminal: boolean; retryAt: Date }) {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{ organization_id: string }>(
      `UPDATE fractal.organization_invitations
          SET delivery_status = CASE WHEN $4 THEN 'terminal' ELSE 'failed' END,
              delivery_claimed_at = NULL, delivery_claimed_by = NULL,
              delivery_next_attempt_at = CASE WHEN $4 THEN delivery_next_attempt_at ELSE $3 END,
              delivery_terminal_at = CASE WHEN $4 THEN now() ELSE NULL END,
              delivery_last_error = CASE WHEN $4 THEN 'delivery could not be completed' ELSE 'delivery retry scheduled' END,
              updated_at = now()
        WHERE id = $1 AND delivery_claimed_by = $2 AND delivery_status IN ('requested', 'failed')
          AND delivery_generation = $5
        RETURNING organization_id`, [
        input.delivery.id,
        input.workerId,
        input.retryAt,
        input.terminal,
        input.delivery.generation,
      ]);
    const row = result.rows[0];
    if (!row) throw new OrganizationInvitationError("Invitation delivery is no longer claimed by this worker");
    await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${row.organization_id}`, organizationId: row.organization_id, actorType: "worker",
      action: input.terminal ? "organization.invitation.delivery_terminal" : "organization.invitation.delivery_retry_scheduled",
      entityType: "organization_invitation", entityId: input.delivery.id,
      payload: { attempts: input.delivery.attempts },
    });
  });
}

export async function dispatchPendingOrganizationInvitationDeliveries(input: {
  workerId?: string;
  send: (payload: EmailPayload) => Promise<EmailResult>;
  logger: OrganizationInvitationDeliveryLogger;
}): Promise<number> {
  const workerId = input.workerId ?? randomUUID();
  const deliveries = await claimOrganizationInvitationDeliveries({
    workerId,
    limit: env.AUTH_EMAIL_DELIVERY_BATCH_SIZE,
    claimTimeoutSeconds: env.AUTH_EMAIL_DELIVERY_CLAIM_TIMEOUT_SECONDS,
  });
  for (const delivery of deliveries) {
    try {
      const prepared = await prepareClaimedInvitationDelivery({ delivery, workerId });
      const result = await input.send(invitationEmailPayload({
        invitationId: delivery.id,
        generation: delivery.generation,
        email: prepared.email,
        role: prepared.role,
        expiresAt: prepared.expires_at,
        organizationLegalName: prepared.organization_legal_name,
        inviterLegalName: prepared.inviter_legal_name,
        token: prepared.token,
      }));
      if (result.status !== "sent") throw new OrganizationInvitationError(result.error ?? "Invitation email transport did not accept delivery");
      await markInvitationDeliverySent({ delivery, workerId, result });
      input.logger.info({ invitationId: delivery.id, organizationId: delivery.organizationId }, "Organization invitation delivered");
    } catch (error) {
      const terminal = delivery.attempts >= env.AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS;
      const delaySeconds = Math.min(60 * 60, env.AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS * 2 ** Math.max(0, delivery.attempts - 1));
      await markInvitationDeliveryFailed({ delivery, workerId, terminal, retryAt: new Date(Date.now() + delaySeconds * 1_000) });
      input.logger.error({ err: error, invitationId: delivery.id, organizationId: delivery.organizationId, terminal, delaySeconds }, "Organization invitation delivery failed");
    }
  }
  return deliveries.length;
}

export function startOrganizationInvitationDeliveryDispatcher(input: {
  send: (payload: EmailPayload) => Promise<EmailResult>;
  logger: OrganizationInvitationDeliveryLogger;
}): { stop: () => void } {
  let running = false;
  let stopped = false;
  const workerId = randomUUID();
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try { await dispatchPendingOrganizationInvitationDeliveries({ ...input, workerId }); }
    catch (error) { input.logger.error({ err: error }, "Organization invitation dispatcher failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void dispatch(), env.AUTH_EMAIL_DELIVERY_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
