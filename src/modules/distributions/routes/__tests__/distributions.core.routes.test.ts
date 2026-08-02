import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ businessFind: vi.fn(), distributionFind: vi.fn(), distributionCreate: vi.fn(), distributionFindById: vi.fn(), distributionFindOneAndUpdate: vi.fn(), lineFind: vi.fn(), lineFindById: vi.fn(), lineFindOneAndUpdate: vi.fn(), offeringFind: vi.fn(), offeringFindById: vi.fn(), profileFind: vi.fn(), subscriptionFind: vi.fn(), subscriptionExists: vi.fn(), userFind: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), notifications: vi.fn(), decimal: vi.fn(), escrowBalance: vi.fn(), postLedger: vi.fn(), exceedsEscrow: vi.fn(), transition: vi.fn(), scope: vi.fn(), transaction: vi.fn(), serialize: vi.fn((value: unknown) => value), anchor: vi.fn(), idempotent: vi.fn(), readCommandId: vi.fn() }));
vi.mock("../../../../db/models.js", () => ({ BusinessModel: { find: mocks.businessFind }, DistributionLineModel: { find: mocks.lineFind, findById: mocks.lineFindById, findOneAndUpdate: mocks.lineFindOneAndUpdate }, DistributionModel: { find: mocks.distributionFind, create: mocks.distributionCreate, findById: mocks.distributionFindById, findOneAndUpdate: mocks.distributionFindOneAndUpdate }, InvestorProfileModel: { find: mocks.profileFind }, LedgerEntryModel: {}, OfferingModel: { find: mocks.offeringFind, findById: mocks.offeringFindById }, OutboundTransferModel: {}, SubscriptionModel: { find: mocks.subscriptionFind, exists: mocks.subscriptionExists }, UserModel: { find: mocks.userFind } }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notifications }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../services/ledger.js", () => ({ escrowAccountRef: vi.fn(), getEscrowBalance: mocks.escrowBalance, postLedger: mocks.postLedger, exceedsAvailableEscrow: mocks.exceedsEscrow }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/state-machine.js", () => ({ assertTransition: mocks.transition }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.scope }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/anchor.js", () => ({ createAnchorRecord: mocks.anchor }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.readCommandId, runIdempotentCommand: mocks.idempotent }));
vi.mock("../../../../config/env.js", () => ({ env: { PAYSTACK_ENABLED: false, PAYSTACK_BALANCE_CHECK_ENABLED: false } }));
vi.mock("../../../../services/paystack.js", () => ({ getAvailableBalanceKobo: vi.fn(), initiatePaystackTransfer: vi.fn(), nairaToKobo: vi.fn() }));
import { distributionRoutes } from "../distributions.routes.js";

let app: ReturnType<typeof Fastify>; let role = "issuer"; let businessId = "business-1";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const sessioned = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
const sessionLean = (value: unknown) => ({ session: vi.fn(() => lean(value)) });
const saved = (value: Record<string, unknown>): any => ({ ...value, toObject: () => value, save: vi.fn().mockResolvedValue(undefined) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined); mocks.appendEvent.mockResolvedValue(undefined); mocks.notifications.mockResolvedValue(undefined); mocks.decimal.mockImplementation((value: unknown) => value); mocks.escrowBalance.mockResolvedValue({ balance: 1_000 }); mocks.exceedsEscrow.mockReturnValue(false); mocks.transition.mockReturnValue(undefined); mocks.scope.mockReturnValue(undefined); mocks.transaction.mockImplementation(async (callback: (session: string) => unknown) => callback("session-1")); mocks.serialize.mockImplementation((value: unknown) => value); mocks.anchor.mockResolvedValue({ id: "anchor-1" }); mocks.idempotent.mockImplementation(async ({ execute }: { execute: () => unknown }) => execute()); role = "issuer"; businessId = "business-1";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role, businessId }; }); await app.register(distributionRoutes);
});
afterEach(async () => { await app.close(); });

