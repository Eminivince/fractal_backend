import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(), commandId: vi.fn(), authorize: vi.fn(), organizationAccess: vi.fn(),
  resolveInvitation: vi.fn(), inspectInvitation: vi.fn(), acceptInvitation: vi.fn(), issueInvitation: vi.fn(), revokeInvitation: vi.fn(), resendInvitation: vi.fn(),
  createOrganization: vi.fn(), workspace: vi.fn(), changeRole: vi.fn(), changeStatus: vi.fn(),
  proposeTransfer: vi.fn(), decideTransfer: vi.fn(), recordEvidence: vi.fn(), evidence: vi.fn(), submitVerification: vi.fn(),
  reviewQueue: vi.fn(), review: vi.fn(), decideVerification: vi.fn(), persist: vi.fn(), retrieve: vi.fn(), recordDocument: vi.fn(),
}));
const {
  TestIdentityUnavailableError, TestTenantAccessError, TestAuthorityError, TestInvitationError,
  TestTransferError, TestIdempotencyError,
} = vi.hoisted(() => ({
  TestIdentityUnavailableError: class TestIdentityUnavailableError extends Error {},
  TestTenantAccessError: class TestTenantAccessError extends Error {},
  TestAuthorityError: class TestAuthorityError extends Error {},
  TestInvitationError: class TestInvitationError extends Error {},
  TestTransferError: class TestTransferError extends Error {},
  TestIdempotencyError: class TestIdempotencyError extends Error {},
}));

vi.mock("../../../../platform/postgres-idempotency.js", () => ({ PostgresIdempotencyConflictError: TestIdempotencyError }));
vi.mock("../../../../platform/postgres-organization-ownership.js", () => ({
  OrganizationOwnershipTransferError: TestTransferError,
  proposeOrganizationOwnershipTransfer: mocks.proposeTransfer,
  decideOrganizationOwnershipTransfer: mocks.decideTransfer,
}));
vi.mock("../../../../platform/postgres-organization-authority.js", () => ({
  OrganizationAuthorityError: TestAuthorityError,
  organizationEntityTypes: ["limited_company"],
  organizationVerificationEvidenceTypes: ["certificate"],
  createIssuerOrganization: mocks.createOrganization,
  decideOrganizationVerification: mocks.decideVerification,
  getOrganizationAuthorityWorkspace: mocks.workspace,
  getOrganizationVerificationEvidence: mocks.evidence,
  getOrganizationVerificationReview: mocks.review,
  listOrganizationVerificationReviewQueue: mocks.reviewQueue,
  recordOrganizationVerificationEvidence: mocks.recordEvidence,
  submitOrganizationVerification: mocks.submitVerification,
}));
vi.mock("../../../../platform/postgres-identities.js", () => ({
  PostgresIdentityUnavailableError: TestIdentityUnavailableError,
  requirePostgresIdentityForSubject: mocks.identity,
}));
vi.mock("../../../../platform/tenant-invitations.js", () => ({
  OrganizationInvitationError: TestInvitationError,
  acceptOrganizationInvitation: mocks.acceptInvitation,
  changeOrganizationMembershipRole: mocks.changeRole,
  changeOrganizationMembershipStatus: mocks.changeStatus,
  inspectOrganizationInvitation: mocks.inspectInvitation,
  issueOrganizationInvitation: mocks.issueInvitation,
  resolveOrganizationInvitation: mocks.resolveInvitation,
  resendOrganizationInvitation: mocks.resendInvitation,
  revokeOrganizationInvitation: mocks.revokeInvitation,
}));
vi.mock("../../../../platform/tenant-access.js", () => ({
  organizationMembershipRoles: ["owner", "administrator", "viewer"],
  TenantAccessError: TestTenantAccessError,
  requireOrganizationAccess: mocks.organizationAccess,
}));
vi.mock("../../../../services/storage.js", () => ({ persistOrganizationVerificationEvidenceBinary: mocks.persist, retrieveFile: mocks.retrieve }));
vi.mock("../../../../services/storage-metadata-guard.js", () => ({ recordStoredDocument: mocks.recordDocument }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.commandId }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));

import { postgresOrganizationAuthorityRoutes } from "../postgres-organization-authority.routes.js";

const organizationId = "11111111-1111-4111-8111-111111111111";
const invitationId = "22222222-2222-4222-8222-222222222222";
const membershipId = "33333333-3333-4333-8333-333333333333";
const transferId = "44444444-4444-4444-8444-444444444444";
const evidenceId = "55555555-5555-4555-8555-555555555555";
const verificationId = "66666666-6666-4666-8666-666666666666";
const inviteToken = "a".repeat(32);
let role = "issuer";
let app: ReturnType<typeof Fastify>;

