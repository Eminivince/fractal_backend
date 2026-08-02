import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ find: vi.fn(), count: vi.fn(), findOneAndUpdate: vi.fn(), updateMany: vi.fn(), authorize: vi.fn(), serialize: vi.fn((value: unknown) => value), onUserEvent: vi.fn() }));
vi.mock("../../../../db/models.js", () => ({ NotificationModel: { find: mocks.find, countDocuments: mocks.count, findOneAndUpdate: mocks.findOneAndUpdate, updateMany: mocks.updateMany } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../services/event-bus.js", () => ({ onUserEvent: mocks.onUserEvent }));
import { notificationRoutes } from "../notifications.routes.js";

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.find.mockReturnValue({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ id: "notice-1" }]) });
  mocks.count.mockResolvedValue(3);
  mocks.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue({ id: "notice-1", readAt: new Date() }) });
  mocks.updateMany.mockResolvedValue({ matchedCount: 3, modifiedCount: 2 });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  app.decorate("authenticate", async (request: any) => { request.authUser = { userId: "user-1", role: "investor" }; });
  app.decorate("jwt", { verify: vi.fn().mockRejectedValue(new Error("invalid")) });
  await app.register(notificationRoutes);
});
afterEach(async () => { await app.close(); });

describe("notification routes", () => {
  it("lists only the caller notifications and supports unread filtering", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/notifications?unreadOnly=true&limit=5" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), "read", "notification");
    expect(mocks.find).toHaveBeenCalledWith({ recipientUserId: "user-1", readAt: { $exists: false } });
  });

  it("gets an unread count and marks a caller-owned notification read", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/notifications/unread-count" })).resolves.toMatchObject({ statusCode: 200, json: expect.any(Function) });
    const marked = await app.inject({ method: "POST", url: "/v1/notifications/notice-1/read" });
    expect(marked.statusCode).toBe(200);
    expect(mocks.findOneAndUpdate).toHaveBeenCalledWith({ _id: "notice-1", recipientUserId: "user-1" }, expect.objectContaining({ $set: { readAt: expect.any(Date) } }), { new: true });
  });

  it("returns not found for another user notification and marks all unread notifications", async () => {
    mocks.findOneAndUpdate.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    await expect(app.inject({ method: "POST", url: "/v1/notifications/other/read" })).resolves.toMatchObject({ statusCode: 404 });
    const all = await app.inject({ method: "POST", url: "/v1/notifications/read-all" });
    expect(all.statusCode).toBe(200);
    expect(JSON.parse(all.payload)).toEqual({ matched: 3, modified: 2 });
  });

  it("rejects invalid stream tokens before it opens an event stream", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/notifications/stream?token=invalid" })).resolves.toMatchObject({ statusCode: 401 });
  });

  it("opens an authenticated event stream, forwards user events, and cleans up on disconnect", async () => {
    let emit: ((payload: Record<string, unknown>) => void) | undefined;
    const unsubscribe = vi.fn();
    mocks.onUserEvent.mockImplementation((_userId: string, handler: (payload: Record<string, unknown>) => void) => { emit = handler; return unsubscribe; });
    (app as any).jwt.verify.mockResolvedValue({ userId: "user-1", role: "investor" });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address() as AddressInfo;
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}/v1/notifications/stream?token=valid`, { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    expect(decoder.decode((await reader.read()).value)).toContain(": connected");
    emit?.({ type: "notification", id: "notice-1" });
    expect(decoder.decode((await reader.read()).value)).toContain('"notice-1"');
    await reader.cancel();
    controller.abort();
    await vi.waitFor(() => expect(unsubscribe).toHaveBeenCalledOnce());
  });

  it("rejects invalid notification list input", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/notifications?limit=201" })).resolves.toMatchObject({ statusCode: 400 });
  });
});