describe("core distribution routes", () => {
  it("creates a draft distribution within the available escrow balance", async () => {
    mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", businessId: "business-1", templateCode: "A" })); mocks.distributionFind.mockReturnValueOnce(sessionLean([])); mocks.distributionCreate.mockResolvedValueOnce([saved({ _id: "distribution-1", period: "2026-07" })]);
    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/distributions", payload: { period: "2026-07", amount: 400, whtPct: 5 } });
    expect(response.statusCode).toBe(200); expect(mocks.distributionCreate).toHaveBeenCalledWith([expect.objectContaining({ offeringId: "offering-1", status: "draft", amount: 400, whtAmount: 20, netAmount: 380 })], { session: "session-1" }); expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DistributionDraftCreated" }), "session-1");
  });

  it("blocks distribution drafts for other roles, templates, and insufficient escrow", async () => {
    role = "investor"; await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/distributions", payload: { period: "2026-07", amount: 400 } })).resolves.toMatchObject({ statusCode: 403 });
    role = "issuer"; mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", businessId: "business-1", templateCode: "B" })); await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/distributions", payload: { period: "2026-07", amount: 400 } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", businessId: "business-1", templateCode: "A" })); mocks.distributionFind.mockReturnValueOnce(sessionLean([])); mocks.exceedsEscrow.mockReturnValueOnce(true); await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/distributions", payload: { period: "2026-07", amount: 400 } })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("submits a draft distribution for independent approval", async () => {
    const distribution = saved({ _id: "distribution-1", offeringId: "offering-1", status: "draft" }); mocks.distributionFindById.mockResolvedValueOnce(distribution); mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" }));
    const response = await app.inject({ method: "POST", url: "/v1/distributions/distribution-1/submit" });
    expect(response.statusCode).toBe(200); expect(distribution).toMatchObject({ status: "pending_approval" }); expect(distribution.save).toHaveBeenCalledOnce(); expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DistributionSubmitted" }));
  });

  it("allows operators to approve and schedule a distribution", async () => {
    role = "operator"; const approved = saved({ _id: "distribution-1", offeringId: "offering-1", period: "2026-07", amount: { toString: () => "400" }, status: "pending_approval" }); mocks.distributionFindById.mockReturnValueOnce(sessioned(approved));
    const approval = await app.inject({ method: "POST", url: "/v1/distributions/distribution-1/approve" });
    expect(approval.statusCode).toBe(200); expect(approved).toMatchObject({ status: "approved", approvedBy: "issuer-1", approvedAt: expect.any(Date) }); expect(mocks.anchor).toHaveBeenCalledWith(expect.objectContaining({ eventType: "DistributionDeclared" }), "session-1"); expect(mocks.notifications).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DistributionApproved" }), "session-1");
    const scheduled = saved({ _id: "distribution-1", status: "approved" }); mocks.distributionFindById.mockReturnValueOnce(sessioned(scheduled)); const schedule = await app.inject({ method: "POST", url: "/v1/distributions/distribution-1/schedule" });
    expect(schedule.statusCode).toBe(200); expect(scheduled).toMatchObject({ status: "scheduled", scheduledAt: expect.any(Date) });
  });

  it("blocks issuer approval and scheduling actions", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/distributions/distribution-1/approve" })).resolves.toMatchObject({ statusCode: 403 }); await expect(app.inject({ method: "POST", url: "/v1/distributions/distribution-1/schedule" })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("records failed and reversed distributions as operator actions", async () => {
    role = "operator"; const failed = saved({ _id: "distribution-1", status: "scheduled" }); mocks.distributionFindById.mockReturnValueOnce(sessioned(failed)); const failure = await app.inject({ method: "POST", url: "/v1/distributions/distribution-1/mark-failed", payload: { reason: "Bank details are invalid." } });
    expect(failure.statusCode).toBe(200); expect(failed).toMatchObject({ status: "failed" });
    const reversed = saved({ _id: "distribution-1", offeringId: "offering-1", amount: 400, status: "paid" }); mocks.distributionFindById.mockReturnValueOnce(sessioned(reversed)); const reversal = await app.inject({ method: "POST", url: "/v1/distributions/distribution-1/reverse", payload: { reason: "Trustee requested reversal.", trusteeTicket: "TRUST-100", confirm: "REVERSE" } });
    expect(reversal.statusCode).toBe(200); expect(reversed).toMatchObject({ status: "reversed", reversalReason: "Trustee requested reversal.", reversedAt: expect.any(Date) }); expect(mocks.postLedger).toHaveBeenCalledWith(expect.objectContaining({ direction: "credit", entityType: "distribution" }), "session-1");
  });

  it("settles a scheduled distribution once and treats a retry as idempotent", async () => {
    role = "operator"; const paying = saved({ _id: "distribution-1", offeringId: "offering-1", period: "2026-07", amount: { toString: () => "400" }, status: "paying" }); mocks.distributionFindOneAndUpdate.mockResolvedValueOnce(paying); mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", name: "Warehouse Income Note", feeSnapshot: { servicingFeePct: { toString: () => "0" } } })); mocks.subscriptionFind.mockReturnValueOnce(sessionLean([]));
    const settled = await app.inject({ method: "POST", url: "/v1/distributions/distribution-1/mark-paid", payload: { payoutReceiptRefs: ["receipt-1"] } });
    expect(settled.statusCode).toBe(200); expect(paying).toMatchObject({ status: "paid", paidAt: expect.any(Date) }); expect(paying.save).toHaveBeenCalledWith({ session: "session-1" }); expect(mocks.postLedger).toHaveBeenCalledWith(expect.objectContaining({ direction: "debit", amount: 400 }), "session-1");
    const alreadyPaid = saved({ _id: "distribution-1", status: "paid" }); mocks.distributionFindOneAndUpdate.mockResolvedValueOnce(null); mocks.distributionFindById.mockReturnValueOnce(sessioned(alreadyPaid)); await expect(app.inject({ method: "POST", url: "/v1/distributions/distribution-1/mark-paid", payload: { payoutReceiptRefs: ["receipt-1"] } })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("retries a failed distribution line once and marks a manual payout resolved", async () => {
    role = "operator"; const line = saved({ _id: "line-1", distributionId: "distribution-1", investorUserId: "investor-1", netAmount: { toString: () => "360" }, retryCount: 1, status: "processing" }); mocks.lineFindOneAndUpdate.mockResolvedValueOnce(line); mocks.distributionFindById.mockReturnValueOnce(sessioned({ _id: "distribution-1", offeringId: "offering-1", period: "2026-07" })); mocks.offeringFindById.mockReturnValueOnce(sessioned({ _id: "offering-1", name: "Warehouse Income Note" }));
    const response = await app.inject({ method: "POST", url: "/v1/distribution-lines/line-1/retry" });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ lineId: "line-1", status: "paid", manual: true }); expect(line).toMatchObject({ status: "paid", paymentRef: expect.stringContaining("manual:retry:dist:distribution-1"), paidAt: expect.any(Date) }); expect(line.save).toHaveBeenCalledWith({ session: "session-1" });
  });

  it("limits investor distribution data and provides a controlled statement", async () => {
    role = "investor"; mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" })); mocks.subscriptionExists.mockResolvedValueOnce(false); await expect(app.inject({ method: "GET", url: "/v1/offerings/offering-1/distributions" })).resolves.toMatchObject({ statusCode: 403 });
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" })); mocks.subscriptionExists.mockResolvedValueOnce(true); mocks.distributionFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "distribution-1" }])) }); expect((await app.inject({ method: "GET", url: "/v1/offerings/offering-1/distributions" })).json()).toEqual([{ _id: "distribution-1" }]);
    mocks.distributionFindById.mockReturnValueOnce(lean({ _id: "distribution-1", offeringId: "offering-1", period: "2026-07", amount: { toString: () => "400" }, status: "paid", createdAt: "2026-07-01T00:00:00.000Z" })); mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", name: "Warehouse, Income" })); mocks.subscriptionExists.mockResolvedValueOnce(true); const statement = await app.inject({ method: "GET", url: "/v1/distributions/distribution-1/statement" });
    expect(statement.statusCode).toBe(200); expect(statement.headers["content-type"]).toContain("text/csv"); expect(statement.body).toContain('"Warehouse, Income"');
  });

  it("shows investors only their own distribution lines", async () => {
    role = "investor"; mocks.distributionFindById.mockReturnValueOnce(lean({ _id: "distribution-1", offeringId: "offering-1" })); mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" })); mocks.subscriptionExists.mockResolvedValueOnce(true); mocks.lineFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "line-1", investorUserId: "issuer-1" }])) });
    const response = await app.inject({ method: "GET", url: "/v1/distributions/distribution-1/lines" });
    expect(response.statusCode).toBe(200); expect(mocks.lineFind).toHaveBeenCalledWith({ distributionId: "distribution-1", investorUserId: "issuer-1" });
  });

  it("creates controlled issuer and operator reports", async () => {
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", name: "Warehouse Income", status: "servicing", metrics: { raiseAmount: { toString: () => "1000" }, subscribedAmount: { toString: () => "800" }, investorCount: 1 } })); mocks.distributionFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: "distribution-1", period: "2026-07", amount: { toString: () => "100" }, status: "paid" }])) }); mocks.subscriptionFind.mockReturnValueOnce(lean([{ amount: { toString: () => "800" } }]));
    const report = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/report" }); expect(report.statusCode).toBe(200); expect(report.body).toContain("totalDistributed"); expect(report.body).toContain("100");
    role = "operator"; mocks.offeringFind.mockReturnValueOnce(lean([{ _id: "offering-1", name: "Warehouse Income", status: "closed", metrics: { raiseAmount: { toString: () => "1000" }, subscribedAmount: { toString: () => "800" }, investorCount: 1 } }])); mocks.distributionFind.mockReturnValueOnce(lean([{ amount: { toString: () => "100" }, status: "paid" }])); const aum = await app.inject({ method: "GET", url: "/v1/operator/reports/aum" }); expect(aum.statusCode).toBe(200); expect(aum.body).toContain("TOTAL AUM");
    mocks.profileFind.mockReturnValueOnce(lean([{ kycStatus: "approved" }])); mocks.businessFind.mockReturnValueOnce(lean([{ kybStatus: "approved" }])); mocks.offeringFind.mockReturnValueOnce(lean([{ status: "closed" }])); mocks.distributionFind.mockReturnValueOnce(lean([{ status: "paid" }])); const compliance = await app.inject({ method: "GET", url: "/v1/operator/reports/compliance" }); expect(compliance.statusCode).toBe(200); expect(compliance.body).toContain("KYC,approved,1");
    role = "issuer"; mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1", feeSnapshot: { servicingFeePct: { toString: () => "5" } } })); mocks.distributionFind.mockReturnValueOnce(lean([{ period: "2026-07", amount: { toString: () => "100" }, status: "paid" }])); mocks.subscriptionFind.mockReturnValueOnce(lean([{ investorUserId: "investor-1", amount: { toString: () => "800" } }])); mocks.userFind.mockReturnValueOnce({ select: vi.fn(() => lean([{ _id: "investor-1", name: "Investor One", email: "investor@example.com" }])) }); const investorReport = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/investor-distributions" }); expect(investorReport.statusCode).toBe(200); expect(investorReport.body).toContain("investor@example.com");
  });
});
