import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ identity: vi.fn(), policy: vi.fn(), listRequests: vi.fn(), submit: vi.fn(), getRequest: vi.fn(), decide: vi.fn(), listInvestor: vi.fn(), markRead: vi.fn(), acknowledge: vi.fn(), access: vi.fn(), stepUp: vi.fn(), commandId: vi.fn(), authorize: vi.fn() }));
const categories = vi.hoisted(() => ["material_update", "payment_update", "governance", "risk_disclosure", "general"] as const);
vi.mock("../../../../platform/postgres-identities.js", () => ({ requirePostgresIdentityForSubject: mocks.identity, PostgresIdentityUnavailableError: class PostgresIdentityUnavailableError extends Error {} }));
vi.mock("../../../../platform/postgres-offering-notices.js", () => ({ getOfferingNoticePolicyOptions: mocks.policy, listOfferingNoticeRequests: mocks.listRequests, submitOfferingNotice: mocks.submit, getOfferingNoticeRequest: mocks.getRequest, decideOfferingNotice: mocks.decide, listInvestorOfferingNotices: mocks.listInvestor, markInvestorOfferingNoticeRead: mocks.markRead, acknowledgeInvestorOfferingNotice: mocks.acknowledge, offeringNoticeCategories: categories, OfferingNoticeError: class OfferingNoticeError extends Error {} }));
vi.mock("../../../../platform/tenant-access.js", () => ({ requireOrganizationAccess: mocks.access, TenantAccessError: class TenantAccessError extends Error {} }));
vi.mock("../../../../platform/auth-step-up.js", () => ({ requireFreshTotpStepUp: mocks.stepUp, StepUpRequiredError: class StepUpRequiredError extends Error {} }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.commandId }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
import { postgresOfferingNoticeRoutes } from "../postgres-offering-notice.routes.js";

const organizationId = "11111111-1111-4111-8111-111111111111"; const requestId = "22222222-2222-4222-8222-222222222222"; const noticeId = "33333333-3333-4333-8333-333333333333"; const identityId = "44444444-4444-4444-8444-444444444444";
let app: ReturnType<typeof Fastify>; let role = "issuer";
const date = "2026-07-29T00:00:00.000Z";
const policyOptions = { policy: { versionId: identityId, versionNumber: 1, reference: "NOTICE-1", name: "Offering notice policy", schemaVersion: "offering-notice-policy-v1", jurisdictionCode: "NG", legalBasisReference: "SEC" }, rules: categories.map((category) => ({ category, retentionDays: 365, acknowledgmentRequired: false, acknowledgmentWindowDays: null })) };
const notice = { id: noticeId, organizationName: "Fractal Issuer", publicReference: "OFF-1", offeringName: "Warehouse Note", category: "general", subject: "Offering update", body: "This controlled notice explains the current offering status in full.", policyReference: "NOTICE-1", legalBasisReference: "SEC", retainUntil: date, acknowledgmentRequired: false, acknowledgmentDueAt: null, publishedAt: date, firstReadAt: null, acknowledgedAt: null };
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.identity.mockResolvedValue(identityId); mocks.access.mockResolvedValue(undefined); mocks.stepUp.mockResolvedValue(undefined); mocks.commandId.mockReturnValue("command-1"); mocks.authorize.mockReturnValue(undefined); role = "issuer";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role, sessionId: "session-1" }; }); await app.register(postgresOfferingNoticeRoutes);
});
afterEach(async () => { await app.close(); });

describe("governed offering notice routes", () => {
  it("lets authorized issuers read policy and submit a governed notice", async () => {
    mocks.policy.mockResolvedValueOnce(policyOptions); const policy = await app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/offering-notice-policy` }); expect(policy.statusCode).toBe(200); expect(policy.json()).toEqual(policyOptions); expect(mocks.access).toHaveBeenCalledWith(expect.objectContaining({ identityId, organizationId }),);
    mocks.submit.mockResolvedValueOnce({ requestId, replayed: false }); const response = await app.inject({ method: "POST", url: `/v1/governance/organizations/${organizationId}/offering-notice-requests`, headers: { "x-command-id": "command-1" }, payload: { offeringId: requestId, category: "general", subject: "Important offering update", body: "This controlled notice supplies all required information for investors." } });
    expect(response.statusCode).toBe(200); expect(mocks.submit).toHaveBeenCalledWith(expect.objectContaining({ organizationId, actorIdentityId: identityId, commandKey: "command-1" }));
  });

  it("rejects issuer notice commands without a command identifier or issuer role", async () => {
    await expect(app.inject({ method: "POST", url: `/v1/governance/organizations/${organizationId}/offering-notice-requests`, payload: { offeringId: requestId, category: "general", subject: "Important offering update", body: "This controlled notice supplies all required information for investors." } })).resolves.toMatchObject({ statusCode: 400 });
    role = "investor"; await expect(app.inject({ method: "GET", url: `/v1/governance/organizations/${organizationId}/offering-notice-policy` })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("requires a scoped, stepped-up issuer decision", async () => {
    mocks.getRequest.mockResolvedValueOnce({ organizationId }); mocks.decide.mockResolvedValueOnce({ requestId, status: "approved", publishedNoticeId: noticeId, replayed: false });
    const response = await app.inject({ method: "POST", url: `/v1/governance/offering-notice-requests/${requestId}/decision`, payload: { decision: "approve", decisionReason: "The notice is accurate, complete, and ready for publication." } });
    expect(response.statusCode).toBe(200); expect(mocks.stepUp).toHaveBeenCalledWith({ sessionId: "session-1", identityId }); expect(mocks.decide).toHaveBeenCalledWith(expect.objectContaining({ requestId, actorIdentityId: identityId, decision: "approve" }));
    mocks.getRequest.mockResolvedValueOnce(null); await expect(app.inject({ method: "POST", url: `/v1/governance/offering-notice-requests/${requestId}/decision`, payload: { decision: "reject", decisionReason: "The notice needs more complete supporting evidence before publication." } })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("lets investors list, read, and acknowledge their own notices", async () => {
    role = "investor"; mocks.listInvestor.mockResolvedValueOnce([notice]); expect((await app.inject({ method: "GET", url: "/v1/investor/notices" })).json()).toEqual({ notices: [notice] }); mocks.markRead.mockResolvedValueOnce({ noticeId, replayed: false, occurredAt: date }); expect((await app.inject({ method: "POST", url: `/v1/investor/notices/${noticeId}/read` })).json()).toMatchObject({ noticeId, replayed: false }); mocks.acknowledge.mockResolvedValueOnce({ noticeId, replayed: false, occurredAt: date }); await expect(app.inject({ method: "POST", url: `/v1/investor/notices/${noticeId}/acknowledge` })).resolves.toMatchObject({ statusCode: 200 });
  });
});
