import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(), userFindOne: vi.fn(), userCreate: vi.fn(), userFindById: vi.fn(), userFindByIdAndUpdate: vi.fn(),
  businessFindById: vi.fn(), professionalFindById: vi.fn(), investorCreate: vi.fn(),
  authorize: vi.fn(), appendEvent: vi.fn(), serialize: vi.fn((value: unknown) => value), resetPassword: vi.fn(), isValidObjectId: vi.fn(),
}));

vi.mock("mongoose", () => ({ default: { isValidObjectId: mocks.isValidObjectId } }));
vi.mock("../../../../db/models.js", () => ({
  UserModel: { find: mocks.userFind, findOne: mocks.userFindOne, create: mocks.userCreate, findById: mocks.userFindById, findByIdAndUpdate: mocks.userFindByIdAndUpdate },
  BusinessModel: { findById: mocks.businessFindById },
  ProfessionalModel: { findById: mocks.professionalFindById },
  InvestorProfileModel: { create: mocks.investorCreate },
}));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../auth/services/account-security.service.js", () => ({ requestPasswordReset: mocks.resetPassword }));

import { userRoutes } from "../users.routes.js";

const userId = "507f1f77bcf86cd799439011";
const businessId = "507f1f77bcf86cd799439012";
const professionalId = "507f1f77bcf86cd799439013";
let role = "admin";
let app: ReturnType<typeof Fastify>;

function lean(value: unknown) { return { lean: vi.fn().mockResolvedValue(value) }; }
function selected(value: unknown) { return { select: vi.fn(() => lean(value)), lean: vi.fn().mockResolvedValue(value) }; }

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "admin";
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.authorize.mockReturnValue(undefined);
  mocks.appendEvent.mockResolvedValue(undefined);
  mocks.resetPassword.mockResolvedValue(undefined);
  mocks.isValidObjectId.mockReturnValue(true);
  mocks.userFind.mockReturnValue({ sort: vi.fn(() => lean([])) });
  mocks.userFindOne.mockReturnValue(lean(null));
  mocks.businessFindById.mockReturnValue(lean({ _id: businessId }));
  mocks.professionalFindById.mockReturnValue(lean({ _id: professionalId }));
  mocks.investorCreate.mockResolvedValue({ _id: "investor-profile-1" });
  mocks.userFindById.mockReturnValue(selected({ _id: userId, email: "member@example.test", preferences: { theme: "light" } }));
  mocks.userFindByIdAndUpdate.mockReturnValue(selected({ _id: userId, status: "disabled", preferences: { theme: "dark" } }));
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId, role }; });
  await app.register(userRoutes);
});
afterEach(async () => { await app.close(); });

