import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ deletionFindOne: vi.fn(), deletionCreate: vi.fn(), deletionFindById: vi.fn(), eventFind: vi.fn(), profileFindOne: vi.fn(), profileUpdateOne: vi.fn(), profileLinkWallet: vi.fn(), subscriptionFind: vi.fn(), assessmentFind: vi.fn(), userFindById: vi.fn(), userUpdateOne: vi.fn(), appendEvent: vi.fn(), serialize: vi.fn((value: unknown) => value), transaction: vi.fn(), verifyPrivy: vi.fn() }));
vi.mock("../../../../db/models.js", () => ({ DeletionRequestModel: { findOne: mocks.deletionFindOne, create: mocks.deletionCreate, findById: mocks.deletionFindById }, EventLogModel: { find: mocks.eventFind }, InvestorProfileModel: { findOne: mocks.profileFindOne, updateOne: mocks.profileUpdateOne, findOneAndUpdate: mocks.profileLinkWallet }, SubscriptionModel: { find: mocks.subscriptionFind }, SuitabilityAssessmentModel: { find: mocks.assessmentFind }, UserModel: { findById: mocks.userFindById, updateOne: mocks.userUpdateOne } }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../services/privy.service.js", () => ({ verifyPrivyToken: mocks.verifyPrivy }));
import { dataPrivacyRoutes } from "../data-privacy.routes.js";

let app: ReturnType<typeof Fastify>; let role = "investor";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const selected = (value: unknown) => ({ select: vi.fn(() => lean(value)) });
const sessioned = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
const saved = (value: Record<string, unknown>): any => ({ ...value, save: vi.fn().mockResolvedValue(undefined) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.appendEvent.mockResolvedValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); mocks.transaction.mockImplementation(async (callback: (session: string) => unknown) => callback("session-1")); role = "investor";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "investor-1", role }; }); await app.register(dataPrivacyRoutes);
});
afterEach(async () => { await app.close(); });

