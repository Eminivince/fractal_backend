import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ applicationFindById: vi.fn(), applicationFind: vi.fn(), disputeFind: vi.fn(), disputeCreate: vi.fn(), disputeFindById: vi.fn(), distributionFindById: vi.fn(), distributionFind: vi.fn(), milestoneFindById: vi.fn(), milestoneFind: vi.fn(), offeringFindById: vi.fn(), offeringFind: vi.fn(), subscriptionFindById: vi.fn(), subscriptionFind: vi.fn(), subscriptionExists: vi.fn(), trancheFindById: vi.fn(), trancheFind: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), assertScope: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ ApplicationModel: { findById: mocks.applicationFindById, find: mocks.applicationFind }, DisputeModel: { find: mocks.disputeFind, create: mocks.disputeCreate, findById: mocks.disputeFindById }, DistributionModel: { findById: mocks.distributionFindById, find: mocks.distributionFind }, MilestoneModel: { findById: mocks.milestoneFindById, find: mocks.milestoneFind }, OfferingModel: { findById: mocks.offeringFindById, find: mocks.offeringFind }, SubscriptionModel: { findById: mocks.subscriptionFindById, find: mocks.subscriptionFind, exists: mocks.subscriptionExists }, TrancheModel: { findById: mocks.trancheFindById, find: mocks.trancheFind } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.assertScope }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { disputeRoutes } from "../disputes.routes.js";

let app: ReturnType<typeof Fastify>; let role = "admin"; let businessId = "business-1";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const selected = (value: unknown) => ({ select: vi.fn(() => lean(value)) });
const document = (value: Record<string, unknown>): any => ({ ...value, toObject: () => value });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined); mocks.appendEvent.mockResolvedValue(undefined); mocks.assertScope.mockReturnValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); role = "admin"; businessId = "business-1";
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role, businessId }; }); await app.register(disputeRoutes);
});
afterEach(async () => { await app.close(); });

function listChain(value: unknown) { return { sort: vi.fn(() => ({ limit: vi.fn(() => lean(value)) })) }; }

