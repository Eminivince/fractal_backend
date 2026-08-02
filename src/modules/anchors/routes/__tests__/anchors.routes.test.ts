import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";
import { anchorRoutes } from "../anchors.routes.js";

const mocks = vi.hoisted(() => ({
  find: vi.fn(),
  findById: vi.fn(),
  authorize: vi.fn(),
  appendEvent: vi.fn(),
}));

vi.mock("../../../../db/models.js", () => ({ AnchorModel: { find: mocks.find, findById: mocks.findById } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));

let app: ReturnType<typeof Fastify>;
let role = "investor";

beforeEach(async () => {
  vi.clearAllMocks();
  role = "investor";
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role, sessionId: "session-1" }; });
  await app.register(anchorRoutes);
});

afterEach(async () => { await app.close(); });

describe("anchor routes", () => {
  it("lists anchors with the requested filters and limit", async () => {
    const lean = vi.fn().mockResolvedValue([{ _id: "anchor-1", anchorStatus: "anchored" }]);
    const limit = vi.fn().mockReturnValue({ lean });
    const sort = vi.fn().mockReturnValue({ limit });
    mocks.find.mockReturnValue({ sort });

    const response = await app.inject({ method: "GET", url: "/v1/anchors?entityType=offering&entityId=offer-1&anchorStatus=anchored&limit=20" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ _id: "anchor-1", anchorStatus: "anchored" }]);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "investor" }), "read", "anchor");
    expect(mocks.find).toHaveBeenCalledWith({ entityType: "offering", entityId: "offer-1", anchorStatus: "anchored" });
    expect(sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(limit).toHaveBeenCalledWith(20);
  });

  it("rejects a retry from a non-operator before it reads the anchor", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/anchors/anchor-1/retry" });

    expect(response.statusCode).toBe(403);
    expect(mocks.findById).not.toHaveBeenCalled();
  });

  it("queues a failed anchor again and records the audit event", async () => {
    role = "operator";
    const save = vi.fn();
    const anchor = { _id: "anchor-1", anchorStatus: "failed", lastError: "Network failure", save, toObject: () => ({ _id: "anchor-1", anchorStatus: "pending" }) };
    mocks.findById.mockResolvedValue(anchor);

    const response = await app.inject({ method: "POST", url: "/v1/anchors/anchor-1/retry" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ _id: "anchor-1", anchorStatus: "pending" });
    expect(anchor.anchorStatus).toBe("pending");
    expect(anchor.lastError).toBeUndefined();
    expect(save).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ role: "operator" }), { entityType: "anchor", entityId: "anchor-1", action: "AnchorRetryQueued" });
  });

  it("does not retry an anchor that is already anchored", async () => {
    role = "admin";
    mocks.findById.mockResolvedValue({ anchorStatus: "anchored" });

    const response = await app.inject({ method: "POST", url: "/v1/anchors/anchor-1/retry" });

    expect(response.statusCode).toBe(422);
  });
});
