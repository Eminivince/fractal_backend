import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ config: vi.fn(), offeringById: vi.fn(), offeringFind: vi.fn(), userFind: vi.fn(), profileFind: vi.fn(), transferCreate: vi.fn(), transferFind: vi.fn(), transferById: vi.fn(), transaction: vi.fn(), authorize: vi.fn(), scope: vi.fn(), serialize: vi.fn((value: unknown) => value), decimal: vi.fn(), event: vi.fn(), notify: vi.fn(), holding: vi.fn(), ledger: vi.fn(), onchain: vi.fn(), enqueue: vi.fn() }));
vi.mock("../../../../db/models.js", () => ({ InvestorProfileModel: { findOne: mocks.profileFind }, OfferingModel: { findById: mocks.offeringById, find: mocks.offeringFind }, PlatformConfigModel: { findById: mocks.config }, SecondaryTransferModel: { create: mocks.transferCreate, find: mocks.transferFind, findById: mocks.transferById }, UserModel: { findOne: mocks.userFind } }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/scope.js", () => ({ assertInvestorScope: mocks.scope }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.event }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notify }));
vi.mock("../../../../services/ledger.js", () => ({ getOwnershipHolding: mocks.holding, postLedger: mocks.ledger }));
vi.mock("../../../../services/onchain-autowire.js", () => ({ isOnchainEnabled: mocks.onchain }));
vi.mock("../../../../workers/blockchain.worker.js", () => ({ enqueueBlockchainOp: mocks.enqueue }));
import { secondaryTransferRoutes } from "../secondary-transfers.routes.js";

const offeringId = "offering-1"; const transferId = "transfer-1";
let role = "investor"; let userId = "seller-1"; let app: ReturnType<typeof Fastify>;
const offering = { _id: offeringId, status: "servicing", terms: { raiseAmount: 1000, lockupDays: 0 }, metrics: { maxSingleInvestorPct: 0 } };
function chain(value: unknown) { return { session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })), select: vi.fn(() => ({ session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })), lean: vi.fn().mockResolvedValue(value) }; }
function dual(value: unknown) { return { session: vi.fn().mockResolvedValue(value), then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(value).then(resolve, reject) }; }
function transfer(overrides: Record<string, unknown> = {}) { return { _id: transferId, offeringId, fromUserId: "seller-1", toUserId: "buyer-1", units: 10, status: "pending_approval", save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }), ...overrides } as any; }
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset(); role = "investor"; userId = "seller-1";
  mocks.transaction.mockImplementation(async (operation: (session: unknown) => Promise<unknown>) => operation({ id: "session-1" })); mocks.authorize.mockReturnValue(undefined); mocks.scope.mockReturnValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); mocks.decimal.mockImplementation((value: number) => `decimal:${value}`); mocks.event.mockResolvedValue(undefined); mocks.notify.mockResolvedValue(undefined); mocks.ledger.mockResolvedValue(undefined); mocks.onchain.mockReturnValue(false);
  mocks.config.mockReturnValue(chain({ featureFlags: { enableSecondaryTransfers: true }, complianceRules: { defaultLockupDays: 0 } })); mocks.offeringById.mockReturnValue(dual(offering)); mocks.offeringFind.mockReturnValue({ select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: offeringId }]) })) }); mocks.userFind.mockReturnValue(chain({ _id: "buyer-1" })); mocks.profileFind.mockReturnValue(chain({ kycStatus: "approved", amlStatus: "clear" })); mocks.holding.mockResolvedValue(100); mocks.transferCreate.mockResolvedValue([transfer()]); mocks.transferFind.mockReturnValue({ sort: vi.fn(() => ({ limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })) })) }); mocks.transferById.mockReturnValue(dual(transfer()));
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message })); app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId, role, businessId: "business-1" }; }); await app.register(secondaryTransferRoutes);
});
afterEach(async () => { await app.close(); });