describe("dispute routes", () => {
  it("limits investor lists to disputes raised by that investor", async () => {
    role = "investor"; mocks.disputeFind.mockReturnValueOnce(listChain([{ _id: "dispute-1" }]));
    const response = await app.inject({ method: "GET", url: "/v1/disputes?status=open&entityType=offering&entityId=offering-1&limit=5" });
    expect(response.statusCode).toBe(200); expect(mocks.disputeFind).toHaveBeenCalledWith({ status: "open", entityType: "offering", entityId: "offering-1", raisedBy: "user-1" });
  });

  it("limits issuer lists to records related to its own offering set", async () => {
    role = "issuer"; mocks.offeringFind.mockReturnValueOnce(selected([{ _id: "offering-1" }])); mocks.subscriptionFind.mockReturnValueOnce(selected([{ _id: "subscription-1" }])); mocks.distributionFind.mockReturnValueOnce(selected([{ _id: "distribution-1" }])); mocks.milestoneFind.mockReturnValueOnce(selected([{ _id: "milestone-1" }])); mocks.trancheFind.mockReturnValueOnce(selected([{ _id: "tranche-1" }])); mocks.applicationFind.mockReturnValueOnce(selected([{ _id: "application-1" }])); mocks.disputeFind.mockReturnValueOnce(listChain([]));
    const response = await app.inject({ method: "GET", url: "/v1/disputes?entityType=subscription" });
    expect(response.statusCode).toBe(200); expect(mocks.disputeFind).toHaveBeenCalledWith({ entityType: "subscription", entityId: { $in: ["subscription-1"] } });
    mocks.offeringFind.mockReturnValueOnce(selected([{ _id: "offering-1" }])); mocks.subscriptionFind.mockReturnValueOnce(selected([{ _id: "subscription-1" }])); mocks.distributionFind.mockReturnValueOnce(selected([{ _id: "distribution-1" }])); mocks.milestoneFind.mockReturnValueOnce(selected([{ _id: "milestone-1" }])); mocks.trancheFind.mockReturnValueOnce(selected([{ _id: "tranche-1" }])); mocks.applicationFind.mockReturnValueOnce(selected([{ _id: "application-1" }])); mocks.disputeFind.mockReturnValueOnce(listChain([]));
    await expect(app.inject({ method: "GET", url: "/v1/disputes" })).resolves.toMatchObject({ statusCode: 200 }); expect(mocks.disputeFind).toHaveBeenLastCalledWith(expect.objectContaining({ $or: expect.arrayContaining([expect.objectContaining({ entityType: "offering" })]) }));
  });

  it("creates disputes for every supported entity context", async () => {
    mocks.applicationFindById.mockImplementation((id: string) => lean(id === "application-1" ? { businessId: "business-1" } : null)); mocks.offeringFindById.mockImplementation((id: string) => lean(id === "offering-1" ? { _id: "offering-1", businessId: "business-1" } : null)); mocks.subscriptionFindById.mockImplementation((id: string) => lean(id === "subscription-1" ? { offeringId: "offering-1", investorUserId: "owner-1" } : null)); mocks.distributionFindById.mockImplementation((id: string) => lean(id === "distribution-1" ? { offeringId: "offering-1" } : null)); mocks.milestoneFindById.mockImplementation((id: string) => lean(id === "milestone-1" ? { offeringId: "offering-1" } : null)); mocks.trancheFindById.mockImplementation((id: string) => lean(id === "tranche-1" ? { offeringId: "offering-1" } : null));
    for (const [entityType, entityId] of [["application", "application-1"], ["offering", "offering-1"], ["subscription", "subscription-1"], ["distribution", "distribution-1"], ["milestone", "milestone-1"], ["tranche", "tranche-1"]] as const) { mocks.disputeCreate.mockResolvedValueOnce(document({ _id: `dispute-${entityType}` })); const response = await app.inject({ method: "POST", url: "/v1/disputes", payload: { entityType, entityId, reason: "Please investigate this issue." } }); expect(response.statusCode).toBe(200); }
    expect(mocks.disputeCreate).toHaveBeenCalledTimes(6); expect(mocks.appendEvent).toHaveBeenCalledTimes(6);
  });

  it("enforces issuer scope and investor ownership before creating a dispute", async () => {
    role = "issuer"; mocks.applicationFindById.mockReturnValueOnce(lean({ businessId: "business-2" })); mocks.disputeCreate.mockResolvedValueOnce(document({ _id: "dispute-1" })); await expect(app.inject({ method: "POST", url: "/v1/disputes", payload: { entityType: "application", entityId: "application-1", reason: "Please investigate." } })).resolves.toMatchObject({ statusCode: 200 }); expect(mocks.assertScope).toHaveBeenCalledWith(expect.objectContaining({ businessId: "business-1" }), "business-2");
    role = "investor"; mocks.subscriptionFindById.mockReturnValueOnce(lean({ offeringId: "offering-1", investorUserId: "user-1" })); mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" })); mocks.disputeCreate.mockResolvedValueOnce(document({ _id: "dispute-2" })); await expect(app.inject({ method: "POST", url: "/v1/disputes", payload: { entityType: "subscription", entityId: "subscription-1", reason: "Please investigate." } })).resolves.toMatchObject({ statusCode: 200 });
    mocks.offeringFindById.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" })); mocks.subscriptionExists.mockResolvedValueOnce(false); await expect(app.inject({ method: "POST", url: "/v1/disputes", payload: { entityType: "offering", entityId: "offering-1", reason: "Please investigate." } })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("rejects invalid and missing dispute targets", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/disputes", payload: { entityType: "wrong", entityId: "x", reason: "x" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.applicationFindById.mockReturnValueOnce(lean(null)); await expect(app.inject({ method: "POST", url: "/v1/disputes", payload: { entityType: "application", entityId: "application-1", reason: "Please investigate." } })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("allows operators to assign and resolve disputes", async () => {
    role = "operator"; const dispute = document({ _id: "dispute-1", status: "open", save: vi.fn().mockResolvedValue(undefined) }); mocks.disputeFindById.mockResolvedValueOnce(dispute);
    const response = await app.inject({ method: "PATCH", url: "/v1/disputes/dispute-1/status", payload: { status: "resolved", resolutionNote: "Resolved with corrected statement.", assignedTo: "operator-2" } });
    expect(response.statusCode).toBe(200); expect(dispute).toMatchObject({ status: "resolved", assignedTo: "operator-2", resolutionNote: "Resolved with corrected statement.", resolvedAt: expect.any(Date) }); expect(dispute.save).toHaveBeenCalledOnce();
    const reopened = document({ _id: "dispute-1", save: vi.fn().mockResolvedValue(undefined) }); mocks.disputeFindById.mockResolvedValueOnce(reopened); await expect(app.inject({ method: "PATCH", url: "/v1/disputes/dispute-1/status", payload: { status: "investigating" } })).resolves.toMatchObject({ statusCode: 200 }); expect(reopened).toMatchObject({ status: "investigating", resolvedAt: undefined });
  });

  it("blocks unauthorized, invalid, and missing status updates", async () => {
    role = "investor"; await expect(app.inject({ method: "PATCH", url: "/v1/disputes/dispute-1/status", payload: { status: "open" } })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator"; await expect(app.inject({ method: "PATCH", url: "/v1/disputes/dispute-1/status", payload: { status: "wrong" } })).resolves.toMatchObject({ statusCode: 400 }); mocks.disputeFindById.mockResolvedValueOnce(null); await expect(app.inject({ method: "PATCH", url: "/v1/disputes/missing/status", payload: { status: "open" } })).resolves.toMatchObject({ statusCode: 404 });
  });
});
