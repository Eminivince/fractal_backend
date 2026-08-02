import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), update: vi.fn(), status: vi.fn(), register: vi.fn(), submit: vi.fn(), review: vi.fn(), authorize: vi.fn(), requireRole: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../middleware/role-guard.js", () => ({ requireRole: mocks.requireRole }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../services/professionals.service.js", () => ({
  listProfessionals: mocks.list, createProfessional: mocks.create, updateProfessional: mocks.update, updateProfessionalStatus: mocks.status,
  registerProfessionalProfile: mocks.register, submitProfessionalOnboarding: mocks.submit, reviewProfessionalOnboarding: mocks.review,
}));
import { professionalRoutes } from "../professionals.routes.js";

let role = "admin";
let app: ReturnType<typeof Fastify>;
const professionalId = "professional-1";
const payload = { category: "valuer", name: "Amina Valuers Limited", organizationType: "firm", contactEmail: "team@valuer.example.test", regions: ["Lagos"], jurisdictions: ["NG"], serviceCategories: ["valuation"], slaDays: 3, pricing: { model: "flat", amount: 250000 } };
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "admin"; mocks.serialize.mockImplementation((value: unknown) => value); mocks.authorize.mockReturnValue(undefined);
  mocks.requireRole.mockImplementation((user: { role?: string } | undefined, required: string) => { if (user?.role !== required) throw new HttpError(403, "Required role missing"); });
  mocks.list.mockResolvedValue([{ id: professionalId }]); mocks.create.mockResolvedValue({ id: professionalId }); mocks.update.mockResolvedValue({ id: professionalId }); mocks.status.mockResolvedValue({ id: professionalId, status: "disabled" }); mocks.register.mockResolvedValue({ token: "session-token", professional: { id: professionalId }, user: { id: "user-1" } }); mocks.submit.mockResolvedValue({ id: professionalId, onboardingStatus: "submitted" }); mocks.review.mockResolvedValue({ id: professionalId, onboardingStatus: "approved" });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role }; });
  await app.register(professionalRoutes);
});
afterEach(async () => { await app.close(); });

describe("professional routes and controller", () => {
  it("lists, creates, updates, and changes professional status through authority checks", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/professionals?category=valuer&status=active" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/professionals", payload })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "PUT", url: `/v1/professionals/${professionalId}`, payload })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "PATCH", url: `/v1/professionals/${professionalId}/status`, payload: { status: "disabled" } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), expect.objectContaining({ category: "valuer" }));
    expect(mocks.status).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), professionalId, { status: "disabled" });
  });

  it("allows a professional to save and submit their own onboarding profile", async () => {
    role = "professional";
    const registered = await app.inject({ method: "POST", url: "/v1/professionals/register", payload });
    expect(registered.statusCode).toBe(200); expect(registered.json()).toMatchObject({ token: "session-token" });
    await expect(app.inject({ method: "POST", url: "/v1/professionals/me/submit-onboarding" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.register).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ role: "professional" }), expect.objectContaining({ name: payload.name }));
  });

  it("allows only an administrator to review onboarding", async () => {
    role = "professional";
    await expect(app.inject({ method: "PATCH", url: `/v1/professionals/${professionalId}/onboarding-status`, payload: { status: "approved", notes: "Independent review approved the profile." } })).resolves.toMatchObject({ statusCode: 403 });
    role = "admin";
    await expect(app.inject({ method: "PATCH", url: `/v1/professionals/${professionalId}/onboarding-status`, payload: { status: "approved", notes: "Independent review approved the profile." } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.review).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), professionalId, expect.objectContaining({ status: "approved" }));
  });

  it("rejects malformed professional records before service access", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/professionals", payload: { ...payload, pricing: { model: "flat", amount: -1 } } })).resolves.toMatchObject({ statusCode: 400 });
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
