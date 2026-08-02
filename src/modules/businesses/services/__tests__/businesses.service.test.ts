import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindById = vi.hoisted(() => vi.fn());
const userFind = vi.hoisted(() => vi.fn());
const businessFindById = vi.hoisted(() => vi.fn());
const businessFindByIdAndUpdate = vi.hoisted(() => vi.fn());
const businessFind = vi.hoisted(() => vi.fn());
const businessCount = vi.hoisted(() => vi.fn());
const businessCreate = vi.hoisted(() => vi.fn());
const appendEvent = vi.hoisted(() => vi.fn());
const runInTransaction = vi.hoisted(() => vi.fn());
const persistBusinessBinary = vi.hoisted(() => vi.fn());
const retrieveFile = vi.hoisted(() => vi.fn());
const createNotificationsFromEvent = vi.hoisted(() => vi.fn());
const assertIssuerBusinessScope = vi.hoisted(() => vi.fn());
const resolvePaystackAccount = vi.hoisted(() => vi.fn());
const validateUboCoverage = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({} as Record<string, unknown>));

vi.mock("../../../../db/models.js", () => ({
  UserModel: { findById: userFindById, find: userFind },
  BusinessModel: {
    findById: businessFindById,
    findByIdAndUpdate: businessFindByIdAndUpdate,
    find: businessFind,
    countDocuments: businessCount,
    create: businessCreate,
  },
}));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction }));
vi.mock("../../../../services/storage.js", () => ({
  persistBusinessBinary,
  retrieveFile,
}));
vi.mock("../../../../services/notifications.js", () => ({
  createNotificationsFromEvent,
}));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope }));
vi.mock("../../../../config/env.js", () => ({ env }));
vi.mock("../../../../services/paystack.js", () => ({ resolvePaystackAccount }));
vi.mock("../../../../utils/ubo-validation.js", () => ({ validateUboCoverage }));

import {
  addDirector,
  addShareholder,
  addUbo,
  getIssuerBusiness,
  listBusinessUsers,
  listBusinessesForUser,
  listBusinessDocuments,
  removeDirector,
  removeShareholder,
  removeUbo,
  retrieveBusinessDocument,
  reviewBusinessKybStatus,
  registerIssuerBusiness,
  submitIssuerBusinessKyb,
  suspendBusiness,
  unsuspendBusiness,
  updateBusinessProfile,
  updatePayoutBankAccount,
  uploadBusinessDocument,
} from "../businesses.service.js";

const authUser = { userId: "user-1", role: "issuer", businessId: "business-1" } as any;
const chain = (value: unknown) => ({
  select: vi.fn().mockReturnThis(),
  sort: vi.fn().mockReturnThis(),
  skip: vi.fn().mockReturnThis(),
  limit: vi.fn().mockReturnThis(),
  lean: vi.fn().mockResolvedValue(value),
});

function completeProfile() {
  return {
    legalName: "Fractal Issuer Limited",
    registrationNumber: "RC-1",
    contact: { email: "legal@fractal.test", phone: "+2348000000000" },
    address: { country: "NG", state: "Lagos", city: "Lagos", addressLine1: "1 Test Way" },
    representative: { fullName: "Ada Owner", email: "ada@fractal.test", phone: "+2348000000000" },
  };
}

function businessFixture(overrides: Record<string, unknown> = {}) {
  const business: any = {
    _id: "business-1",
    registrationProfile: completeProfile(),
    ubos: [{ _id: "ubo-1", fullName: "Ada Owner", ownershipPct: 100, controlBasis: "shares" }],
    directors: [{ _id: "director-1", fullName: "Ada Owner" }],
    shareholders: [{ _id: "shareholder-1", name: "Ada Owner", ownershipPct: 100 }],
    documents: [
      { _id: "doc-1", type: "certificate_of_incorporation" },
      { _id: "doc-2", type: "tax_identification_document" },
      { _id: "doc-3", type: "proof_of_registered_address" },
      { _id: "doc-4", type: "director_id_document" },
    ],
    kybStatus: "draft",
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(function (this: any) { return { ...this }; }),
    ...overrides,
  };
  return business;
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.keys(env).forEach((key) => delete env[key]);
  runInTransaction.mockImplementation(async (work: (session: unknown) => Promise<unknown>) => work({}));
  validateUboCoverage.mockReturnValue({ valid: true, errors: [] });
});

