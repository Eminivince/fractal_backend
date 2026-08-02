import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ find: vi.fn(), findOne: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ TemplateModel: { find: mocks.find, findOne: mocks.findOne } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { templateRoutes } from "../templates.routes.js";

let app: ReturnType<typeof Fastify>;
const template = { _id: "template-a", name: "Asset application", checklistItems: [], termSchema: [], enabled: true, save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ code: "A" })) };
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  template.name = "Asset application"; template.checklistItems = []; template.termSchema = []; template.enabled = true; template.save.mockClear(); template.toObject.mockClear();
  mocks.serialize.mockImplementation((value: unknown) => value); mocks.appendEvent.mockResolvedValue(undefined); mocks.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ code: "A" }]) }); mocks.findOne.mockResolvedValue(template);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "admin-1", role: "admin" }; });
  await app.register(templateRoutes);
});
afterEach(async () => { await app.close(); });

describe("template routes", () => {
  it("lists governed templates with read authority", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/templates" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "template");
  });

  it("updates each optional template field and writes an audit event", async () => {
    const response = await app.inject({ method: "PUT", url: "/v1/templates/A", payload: {
      name: "Updated asset application", checklistItems: [{ key: "identity", label: "Identity", requiredStage: "Compliance" }], termSchema: [{ key: "term", label: "Term", type: "number", required: true }], enabled: false,
    } });
    expect(response.statusCode).toBe(200);
    expect(template).toMatchObject({ name: "Updated asset application", enabled: false, updatedBy: "admin-1" });
    expect(template.save).toHaveBeenCalledOnce();
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "admin-1" }), expect.objectContaining({ action: "Template A updated" }));
  });

  it("rejects unsupported template codes, invalid fields, and missing templates", async () => {
    await expect(app.inject({ method: "PUT", url: "/v1/templates/C", payload: {} })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "PUT", url: "/v1/templates/A", payload: { enabled: "yes" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.findOne.mockResolvedValueOnce(null);
    await expect(app.inject({ method: "PUT", url: "/v1/templates/A", payload: {} })).resolves.toMatchObject({ statusCode: 404 });
  });
});
