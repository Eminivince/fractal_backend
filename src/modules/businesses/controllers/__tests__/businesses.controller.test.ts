import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  getIssuerBusiness: vi.fn(),
  listBusinessDocuments: vi.fn(),
  listBusinessesForUser: vi.fn(),
  listBusinessUsers: vi.fn(),
  registerIssuerBusiness: vi.fn(),
  requireRole: vi.fn(),
  retrieveBusinessDocument: vi.fn(),
  reviewBusinessKybStatus: vi.fn(),
  serialize: vi.fn((value: unknown) => value),
  submitIssuerBusinessKyb: vi.fn(),
  updateBusinessProfile: vi.fn(),
  updatePayoutBankAccount: vi.fn(),
  uploadBusinessDocument: vi.fn(),
}));

vi.mock("../../../../middleware/role-guard.js", () => ({ requireRole: mocks.requireRole }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../services/businesses.service.js", () => ({
  getIssuerBusiness: mocks.getIssuerBusiness,
  listBusinessDocuments: mocks.listBusinessDocuments,
  listBusinessesForUser: mocks.listBusinessesForUser,
  listBusinessUsers: mocks.listBusinessUsers,
  registerIssuerBusiness: mocks.registerIssuerBusiness,
  retrieveBusinessDocument: mocks.retrieveBusinessDocument,
  reviewBusinessKybStatus: mocks.reviewBusinessKybStatus,
  submitIssuerBusinessKyb: mocks.submitIssuerBusinessKyb,
  updateBusinessProfile: mocks.updateBusinessProfile,
  updatePayoutBankAccount: mocks.updatePayoutBankAccount,
  uploadBusinessDocument: mocks.uploadBusinessDocument,
}));

import { createBusinessController } from "../businesses.controller.js";

const admin = { userId: "admin-1", role: "admin" };
const issuer = { userId: "issuer-1", role: "issuer" };
const request = (body: unknown = {}, extra: Record<string, unknown> = {}) => ({ body, params: {}, query: {}, authUser: admin, ...extra }) as any;

const registration = {
  legalName: "Fractal Assets", businessType: "issuer", registrationNumber: "RC-100", summary: "A regulated real-world asset issuer.", contactEmail: "team@example.test", contactPhone: "+2348012345678",
  address: { country: "Nigeria", state: "Lagos", city: "Lagos", addressLine1: "1 Market Street" },
  representative: { fullName: "Ada Owner", title: "Director", email: "ada@example.test", phone: "+2348012345678" },
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined);
  mocks.requireRole.mockReturnValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
});