describe("investor data privacy routes", () => {
  it("exports only the authenticated investor's privacy data", async () => {
    mocks.userFindById.mockReturnValueOnce(selected({ _id: "investor-1", email: "person@example.com" })); mocks.profileFindOne.mockReturnValueOnce(lean({ userId: "investor-1" })); mocks.subscriptionFind.mockReturnValueOnce(lean([{ _id: "subscription-1" }])); mocks.assessmentFind.mockReturnValueOnce(lean([{ _id: "assessment-1" }])); mocks.eventFind.mockReturnValueOnce({ sort: vi.fn(() => ({ limit: vi.fn(() => lean([{ _id: "event-1" }])) })) });
    const response = await app.inject({ method: "GET", url: "/v1/investor/data-export" });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ user: { email: "person@example.com" }, subscriptions: [{ _id: "subscription-1" }] }); expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DataExportRequested" }));
    role = "issuer"; await expect(app.inject({ method: "GET", url: "/v1/investor/data-export" })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("grants a new consent and does not duplicate an active consent", async () => {
    const user = saved({ _id: "investor-1", consents: [] }); mocks.userFindById.mockResolvedValueOnce(user);
    const granted = await app.inject({ method: "POST", url: "/v1/user/consent", payload: { type: "marketing" } });
    expect(granted.statusCode).toBe(200); expect(user.consents).toEqual([expect.objectContaining({ type: "marketing", grantedAt: expect.any(Date) })]); expect(user.save).toHaveBeenCalledOnce();
    const existing = { type: "marketing", grantedAt: new Date() }; mocks.userFindById.mockResolvedValueOnce(saved({ _id: "investor-1", consents: [existing] }));
    expect((await app.inject({ method: "POST", url: "/v1/user/consent", payload: { type: "marketing" } })).json()).toMatchObject({ message: "Consent already granted", consent: { type: "marketing" } });
  });

  it("revokes active consent and reports missing users or consent records", async () => {
    const user = saved({ _id: "investor-1", consents: [{ type: "marketing" }] }); mocks.userFindById.mockResolvedValueOnce(user);
    const revoked = await app.inject({ method: "DELETE", url: "/v1/user/consent/marketing" });
    expect(revoked.statusCode).toBe(200); expect(user.consents[0]).toMatchObject({ revokedAt: expect.any(Date) });
    mocks.userFindById.mockResolvedValueOnce(null); await expect(app.inject({ method: "DELETE", url: "/v1/user/consent/marketing" })).resolves.toMatchObject({ statusCode: 404 });
    mocks.userFindById.mockResolvedValueOnce(saved({ _id: "investor-1", consents: [] })); await expect(app.inject({ method: "DELETE", url: "/v1/user/consent/marketing" })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("creates one deletion request per investor while one remains pending", async () => {
    mocks.deletionFindOne.mockResolvedValueOnce(null); mocks.deletionCreate.mockResolvedValueOnce({ _id: "request-1", userId: "investor-1" });
    const created = await app.inject({ method: "POST", url: "/v1/investor/deletion-request", payload: { reason: "I no longer use this service." } });
    expect(created.statusCode).toBe(200); expect(mocks.deletionCreate).toHaveBeenCalledWith({ userId: "investor-1", reason: "I no longer use this service." });
    mocks.deletionFindOne.mockResolvedValueOnce({ _id: "request-1" }); expect((await app.inject({ method: "POST", url: "/v1/investor/deletion-request", payload: {} })).json()).toMatchObject({ message: "A deletion request is already pending" });
    role = "operator"; await expect(app.inject({ method: "POST", url: "/v1/investor/deletion-request", payload: {} })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("anonymizes requested user data and preserves the financial record shell", async () => {
    role = "admin"; const request = saved({ _id: "request-1", userId: "investor-1", status: "pending" }); mocks.deletionFindById.mockReturnValueOnce(sessioned(request)); mocks.userUpdateOne.mockReturnValueOnce(sessioned(undefined)); mocks.profileUpdateOne.mockReturnValueOnce(sessioned(undefined));
    const response = await app.inject({ method: "POST", url: "/v1/admin/deletion-requests/request-1/fulfill" });
    expect(response.statusCode).toBe(200); expect(request).toMatchObject({ status: "completed", reviewedBy: "investor-1", completedAt: expect.any(Date) }); expect(request.save).toHaveBeenCalledWith({ session: "session-1" }); expect(mocks.userUpdateOne).toHaveBeenCalledWith({ _id: "investor-1" }, expect.objectContaining({ $set: expect.objectContaining({ status: "disabled" }), $unset: expect.objectContaining({ phone: "" }) }));
    mocks.deletionFindById.mockReturnValueOnce(sessioned(saved({ _id: "request-1", userId: "investor-1", status: "completed" }))); expect((await app.inject({ method: "POST", url: "/v1/admin/deletion-requests/request-1/fulfill" })).json()).toMatchObject({ message: "Already fulfilled" });
  });

  it("blocks invalid deletion fulfillment requests", async () => {
    role = "investor"; await expect(app.inject({ method: "POST", url: "/v1/admin/deletion-requests/request-1/fulfill" })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator"; mocks.deletionFindById.mockReturnValueOnce(sessioned(null)); await expect(app.inject({ method: "POST", url: "/v1/admin/deletion-requests/missing/fulfill" })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("links a verified Privy wallet and lists consents", async () => {
    mocks.verifyPrivy.mockResolvedValueOnce({ userId: "privy-1", walletAddress: "0x123" }); mocks.profileLinkWallet.mockReturnValueOnce(lean({ _id: "profile-1" }));
    const linked = await app.inject({ method: "POST", url: "/v1/investor/link-wallet", payload: { privyToken: "token-12345" } });
    expect(linked.statusCode).toBe(200); expect(mocks.profileLinkWallet).toHaveBeenCalledWith({ userId: "investor-1" }, { $set: { privyUserId: "privy-1", walletAddress: "0x123" } }, { new: true });
    mocks.userFindById.mockReturnValueOnce(selected({ consents: [{ type: "marketing" }] })); expect((await app.inject({ method: "GET", url: "/v1/user/consents" })).json()).toEqual({ consents: [{ type: "marketing" }] });
  });

  it("blocks wallet requests without a wallet or profile", async () => {
    mocks.verifyPrivy.mockResolvedValueOnce({ userId: "privy-1" }); await expect(app.inject({ method: "POST", url: "/v1/investor/link-wallet", payload: { privyToken: "token-12345" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.verifyPrivy.mockResolvedValueOnce({ userId: "privy-1", walletAddress: "0x123" }); mocks.profileLinkWallet.mockReturnValueOnce(lean(null)); await expect(app.inject({ method: "POST", url: "/v1/investor/link-wallet", payload: { privyToken: "token-12345" } })).resolves.toMatchObject({ statusCode: 404 });
    role = "admin"; await expect(app.inject({ method: "POST", url: "/v1/investor/link-wallet", payload: { privyToken: "token-12345" } })).resolves.toMatchObject({ statusCode: 403 });
  });
});