describe("business service read paths", () => {
  it("limits issuer results to the issuer business", async () => {
    userFindById.mockReturnValue(chain({ businessId: "business-1" }));
    businessFind.mockReturnValue(chain([{ _id: "business-1" }]));
    businessCount.mockResolvedValue(1);

    await expect(listBusinessesForUser(authUser, { name: "Fractal" })).resolves.toMatchObject({ total: 1, pages: 1 });
    expect(businessFind).toHaveBeenCalledWith({ _id: "business-1", name: { $regex: "Fractal", $options: "i" } });
  });

  it("fails closed when an issuer business is absent", async () => {
    userFindById.mockReturnValue(chain(null));
    const issuerWithoutBusiness = { userId: "user-1", role: "issuer" } as any;
    await expect(listBusinessesForUser(issuerWithoutBusiness)).resolves.toMatchObject({ total: 0 });
    await expect(getIssuerBusiness(issuerWithoutBusiness)).rejects.toThrow("Business not found");
  });

  it("rejects an issuer whose linked business was removed", async () => {
    userFindById.mockReturnValue(chain({ businessId: "business-missing" }));
    businessFindById.mockReturnValueOnce(chain(null));
    await expect(getIssuerBusiness({ userId: "user-1", role: "issuer" } as any)).rejects.toThrow("Business not found");
  });

  it("returns the linked issuer business", async () => {
    const business = { _id: "business-1", name: "Fractal Issuer" };
    userFindById.mockReturnValue(chain({ businessId: "business-1" }));
    businessFindById.mockReturnValueOnce(chain(business));
    await expect(getIssuerBusiness({ userId: "user-1", role: "issuer" } as any)).resolves.toEqual(business);
  });

  it("lists all businesses for an administrator with newest records first", async () => {
    businessFind.mockReturnValue(chain([{ _id: "business-2" }]));
    businessCount.mockResolvedValue(1);
    await expect(listBusinessesForUser({ userId: "admin-1", role: "admin" } as any)).resolves.toMatchObject({ total: 1 });
    expect(businessFind).toHaveBeenCalledWith({});
  });
});