describe("business controller", () => {
  it("lists businesses and returns the issuer business", async () => {
    const controller = createBusinessController({} as any);
    mocks.listBusinessesForUser.mockResolvedValueOnce({ data: [{ id: "business-1" }], total: 1 });
    mocks.getIssuerBusiness.mockResolvedValueOnce({ id: "business-1" });

    await expect(controller.listBusinesses(request({}, { query: { name: "Fractal", page: "2", limit: "5" } }))).resolves.toEqual({ data: [{ id: "business-1" }], total: 1 });
    await expect(controller.getMyBusiness(request({}, { authUser: issuer }))).resolves.toEqual({ id: "business-1" });
    expect(mocks.authorize).toHaveBeenCalledWith(admin, "read", "business");
    expect(mocks.requireRole).toHaveBeenCalledWith(issuer, "issuer");
    expect(mocks.listBusinessesForUser).toHaveBeenCalledWith(admin, { name: "Fractal", page: 2, limit: 5 });
  });

  it("registers an issuer business and submits KYB", async () => {
    const controller = createBusinessController({ name: "app" } as any);
    mocks.registerIssuerBusiness.mockResolvedValueOnce({ token: "session-token", business: { id: "business-1" }, user: { id: "issuer-1" } });
    mocks.submitIssuerBusinessKyb.mockResolvedValueOnce({ id: "business-1", kybStatus: "submitted" });

    await expect(controller.registerBusiness(request(registration, { authUser: issuer }))).resolves.toEqual({ token: "session-token", business: { id: "business-1" }, user: { id: "issuer-1" } });
    await expect(controller.submitMyKyb(request({}, { authUser: issuer }))).resolves.toEqual({ id: "business-1", kybStatus: "submitted" });
    expect(mocks.registerIssuerBusiness).toHaveBeenCalledWith(expect.objectContaining({ name: "app" }), issuer, registration);
    expect(mocks.submitIssuerBusinessKyb).toHaveBeenCalledWith(issuer);
  });

  it("lists, uploads, and retrieves business documents", async () => {
    const controller = createBusinessController({} as any);
    mocks.listBusinessDocuments.mockResolvedValueOnce([{ id: "document-1" }]);
    mocks.uploadBusinessDocument.mockResolvedValueOnce({ id: "document-2" });
    mocks.retrieveBusinessDocument.mockResolvedValueOnce({ doc: { filename: "report.pdf", mimeType: "application/pdf" }, buffer: Buffer.from("pdf") });
    const headers: Record<string, string | number> = {};
    const reply = { header: vi.fn((name: string, value: string | number) => { headers[name] = value; }), send: vi.fn((value: unknown) => value), redirect: vi.fn() } as any;

    await expect(controller.listDocuments(request({}, { params: { id: "business-1" } }))).resolves.toEqual([{ id: "document-1" }]);
    await expect(controller.uploadDocument(request({ type: "financials", filename: "report.pdf", contentBase64: "cGRmLWJ5dGVz" }, { params: { id: "business-1" } }))).resolves.toEqual({ id: "document-2" });
    await expect(controller.retrieveDocument(request({}, { params: { id: "business-1", docId: "document-1" } }), reply)).resolves.toEqual(Buffer.from("pdf"));
    expect(headers).toEqual({ "Content-Type": "application/pdf", "Content-Disposition": "attachment; filename=\"report.pdf\"", "Content-Length": 3 });
    expect(mocks.retrieveBusinessDocument).toHaveBeenCalledWith(admin, "business-1", "document-1");
  });

  it("redirects a document request when storage supplies a signed URL", async () => {
    const controller = createBusinessController({} as any);
    mocks.retrieveBusinessDocument.mockResolvedValueOnce({ doc: {}, buffer: Buffer.alloc(0), redirectUrl: "https://storage.example.test/document" });
    const reply = { redirect: vi.fn() } as any;

    await controller.retrieveDocument(request({}, { params: { id: "business-1", docId: "document-1" } }), reply);
    expect(reply.redirect).toHaveBeenCalledWith("https://storage.example.test/document", 302);
  });

  it("uses a safe binary content type when a stored document has no MIME type", async () => {
    const controller = createBusinessController({} as any);
    mocks.retrieveBusinessDocument.mockResolvedValueOnce({ doc: { filename: "archive" }, buffer: Buffer.from("data") });
    const headers: Record<string, string | number> = {};
    const reply = { header: vi.fn((name: string, value: string | number) => { headers[name] = value; }), send: vi.fn((value: unknown) => value) } as any;

    await controller.retrieveDocument(request({}, { params: { id: "business-1", docId: "document-1" } }), reply);
    expect(headers["Content-Type"]).toBe("application/octet-stream");
  });

  it("reviews KYB and updates an administrator business profile", async () => {
    const controller = createBusinessController({} as any);
    mocks.reviewBusinessKybStatus.mockResolvedValueOnce({ id: "business-1", kybStatus: "approved" });
    mocks.updateBusinessProfile.mockResolvedValueOnce({ id: "business-1", riskTier: "high" });

    await expect(controller.reviewKybStatus(request({ status: "approved", notes: "Verified" }, { params: { id: "business-1" } }))).resolves.toMatchObject({ kybStatus: "approved" });
    await expect(controller.updateBusiness(request({ riskTier: "high", status: "disabled" }, { params: { id: "business-1" } }))).resolves.toMatchObject({ riskTier: "high" });
    expect(mocks.requireRole).toHaveBeenCalledWith(admin, "admin");
    expect(mocks.updateBusinessProfile).toHaveBeenCalledWith(admin, "business-1", { riskTier: "high", status: "disabled" });
  });

  it("limits issuer updates to issuer-safe fields and returns users and payout details", async () => {
    const controller = createBusinessController({} as any);
    mocks.updateBusinessProfile.mockResolvedValueOnce({ id: "business-1", summary: "Updated issuer company summary." });
    mocks.listBusinessUsers.mockResolvedValueOnce([{ id: "issuer-1" }]);
    mocks.updatePayoutBankAccount.mockResolvedValueOnce({ id: "business-1", payoutBankAccount: { bankName: "GTBank" } });

    await expect(controller.updateBusiness(request({ summary: "Updated issuer company summary." }, { authUser: issuer, params: { id: "business-1" } }))).resolves.toMatchObject({ summary: "Updated issuer company summary." });
    await expect(controller.listUsers(request({}, { params: { id: "business-1" } }))).resolves.toEqual([{ id: "issuer-1" }]);
    await expect(controller.updatePayoutBankAccount(request({ bankName: "GTBank", bankCode: "058", accountNumber: "1234567890", accountName: "Fractal Assets" }, { params: { id: "business-1" } }))).resolves.toMatchObject({ payoutBankAccount: { bankName: "GTBank" } });
    expect(mocks.updateBusinessProfile).toHaveBeenCalledWith(issuer, "business-1", { summary: "Updated issuer company summary." });
    expect(mocks.listBusinessUsers).toHaveBeenCalledWith(admin, "business-1");
    expect(mocks.updatePayoutBankAccount).toHaveBeenCalledWith(admin, "business-1", { bankName: "GTBank", bankCode: "058", accountNumber: "1234567890", accountName: "Fractal Assets" });
  });
});
