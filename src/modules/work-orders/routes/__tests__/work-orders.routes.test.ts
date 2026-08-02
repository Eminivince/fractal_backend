import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ templateFind: vi.fn(), templateCreate: vi.fn(), templateUpdate: vi.fn(), authorize: vi.fn(), serialize: vi.fn((value: unknown) => value), controller: vi.fn() }));
vi.mock("../../../../db/models.js", () => ({ WorkOrderTemplateModel: { find: mocks.templateFind, create: mocks.templateCreate, findByIdAndUpdate: mocks.templateUpdate } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../controllers/work-orders.controller.js", () => ({ createWorkOrderController: mocks.controller }));

import { workOrderRoutes } from "../work-orders.routes.js";

let app: ReturnType<typeof Fastify>;

function controllerHandler() {
  return async () => ({ ok: true });
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.controller.mockReturnValue({ assignTask: controllerHandler(), list: controllerHandler(), escalateOverdue: controllerHandler(), getById: controllerHandler(), events: controllerHandler(), accept: controllerHandler(), decline: controllerHandler(), start: controllerHandler(), requestInfo: controllerHandler(), submitOutcome: controllerHandler(), startReview: controllerHandler(), review: controllerHandler(), score: controllerHandler(), getInvoice: controllerHandler(), withdraw: controllerHandler(), bulkAssign: controllerHandler(), uploadDeliverable: controllerHandler(), downloadDeliverable: controllerHandler() });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "admin-1", role: "admin" }; });
  await app.register(workOrderRoutes);
});

afterEach(async () => { await app.close(); });

describe("work order routes", () => {
  it("registers controller-backed lifecycle routes behind authentication", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/tasks/task-1/assign" })).resolves.toMatchObject({ statusCode: 200, json: expect.any(Function) });
    await expect(app.inject({ method: "GET", url: "/v1/work-orders" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/work-orders/work-1/accept" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/work-orders/work-1/upload-deliverable" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "GET", url: "/v1/work-orders/work-1/deliverables/0" })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("lists active templates with an optional category filter", async () => {
    mocks.templateFind.mockReturnValueOnce({ sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: "template-1", category: "legal" }]) })) });
    const response = await app.inject({ method: "GET", url: "/v1/work-order-templates?category=legal" });
    expect(response.statusCode).toBe(200);
    expect(mocks.templateFind).toHaveBeenCalledWith({ isActive: true, category: "legal" });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "work_order");
  });

  it("creates, updates, and deactivates governed templates", async () => {
    const payload = { name: "Legal diligence", category: "legal", instructions: "Review each required legal document.", requiredDeliverableTypes: ["report"], standardSlaDays: 5, priority: "high" };
    mocks.templateCreate.mockResolvedValueOnce({ _id: "template-1", toObject: () => ({ _id: "template-1", ...payload, createdBy: "admin-1" }) });
    const created = await app.inject({ method: "POST", url: "/v1/work-order-templates", payload });
    expect(created.statusCode).toBe(200);
    expect(mocks.templateCreate).toHaveBeenCalledWith(expect.objectContaining({ ...payload, createdBy: "admin-1" }));

    mocks.templateUpdate.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue({ _id: "template-1", priority: "low" }) });
    const updated = await app.inject({ method: "PUT", url: "/v1/work-order-templates/template-1", payload: { priority: "low" } });
    expect(updated.statusCode).toBe(200);
    expect(mocks.templateUpdate).toHaveBeenCalledWith("template-1", { $set: { priority: "low" } }, { new: true });

    mocks.templateUpdate.mockResolvedValueOnce(undefined);
    const removed = await app.inject({ method: "DELETE", url: "/v1/work-order-templates/template-1" });
    expect(removed.statusCode).toBe(200);
    expect(mocks.templateUpdate).toHaveBeenLastCalledWith("template-1", { $set: { isActive: false } });
  });

  it("rejects invalid templates and reports a missing update target", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/work-order-templates", payload: { name: "x", category: "bad", instructions: "short" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.templateUpdate.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    await expect(app.inject({ method: "PUT", url: "/v1/work-order-templates/missing", payload: { priority: "normal" } })).resolves.toMatchObject({ statusCode: 404 });
  });
});