describe("business registration", () => {
  const registration = {
    legalName: "Fractal Issuer Limited",
    tradingName: "Fractal",
    businessType: "spv",
    registrationNumber: "RC-123",
    taxId: "TIN-1",
    incorporationDate: "2024-01-02",
    summary: "A properly registered property issuer business.",
    contactEmail: "legal@fractal.test",
    contactPhone: "+2348000000000",
    address: { country: "NG", state: "Lagos", city: "Lagos", addressLine1: "1 Test Way" },
    representative: { fullName: "Ada Owner", title: "Director", email: "ada@fractal.test", phone: "+2348000000000" },
  };

  it("creates a business, links the owner, audits it, and issues a scoped session token", async () => {
    const user: any = { _id: { toString: () => "user-1" }, role: "issuer", save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ id: "user-1" })) };
    const business = businessFixture({ _id: { toString: () => "business-1" } });
    userFindById.mockResolvedValue(user);
    businessFindById.mockResolvedValueOnce(null);
    businessCreate.mockResolvedValue([business]);
    const app = { jwt: { sign: vi.fn().mockResolvedValue("scoped-token") } } as any;

    await expect(registerIssuerBusiness(app, authUser, registration as any)).resolves.toMatchObject({ token: "scoped-token", business: expect.any(Object) });
    expect(businessCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: "spv_manager", kybStatus: "draft" })]), expect.any(Object));
    expect(user).toMatchObject({ businessRole: "owner" });
    expect(app.jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ businessId: "business-1" }), { expiresIn: "8h" });
  });

  it("resets a rejected registration when its owner resubmits it", async () => {
    const user: any = { _id: { toString: () => "user-1" }, role: "issuer", businessId: "business-1", save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ id: "user-1" })) };
    const business = businessFixture({ kybStatus: "rejected", kybReviewNotes: "Old review", save: vi.fn().mockResolvedValue(undefined) });
    userFindById.mockResolvedValue(user);
    businessFindById.mockResolvedValue(business);
    const app = { jwt: { sign: vi.fn().mockResolvedValue("scoped-token") } } as any;

    await registerIssuerBusiness(app, authUser, registration as any);
    expect(business.kybStatus).toBe("draft");
    expect(business.kybReviewNotes).toBeUndefined();
    expect(business.save).toHaveBeenCalled();
  });

  it("accepts an omitted incorporation date during registration", async () => {
    const user: any = { _id: { toString: () => "user-1" }, role: "issuer", save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ id: "user-1" })) };
    const business = businessFixture({ _id: { toString: () => "business-1" } });
    userFindById.mockResolvedValue(user);
    businessFindById.mockResolvedValueOnce(null);
    businessCreate.mockResolvedValue([business]);
    const app = { jwt: { sign: vi.fn().mockResolvedValue("scoped-token") } } as any;
    const payload = { ...registration, businessType: "issuer", incorporationDate: "" };

    await registerIssuerBusiness(app, authUser, payload as any);
    expect(businessCreate).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ type: "property_owner", registrationProfile: expect.objectContaining({ incorporationDate: undefined }) })]),
      expect.objectContaining({ session: expect.anything() }),
    );
  });
});

