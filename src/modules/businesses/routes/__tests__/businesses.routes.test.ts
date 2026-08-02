import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  addDirector: vi.fn(),
  addShareholder: vi.fn(),
  addUbo: vi.fn(),
  authorize: vi.fn(),
  controller: vi.fn(),
  removeDirector: vi.fn(),
  removeShareholder: vi.fn(),
  removeUbo: vi.fn(),
  serialize: vi.fn((value: unknown) => value),
  suspendBusiness: vi.fn(),
  teamRoutes: vi.fn(),
  unsuspendBusiness: vi.fn(),
}));

vi.mock("../../controllers/businesses.controller.js", () => ({
  createBusinessController: mocks.controller,
}));
vi.mock("../team.routes.js", () => ({ businessTeamRoutes: mocks.teamRoutes }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../services/businesses.service.js", () => ({
  addDirector: mocks.addDirector,
  addShareholder: mocks.addShareholder,
  addUbo: mocks.addUbo,
  removeDirector: mocks.removeDirector,
  removeShareholder: mocks.removeShareholder,
  removeUbo: mocks.removeUbo,
  suspendBusiness: mocks.suspendBusiness,
  unsuspendBusiness: mocks.unsuspendBusiness,
}));

import { businessRoutes } from "../businesses.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "admin";
const user = { userId: "user-1", role: "admin" };

function controllerHandler() {
  return async () => ({ ok: true });
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "admin";
  mocks.authorize.mockReturnValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.teamRoutes.mockResolvedValue(undefined);
  mocks.controller.mockReturnValue({
    listBusinesses: controllerHandler(),
    getMyBusiness: controllerHandler(),
    registerBusiness: controllerHandler(),
    submitMyKyb: controllerHandler(),
    listDocuments: controllerHandler(),
    uploadDocument: controllerHandler(),
    retrieveDocument: controllerHandler(),
    reviewKybStatus: controllerHandler(),
    updateBusiness: controllerHandler(),
    listUsers: controllerHandler(),
    updatePayoutBankAccount: controllerHandler(),
  });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) =>
    reply.status(error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message }),
  );
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    request.authUser = { ...user, role };
  });
  await app.register(businessRoutes);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("business routes", () => {
  it("registers controller-backed business routes", () => {
    expect(mocks.controller).toHaveBeenCalledTimes(1);
    expect(mocks.teamRoutes).toHaveBeenCalledTimes(1);
  });

  it("adds and removes each business governance record", async () => {
    mocks.addUbo.mockResolvedValueOnce({ id: "ubo-1" });
    const ubo = await app.inject({
      method: "POST",
      url: "/v1/businesses/business-1/ubos",
      payload: { fullName: "Ada Owner", ownershipPct: 60 },
    });
    expect(ubo.statusCode).toBe(200);
    expect(mocks.addUbo).toHaveBeenCalledWith(
      expect.objectContaining(user),
      "business-1",
      expect.objectContaining({ fullName: "Ada Owner", ownershipPct: 60, controlBasis: "shares", isPep: false }),
    );

    mocks.removeUbo.mockResolvedValueOnce({ success: true });
    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/ubos/ubo-1" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.removeUbo).toHaveBeenCalledWith(expect.objectContaining(user), "business-1", "ubo-1");

    mocks.addDirector.mockResolvedValueOnce({ id: "director-1" });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/directors", payload: { fullName: "Ada Director" } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.addDirector).toHaveBeenCalledWith(expect.objectContaining(user), "business-1", expect.objectContaining({ fullName: "Ada Director", isPep: false }));
    mocks.removeDirector.mockResolvedValueOnce({ success: true });
    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/directors/director-1" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.removeDirector).toHaveBeenCalledWith(expect.objectContaining(user), "business-1", "director-1");

    mocks.addShareholder.mockResolvedValueOnce({ id: "shareholder-1" });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/shareholders", payload: { name: "Ada Holdings", ownershipPct: 40 } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.addShareholder).toHaveBeenCalledWith(expect.objectContaining(user), "business-1", expect.objectContaining({ name: "Ada Holdings", ownershipPct: 40, isEntity: false, entityUboChainRequired: false }));
    mocks.removeShareholder.mockResolvedValueOnce({ success: true });
    await expect(app.inject({ method: "DELETE", url: "/v1/businesses/business-1/shareholders/shareholder-1" })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.removeShareholder).toHaveBeenCalledWith(expect.objectContaining(user), "business-1", "shareholder-1");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "update", "business");
  });

  it("rejects invalid governance records before service calls", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/ubos", payload: { fullName: "A", ownershipPct: 101 } })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/directors", payload: { fullName: "A" } })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/shareholders", payload: { name: "A", ownershipPct: -1 } })).resolves.toMatchObject({ statusCode: 400 });
    expect(mocks.addUbo).not.toHaveBeenCalled();
    expect(mocks.addDirector).not.toHaveBeenCalled();
    expect(mocks.addShareholder).not.toHaveBeenCalled();
  });

  it("lets an administrator suspend and unsuspend a business", async () => {
    mocks.suspendBusiness.mockResolvedValueOnce({ id: "business-1", status: "suspended" });
    const suspended = await app.inject({ method: "POST", url: "/v1/businesses/business-1/suspend", payload: { reason: "aml_concern", notes: "Review required" } });
    expect(suspended.statusCode).toBe(200);
    expect(mocks.suspendBusiness).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "business-1", { reason: "aml_concern", notes: "Review required" });

    mocks.unsuspendBusiness.mockResolvedValueOnce({ id: "business-1", status: "active" });
    const unsuspended = await app.inject({ method: "POST", url: "/v1/businesses/business-1/unsuspend" });
    expect(unsuspended.statusCode).toBe(200);
    expect(mocks.unsuspendBusiness).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "business-1");
  });

  it("rejects invalid suspension requests and non-administrators", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/suspend", payload: { reason: "invalid" } })).resolves.toMatchObject({ statusCode: 400 });
    role = "issuer";
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/suspend", payload: { reason: "kyb_lapse" } })).resolves.toMatchObject({ statusCode: 403 });
    await expect(app.inject({ method: "POST", url: "/v1/businesses/business-1/unsuspend" })).resolves.toMatchObject({ statusCode: 403 });
    expect(mocks.suspendBusiness).not.toHaveBeenCalled();
    expect(mocks.unsuspendBusiness).not.toHaveBeenCalled();
  });
});
