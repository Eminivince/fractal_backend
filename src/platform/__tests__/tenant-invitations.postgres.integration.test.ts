import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import type { EmailPayload } from "../../services/email.js";
import {
  createIssuerOrganization,
  decideOrganizationVerification,
  getOrganizationAuthorityWorkspace,
  recordOrganizationVerificationEvidence,
  submitOrganizationVerification,
} from "../postgres-organization-authority.js";
import {
  decideOrganizationOwnershipTransfer,
  expireOrganizationOwnershipTransfers,
  proposeOrganizationOwnershipTransfer,
} from "../postgres-organization-ownership.js";
import {
  acceptOrganizationInvitation,
  changeOrganizationMembershipRole,
  changeOrganizationMembershipStatus,
  dispatchPendingOrganizationInvitationDeliveries,
  inspectOrganizationInvitation,
  issueOrganizationInvitation,
  OrganizationInvitationError,
  resolveOrganizationInvitation,
  resendOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../tenant-invitations.js";

async function identity(email: string, input: { role?: "issuer" | "investor" | "operator" | "admin"; verified?: boolean } = {}) {
  const id = randomUUID();
  await postgresQuery(
    `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
     VALUES ($1, $2, 'Invitation test identity', 'active', $3)`,
    [id, email, input.verified === false ? null : new Date()],
  );
  await postgresQuery(
    `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
     VALUES ($1, $2, $3, 'global')`,
    [randomUUID(), id, input.role ?? "issuer"],
  );
  return id;
}

async function organization() {
  const id = randomUUID();
  await postgresQuery("INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, $2, 'active')", [id, `Organization ${id}`]);
  return id;
}

async function membership(organizationId: string, identityId: string, role: "owner" | "administrator" = "owner") {
  const id = randomUUID();
  await postgresQuery(
    `INSERT INTO fractal.organization_memberships (id, organization_id, identity_id, role, status)
     VALUES ($1, $2, $3, $4, 'active')`,
    [id, organizationId, identityId, role],
  );
  return id;
}

async function deliverInvitation(email: string): Promise<{ token: string; payload: EmailPayload }> {
  const delivered: EmailPayload[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await dispatchPendingOrganizationInvitationDeliveries({
      workerId: randomUUID(),
      send: async (payload) => {
        delivered.push(payload);
        return {
          status: "sent",
          provider: "resend",
          providerMessageId: `resend-${payload.idempotencyKey}`,
        };
      },
      logger: { info: vi.fn(), error: vi.fn() },
    });
    const payload = delivered.find((candidate) => candidate.to === email);
    if (payload) {
      const token = /\/invitation\?token=([A-Za-z0-9_-]+)/.exec(payload.text)?.[1];
      if (!token) throw new Error("Invitation email did not contain a bearer token");
      return { token, payload };
    }
  }
  throw new Error(`Invitation for ${email} was not delivered`);
}

describe("PostgreSQL organization invitations", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => { await disconnectPostgres(); });

  it("queues delivery without returning a bearer token, stores only its hash, and atomically creates membership", async () => {
    const issuer = await identity(`issuer-${randomUUID()}@example.test`);
    const inviteeEmail = `invitee-${randomUUID()}@example.test`;
    const invitee = await identity(inviteeEmail);
    const organizationId = await organization();
    await membership(organizationId, issuer);
    const issued = await issueOrganizationInvitation({
      organizationId, invitedByIdentityId: issuer, email: inviteeEmail, role: "viewer",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), commandKey: randomUUID(),
    });
    expect(issued.body).toMatchObject({ deliveryStatus: "requested" });
    expect(issued.body).not.toHaveProperty("token");
    const beforeDelivery = await postgresQuery<{ token_hash: string | null; delivery_status: string }>(
      "SELECT token_hash, delivery_status FROM fractal.organization_invitations WHERE id = $1", [issued.body.invitationId]);
    expect(beforeDelivery.rows[0]).toMatchObject({ token_hash: null, delivery_status: "requested" });

    const delivered = await deliverInvitation(inviteeEmail);
    const stored = await postgresQuery<{
      token_hash: string;
      delivery_status: string;
      delivery_generation: number;
      delivery_provider: string | null;
      delivery_provider_message_id: string | null;
    }>(
      `SELECT token_hash, delivery_status, delivery_generation,
              delivery_provider, delivery_provider_message_id
         FROM fractal.organization_invitations
        WHERE id = $1`,
      [issued.body.invitationId],
    );
    expect(stored.rows[0]?.token_hash).not.toBe(delivered.token);
    expect(stored.rows[0]?.delivery_status).toBe("sent");
    expect(stored.rows[0]).toMatchObject({
      delivery_generation: 1,
      delivery_provider: "resend",
      delivery_provider_message_id: `resend-${delivered.payload.idempotencyKey}`,
    });

    await expect(acceptOrganizationInvitation({ token: delivered.token, identityId: invitee }))
      .resolves.toMatchObject({ organizationId, role: "viewer" });
    const accepted = await postgresQuery<{ accepted_by_identity_id: string }>(
      "SELECT accepted_by_identity_id FROM fractal.organization_invitations WHERE id = $1", [issued.body.invitationId]);
    expect(accepted.rows[0]?.accepted_by_identity_id).toBe(invitee);
    await expect(acceptOrganizationInvitation({ token: delivered.token, identityId: invitee }))
      .rejects.toBeInstanceOf(OrganizationInvitationError);
  });

  it("does not disclose organization details before matching authenticated identity proof", async () => {
    const issuer = await identity(`issuer-${randomUUID()}@example.test`);
    const inviteeEmail = `invited-${randomUUID()}@example.test`;
    const invitee = await identity(inviteeEmail);
    const other = await identity(`other-${randomUUID()}@example.test`);
    const organizationId = await organization();
    await membership(organizationId, issuer, "administrator");
    await issueOrganizationInvitation({
      organizationId, invitedByIdentityId: issuer, email: inviteeEmail, role: "finance_operator",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), commandKey: randomUUID(),
    });
    const { token } = await deliverInvitation(inviteeEmail);
    const publicResolution = await resolveOrganizationInvitation(token);
    expect(publicResolution).toEqual({ state: "requires_auth" });
    expect(publicResolution).not.toHaveProperty("organizationId");
    expect(publicResolution).not.toHaveProperty("email");
    await expect(inspectOrganizationInvitation({ token, identityId: invitee })).resolves.toMatchObject({
      organizationId, role: "finance_operator", organizationLegalName: expect.any(String), inviterLegalName: expect.any(String),
    });
    await expect(inspectOrganizationInvitation({ token, identityId: other })).rejects.toThrow("invalid or expired for this identity");
    await expect(acceptOrganizationInvitation({ token, identityId: other })).rejects.toThrow("not valid for this identity");
  });

  it("keeps one invitation token and provider command stable across a retry", async () => {
    const issuer = await identity(`retry-issuer-${randomUUID()}@example.test`);
    const inviteeEmail = `retry-invitee-${randomUUID()}@example.test`;
    const organizationId = await organization();
    await membership(organizationId, issuer);
    const issued = await issueOrganizationInvitation({
      organizationId,
      invitedByIdentityId: issuer,
      email: inviteeEmail,
      role: "viewer",
      expiresAt: new Date(Date.now() + 86_400_000),
      commandKey: randomUUID(),
    });
    const attempts: EmailPayload[] = [];
    await dispatchPendingOrganizationInvitationDeliveries({
      workerId: "invitation-retry-first",
      send: async (payload) => {
        attempts.push(payload);
        return { status: "failed", error: "ambiguous provider timeout" };
      },
      logger: { info: vi.fn(), error: vi.fn() },
    });
    await postgresQuery(
      `UPDATE fractal.organization_invitations
          SET delivery_next_attempt_at = now()
        WHERE id = $1`,
      [issued.body.invitationId],
    );
    await dispatchPendingOrganizationInvitationDeliveries({
      workerId: "invitation-retry-second",
      send: async (payload) => {
        attempts.push(payload);
        return {
          status: "sent",
          provider: "resend",
          providerMessageId: "resend-invitation-retry-1",
        };
      },
      logger: { info: vi.fn(), error: vi.fn() },
    });
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const stored = await postgresQuery<{
      delivery_attempts: number;
      delivery_generation: number;
      delivery_provider_message_id: string;
    }>(
      `SELECT delivery_attempts, delivery_generation,
              delivery_provider_message_id
         FROM fractal.organization_invitations
        WHERE id = $1`,
      [issued.body.invitationId],
    );
    expect(stored.rows[0]).toEqual({
      delivery_attempts: 2,
      delivery_generation: 1,
      delivery_provider_message_id: "resend-invitation-retry-1",
    });
  });

  it("requires a verified issuer-capacity account and rejects unverified or investor identities", async () => {
    const issuer = await identity(`issuer-${randomUUID()}@example.test`);
    const organizationId = await organization();
    await membership(organizationId, issuer);

    const unverifiedEmail = `unverified-${randomUUID()}@example.test`;
    const unverified = await identity(unverifiedEmail, { verified: false });
    await issueOrganizationInvitation({ organizationId, invitedByIdentityId: issuer, email: unverifiedEmail, role: "viewer", expiresAt: new Date(Date.now() + 86_400_000), commandKey: randomUUID() });
    const unverifiedDelivery = await deliverInvitation(unverifiedEmail);
    await expect(acceptOrganizationInvitation({ token: unverifiedDelivery.token, identityId: unverified })).rejects.toThrow("not valid for this identity");

    const investorEmail = `investor-${randomUUID()}@example.test`;
    const investor = await identity(investorEmail, { role: "investor" });
    await issueOrganizationInvitation({ organizationId, invitedByIdentityId: issuer, email: investorEmail, role: "viewer", expiresAt: new Date(Date.now() + 86_400_000), commandKey: randomUUID() });
    const investorDelivery = await deliverInvitation(investorEmail);
    await expect(acceptOrganizationInvitation({ token: investorDelivery.token, identityId: investor })).rejects.toThrow("issuer-capacity account");
  });

  it("is command-idempotent and revocation immediately invalidates the delivered token", async () => {
    const issuer = await identity(`issuer-${randomUUID()}@example.test`);
    const inviteeEmail = `revoke-${randomUUID()}@example.test`;
    const organizationId = await organization();
    await membership(organizationId, issuer);
    const commandKey = randomUUID();
    const input = { organizationId, invitedByIdentityId: issuer, email: inviteeEmail, role: "viewer" as const, expiresAt: new Date(Date.now() + 86_400_000), commandKey };
    const first = await issueOrganizationInvitation(input);
    const replay = await issueOrganizationInvitation(input);
    expect(replay.replayed).toBe(true);
    expect(replay.body.invitationId).toBe(first.body.invitationId);
    const { token } = await deliverInvitation(inviteeEmail);
    await expect(revokeOrganizationInvitation({ invitationId: first.body.invitationId, organizationId, revokedByIdentityId: issuer, reason: "Recipient access is no longer required" }))
      .resolves.toEqual({ invitationId: first.body.invitationId, state: "revoked" });
    await expect(resolveOrganizationInvitation(token)).resolves.toEqual({ state: "invalid" });
  });

  it("rotates invitation bearers on governed resend and enforces membership-management boundaries", async () => {
    const owner = await identity(`access-owner-${randomUUID()}@example.test`);
    const administrator = await identity(`access-admin-${randomUUID()}@example.test`);
    const collaboratorEmail = `access-member-${randomUUID()}@example.test`;
    const collaborator = await identity(collaboratorEmail);
    const organizationId = await organization();
    await membership(organizationId, owner);
    const administratorMembershipId = await membership(organizationId, administrator, "administrator");
    const issued = await issueOrganizationInvitation({
      organizationId, invitedByIdentityId: owner, email: collaboratorEmail, role: "viewer",
      expiresAt: new Date(Date.now() + 86_400_000), commandKey: randomUUID(),
    });
    const firstDelivery = await deliverInvitation(collaboratorEmail);
    const firstState = await postgresQuery<{ delivery_generation: number }>(
      "SELECT delivery_generation FROM fractal.organization_invitations WHERE id = $1",
      [issued.body.invitationId],
    );
    expect(firstState.rows[0]?.delivery_generation).toBe(1);
    await postgresQuery(
      "UPDATE fractal.organization_invitations SET delivery_sent_at = now() - interval '6 minutes', updated_at = now() - interval '6 minutes' WHERE id = $1",
      [issued.body.invitationId],
    );
    const resent = await resendOrganizationInvitation({
      organizationId, invitationId: issued.body.invitationId, requestedByIdentityId: owner, commandKey: randomUUID(),
    });
    expect(resent.body).toMatchObject({ deliveryStatus: "requested" });
    await expect(resolveOrganizationInvitation(firstDelivery.token)).resolves.toEqual({ state: "invalid" });
    const secondDelivery = await deliverInvitation(collaboratorEmail);
    expect(secondDelivery.token).not.toBe(firstDelivery.token);
    const secondState = await postgresQuery<{ delivery_generation: number }>(
      "SELECT delivery_generation FROM fractal.organization_invitations WHERE id = $1",
      [issued.body.invitationId],
    );
    expect(secondState.rows[0]?.delivery_generation).toBe(2);
    const accepted = await acceptOrganizationInvitation({ token: secondDelivery.token, identityId: collaborator });

    await expect(changeOrganizationMembershipRole({
      organizationId, membershipId: accepted.membershipId, changedByIdentityId: owner,
      role: "finance_operator", reason: "Finance operations responsibility was approved",
    })).resolves.toMatchObject({ role: "finance_operator", status: "active" });
    await expect(changeOrganizationMembershipStatus({
      organizationId, membershipId: accepted.membershipId, changedByIdentityId: administrator,
      action: "suspend", reason: "Access is paused during a responsibility review",
    })).resolves.toMatchObject({ status: "suspended" });
    await expect(changeOrganizationMembershipStatus({
      organizationId, membershipId: accepted.membershipId, changedByIdentityId: administrator,
      action: "restore", reason: "The responsibility review has completed",
    })).resolves.toMatchObject({ status: "active" });
    await expect(changeOrganizationMembershipRole({
      organizationId, membershipId: administratorMembershipId, changedByIdentityId: administrator,
      role: "viewer", reason: "Attempted self-service role reduction",
    })).rejects.toThrow("separate authorized owner");
    await expect(changeOrganizationMembershipStatus({
      organizationId, membershipId: administratorMembershipId, changedByIdentityId: owner,
      action: "revoke", reason: "Administrator access is no longer required",
    })).resolves.toMatchObject({ status: "revoked" });

    const successor = await identity(`access-successor-${randomUUID()}@example.test`);
    const successorMembershipId = await membership(organizationId, successor, "administrator");
    const proposed = await proposeOrganizationOwnershipTransfer({
      organizationId, requestedByIdentityId: owner, targetMembershipId: successorMembershipId,
      reason: "The board approved an accountable change of organization owner",
      expiresAt: new Date(Date.now() + 86_400_000), commandKey: randomUUID(),
    });
    await expect(decideOrganizationOwnershipTransfer({
      organizationId, transferId: proposed.body.transferId, actorIdentityId: owner,
      action: "accept", reason: "The source owner cannot accept for the successor", commandKey: randomUUID(),
    })).rejects.toThrow("nominated successor");
    await expect(decideOrganizationOwnershipTransfer({
      organizationId, transferId: proposed.body.transferId, actorIdentityId: successor,
      action: "accept", reason: "I accept the accountable organization ownership responsibilities", commandKey: randomUUID(),
    })).resolves.toMatchObject({ body: { status: "accepted" } });
    const transferredRoles = await postgresQuery<{ identity_id: string; role: string }>(
      "SELECT identity_id, role FROM fractal.organization_memberships WHERE organization_id = $1 AND identity_id = ANY($2::uuid[]) ORDER BY identity_id",
      [organizationId, [owner, successor]],
    );
    expect(transferredRoles.rows).toEqual(expect.arrayContaining([
      { identity_id: owner, role: "administrator" }, { identity_id: successor, role: "owner" },
    ]));
    await expect(postgresQuery(
      "UPDATE fractal.organization_ownership_transfer_requests SET decision_reason = 'tampered terminal record' WHERE id = $1",
      [proposed.body.transferId],
    )).rejects.toThrow("immutable");

    const priorOwnerMembership = await postgresQuery<{ id: string }>(
      "SELECT id FROM fractal.organization_memberships WHERE organization_id = $1 AND identity_id = $2",
      [organizationId, owner],
    );
    expect(priorOwnerMembership.rows[0]?.id).toBeDefined();
    const expiring = await proposeOrganizationOwnershipTransfer({
      organizationId, requestedByIdentityId: successor, targetMembershipId: priorOwnerMembership.rows[0]!.id,
      reason: "This succession proposal is used to prove accountable automatic expiry",
      expiresAt: new Date(Date.now() + 86_400_000), commandKey: randomUUID(),
    });
    await postgresQuery(
      `UPDATE fractal.organization_ownership_transfer_requests
          SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
        WHERE id = $1`,
      [expiring.body.transferId],
    );
    await expect(expireOrganizationOwnershipTransfers(organizationId)).resolves.toBe(1);
    await expect(expireOrganizationOwnershipTransfers(organizationId)).resolves.toBe(0);
    const expiryEvidence = await postgresQuery<{ audit_count: string; outbox_count: string }>(
      `SELECT
         (SELECT count(*) FROM fractal.audit_events WHERE entity_id = $1 AND action = 'organization.ownership_transfer.expired')::text AS audit_count,
         (SELECT count(*) FROM fractal.outbox_events WHERE aggregate_id = $1 AND event_type = 'organization.ownership_transfer.expired')::text AS outbox_count`,
      [expiring.body.transferId],
    );
    expect(expiryEvidence.rows[0]).toEqual({ audit_count: "1", outbox_count: "1" });
    const events = await postgresQuery<{ action: string }>(
      `SELECT action FROM fractal.audit_events
        WHERE organization_id = $1 AND action LIKE 'organization.membership.%'`,
      [organizationId],
    );
    expect(events.rows.map((event) => event.action)).toEqual(expect.arrayContaining([
      "organization.membership.role_changed", "organization.membership.suspended",
      "organization.membership.restored", "organization.membership.revoked",
    ]));
  });

  it("keeps at least one active owner even when a direct database mutation is attempted", async () => {
    const issuer = await identity(`owner-${randomUUID()}@example.test`);
    const organizationId = await organization();
    await membership(organizationId, issuer);
    await expect(postgresQuery(
      `UPDATE fractal.organization_memberships SET status = 'revoked', revoked_at = now()
        WHERE organization_id = $1 AND identity_id = $2`, [organizationId, issuer],
    )).rejects.toThrow("organization must retain at least one active owner");

    const secondOwner = await identity(`owner-two-${randomUUID()}@example.test`);
    await membership(organizationId, secondOwner);
    await expect(postgresQuery(
      `UPDATE fractal.organization_memberships SET status = 'revoked', revoked_at = now()
        WHERE organization_id = $1 AND identity_id = $2`, [organizationId, issuer],
    )).resolves.toMatchObject({ rowCount: 1 });
  });

  it("creates an issuer organization atomically and governs a complete independent KYB decision", async () => {
    const issuer = await identity(`kyb-issuer-${randomUUID()}@example.test`);
    const reviewer = await identity(`kyb-reviewer-${randomUUID()}@example.test`, { role: "operator" });
    const commandKey = randomUUID();
    const profile = {
      legalName: `Authority Test ${randomUUID()}`,
      registrationNumber: `RC-${randomUUID()}`,
      jurisdictionCode: "NG",
      entityType: "private_company" as const,
      primaryActivity: "Institutional-grade logistics infrastructure",
      registeredAddress: { line1: "14 Authority Avenue", city: "Lagos", stateOrProvince: "Lagos", countryCode: "NG" },
    };
    const created = await createIssuerOrganization({ identityId: issuer, commandKey, ...profile });
    const replay = await createIssuerOrganization({ identityId: issuer, commandKey, ...profile });
    expect(replay.replayed).toBe(true);
    expect(replay.body.organizationId).toBe(created.body.organizationId);
    const organizationId = created.body.organizationId;
    const owner = await postgresQuery<{ role: string; status: string }>(
      "SELECT role, status FROM fractal.organization_memberships WHERE organization_id = $1 AND identity_id = $2", [organizationId, issuer]);
    expect(owner.rows[0]).toMatchObject({ role: "owner", status: "active" });

    const evidence = await Promise.all([
      ["registration_evidence", "registration.pdf"],
      ["ownership_structure", "ownership.pdf"],
      ["representative_authority", "authority.pdf"],
    ].map(async ([evidenceType, filename], index) => recordOrganizationVerificationEvidence({
      organizationId, uploadedByIdentityId: issuer,
      evidenceType: evidenceType as "registration_evidence" | "ownership_structure" | "representative_authority",
      filename: filename!, mimeType: "application/pdf", storageKey: `test/organization/${organizationId}/${filename}`,
      contentSha256: String(index + 1).repeat(64), bytes: 1024 + index,
    })));
    const submitted = await submitOrganizationVerification({
      organizationId, submittedByIdentityId: issuer, commandKey: randomUUID(), ...profile,
      representativeAuthorityBasis: "I am a duly appointed director authorized by board resolution to represent this organization.",
      beneficialOwners: [
        { ownerType: "natural_person", legalName: "This input must be canonicalized", ownershipBps: 6000, isControlPerson: true, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG", identityLink: "self" },
        { ownerType: "natural_person", legalName: "Tunde Control", ownershipBps: 4000, isControlPerson: false, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG" },
      ],
      evidenceDocumentIds: evidence.map((document) => document.evidenceDocumentId),
    });
    expect(submitted.body).toMatchObject({ version: 1, status: "submitted" });
    await expect(decideOrganizationVerification({ requestId: submitted.body.requestId, decidedByIdentityId: issuer, approve: true, reason: "Issuer evidence has been independently verified" }))
      .rejects.toThrow("operator or administrator");
    const decision = await decideOrganizationVerification({
      requestId: submitted.body.requestId, decidedByIdentityId: reviewer, approve: true,
      reason: "Registry, ownership, and representative-authority evidence were independently verified", validityDays: 365,
    });
    expect(decision).toMatchObject({ organizationId, status: "approved" });
    const workspace = await getOrganizationAuthorityWorkspace({ organizationId });
    expect(workspace.organization).toMatchObject({ verificationStatus: "verified", verificationVersion: 1 });
    expect(workspace.beneficialOwners).toHaveLength(2);
    expect(workspace.beneficialOwners).toEqual(expect.arrayContaining([
      expect.objectContaining({ legalName: "Invitation test identity", identityLink: "self" }),
      expect.objectContaining({ legalName: "Tunde Control", identityLink: null }),
    ]));
    const ownerLinks = await postgresQuery<{ legal_name: string; subject_identity_id: string | null; subject_link_basis: string | null; subject_linked_at: Date | null }>(
      `SELECT legal_name, subject_identity_id, subject_link_basis, subject_linked_at
         FROM fractal.organization_beneficial_owner_declarations
        WHERE verification_request_id = $1 ORDER BY ownership_bps DESC`,
      [submitted.body.requestId],
    );
    expect(ownerLinks.rows[0]).toMatchObject({
      legal_name: "Invitation test identity",
      subject_identity_id: issuer,
      subject_link_basis: "submitting_identity_self_declaration",
    });
    expect(ownerLinks.rows[0]?.subject_linked_at).toBeInstanceOf(Date);
    expect(ownerLinks.rows[1]).toMatchObject({ subject_identity_id: null, subject_link_basis: null, subject_linked_at: null });
    const unrelatedIdentity = await identity(`unrelated-owner-${randomUUID()}@example.test`);
    await expect(postgresQuery(
      `INSERT INTO fractal.organization_beneficial_owner_declarations
         (id, verification_request_id, owner_type, legal_name, ownership_bps, is_control_person,
          nationality_or_jurisdiction_code, country_of_residence_code, subject_identity_id,
          subject_link_basis, subject_linked_at)
       VALUES ($1,$2,'natural_person','Spoofed owner',0,false,'NG','NG',$3,
               'submitting_identity_self_declaration',now())`,
      [randomUUID(), submitted.body.requestId, unrelatedIdentity],
    )).rejects.toThrow("active verified verification request submitter");
    await postgresQuery("UPDATE fractal.identities SET email_verified_at = NULL WHERE id = $1", [issuer]);
    await expect(postgresQuery(
      `INSERT INTO fractal.organization_beneficial_owner_declarations
         (id, verification_request_id, owner_type, legal_name, ownership_bps, is_control_person,
          nationality_or_jurisdiction_code, country_of_residence_code, subject_identity_id,
          subject_link_basis, subject_linked_at)
       VALUES ($1,$2,'natural_person','Unverified direct insert',0,false,'NG','NG',$3,
               'submitting_identity_self_declaration',now())`,
      [randomUUID(), submitted.body.requestId, issuer],
    )).rejects.toThrow("active verified verification request submitter");
    await expect(submitOrganizationVerification({
      organizationId, submittedByIdentityId: issuer, commandKey: randomUUID(), ...profile,
      representativeAuthorityBasis: "I remain duly authorized to submit the governed renewal snapshot.",
      beneficialOwners: [{
        ownerType: "natural_person", legalName: "Unverified input", ownershipBps: 10000,
        isControlPerson: true, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG", identityLink: "self",
      }],
      evidenceDocumentIds: evidence.map((document) => document.evidenceDocumentId),
    })).rejects.toThrow("requires the active verified submitting identity");
    expect(workspace.evidenceDocuments).toHaveLength(3);
    const restrictedWorkspace = await getOrganizationAuthorityWorkspace({ organizationId, viewerRole: "viewer" });
    expect(restrictedWorkspace.beneficialOwners).toEqual([]);
    expect(restrictedWorkspace.evidenceDocuments).toEqual([]);
    expect(restrictedWorkspace.invitations).toEqual([]);
    expect(restrictedWorkspace.memberships).toHaveLength(1);
    await expect(postgresQuery(
      "UPDATE fractal.organization_beneficial_owner_declarations SET ownership_bps = 10000 WHERE verification_request_id = $1",
      [submitted.body.requestId],
    )).rejects.toThrow("immutable");
  });

  it("rejects cross-tenant verification evidence and incomplete ownership at both service and database boundaries", async () => {
    const issuer = await identity(`cross-tenant-${randomUUID()}@example.test`);
    const firstOrganizationId = await organization();
    const secondOrganizationId = await organization();
    await membership(firstOrganizationId, issuer);
    await membership(secondOrganizationId, issuer);
    const document = await recordOrganizationVerificationEvidence({
      organizationId: firstOrganizationId, uploadedByIdentityId: issuer, evidenceType: "registration_evidence",
      filename: "registration.pdf", mimeType: "application/pdf", storageKey: `test/cross/${randomUUID()}`,
      contentSha256: "a".repeat(64), bytes: 500,
    });
    const baseVerificationInput = {
      organizationId: firstOrganizationId, submittedByIdentityId: issuer, commandKey: randomUUID(),
      legalName: "Owner Link Boundary Organization", registrationNumber: `RC-${randomUUID()}`, jurisdictionCode: "NG",
      entityType: "private_company" as const, primaryActivity: "Infrastructure",
      registeredAddress: { line1: "3 Boundary Road", city: "Abuja", countryCode: "NG" },
      representativeAuthorityBasis: "Authorized representative under a current board resolution",
      evidenceDocumentIds: [document.evidenceDocumentId, randomUUID(), randomUUID()],
    };
    await expect(submitOrganizationVerification({
      ...baseVerificationInput,
      beneficialOwners: [{ ownerType: "legal_entity", legalName: "Cannot Be Me Limited", ownershipBps: 10000, isControlPerson: true, nationalityOrJurisdictionCode: "NG", identityLink: "self" }],
    })).rejects.toThrow("Only a natural-person owner");
    await expect(submitOrganizationVerification({
      ...baseVerificationInput,
      beneficialOwners: [
        { ownerType: "natural_person", legalName: "First self", ownershipBps: 5000, isControlPerson: true, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG", identityLink: "self" },
        { ownerType: "natural_person", legalName: "Second self", ownershipBps: 5000, isControlPerson: false, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG", identityLink: "self" },
      ],
    })).rejects.toThrow("may self-declare only one");
    await expect(submitOrganizationVerification({
      organizationId: secondOrganizationId, submittedByIdentityId: issuer, commandKey: randomUUID(),
      legalName: "Cross Tenant Organization", registrationNumber: `RC-${randomUUID()}`, jurisdictionCode: "NG",
      entityType: "private_company", primaryActivity: "Infrastructure",
      registeredAddress: { line1: "2 Boundary Road", city: "Abuja", countryCode: "NG" },
      representativeAuthorityBasis: "Authorized representative under a current board resolution",
      beneficialOwners: [{ ownerType: "natural_person", legalName: "Boundary Owner", ownershipBps: 10000, isControlPerson: true, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG" }],
      evidenceDocumentIds: [document.evidenceDocumentId, randomUUID(), randomUUID()],
    })).rejects.toThrow("Every verification document must belong to this organization");
    await expect(submitOrganizationVerification({
      organizationId: firstOrganizationId, submittedByIdentityId: issuer, commandKey: randomUUID(),
      legalName: "Incomplete Ownership Organization", registrationNumber: `RC-${randomUUID()}`, jurisdictionCode: "NG",
      entityType: "private_company", primaryActivity: "Infrastructure",
      registeredAddress: { line1: "4 Boundary Road", city: "Abuja", countryCode: "NG" },
      representativeAuthorityBasis: "Authorized representative under a current board resolution",
      beneficialOwners: [{ ownerType: "natural_person", legalName: "Incomplete Owner", ownershipBps: 9000, isControlPerson: true, nationalityOrJurisdictionCode: "NG", countryOfResidenceCode: "NG" }],
      evidenceDocumentIds: [document.evidenceDocumentId, randomUUID(), randomUUID()],
    })).rejects.toThrow("exactly 10000 basis points");
  });
});