describe("KYB submission", () => {
  function setupSubmission(business: any) {
    userFindById.mockReturnValue({ select: vi.fn().mockResolvedValue({ businessId: "business-1" }) });
    businessFindById.mockResolvedValue(business);
  }

  it("blocks submission before the registration profile is complete", async () => {
    setupSubmission(businessFixture({ registrationProfile: {} }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("Complete business registration");
  });

  it("requires the business representative details before KYB submission", async () => {
    setupSubmission(businessFixture({ registrationProfile: { ...completeProfile(), representative: {} } }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("Complete business registration");
  });

  it("requires a linked business before KYB submission", async () => {
    userFindById.mockReturnValue({ select: vi.fn().mockResolvedValue(null) });
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("Business profile is required before KYB submission");
  });

  it("requires an UBO declaration", async () => {
    setupSubmission(businessFixture({ ubos: [] }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("At least one Ultimate Beneficial Owner");
  });

  it("rejects invalid UBO coverage", async () => {
    setupSubmission(businessFixture());
    validateUboCoverage.mockReturnValue({ valid: false, errors: ["Ownership coverage is incomplete"] });
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("UBO validation failed: Ownership coverage is incomplete");
  });

  it("requires a director and all required KYB documents", async () => {
    setupSubmission(businessFixture({ directors: [] }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("At least one director");

    setupSubmission(businessFixture({ documents: [{ type: "certificate_of_incorporation" }] }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("tax_identification_document");
  });

  it("rejects shareholder totals above one hundred percent", async () => {
    setupSubmission(businessFixture({ shareholders: [{ ownershipPct: 60 }, { ownershipPct: 50 }] }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("exceeds 100%");
  });

  it("requires an UBO chain for an entity shareholder that declares one", async () => {
    setupSubmission(businessFixture({
      ubos: [{ fullName: "Ada Controller", ownershipPct: 100, controlBasis: "voting_rights" }],
      shareholders: [{ name: "Fractal Holdings", ownershipPct: 100, isEntity: true, entityUboChainRequired: true }],
    }));
    await expect(submitIssuerBusinessKyb(authUser)).rejects.toThrow("Entity shareholders with required UBO chains are incomplete: Fractal Holdings");
  });

  it("submits a valid KYB package and clears old review state", async () => {
    const business = businessFixture({
      kybStatus: "rejected",
      registrationApprovedAt: new Date(),
      registrationRejectedAt: new Date(),
      kybReviewedBy: "reviewer-1",
      kybReviewNotes: "Old note",
    });
    setupSubmission(business);

    await expect(submitIssuerBusinessKyb(authUser)).resolves.toMatchObject({ kybStatus: "submitted" });
    expect(business.save).toHaveBeenCalledOnce();
    expect(business.registrationApprovedAt).toBeUndefined();
    expect(business.registrationRejectedAt).toBeUndefined();
    expect(appendEvent).toHaveBeenCalledWith(authUser, expect.objectContaining({ action: "Business KYB submitted" }));
  });
});

describe("KYB reviewer decisions", () => {
  it("does not approve a package with missing approval documents", async () => {
    businessFindById.mockResolvedValue(businessFixture({ documents: [] }));
    await expect(reviewBusinessKybStatus({ userId: "admin-1", role: "admin" } as any, "business-1", { status: "approved" } as any)).rejects.toThrow("missing required documents");
  });

  it("approves a complete package and notifies the business", async () => {
    const business = businessFixture();
    businessFindById.mockResolvedValue(business);
    const reviewer = { userId: "admin-1", role: "admin" } as any;

    await expect(reviewBusinessKybStatus(reviewer, "business-1", { status: "approved", notes: "All checks complete" } as any)).resolves.toMatchObject({ kybStatus: "approved" });
    expect(business.registrationApprovedAt).toBeInstanceOf(Date);
    expect(createNotificationsFromEvent).toHaveBeenCalledWith(reviewer, expect.objectContaining({ action: "KYBApproved" }));
  });

  it("records a rejection and notifies the business", async () => {
    const business = businessFixture();
    businessFindById.mockResolvedValue(business);
    const reviewer = { userId: "admin-1", role: "admin" } as any;

    await reviewBusinessKybStatus(reviewer, "business-1", { status: "rejected", notes: "ID document is unreadable" } as any);
    expect(business.registrationRejectedAt).toBeInstanceOf(Date);
    expect(business.registrationApprovedAt).toBeUndefined();
    expect(createNotificationsFromEvent).toHaveBeenCalledWith(reviewer, expect.objectContaining({ action: "KYBRejected" }));
  });

  it("clears an earlier KYB decision when an administrator returns a package to review", async () => {
    const business = businessFixture({ registrationApprovedAt: new Date(), registrationRejectedAt: new Date() });
    businessFindById.mockResolvedValue(business);
    const reviewer = { userId: "admin-1", role: "admin" } as any;

    await expect(reviewBusinessKybStatus(reviewer, "business-1", { status: "in_review" } as any)).resolves.toMatchObject({ kybStatus: "in_review" });
    expect(business.registrationApprovedAt).toBeUndefined();
    expect(business.registrationRejectedAt).toBeUndefined();
  });
});

describe("business document and ownership changes", () => {
  it("stores uploaded binary content and records the resulting document", async () => {
    const business = businessFixture({ documents: [] });
    businessFindById.mockResolvedValue(business);
    persistBusinessBinary.mockResolvedValue({ storageKey: "businesses/business-1/incorporation.pdf" });

    const result = await uploadBusinessDocument(authUser, "business-1", {
      type: "certificate_of_incorporation",
      filename: "Incorporation.PDF",
      contentBase64: "dGVzdC1jb250ZW50",
      mimeType: "application/pdf",
    } as any);

    expect(persistBusinessBinary).toHaveBeenCalledWith(expect.objectContaining({ businessId: "business-1" }));
    expect(result).toMatchObject({ storageKey: "businesses/business-1/incorporation.pdf" });
    expect(appendEvent).toHaveBeenCalledWith(authUser, expect.objectContaining({ action: "Business KYB document uploaded" }));
  });

  it("does not allow ownership totals above one hundred percent", async () => {
    const business = businessFixture({ shareholders: [{ ownershipPct: 90 }] });
    businessFindById.mockResolvedValue(business);
    await expect(addShareholder(authUser, "business-1", { name: "New investor", ownershipPct: 11 } as any)).rejects.toThrow("cannot exceed 100%");
    expect(business.save).not.toHaveBeenCalled();
  });

  it("adds a shareholder when the total remains valid", async () => {
    const business = businessFixture({ shareholders: [{ ownershipPct: 70 }] });
    businessFindById.mockResolvedValue(business);
    const result = await addShareholder(authUser, "business-1", { name: "New investor", ownershipPct: 30 } as any);
    expect(result).toMatchObject({ name: "New investor", ownershipPct: 30 });
    expect(business.save).toHaveBeenCalledOnce();
  });
});

describe("business records and people", () => {
  it("lists documents only after it resolves the business scope", async () => {
    const business = businessFixture();
    businessFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(business) });

    await expect(listBusinessDocuments(authUser, "business-1")).resolves.toHaveLength(4);
    expect(assertIssuerBusinessScope).toHaveBeenCalledWith(authUser, "business-1");
  });

  it("retrieves a persisted document and rejects unknown documents", async () => {
    const business = businessFixture({ documents: [{ _id: "doc-1", storageKey: "businesses/doc-1.pdf" }] });
    businessFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(business) });
    retrieveFile.mockResolvedValue({ content: Buffer.from("test"), mimeType: "application/pdf" });

    await expect(retrieveBusinessDocument(authUser, "business-1", "doc-1")).resolves.toMatchObject({ doc: { _id: "doc-1" }, mimeType: "application/pdf" });
    await expect(retrieveBusinessDocument(authUser, "business-1", "missing")).rejects.toThrow("Document not found");
  });

  it("prevents issuers from changing governance fields", async () => {
    businessFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(businessFixture()) });
    await expect(updateBusinessProfile(authUser, "business-1", { riskTier: "high" } as any)).rejects.toThrow("Only admins can change riskTier");
  });

  it("prevents issuers from changing the business status", async () => {
    businessFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(businessFixture()) });
    await expect(updateBusinessProfile(authUser, "business-1", { status: "disabled" } as any)).rejects.toThrow("Only admins can change business status");
  });

  it("updates a permitted profile field and audits the change", async () => {
    businessFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(businessFixture()) });
    const updated = { _id: "business-1", name: "Fractal Holdings" };
    businessFindByIdAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(updated) });

    await expect(updateBusinessProfile(authUser, "business-1", { name: "Fractal Holdings" } as any)).resolves.toEqual(updated);
    expect(appendEvent).toHaveBeenCalledWith(authUser, expect.objectContaining({ action: "Business profile updated" }));
  });

  it("adds and removes UBO entries", async () => {
    const business = businessFixture({ ubos: [] });
    businessFindById.mockResolvedValue(business);

    const entry = await addUbo(authUser, "business-1", { fullName: "Ada Owner", ownershipPct: 80 } as any);
    expect(entry).toMatchObject({ fullName: "Ada Owner", ownershipPct: 80, controlBasis: "shares" });
    business.ubos[0]._id = "ubo-1";
    await expect(removeUbo(authUser, "business-1", "ubo-1")).resolves.toEqual({ ok: true });
    await expect(removeUbo(authUser, "business-1", "ubo-1")).rejects.toThrow("UBO not found");
  });

  it("adds and removes director entries", async () => {
    const business = businessFixture({ directors: [] });
    businessFindById.mockResolvedValue(business);

    await expect(addDirector(authUser, "business-1", { fullName: "Ada Owner", title: "CEO" } as any)).resolves.toMatchObject({ fullName: "Ada Owner", title: "CEO" });
    business.directors[0]._id = "director-1";
    await expect(removeDirector(authUser, "business-1", "director-1")).resolves.toEqual({ ok: true });
    await expect(removeDirector(authUser, "business-1", "director-1")).rejects.toThrow("Director not found");
  });

  it("removes a shareholder and lists the business users", async () => {
    const business = businessFixture({ shareholders: [{ _id: "shareholder-1", name: "Ada", ownershipPct: 100 }] });
    businessFindById.mockResolvedValue(business);
    await expect(removeShareholder(authUser, "business-1", "shareholder-1")).resolves.toEqual({ ok: true });
    await expect(removeShareholder(authUser, "business-1", "shareholder-1")).rejects.toThrow("Shareholder not found");

    businessFindById.mockReturnValue({ lean: vi.fn().mockResolvedValue(business) });
    userFind.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: "user-1" }]) });
    await expect(listBusinessUsers(authUser, "business-1")).resolves.toEqual([{ _id: "user-1" }]);
  });
});

