import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: vi.fn(), transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
const invitationEnv = vi.hoisted(() => ({ JWT_SECRET: "test-jwt-secret", EMAIL_DELIVERY_SECRET_KEY: "delivery-secret", APP_BASE_URL: "https://app.example.test" }));
vi.mock("../../config/env.js", () => ({ env: invitationEnv }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  acceptOrganizationInvitation,
  changeOrganizationMembershipRole,
  changeOrganizationMembershipStatus,
  claimOrganizationInvitationDeliveries,
  inspectOrganizationInvitation,
  issueOrganizationInvitation,
  OrganizationInvitationError,
  resolveOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../tenant-invitations.js";

const activeInvitation = {
  id: "invitation-1", organization_id: "organization-1", email: "issuer@example.test", role: "viewer", invited_by_identity_id: "admin-1",
  expires_at: new Date("2030-07-29T10:00:00.000Z"), accepted_at: null, revoked_at: null, delivery_status: "sent" as const,
};
const validToken = "a".repeat(32);

function postgresWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.postgres.mockReturnValue({ query });
  return query;
}
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.postgres.mockReset(); mocks.transaction.mockReset();
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockReset().mockResolvedValue(undefined);
});

describe("organization invitations", () => {
  it("validates invitation issue input before it runs an authority command", async () => {
    await expect(issueOrganizationInvitation({ organizationId: "organization-1", invitedByIdentityId: "admin-1", email: "bad", role: "viewer", expiresAt: new Date(Date.now() + 2 * 60 * 60_000) })).rejects.toThrow("valid invitation email");
    await expect(issueOrganizationInvitation({ organizationId: "organization-1", invitedByIdentityId: "admin-1", email: "issuer@example.test", role: "owner" as never, expiresAt: new Date(Date.now() + 2 * 60 * 60_000) })).rejects.toThrow("role is invalid");
    await expect(issueOrganizationInvitation({ organizationId: "organization-1", invitedByIdentityId: "admin-1", email: "issuer@example.test", role: "viewer", expiresAt: new Date(Date.now() + 1_000) })).rejects.toThrow("at least one hour");
  });

  it("returns each public invitation resolution state", async () => {
    await expect(resolveOrganizationInvitation("short")).resolves.toEqual({ state: "invalid" });
    postgresWithResponses({ rows: [] });
    await expect(resolveOrganizationInvitation(validToken)).resolves.toEqual({ state: "invalid" });
    postgresWithResponses({ rows: [{ ...activeInvitation, accepted_at: new Date() }] });
    await expect(resolveOrganizationInvitation(validToken)).resolves.toEqual({ state: "accepted" });
    postgresWithResponses({ rows: [{ ...activeInvitation, revoked_at: new Date() }] });
    await expect(resolveOrganizationInvitation(validToken)).resolves.toEqual({ state: "revoked" });
    postgresWithResponses({ rows: [{ ...activeInvitation, expires_at: new Date("2020-01-01") }] });
    await expect(resolveOrganizationInvitation(validToken)).resolves.toEqual({ state: "expired" });
    postgresWithResponses({ rows: [activeInvitation] });
    await expect(resolveOrganizationInvitation(validToken)).resolves.toEqual({ state: "requires_auth" });
  });

  it("inspects an invitation only for the verified invited identity", async () => {
    await expect(inspectOrganizationInvitation({ token: "short", identityId: "issuer-1" })).rejects.toThrow("invalid or expired");
    postgresWithResponses({ rows: [{ ...activeInvitation, organization_legal_name: "Fractal Holdings", inviter_legal_name: "Admin User" }] });
    await expect(inspectOrganizationInvitation({ token: validToken, identityId: "issuer-1" })).resolves.toEqual({ invitationId: "invitation-1", organizationId: "organization-1", organizationLegalName: "Fractal Holdings", inviterLegalName: "Admin User", role: "viewer", expiresAt: "2030-07-29T10:00:00.000Z" });
    postgresWithResponses({ rows: [] });
    await expect(inspectOrganizationInvitation({ token: validToken, identityId: "other" })).rejects.toThrow("invalid or expired for this identity");
  });

  it("accepts a sent issuer invitation and writes membership evidence", async () => {
    const query = transactionWithResponses(
      { rows: [activeInvitation] }, { rows: [{ email: "issuer@example.test", role: "issuer" }] }, { rows: [] }, { rowCount: 1 }, { rowCount: 1 },
    );
    await expect(acceptOrganizationInvitation({ token: validToken, identityId: "issuer-1" })).resolves.toMatchObject({ organizationId: "organization-1", role: "viewer" });
    expect(query).toHaveBeenCalledTimes(5);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "organization.invitation.accepted" }));
    expect(mocks.outbox).toHaveBeenCalledOnce();
  });

  it("refuses an invitation for the wrong identity capacity or an existing member", async () => {
    transactionWithResponses({ rows: [activeInvitation] }, { rows: [{ email: "wrong@example.test", role: "issuer" }] });
    await expect(acceptOrganizationInvitation({ token: validToken, identityId: "issuer-1" })).rejects.toThrow("not valid for this identity");
    transactionWithResponses({ rows: [activeInvitation] }, { rows: [{ email: "issuer@example.test", role: "viewer" }] });
    await expect(acceptOrganizationInvitation({ token: validToken, identityId: "issuer-1" })).rejects.toThrow("issuer-capacity");
    transactionWithResponses({ rows: [activeInvitation] }, { rows: [{ email: "issuer@example.test", role: "issuer" }] }, { rows: [{ id: "membership-1" }] });
    await expect(acceptOrganizationInvitation({ token: validToken, identityId: "issuer-1" })).rejects.toThrow("already has organization access");
  });

  it("validates revocation reason and leaves a prior revocation idempotent", async () => {
    await expect(revokeOrganizationInvitation({ invitationId: "invitation-1", organizationId: "organization-1", revokedByIdentityId: "admin-1", reason: "bad" })).rejects.toThrow("between 5 and 1000");
    transactionWithResponses({ rows: [{ legal_name: "Fractal", role: "administrator" }] }, { rows: [{ ...activeInvitation, revoked_at: new Date() }] });
    await expect(revokeOrganizationInvitation({ invitationId: "invitation-1", organizationId: "organization-1", revokedByIdentityId: "admin-1", reason: "No longer required" })).resolves.toEqual({ invitationId: "invitation-1", state: "revoked" });
  });

  it("claims due invitation deliveries and returns empty work for nonpositive limits", async () => {
    await expect(claimOrganizationInvitationDeliveries({ workerId: "worker-1", limit: 0, claimTimeoutSeconds: 300 })).resolves.toEqual([]);
    transactionWithResponses({ rows: [{ id: "invitation-1", organization_id: "organization-1", delivery_attempts: 2, delivery_generation: 3 }] });
    await expect(claimOrganizationInvitationDeliveries({ workerId: "worker-1", limit: 10, claimTimeoutSeconds: 300 })).resolves.toEqual([{ id: "invitation-1", organizationId: "organization-1", attempts: 2, generation: 3 }]);
  });

  it("enforces membership self-management and owner protections", async () => {
    await expect(changeOrganizationMembershipRole({ membershipId: "membership-1", organizationId: "organization-1", changedByIdentityId: "admin-1", role: "owner" as never, reason: "Valid reason" })).rejects.toThrow("role is invalid");
    transactionWithResponses({ rows: [{ legal_name: "Fractal", role: "administrator" }] }, { rows: [{ id: "membership-1", identity_id: "admin-1", role: "viewer", status: "active" }] });
    await expect(changeOrganizationMembershipRole({ membershipId: "membership-1", organizationId: "organization-1", changedByIdentityId: "admin-1", role: "viewer", reason: "Valid reason" })).rejects.toThrow("separate authorized owner");
    transactionWithResponses({ rows: [{ legal_name: "Fractal", role: "owner" }] }, { rows: [{ id: "membership-1", identity_id: "issuer-1", role: "owner" as never, status: "active" }] });
    await expect(changeOrganizationMembershipStatus({ membershipId: "membership-1", organizationId: "organization-1", changedByIdentityId: "admin-1", action: "suspend", reason: "Valid reason" })).rejects.toThrow("ownership-transfer");
  });

  it("uses the invitation error type", () => {
    expect(new OrganizationInvitationError("message")).toBeInstanceOf(Error);
  });
});
