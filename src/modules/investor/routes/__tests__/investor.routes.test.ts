import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  profileFind: vi.fn(), profileCount: vi.fn(), profileFindOne: vi.fn(), profileFindOneAndUpdate: vi.fn(),
  userById: vi.fn(), userUpdate: vi.fn(), authorize: vi.fn(), audit: vi.fn(), serialize: vi.fn((value: unknown) => value),
  paystackRecipient: vi.fn(), persist: vi.fn(), retrieve: vi.fn(), notify: vi.fn(), applicant: vi.fn(), accessToken: vi.fn(),
  env: { PAYSTACK_ENABLED: false, SUMSUB_ENABLED: false, SUMSUB_LEVEL_NAME: "basic" },
}));
vi.mock("../../../../db/models.js", () => ({ InvestorProfileModel: { find: mocks.profileFind, countDocuments: mocks.profileCount, findOne: mocks.profileFindOne, findOneAndUpdate: mocks.profileFindOneAndUpdate }, UserModel: { findById: mocks.userById, findByIdAndUpdate: mocks.userUpdate } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.audit }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/paystack.js", () => ({ createPaystackTransferRecipient: mocks.paystackRecipient }));
vi.mock("../../../../services/storage.js", () => ({ persistKycBinary: mocks.persist, retrieveFile: mocks.retrieve }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notify }));
vi.mock("../../../../services/sumsub.js", () => ({ createApplicant: mocks.applicant, generateAccessToken: mocks.accessToken }));

import { investorRoutes } from "../investor.routes.js";

let role = "investor";
let app: ReturnType<typeof Fastify>;

function lean(value: unknown) { return { lean: vi.fn().mockResolvedValue(value) }; }
function page(value: unknown) { return { sort: vi.fn(() => ({ skip: vi.fn(() => ({ limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })) })) }; }
function profile(overrides: Record<string, unknown> = {}) {
  return { _id: "profile-1", userId: "investor-1", kycStatus: "approved", eligibility: "retail", documents: [], save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }), ...overrides } as any;
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  role = "investor"; mocks.env.PAYSTACK_ENABLED = false; mocks.env.SUMSUB_ENABLED = false;
  mocks.authorize.mockReturnValue(undefined); mocks.audit.mockResolvedValue(undefined); mocks.notify.mockResolvedValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); mocks.userUpdate.mockResolvedValue(undefined);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "investor-1", role }; });
  await app.register(investorRoutes);
});
afterEach(async () => { await app.close(); });