const profile = {
  legalName: "Fractal Asset Company Limited", registrationNumber: "RC-123456", jurisdictionCode: "NG", entityType: "limited_company",
  primaryActivity: "Real-world asset issuance and administration", registeredAddress: { line1: "1 Marina Road", city: "Lagos", countryCode: "NG" },
};
const evidence = { id: evidenceId, filename: "certificate.pdf", mimeType: "application/pdf", storageKey: "organizations/evidence.pdf", contentSha256: "8b3369944dd2a3fab39e32d1aeb1f763946a458ae3e6368a46432adc8f3a0860" };

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "issuer";
  mocks.identity.mockResolvedValue("identity-1");
  mocks.commandId.mockImplementation((headers: Record<string, string | undefined>) => headers["x-command-id"]);
  mocks.authorize.mockReturnValue(undefined);
  mocks.organizationAccess.mockResolvedValue({ role: "owner" });
  mocks.resolveInvitation.mockResolvedValue({ matched: true });
  mocks.inspectInvitation.mockResolvedValue({ invitationId });
  mocks.acceptInvitation.mockResolvedValue({ accepted: true });
  mocks.createOrganization.mockResolvedValue({ status: 201, body: { organizationId }, replayed: false });
  mocks.workspace.mockResolvedValue({ organization: { id: organizationId } });
  mocks.issueInvitation.mockResolvedValue({ status: 201, body: { invitationId }, replayed: false });
  mocks.revokeInvitation.mockResolvedValue({ revoked: true });
  mocks.resendInvitation.mockResolvedValue({ status: 202, body: { invitationId }, replayed: false });
  mocks.changeRole.mockResolvedValue({ changed: true });
  mocks.changeStatus.mockResolvedValue({ changed: true });
  mocks.proposeTransfer.mockResolvedValue({ status: 201, body: { transferId }, replayed: false });
  mocks.decideTransfer.mockResolvedValue({ status: 200, body: { transferId }, replayed: false });
  mocks.persist.mockResolvedValue({ storageKey: evidence.storageKey, sha256: evidence.contentSha256, bytes: 4 });
  mocks.recordDocument.mockImplementation(async ({ record }: { record: () => Promise<unknown> }) => record());
  mocks.recordEvidence.mockResolvedValue({ document: evidence });
  mocks.evidence.mockResolvedValue(evidence);
  mocks.retrieve.mockResolvedValue({ buffer: Buffer.from("safe"), redirectUrl: null });
  mocks.submitVerification.mockResolvedValue({ status: 201, body: { requestId: verificationId }, replayed: false });
  mocks.reviewQueue.mockResolvedValue([{ id: verificationId }]);
  mocks.review.mockResolvedValue({ request: { organizationId }, evidenceDocuments: [evidence] });
  mocks.decideVerification.mockResolvedValue({ approved: true });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message }));
  app.setSerializerCompiler(() => (value: unknown) => JSON.stringify(value));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "subject-1", role }; });
  await app.register(postgresOrganizationAuthorityRoutes);
});
afterEach(async () => { await app.close(); });