describe("secondary transfer routes", () => {
  it("creates a seller-owned secondary transfer only when platform and holding conditions pass", async () => {
    const response = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/transfers`, payload: { toEmail: "buyer@example.test", units: 10, pricePerUnit: 125 } });
    expect(response.statusCode).toBe(200); expect(mocks.transferCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ fromUserId: "seller-1", toUserId: "buyer-1", units: "decimal:10" })]), expect.anything());
    mocks.config.mockReturnValueOnce(chain({ featureFlags: { enableSecondaryTransfers: false } }));
    await expect(app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/transfers`, payload: { toEmail: "buyer@example.test", units: 10 } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.userFind.mockReturnValueOnce(chain({ _id: "seller-1" }));
    await expect(app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/transfers`, payload: { toEmail: "seller@example.test", units: 10 } })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("lists transfers only inside the authenticated investor or issuer scope", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/transfers?status=pending_approval" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.transferFind).toHaveBeenCalledWith(expect.objectContaining({ status: "pending_approval", $or: [{ fromUserId: "seller-1" }, { toUserId: "seller-1" }] }));
    role = "issuer";
    await expect(app.inject({ method: "GET", url: "/v1/transfers?offeringId=ignored" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.transferFind).toHaveBeenLastCalledWith({ offeringId: { $in: [offeringId] } });
  });

  it("runs compliance, ownership entries, and audit notifications before executing an approved transfer", async () => {
    role = "admin";
    const current = transfer(); mocks.transferById.mockReturnValueOnce(dual(current));
    const response = await app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` });
    expect(response.statusCode).toBe(200); expect(current.status).toBe("executed"); expect(mocks.ledger).toHaveBeenCalledTimes(2); expect(mocks.notify).toHaveBeenCalledOnce();
    mocks.transferById.mockReturnValueOnce(dual(transfer({ status: "executed" })));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 422 });
    mocks.transferById.mockReturnValueOnce(dual(transfer())); mocks.profileFind.mockReturnValueOnce(chain({ kycStatus: "pending" }));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("rejects or cancels only pending transfers under the required authority", async () => {
    role = "admin"; const rejected = transfer(); mocks.transferById.mockReturnValueOnce(dual(rejected));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/reject`, payload: { reason: "Compliance evidence is incomplete." } })).resolves.toMatchObject({ statusCode: 200 }); expect(rejected.status).toBe("rejected");
    role = "investor"; const cancelled = transfer(); mocks.transferById.mockReturnValueOnce(dual(cancelled));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/cancel` })).resolves.toMatchObject({ statusCode: 200 }); expect(cancelled.status).toBe("cancelled"); expect(mocks.scope).toHaveBeenCalled();
    mocks.transferById.mockReturnValueOnce(dual(null));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/cancel` })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("enforces servicing, holding, AML, lockup, concentration, and on-chain transfer controls", async () => {
    mocks.offeringById.mockReturnValueOnce(dual({ ...offering, status: "funding" }));
    await expect(app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/transfers`, payload: { toEmail: "buyer@example.test", units: 10 } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.holding.mockResolvedValueOnce(5);
    await expect(app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/transfers`, payload: { toEmail: "buyer@example.test", units: 10 } })).resolves.toMatchObject({ statusCode: 422 });
    role = "admin";
    mocks.transferById.mockReturnValueOnce(dual(transfer({ units: { toString: () => "10" } })));
    mocks.profileFind.mockReturnValueOnce(chain({ kycStatus: "approved", amlStatus: "blocked" }));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 422 });
    mocks.transferById.mockReturnValueOnce(dual(transfer())); mocks.offeringById.mockReturnValueOnce(dual({ ...offering, terms: {}, closesAt: new Date().toISOString() })); mocks.config.mockReturnValueOnce(chain({ complianceRules: { defaultLockupDays: 30 } }));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 422 });
    mocks.transferById.mockReturnValueOnce(dual(transfer())); mocks.offeringById.mockReturnValueOnce(dual({ ...offering, metrics: { maxSingleInvestorPct: 1 }, terms: { raiseAmount: 100 } })); mocks.holding.mockResolvedValueOnce(100).mockResolvedValueOnce(10);
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 422 });
    const onchainOffering = { ...offering, tokenDeployment: { contractAddress: "0x123", status: "deployed" } }; const onchainTransfer = transfer();
    mocks.transferById.mockReturnValueOnce(dual(onchainTransfer)); mocks.offeringById.mockReturnValueOnce(dual(onchainOffering)); mocks.holding.mockResolvedValueOnce(100); mocks.onchain.mockReturnValue(true);
    mocks.profileFind.mockReturnValueOnce(chain({ kycStatus: "approved", amlStatus: "clear" })).mockReturnValueOnce(chain({ walletAddress: "0xseller" })).mockReturnValueOnce(chain({ walletAddress: "0xbuyer" }));
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.enqueue).toHaveBeenCalledWith(expect.objectContaining({ opType: "forced_transfer", payload: expect.objectContaining({ from: "0xseller", to: "0xbuyer" }) }));
    expect(onchainTransfer.onchainEnqueued).toBe(true);
    mocks.transferById.mockReturnValueOnce(dual(transfer())); mocks.offeringById.mockReturnValueOnce(dual({ ...offering, terms: {} })); mocks.config.mockReturnValueOnce(chain(null)); mocks.profileFind.mockReturnValueOnce(chain({ kycStatus: "approved" })); mocks.holding.mockResolvedValueOnce(100); mocks.onchain.mockReturnValue(false);
    await expect(app.inject({ method: "POST", url: `/v1/transfers/${transferId}/approve` })).resolves.toMatchObject({ statusCode: 200 });
  });
});
