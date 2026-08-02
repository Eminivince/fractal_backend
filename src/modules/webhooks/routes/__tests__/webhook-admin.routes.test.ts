import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), byId: vi.fn(), update: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ WebhookEventModel: { find: mocks.find, countDocuments: mocks.count, findById: mocks.byId, updateOne: mocks.update } }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));

import { webhookAdminRoutes } from "../webhook-admin.routes.js";

let role = "admin";
let app: ReturnType<typeof Fastify>;

function listQuery(value: unknown) {
  return { sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => ({ select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })) })) })) };
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "admin";
  mocks.serialize.mockImplementation((value: unknown) => value);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "admin-1", role }; });
  await app.register(webhookAdminRoutes);
});

afterEach(async () => { await app.close(); });

describe("webhook administration routes", () => {
  it("lists webhook events with bounded filtering and no raw payload", async () => {
    mocks.find.mockReturnValueOnce(listQuery([{ _id: "event-1", provider: "paystack", status: "failed" }]));
    mocks.count.mockResolvedValueOnce(1);
    const response = await app.inject({ method: "GET", url: "/v1/admin/webhooks?provider=paystack&status=failed&limit=10&offset=4" });
    expect(response.statusCode).toBe(200);
    expect(mocks.find).toHaveBeenCalledWith({ provider: "paystack", status: "failed" });
    expect(response.json()).toEqual({ events: [{ _id: "event-1", provider: "paystack", status: "failed" }], total: 1, limit: 10, offset: 4 });
  });

  it("allows an operator to read a full event but not replay it", async () => {
    role = "operator";
    mocks.byId.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue({ _id: "event-1", rawPayload: { provider: "test" } }) });
    const detail = await app.inject({ method: "GET", url: "/v1/admin/webhooks/event-1" });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual({ _id: "event-1", rawPayload: { provider: "test" } });
    const replay = await app.inject({ method: "POST", url: "/v1/admin/webhooks/event-1/replay" });
    expect(replay.statusCode).toBe(403);
  });

  it("marks a stored event for replay and reports its next replay count", async () => {
    mocks.byId.mockResolvedValueOnce({ _id: "event-1", replayCount: 2 });
    const response = await app.inject({ method: "POST", url: "/v1/admin/webhooks/event-1/replay" });
    expect(response.statusCode).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith({ _id: "event-1" }, { $set: { status: "received" }, $inc: { replayCount: 1 } });
    expect(response.json()).toEqual({ message: "Webhook event event-1 marked for replay. The next webhook processing cycle will re-process it.", replayCount: 3 });
  });

  it("rejects unsupported actors, invalid queries, and missing events", async () => {
    role = "investor";
    await expect(app.inject({ method: "GET", url: "/v1/admin/webhooks" })).resolves.toMatchObject({ statusCode: 403 });
    role = "admin";
    await expect(app.inject({ method: "GET", url: "/v1/admin/webhooks?limit=101" })).resolves.toMatchObject({ statusCode: 400 });
    mocks.byId.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    await expect(app.inject({ method: "GET", url: "/v1/admin/webhooks/missing" })).resolves.toMatchObject({ statusCode: 404 });
  });
});