describe("business suspension", () => {
  it("disables all business users and sends notifications", async () => {
    const business = businessFixture();
    const userA = { _id: "user-a", save: vi.fn().mockResolvedValue(undefined) };
    const userB = { _id: "user-b", save: vi.fn().mockResolvedValue(undefined) };
    businessFindById.mockResolvedValue(business);
    userFind.mockResolvedValue([userA, userB]);
    const admin = { userId: "admin-1", role: "admin" } as any;

    await expect(suspendBusiness(admin, "business-1", { reason: "regulatory_hold", notes: "Compliance review" } as any)).resolves.toMatchObject({ status: "disabled" });
    expect(userA).toMatchObject({ status: "disabled" });
    expect(userB).toMatchObject({ status: "disabled" });
    expect(createNotificationsFromEvent).toHaveBeenCalledTimes(3);
  });

  it("restores active status and clears suspension information", async () => {
    const business = businessFixture({ status: "disabled", suspendedAt: new Date(), suspensionReason: "regulatory_hold" });
    businessFindById.mockResolvedValue(business);

    await expect(unsuspendBusiness({ userId: "admin-1", role: "admin" } as any, "business-1")).resolves.toMatchObject({ status: "active" });
    expect(business.suspendedAt).toBeUndefined();
    expect(business.suspensionReason).toBeUndefined();
  });
});

