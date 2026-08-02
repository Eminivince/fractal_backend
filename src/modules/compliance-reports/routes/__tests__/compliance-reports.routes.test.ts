import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ businessAggregate: vi.fn(), investorAggregate: vi.fn(), investorFind: vi.fn(), subscriptionAggregate: vi.fn(), ledgerAggregate: vi.fn(), eventsFind: vi.fn(), authorize: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ BusinessModel: { aggregate: mocks.businessAggregate }, InvestorProfileModel: { aggregate: mocks.investorAggregate, find: mocks.investorFind }, SubscriptionModel: { aggregate: mocks.subscriptionAggregate }, LedgerEntryModel: { aggregate: mocks.ledgerAggregate }, EventLogModel: { find: mocks.eventsFind } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));

import { complianceReportRoutes } from "../compliance-reports.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "admin";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockImplementation((_user, _action, subject) => { if (role === "investor" && subject === "compliance_report") throw new HttpError(403, "forbidden"); }); mocks.serialize.mockImplementation((value: unknown) => value); role = "admin";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "admin-1", role }; }); await app.register(complianceReportRoutes);
});
afterEach(async () => { await app.close(); });

describe("compliance report routes", () => {
  it("returns KYB, AML, and investor summary reports to authorized users", async () => {
    mocks.businessAggregate.mockResolvedValue([{ _id: "approved", count: 2 }]);
    await expect(app.inject({ method: "GET", url: "/v1/admin/reports/kyb-status" })).resolves.toMatchObject({ statusCode: 200, json: expect.any(Function) });
    mocks.investorFind.mockReturnValue({ select: vi.fn(() => ({ populate: vi.fn(() => lean([{ amlStatus: "flagged" }])) })) });
    expect((await app.inject({ method: "GET", url: "/v1/admin/reports/aml-flags" })).json()).toMatchObject({ report: "aml-flags", total: 1 });
    mocks.investorAggregate.mockResolvedValueOnce([{ _id: "retail", count: 1 }]).mockResolvedValueOnce([{ _id: "NG", count: 1 }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect((await app.inject({ method: "GET", url: "/v1/admin/reports/investor-summary" })).json()).toMatchObject({ report: "investor-summary", data: { byEligibility: [{ _id: "retail", count: 1 }] } });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "compliance_report");
  });

  it("uses a supplied date range for transaction volume", async () => {
    mocks.subscriptionAggregate.mockResolvedValue([{ _id: "2026-07", count: 1, totalAmount: 100 }]); mocks.ledgerAggregate.mockResolvedValue([{ _id: { direction: "credit" }, totalAmount: 100 }]);
    const response = await app.inject({ method: "GET", url: "/v1/admin/reports/transaction-volume?from=2026-07-01T00:00:00.000Z&to=2026-07-31T23:59:59.000Z" });
    expect(response.statusCode).toBe(200); expect(response.json()).toMatchObject({ report: "transaction-volume", data: { subscriptionVolume: [{ _id: "2026-07", count: 1, totalAmount: 100 }] } });
    expect(mocks.subscriptionAggregate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ $match: expect.objectContaining({ createdAt: expect.objectContaining({ $gte: new Date("2026-07-01T00:00:00.000Z") }) }) })]));
  });

  it("exports bounded compliance events as CSV and rejects invalid input", async () => {
    mocks.eventsFind.mockReturnValue({ sort: vi.fn(() => ({ limit: vi.fn(() => lean([{ timestamp: "2026-07-01", action: "KYCApproved", entityType: "investor", entityId: "investor-1", actorUserId: "admin-1", roleAtTime: "admin", notes: "ok", hash: "hash" }])) })) });
    const csv = await app.inject({ method: "GET", url: "/v1/admin/reports/compliance-events?format=csv" });
    expect(csv.statusCode).toBe(200); expect(csv.headers["content-type"]).toContain("text/csv"); expect(csv.body).toContain("KYCApproved");
    await expect(app.inject({ method: "GET", url: "/v1/admin/reports/compliance-events?from=invalid" })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("does not disclose reports to an unauthorized role", async () => {
    role = "investor";
    await expect(app.inject({ method: "GET", url: "/v1/admin/reports/kyb-status" })).resolves.toMatchObject({ statusCode: 403 });
  });
});