describe("user routes", () => {
  it("lists users through authorized filters", async () => {
    const rows = [{ _id: userId, role: "investor" }];
    mocks.userFind.mockReturnValue({ sort: vi.fn(() => lean(rows)) });
    const response = await app.inject({ method: "GET", url: "/v1/users?role=investor&status=active" });
    expect(response.statusCode).toBe(200);
    expect(mocks.userFind).toHaveBeenCalledWith({ role: "investor", status: "active" });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "user");
  });

  it("creates investor, issuer, and professional users with their required linked records", async () => {
    const investor = { _id: userId, investorProfileId: undefined as string | undefined, toObject: vi.fn(() => ({ _id: userId })), save: vi.fn().mockResolvedValue(undefined) };
    mocks.userCreate.mockResolvedValueOnce(investor);
    const investorResponse = await app.inject({ method: "POST", url: "/v1/users", payload: { email: "Investor@Example.test", name: "Amina Investor", role: "investor" } });
    expect(investorResponse.statusCode).toBe(200);
    expect(mocks.investorCreate).toHaveBeenCalledWith(expect.objectContaining({ userId, kycStatus: "draft" }));
    expect(investor.investorProfileId).toBe("investor-profile-1");

    const issuer = { _id: userId, toObject: vi.fn(() => ({ _id: userId })), save: vi.fn() };
    mocks.userCreate.mockResolvedValueOnce(issuer);
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "issuer@example.test", name: "Ife Issuer", role: "issuer", businessId } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.businessFindById).toHaveBeenCalledWith(businessId);

    const professional = { _id: userId, toObject: vi.fn(() => ({ _id: userId })), save: vi.fn() };
    mocks.userCreate.mockResolvedValueOnce(professional);
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "professional@example.test", name: "Pola Professional", role: "professional", professionalId } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.professionalFindById).toHaveBeenCalledWith(professionalId);
    expect(mocks.appendEvent).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), expect.objectContaining({ action: "User created" }));
  });

  it("rejects invalid or conflicting user creation before it records a user", async () => {
    mocks.isValidObjectId.mockReturnValue(false);
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "issuer@example.test", name: "Ife Issuer", role: "issuer", businessId: "invalid" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.isValidObjectId.mockReturnValue(true);
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "issuer@example.test", name: "Ife Issuer", role: "issuer" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.isValidObjectId.mockReturnValueOnce(false);
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "professional@example.test", name: "Pola Professional", role: "professional", professionalId: "invalid" } })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "professional@example.test", name: "Pola Professional", role: "professional" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.businessFindById.mockReturnValueOnce(lean(null));
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "issuer@example.test", name: "Ife Issuer", role: "issuer", businessId } })).resolves.toMatchObject({ statusCode: 404 });
    mocks.userFindOne.mockReturnValueOnce(lean({ _id: userId }));
    await expect(app.inject({ method: "POST", url: "/v1/users", payload: { email: "investor@example.test", name: "Amina Investor", role: "investor" } })).resolves.toMatchObject({ statusCode: 409 });
  });

  it("changes roles with linked professional validation and creates an investor profile when needed", async () => {
    const current = { _id: userId, role: "issuer", businessId, professionalId: undefined, investorProfileId: undefined, save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ _id: userId, role: current.role })) };
    mocks.userFindById.mockReturnValueOnce(current);
    await expect(app.inject({ method: "PATCH", url: `/v1/users/${userId}/role`, payload: { role: "professional", professionalId } })).resolves.toMatchObject({ statusCode: 200 });
    expect(current.businessId).toBeUndefined();
    expect(current.professionalId).toBe(professionalId);

    const investor = { _id: userId, role: "admin", businessId: undefined, professionalId: undefined, investorProfileId: undefined, save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ _id: userId, role: investor.role })) };
    mocks.userFindById.mockReturnValueOnce(investor);
    await expect(app.inject({ method: "PATCH", url: `/v1/users/${userId}/role`, payload: { role: "investor" } })).resolves.toMatchObject({ statusCode: 200 });
    expect(investor.investorProfileId).toBe("investor-profile-1");
  });

  it("updates status, sends reset links, and persists the authenticated user preferences", async () => {
    await expect(app.inject({ method: "PATCH", url: `/v1/users/${userId}/status`, payload: { status: "disabled" } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: `/v1/users/${userId}/reset-password` })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.resetPassword).toHaveBeenCalledWith("member@example.test");
    await expect(app.inject({ method: "GET", url: "/v1/users/me/preferences" })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "PUT", url: "/v1/users/me/preferences", payload: { preferences: { theme: "dark", compact: true } } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.userFindByIdAndUpdate).toHaveBeenCalledWith(userId, { $set: { preferences: { theme: "dark", compact: true } } }, { new: true });
  });

  it("fails closed for missing users, invalid professional links, and accounts without email", async () => {
    mocks.userFindById.mockReturnValueOnce(null);
    await expect(app.inject({ method: "PATCH", url: `/v1/users/${userId}/role`, payload: { role: "investor" } })).resolves.toMatchObject({ statusCode: 404 });
    const current = { _id: userId, role: "admin", save: vi.fn(), toObject: vi.fn(() => ({ _id: userId })) };
    mocks.userFindById.mockReturnValueOnce(current);
    mocks.isValidObjectId.mockReturnValueOnce(false);
    await expect(app.inject({ method: "PATCH", url: `/v1/users/${userId}/role`, payload: { role: "professional", professionalId: "invalid" } })).resolves.toMatchObject({ statusCode: 400 });
    const noProfessional = { _id: userId, role: "admin", professionalId: undefined, save: vi.fn(), toObject: vi.fn(() => ({ _id: userId })) };
    mocks.userFindById.mockReturnValueOnce(noProfessional);
    await expect(app.inject({ method: "PATCH", url: `/v1/users/${userId}/role`, payload: { role: "professional" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.userFindById.mockReturnValueOnce(lean({ _id: userId, email: "" }));
    await expect(app.inject({ method: "POST", url: `/v1/users/${userId}/reset-password` })).resolves.toMatchObject({ statusCode: 422 });
    mocks.userFindByIdAndUpdate.mockReturnValueOnce(selected(null));
    await expect(app.inject({ method: "PUT", url: "/v1/users/me/preferences", payload: { preferences: {} } })).resolves.toMatchObject({ statusCode: 404 });
  });
});