describe("payout account verification", () => {
  it("uses the bank-resolved account name after a successful verification", async () => {
    const business = businessFixture();
    businessFindById.mockResolvedValue(business);
    env.PAYSTACK_ENABLED = true;
    resolvePaystackAccount.mockResolvedValue({ account_name: "Fractal Issuer Limited" });

    await updatePayoutBankAccount(authUser, "business-1", {
      bankName: "GTBank",
      bankCode: "058",
      accountNumber: "0123456789",
      accountName: "Fractal Issuer",
    } as any);

    expect(business.payoutBankAccount).toMatchObject({ accountName: "Fractal Issuer Limited", paystackVerified: true });
  });

  it("rejects a verified account where the declared name does not match", async () => {
    businessFindById.mockResolvedValue(businessFixture());
    env.PAYSTACK_ENABLED = true;
    resolvePaystackAccount.mockResolvedValue({ account_name: "Other Company Limited" });

    await expect(updatePayoutBankAccount(authUser, "business-1", {
      bankName: "GTBank", bankCode: "058", accountNumber: "0123456789", accountName: "Fractal Issuer",
    } as any)).rejects.toThrow("Bank account name mismatch");
  });

  it("turns a Paystack lookup failure into a safe account validation error", async () => {
    businessFindById.mockResolvedValue(businessFixture());
    env.PAYSTACK_ENABLED = true;
    resolvePaystackAccount.mockRejectedValueOnce(new Error("Paystack service unavailable"));

    await expect(updatePayoutBankAccount(authUser, "business-1", {
      bankName: "GTBank", bankCode: "058", accountNumber: "0123456789", accountName: "Fractal Issuer",
    } as any)).rejects.toThrow("Bank account validation failed: Paystack service unavailable");
  });
});
