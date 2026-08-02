import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  applicationFind: vi.fn(), offeringFind: vi.fn(), subscriptionFind: vi.fn(), distributionFind: vi.fn(), milestoneFind: vi.fn(), trancheFind: vi.fn(), eventFind: vi.fn(), authorize: vi.fn(), serialize: vi.fn((value: unknown) => value),
}));
vi.mock("../../../../db/models.js", () => ({
  ApplicationModel: { find: mocks.applicationFind }, OfferingModel: { find: mocks.offeringFind }, SubscriptionModel: { find: mocks.subscriptionFind }, DistributionModel: { find: mocks.distributionFind }, MilestoneModel: { find: mocks.milestoneFind }, TrancheModel: { find: mocks.trancheFind }, EventLogModel: { find: mocks.eventFind },
}));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { eventRoutes } from "../events.routes.js";

let app: ReturnType<typeof Fastify>;
let currentAuth: { userId: string; role: string; businessId?: string };
const chained = (rows: unknown[]) => ({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(rows) });

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.applicationFind.mockReturnValue(chained([{ _id: "application-1" }]));
  mocks.offeringFind.mockReturnValue(chained([{ _id: "offering-1" }]));
  mocks.subscriptionFind.mockReturnValue(chained([{ _id: "subscription-1", offeringId: "offering-1" }]));
  mocks.distributionFind.mockReturnValue(chained([{ _id: "distribution-1" }]));
  mocks.milestoneFind.mockReturnValue(chained([{ _id: "milestone-1" }]));
  mocks.trancheFind.mockReturnValue(chained([{ _id: "tranche-1" }]));
  mocks.eventFind.mockReturnValue({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ id: "event-1" }]) });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  currentAuth = { userId: "admin-1", role: "admin" };
  app.decorate("authenticate", async (request: { authUser?: any }) => { request.authUser = currentAuth; });
  await app.register(eventRoutes);
});
afterEach(async () => { await app.close(); });

describe("event routes", () => {
  it("lists events with governed filters and read authority", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/events?entityType=offering&entityId=offering-1&actor=user-1&q=approved&from=2026-01-01&to=2026-01-02&limit=5" });
    expect(response.statusCode).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "event");
    expect(mocks.eventFind).toHaveBeenCalledWith(expect.objectContaining({ entityType: "offering", entityId: "offering-1", actorUserId: "user-1", $or: expect.any(Array), timestamp: expect.objectContaining({ $gte: expect.any(Date), $lte: expect.any(Date) }) }));
  });

  it("limits issuer event visibility to its governed entities", async () => {
    currentAuth = { userId: "issuer-user", role: "issuer", businessId: "business-1" };
    const response = await app.inject({ method: "GET", url: "/v1/events" });
    expect(response.statusCode).toBe(200);
    expect(mocks.eventFind).toHaveBeenCalledWith(expect.objectContaining({ entityId: { $in: expect.arrayContaining(["application-1", "offering-1", "business-1", "issuer-user"]) } }));
  });

  it("returns no issuer data for a foreign requested entity", async () => {
    currentAuth = { userId: "issuer-user", role: "issuer", businessId: "business-1" };
    await expect(app.inject({ method: "GET", url: "/v1/events?entityId=foreign" })).resolves.toMatchObject({ statusCode: 200, payload: "[]" });
    expect(mocks.eventFind).not.toHaveBeenCalled();
  });

  it("limits investor event visibility to subscriptions and related entities", async () => {
    currentAuth = { userId: "investor-user", role: "investor" };
    const response = await app.inject({ method: "GET", url: "/v1/events" });
    expect(response.statusCode).toBe(200);
    expect(mocks.subscriptionFind).toHaveBeenCalledWith({ investorUserId: "investor-user" });
    expect(mocks.eventFind).toHaveBeenCalledWith(expect.objectContaining({ entityId: { $in: expect.arrayContaining(["subscription-1", "offering-1", "investor-user"]) } }));
  });

  it("returns no investor data for a foreign requested entity", async () => {
    currentAuth = { userId: "investor-user", role: "investor" };
    await expect(app.inject({ method: "GET", url: "/v1/events?entityId=foreign" })).resolves.toMatchObject({ statusCode: 200, payload: "[]" });
    expect(mocks.eventFind).not.toHaveBeenCalled();
  });

  it("rejects invalid query values", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/events?limit=201" })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "GET", url: "/v1/events?entityType=unknown" })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("supports one-sided date filters without adding an empty search filter", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/events?from=2026-01-01&q=%20" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.eventFind).toHaveBeenCalledWith(expect.objectContaining({ timestamp: { $gte: expect.any(Date) } }));
    mocks.eventFind.mockClear();
    await expect(app.inject({ method: "GET", url: "/v1/events?to=2026-01-02" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.eventFind).toHaveBeenCalledWith(expect.objectContaining({ timestamp: { $lte: expect.any(Date) } }));
  });
});
