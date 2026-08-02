import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), findById: vi.fn(), findByIdAndUpdate: vi.fn(), findByIdAndDelete: vi.fn(), userCreate: vi.fn(), investorUpsert: vi.fn(), professionalCreate: vi.fn(), bcryptHash: vi.fn(), bcryptCompare: vi.fn(), project: vi.fn(), pgCreate: vi.fn(), pgByEmail: vi.fn(), pgById: vi.fn(), sendVerify: vi.fn(), env: { AUTH_IDENTITY_AUTHORITY: "legacy", NODE_ENV: "development" } }));
const { ProjectionError, ConflictError, ContentError } = vi.hoisted(() => ({ ProjectionError: class ProjectionError extends Error {}, ConflictError: class ConflictError extends Error {}, ContentError: class ContentError extends Error { constructor(readonly code: string, message: string) { super(message); } } }));
vi.mock("bcrypt", () => ({ default: { hash: mocks.bcryptHash, compare: mocks.bcryptCompare } }));
vi.mock("../../../../db/models.js", () => ({ UserModel: { findOne: mocks.findOne, findById: mocks.findById, findByIdAndUpdate: mocks.findByIdAndUpdate, findByIdAndDelete: mocks.findByIdAndDelete, create: mocks.userCreate }, InvestorProfileModel: { findOneAndUpdate: mocks.investorUpsert }, ProfessionalModel: { create: mocks.professionalCreate } }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../platform/postgres-identities.js", () => ({ projectLegacyIdentity: mocks.project, PostgresIdentityProjectionError: ProjectionError, createPostgresAuthIdentity: mocks.pgCreate, getPostgresAuthIdentityByEmail: mocks.pgByEmail, getPostgresAuthIdentityById: mocks.pgById, PostgresAuthIdentityConflictError: ConflictError }));
vi.mock("../account-security.service.js", () => ({ sendEmailVerification: mocks.sendVerify }));
vi.mock("../../../../platform/postgres-platform-content.js", () => ({ PlatformContentError: ContentError }));
import { authenticateByPassword, getAuthUserById, registerAuthUser, syncAuthUser } from "../auth.service.js";

const login = { email: "MEMBER@example.test", password: "ValidPassword1" } as any;
const register = { email: "MEMBER@example.test", name: "Member", role: "investor", password: "ValidPassword1" } as any;
function user(overrides: Record<string, unknown> = {}) { return { _id: "user-1", email: "member@example.test", name: "Member", role: "investor", status: "active", passwordHash: "hash", emailVerified: true, toObject: () => ({ _id: "user-1", email: "member@example.test", name: "Member", role: "investor", status: "active", passwordHash: "hash", emailVerified: true }), ...overrides } as any; }
function lean(value: unknown) { return { lean: vi.fn().mockResolvedValue(value) }; }
const pgIdentity = { id: "identity-1", email: "member@example.test", legalName: "Member", role: "investor", status: "active", passwordHash: "hash", emailVerifiedAt: new Date(), credentialInvalidatedAt: null, createdAt: new Date(), updatedAt: new Date() } as any;
beforeEach(() => {
  for (const mock of Object.values(mocks)) if (typeof mock === "function") mock.mockReset(); Object.assign(mocks.env, { AUTH_IDENTITY_AUTHORITY: "legacy", NODE_ENV: "development" });
  mocks.bcryptHash.mockResolvedValue("new-hash"); mocks.bcryptCompare.mockResolvedValue(true); mocks.project.mockResolvedValue(undefined); mocks.sendVerify.mockResolvedValue(undefined); mocks.findOne.mockReturnValue(lean(null)); mocks.findById.mockReturnValue(lean(user())); mocks.findByIdAndUpdate.mockReturnValue(lean(user({ investorProfileId: "profile-1" }))); mocks.investorUpsert.mockReturnValue(lean({ _id: "profile-1" })); mocks.userCreate.mockResolvedValue(user()); mocks.professionalCreate.mockResolvedValue({ _id: "professional-1" }); mocks.findByIdAndDelete.mockResolvedValue(undefined);
});

describe("authentication service", () => {
  it("authenticates PostgreSQL and legacy credentials only when active and verified", async () => {
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres"; mocks.pgByEmail.mockResolvedValueOnce(pgIdentity);
    await expect(authenticateByPassword(login)).resolves.toMatchObject({ _id: "identity-1", emailVerified: true });
    mocks.pgByEmail.mockResolvedValueOnce({ ...pgIdentity, emailVerifiedAt: null }); await expect(authenticateByPassword(login)).rejects.toMatchObject({ statusCode: 403 });
    mocks.pgByEmail.mockResolvedValueOnce({ ...pgIdentity, status: "disabled" }); await expect(authenticateByPassword(login)).rejects.toMatchObject({ statusCode: 401 });
    mocks.pgByEmail.mockResolvedValueOnce(pgIdentity); mocks.bcryptCompare.mockResolvedValueOnce(false); await expect(authenticateByPassword(login)).rejects.toMatchObject({ statusCode: 401 });
    mocks.env.AUTH_IDENTITY_AUTHORITY = "legacy"; mocks.findOne.mockReturnValueOnce(lean(user({ emailVerified: false }))); await expect(authenticateByPassword(login)).rejects.toMatchObject({ statusCode: 403 });
    mocks.findOne.mockReturnValueOnce(lean(user())); mocks.bcryptCompare.mockResolvedValueOnce(false); await expect(authenticateByPassword(login)).rejects.toMatchObject({ statusCode: 401 });
    mocks.findOne.mockReturnValueOnce(lean(user({ passwordHash: undefined }))); await expect(authenticateByPassword(login)).rejects.toMatchObject({ statusCode: 401 });
    mocks.findOne.mockReturnValueOnce(lean(user())); mocks.project.mockRejectedValueOnce(new Error("projection unknown")); await expect(authenticateByPassword(login)).rejects.toThrow("projection unknown");
  });

  it("registers PostgreSQL identities and maps identity authority errors safely", async () => {
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres"; mocks.pgCreate.mockResolvedValueOnce(pgIdentity);
    await expect(registerAuthUser(register, { ip: "127.0.0.1" })).resolves.toMatchObject({ _id: "identity-1" });
    expect(mocks.pgCreate).toHaveBeenCalledWith(expect.objectContaining({ email: "member@example.test", passwordHash: "new-hash" }));
    mocks.pgCreate.mockRejectedValueOnce(new ConflictError("conflict")); await expect(registerAuthUser(register, {})).rejects.toMatchObject({ statusCode: 409 });
    mocks.pgCreate.mockRejectedValueOnce(new ProjectionError("down")); await expect(registerAuthUser(register, {})).rejects.toMatchObject({ statusCode: 503 });
    mocks.pgCreate.mockRejectedValueOnce(new ContentError("unavailable", "Terms unavailable")); await expect(registerAuthUser(register, {})).rejects.toMatchObject({ statusCode: 503 });
  });

  it("registers legacy investor and professional accounts with linked records", async () => {
    const investor = user(); mocks.userCreate.mockResolvedValueOnce(investor);
    await expect(registerAuthUser(register, {})).resolves.toMatchObject({ investorProfileId: "profile-1" });
    expect(mocks.sendVerify).toHaveBeenCalledWith("user-1");
    const professional = user({ role: "professional" }); mocks.userCreate.mockResolvedValueOnce(professional);
    mocks.findByIdAndUpdate.mockReturnValueOnce(lean(user({ role: "professional", professionalId: "professional-1" })));
    await expect(registerAuthUser({ ...register, role: "professional", professionalCategory: "valuer" } as any, {})).resolves.toMatchObject({ professionalId: "professional-1" });
    expect(mocks.professionalCreate).toHaveBeenCalledWith(expect.objectContaining({ category: "valuer", onboardingStatus: "draft" }));
    mocks.userCreate.mockResolvedValueOnce(user({ role: "professional" })); await expect(registerAuthUser({ ...register, role: "professional" } as any, {})).rejects.toMatchObject({ statusCode: 422 });
    mocks.findOne.mockReturnValueOnce(lean(user())); await expect(registerAuthUser(register, {})).rejects.toMatchObject({ statusCode: 409 });
    mocks.userCreate.mockResolvedValueOnce(user()); mocks.investorUpsert.mockReturnValueOnce(lean(null)); mocks.findById.mockReturnValueOnce(lean(user({ investorProfileId: undefined })));
    await expect(registerAuthUser(register, {})).resolves.toMatchObject({ _id: "user-1" });
    mocks.userCreate.mockResolvedValueOnce(user()); mocks.investorUpsert.mockReturnValueOnce(lean(null)); mocks.findById.mockReturnValueOnce(lean(null));
    await expect(registerAuthUser(register, {})).rejects.toMatchObject({ statusCode: 404 });
  });

  it("removes a half-created legacy account when identity projection fails", async () => {
    mocks.userCreate.mockResolvedValueOnce(user()); mocks.project.mockRejectedValueOnce(new ProjectionError("down"));
    await expect(registerAuthUser(register, {})).rejects.toMatchObject({ statusCode: 503 }); expect(mocks.findByIdAndDelete).toHaveBeenCalledWith("user-1");
  });

  it("synchronizes only safe legacy account state and blocks privileged or linked role changes", async () => {
    mocks.findOne.mockReturnValueOnce(lean(null)); await expect(syncAuthUser({ email: "new@example.test", name: "New" } as any)).rejects.toMatchObject({ statusCode: 422 });
    mocks.findOne.mockReturnValueOnce(lean(null)); await expect(syncAuthUser({ email: "new@example.test", name: "New", role: "investor" } as any)).resolves.toMatchObject({ role: "investor" });
    mocks.findOne.mockReturnValueOnce(lean(null)); mocks.userCreate.mockResolvedValueOnce(user()); mocks.project.mockRejectedValueOnce(new Error("projection write failed")); await expect(syncAuthUser({ email: "retry@example.test", name: "Retry", role: "investor" } as any)).rejects.toThrow("projection write failed"); expect(mocks.findByIdAndDelete).toHaveBeenCalledWith("user-1");
    mocks.findOne.mockReturnValueOnce(lean(user({ status: "disabled" }))); await expect(syncAuthUser({ email: "member@example.test", name: "Member" } as any)).rejects.toMatchObject({ statusCode: 403 });
    mocks.findOne.mockReturnValueOnce(lean(user({ role: "admin" }))); await expect(syncAuthUser({ email: "member@example.test", name: "Member", role: "issuer" } as any)).resolves.toMatchObject({ role: "admin" });
    mocks.findOne.mockReturnValueOnce(lean(user({ role: "investor", investorProfileId: "profile-1" }))); await expect(syncAuthUser({ email: "member@example.test", name: "Member", role: "issuer" } as any)).rejects.toMatchObject({ statusCode: 409 });
    mocks.findOne.mockReturnValueOnce(lean(user({ role: "investor" }))); await expect(syncAuthUser({ email: "member@example.test", name: "Renamed", role: "issuer" } as any)).resolves.toMatchObject({ role: "investor" });
    mocks.findOne.mockReturnValueOnce(lean(user())); await expect(syncAuthUser({ email: "member@example.test", name: "Member" } as any)).resolves.toMatchObject({ role: "investor" });
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres"; await expect(syncAuthUser({ email: "member@example.test", name: "Member" } as any)).rejects.toMatchObject({ statusCode: 410 });
  });

  it("gets users from the configured authority and reports missing records", async () => {
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres"; mocks.pgById.mockResolvedValueOnce(pgIdentity); await expect(getAuthUserById("identity-1")).resolves.toMatchObject({ _id: "identity-1" });
    mocks.pgById.mockResolvedValueOnce(null); await expect(getAuthUserById("missing")).rejects.toMatchObject({ statusCode: 404 });
    mocks.env.AUTH_IDENTITY_AUTHORITY = "legacy"; mocks.findById.mockReturnValueOnce(lean(null)); await expect(getAuthUserById("missing")).rejects.toMatchObject({ statusCode: 404 });
    mocks.findById.mockReturnValueOnce(lean(user())); await expect(getAuthUserById("user-1")).resolves.toMatchObject({ _id: "user-1" });
  });
});