describe("organization authority routes", () => {
  it("resolves, inspects, and accepts a confidential invitation with identity binding", async () => {
    const resolved = await app.inject({ method: "POST", url: "/v1/organization-invitations/resolve", payload: { token: inviteToken } });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.headers["cache-control"]).toBe("no-store, private");
    await expect(app.inject({ method: "POST", url: "/v1/organization-invitations/inspect", payload: { token: inviteToken } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/organization-invitations/accept", payload: { token: inviteToken } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.inspectInvitation).toHaveBeenCalledWith({ token: inviteToken, identityId: "identity-1" });
    expect(mocks.acceptInvitation).toHaveBeenCalledWith({ token: inviteToken, identityId: "identity-1" });
  });

  it("requires issuer authority to create and manage an organization", async () => {
    const headers = { "x-command-id": "organization-1" };
    await expect(app.inject({ method: "POST", url: "/v1/governance/organizations", headers, payload: profile })).resolves.toMatchObject({ statusCode: 201 });
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/governance/organizations/${organizationId}/invitations`, headers: { "x-command-id": "invite-1" }, payload: { email: "member@example.test", role: "viewer", expiresAt: "2026-12-01T12:00:00.000Z" } })).resolves.toMatchObject({ statusCode: 201 });
    await expect(app.inject({ method: "POST", url: `/v1/governance/organizations/${organizationId}/invitations/${invitationId}/revoke`, payload: { reason: "The recipient no longer requires this invitation." } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/governance/organizations/${organizationId}/invitations/${invitationId}/resend`, headers: { "x-command-id": "resend-1" } })).resolves.toMatchObject({ statusCode: 202 });
    expect(mocks.createOrganization).toHaveBeenCalledWith(expect.objectContaining({ identityId: "identity-1", commandKey: "organization-1" }));
    expect(mocks.organizationAccess).toHaveBeenCalledWith(expect.objectContaining({ organizationId }));
  });

  it("applies role, membership, and two-party ownership commands through the organization scope", async () => {
    const base = `/v1/governance/organizations/${organizationId}`;
    await expect(app.inject({ method: "POST", url: `${base}/memberships/${membershipId}/role`, payload: { role: "viewer", reason: "The team member now only requires read access." } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `${base}/memberships/${membershipId}/status`, payload: { action: "suspend", reason: "The team member access requires temporary suspension." } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `${base}/ownership-transfers`, headers: { "x-command-id": "transfer-1" }, payload: { targetMembershipId: membershipId, reason: "The proposed owner has the required corporate authority.", expiresAt: "2026-12-01T12:00:00.000Z" } })).resolves.toMatchObject({ statusCode: 201 });
    await expect(app.inject({ method: "POST", url: `${base}/ownership-transfers/${transferId}/decision`, headers: { "x-command-id": "transfer-2" }, payload: { action: "accept", reason: "The receiving owner accepts the transfer authority." } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.changeRole).toHaveBeenCalledWith(expect.objectContaining({ membershipId, changedByIdentityId: "identity-1" }));
    expect(mocks.proposeTransfer).toHaveBeenCalledWith(expect.objectContaining({ targetMembershipId: membershipId, commandKey: "transfer-1" }));
  });

  it("stores verification evidence, verifies document bytes, and submits a controlled verification request", async () => {
    const base = `/v1/governance/organizations/${organizationId}`;
    await expect(app.inject({ method: "POST", url: `${base}/verification-evidence`, payload: { evidenceType: "certificate", filename: "certificate.pdf", mimeType: "application/pdf", contentBase64: Buffer.from("safe").toString("base64") } })).resolves.toMatchObject({ statusCode: 200 });
    const downloaded = await app.inject({ method: "GET", url: `${base}/verification-evidence/${evidenceId}/download` });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.headers["cache-control"]).toBe("private, no-store");
    const submission = { ...profile, representativeAuthorityBasis: "The director has authority under the company constitution.", beneficialOwners: [{ ownerType: "natural_person", legalName: "Amina Director", ownershipBps: 10000, isControlPerson: true, nationalityOrJurisdictionCode: "NG", identityLink: "self" }], evidenceDocumentIds: [evidenceId, invitationId, membershipId] };
    await expect(app.inject({ method: "POST", url: `${base}/verification-requests`, headers: { "x-command-id": "verification-1" }, payload: submission })).resolves.toMatchObject({ statusCode: 201 });
    expect(mocks.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({ organizationId, uploadedByIdentityId: "identity-1" }));
    expect(mocks.submitVerification).toHaveBeenCalledWith(expect.objectContaining({ commandKey: "verification-1", evidenceDocumentIds: submission.evidenceDocumentIds }));
  });

  it("gives only operators or administrators access to independent verification review", async () => {
    role = "investor";
    await expect(app.inject({ method: "GET", url: "/v1/control/organization-verifications" })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator";
    await expect(app.inject({ method: "GET", url: "/v1/control/organization-verifications?status=submitted" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: `/v1/control/organization-verifications/${verificationId}` })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: `/v1/control/organization-verifications/${verificationId}/evidence/${evidenceId}/download` })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/control/organization-verifications/${verificationId}/decision`, payload: { approve: true, reason: "Independent review confirms the complete verification evidence.", validityDays: 365 } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.decideVerification).toHaveBeenCalledWith(expect.objectContaining({ requestId: verificationId, decidedByIdentityId: "identity-1" }));
  });

  it("fails closed for unsupported roles, unavailable identities, scope failures, and authoritative conflicts", async () => {
    role = "investor";
    await expect(app.inject({ method: "POST", url: "/v1/governance/organizations", headers: { "x-command-id": "denied" }, payload: profile })).resolves.toMatchObject({ statusCode: 403 });
    role = "issuer";
    mocks.identity.mockRejectedValueOnce(new TestIdentityUnavailableError("migration pending"));
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 409 });
    mocks.organizationAccess.mockRejectedValueOnce(new TestTenantAccessError("not a member"));
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 403 });
    mocks.issueInvitation.mockRejectedValueOnce(new TestInvitationError("Invitation is already active"));
    await expect(app.inject({ method: "POST", url: `/v1/governance/organizations/${organizationId}/invitations`, headers: { "x-command-id": "invite-conflict" }, payload: { email: "member@example.test", role: "viewer", expiresAt: "2026-12-01T12:00:00.000Z" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.identity.mockRejectedValueOnce(new Error("identity database unavailable"));
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 500 });
    mocks.organizationAccess.mockRejectedValueOnce(new Error("membership database unavailable"));
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 500 });
    mocks.createOrganization.mockRejectedValueOnce(new TestIdempotencyError("Command already used"));
    await expect(app.inject({ method: "POST", url: "/v1/governance/organizations", headers: { "x-command-id": "idempotency-conflict" }, payload: profile })).resolves.toMatchObject({ statusCode: 409 });
    mocks.workspace.mockRejectedValueOnce(Object.assign(new Error("unique conflict"), { code: "23505" }));
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 409 });
    mocks.workspace.mockRejectedValueOnce(new Error("authority database unavailable"));
    await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/authority` })).resolves.toMatchObject({ statusCode: 500 });
  });
});