describe("investor profile routes", () => {
  it("lists profiles inside the investor scope and returns the authenticated profile", async () => {
    mocks.profileFind.mockReturnValueOnce(page([{ _id: "profile-1", userId: "investor-1" }])); mocks.profileCount.mockResolvedValueOnce(1);
    const list = await app.inject({ method: "GET", url: "/v1/investor/profiles?userId=other-user&kycStatus=approved" });
    expect(list.statusCode).toBe(200);
    expect(mocks.profileFind).toHaveBeenCalledWith({ userId: "investor-1", kycStatus: "approved" });
    mocks.profileFindOne.mockReturnValueOnce(lean({ _id: "profile-1", userId: "investor-1" }));
    await expect(app.inject({ method: "GET", url: "/v1/investor/profile" })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("records a bank account and a traceable audit event without provider credentials", async () => {
    const current = profile(); mocks.profileFindOne.mockResolvedValueOnce(current);
    const response = await app.inject({ method: "POST", url: "/v1/investor/bank-account", payload: { accountNumber: "0123456789", bankCode: "058", accountName: "Ada Lovelace" } });
    expect(response.statusCode).toBe(200); expect(current.bankAccount).toMatchObject({ accountNumber: "0123456789", bankCode: "058", recipientCode: undefined, verifiedAt: expect.any(Date) });
    expect(current.save).toHaveBeenCalledOnce(); expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "BankAccountRegistered", notes: "bank:058" }));
  });

  it("uses the payment provider only when it is enabled and returns its verification failure safely", async () => {
    mocks.env.PAYSTACK_ENABLED = true; const current = profile(); mocks.profileFindOne.mockResolvedValueOnce(current); mocks.paystackRecipient.mockResolvedValueOnce({ recipient_code: "RCP-1" });
    await expect(app.inject({ method: "POST", url: "/v1/investor/bank-account", payload: { accountNumber: "0123456789", bankCode: "058", accountName: "Ada Lovelace" } })).resolves.toMatchObject({ statusCode: 200 });
    expect(current.bankAccount.recipientCode).toBe("RCP-1");
    mocks.profileFindOne.mockResolvedValueOnce(profile()); mocks.paystackRecipient.mockRejectedValueOnce(new Error("Account not found"));
    const failed = await app.inject({ method: "POST", url: "/v1/investor/bank-account", payload: { accountNumber: "0123456789", bankCode: "058", accountName: "Ada Lovelace" } });
    expect(failed.statusCode).toBe(422); expect(failed.json().message).toContain("Bank account verification failed");
  });

  it("shows, submits, and independently verifies accreditation evidence", async () => {
    const current = profile({ accreditationStatus: "unverified", accreditationDocs: [] }); mocks.profileFindOne.mockReturnValueOnce(lean(current));
    expect((await app.inject({ method: "GET", url: "/v1/investor/accreditation/status" })).json()).toEqual({ accreditationStatus: "unverified", accreditationDocs: [] });
    mocks.profileFindOne.mockResolvedValueOnce(current);
    const submitted = await app.inject({ method: "POST", url: "/v1/investor/accreditation/submit", payload: { docs: [{ docType: "income", storageKey: "kyc/income.pdf", expiresAt: "2027-01-01" }] } });
    expect(submitted.statusCode).toBe(200); expect(current.accreditationStatus).toBe("pending"); expect(current.accreditationDocs[0]).toMatchObject({ docType: "income", storageKey: "kyc/income.pdf", expiresAt: expect.any(Date) });
    role = "admin"; const verification = profile({ userId: "investor-2", accreditationStatus: "pending" }); mocks.profileFindOne.mockResolvedValueOnce(verification);
    const verified = await app.inject({ method: "POST", url: "/v1/investor/accreditation/investor-2/verify", payload: { decision: "verified", notes: "Evidence confirmed" } });
    expect(verified.statusCode).toBe(200); expect(verification.accreditationStatus).toBe("verified"); expect(verification.accreditationVerifiedBy).toBe("investor-1");
  });

  it("rejects non-investors and missing profile records", async () => {
    role = "issuer"; await expect(app.inject({ method: "GET", url: "/v1/investor/profile" })).resolves.toMatchObject({ statusCode: 403 });
    role = "investor"; mocks.profileFindOne.mockReturnValueOnce(lean(null)); await expect(app.inject({ method: "GET", url: "/v1/investor/profile" })).resolves.toMatchObject({ statusCode: 404 });
    await expect(app.inject({ method: "POST", url: "/v1/investor/bank-account", payload: { accountNumber: "bad", bankCode: "x", accountName: "x" } })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("submits KYC, links the profile to the user, and uploads persisted evidence", async () => {
    const current = profile(); mocks.profileFindOneAndUpdate.mockResolvedValueOnce(current);
    const submitted = await app.inject({ method: "POST", url: "/v1/investor/kyc/submit", payload: { eligibility: "sophisticated", documents: [{ type: "passport", filename: "passport.pdf" }] } });
    expect(submitted.statusCode).toBe(200); expect(current.kycStatus).toBe("in_review"); expect(current.eligibility).toBe("sophisticated"); expect(mocks.userUpdate).toHaveBeenCalledWith("investor-1", { $set: { investorProfileId: "profile-1" } });
    const documentProfile = profile({ documents: [] }); mocks.profileFindOneAndUpdate.mockResolvedValueOnce(documentProfile); mocks.persist.mockResolvedValueOnce({ storageKey: "kyc/investor-1/passport.pdf" });
    const uploaded = await app.inject({ method: "POST", url: "/v1/investor/kyc/documents", payload: { type: "passport", filename: "passport.pdf", contentBase64: "cGFzc3BvcnQ=" , mimeType: "application/pdf" } });
    expect(uploaded.statusCode).toBe(200); expect(documentProfile.documents).toHaveLength(1); expect(documentProfile.documents[0]).toMatchObject({ type: "passport", storageKey: "kyc/investor-1/passport.pdf" });
  });

  it("returns persisted KYC evidence only to its investor or an identified operator", async () => {
    const document = { docId: "doc-1", filename: "passport.pdf", mimeType: "application/pdf", storageKey: "kyc/investor-1/passport.pdf" };
    mocks.profileFindOne.mockReturnValueOnce(lean({ userId: "investor-1", documents: [document] })); mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("file") });
    const own = await app.inject({ method: "GET", url: "/v1/investor/kyc/documents/doc-1" });
    expect(own.statusCode).toBe(200); expect(own.headers["content-type"]).toContain("application/pdf"); expect(own.payload).toBe("file");
    role = "operator"; mocks.profileFindOne.mockReturnValueOnce(lean({ userId: "investor-2", documents: [document] })); mocks.retrieve.mockResolvedValueOnce({ redirectUrl: "https://files.example.test/temporary" });
    const operator = await app.inject({ method: "GET", url: "/v1/investor/kyc/documents/doc-1?investorUserId=investor-2" });
    expect(operator.statusCode).toBe(302); expect(operator.headers.location).toBe("https://files.example.test/temporary");
    await expect(app.inject({ method: "GET", url: "/v1/investor/kyc/documents/doc-1" })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("allows an operator to approve or reject only investor KYC profiles", async () => {
    role = "operator"; mocks.userById.mockReturnValueOnce(lean({ _id: "investor-2", role: "investor" })); mocks.profileFindOneAndUpdate.mockReturnValueOnce(lean({ _id: "profile-2", kycStatus: "approved" }));
    const approved = await app.inject({ method: "POST", url: "/v1/investor/kyc/approve", payload: { investorUserId: "investor-2" } });
    expect(approved.statusCode).toBe(200); expect(mocks.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "KYCApproved" }));
    mocks.userById.mockReturnValueOnce(lean({ _id: "investor-2", role: "investor" })); mocks.profileFindOneAndUpdate.mockReturnValueOnce(lean({ _id: "profile-2", kycStatus: "rejected" }));
    const rejected = await app.inject({ method: "POST", url: "/v1/investor/kyc/reject", payload: { investorUserId: "investor-2", reason: "Document image is unreadable" } });
    expect(rejected.statusCode).toBe(200); expect(mocks.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "KYCRejected" }));
    mocks.userById.mockReturnValueOnce(lean({ _id: "issuer-2", role: "issuer" }));
    await expect(app.inject({ method: "POST", url: "/v1/investor/kyc/approve", payload: { investorUserId: "issuer-2" } })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("starts hosted Sumsub verification only when it is enabled and persists its applicant binding", async () => {
    const disabled = await app.inject({ method: "POST", url: "/v1/investor/kyc/sumsub/access-token" });
    expect(disabled.statusCode).toBe(503);
    mocks.env.SUMSUB_ENABLED = true; const current = profile({ kycStatus: "draft" }); mocks.profileFindOneAndUpdate.mockResolvedValueOnce(current); mocks.userById.mockResolvedValueOnce({ email: "investor@example.test" }); mocks.applicant.mockResolvedValueOnce({ id: "sumsub-1" }); mocks.accessToken.mockResolvedValueOnce({ token: "sumsub-token" });
    const result = await app.inject({ method: "POST", url: "/v1/investor/kyc/sumsub/access-token" });
    expect(result.statusCode).toBe(200); expect(result.json()).toEqual({ token: "sumsub-token", applicantId: "sumsub-1", externalUserId: "investor-1" }); expect(current.kycStatus).toBe("in_review"); expect(current.save).toHaveBeenCalledOnce();
  });
});
