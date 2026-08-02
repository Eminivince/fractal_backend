import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const { mocks, MockProfessional } = vi.hoisted(() => {
  const mocks = { find: vi.fn(), findById: vi.fn(), findByIdAndUpdate: vi.fn(), create: vi.fn(), userFindById: vi.fn(), appendEvent: vi.fn(), decimal: vi.fn() };
  class MockProfessional {
    static find = mocks.find;
    static findById = mocks.findById;
    static findByIdAndUpdate = mocks.findByIdAndUpdate;
    static create = mocks.create;
    _id = "professional-new";
    save = vi.fn().mockResolvedValue(undefined);
    constructor(value: Record<string, unknown>) { Object.assign(this, value); }
    toObject() { return { ...this }; }
  }
  return { mocks, MockProfessional };
});
vi.mock("../../../../db/models.js", () => ({ ProfessionalModel: MockProfessional, UserModel: { findById: mocks.userFindById } }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
import {
  createProfessional, listProfessionals, registerProfessionalProfile, reviewProfessionalOnboarding,
  submitProfessionalOnboarding, updateProfessional, updateProfessionalStatus,
} from "../professionals.service.js";

const admin = { userId: "admin-1", role: "admin", email: "admin@example.test" } as any;
const professionalUser = { userId: "user-1", role: "professional", email: "professional@example.test" } as any;
const professionalId = "professional-1";
const payload = {
  category: "valuer", name: "Amina Valuers Limited", organizationType: "firm", contactEmail: "TEAM@VALUER.EXAMPLE.TEST", contactPhone: "08001234567", website: "https://valuer.example.test", regions: ["Lagos"], jurisdictions: ["NG"], serviceCategories: ["valuation"], slaDays: 3, pricing: { model: "flat", amount: 250000 }, licenseMeta: { licenseNumber: "NIESV-1", issuer: "NIESV", expiresAt: "2027-01-01" }, complianceNotes: "Independent valuation evidence required.",
} as any;

function document(overrides: Record<string, unknown> = {}) {
  return {
    _id: professionalId, category: "valuer", name: "Amina Valuers Limited", contactEmail: "team@valuer.example.test", regions: ["Lagos"], serviceCategories: ["valuation"], slaDays: 3, pricing: { model: "flat", amount: 250000 }, licenseMeta: { issuer: "NIESV" }, onboardingStatus: "draft", status: "active", save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }), ...overrides,
  } as any;
}
function lean(value: unknown) { return { lean: vi.fn().mockResolvedValue(value) }; }

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.appendEvent.mockResolvedValue(undefined); mocks.decimal.mockImplementation((value: number) => `decimal:${value}`);
  mocks.find.mockReturnValue({ sort: vi.fn(() => lean([])) }); mocks.findById.mockResolvedValue(document()); mocks.findByIdAndUpdate.mockResolvedValue(document()); mocks.create.mockResolvedValue(document());
  mocks.userFindById.mockReturnValue(lean({ _id: "user-1", role: "professional", professionalId }));
});

describe("professional service", () => {
  it("lists filtered records and creates controlled professional records", async () => {
    await listProfessionals({ category: "valuer", status: "active", onboardingStatus: "approved", serviceCategory: "valuation" } as any);
    expect(mocks.find).toHaveBeenCalledWith({ category: "valuer", status: "active", onboardingStatus: "approved", serviceCategories: { $in: ["valuation"] } });
    const created = await createProfessional(admin, payload);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ contactEmail: "team@valuer.example.test", pricing: { model: "flat", amount: "decimal:250000" }, onboardingStatus: "approved" }));
    expect(created).toMatchObject({ _id: professionalId });
    expect(mocks.appendEvent).toHaveBeenCalledWith(admin, expect.objectContaining({ action: "Professional profile created" }));
  });

  it("uses safe defaults and rejects invalid professional license dates", async () => {
    await createProfessional(admin, { ...payload, organizationType: undefined, serviceCategories: [], jurisdictions: undefined, licenseMeta: undefined } as any);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ organizationType: "firm", serviceCategories: ["valuation"], jurisdictions: [], licenseMeta: undefined }));
    await expect(createProfessional(admin, { ...payload, licenseMeta: { ...payload.licenseMeta, expiresAt: "not-a-date" } })).rejects.toMatchObject({ statusCode: 422 } satisfies Partial<HttpError>);
    for (const category of ["lawyer", "trustee", "servicer"] as const) {
      await createProfessional(admin, { ...payload, category, serviceCategories: [], licenseMeta: undefined } as any);
    }
    mocks.create.mockResolvedValueOnce({ _id: "plain-professional", name: "Plain profile" });
    await expect(createProfessional(admin, { ...payload, licenseMeta: undefined } as any)).resolves.toMatchObject({ _id: "plain-professional" });
  });

  it("updates an administrator-managed profile and limits a professional to their own scope", async () => {
    const managed = document(); mocks.findById.mockResolvedValueOnce(managed);
    await updateProfessional(admin, professionalId, { ...payload, status: "disabled", onboardingStatus: "rejected" } as any);
    expect(managed).toMatchObject({ status: "disabled", onboardingStatus: "rejected", contactEmail: "team@valuer.example.test" });
    expect(managed.save).toHaveBeenCalledOnce();
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ professionalId })) });
    const own = document(); mocks.findById.mockResolvedValueOnce(own);
    const ownPayload = { ...payload, status: "disabled", onboardingStatus: "approved" } as any;
    await updateProfessional(professionalUser, professionalId, ownPayload);
    expect(own.status).toBe("active"); expect(own.onboardingStatus).toBe("draft");
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ professionalId: "different" })) });
    await expect(updateProfessional(professionalUser, professionalId, payload)).rejects.toMatchObject({ statusCode: 403 } satisfies Partial<HttpError>);
  });

  it("returns safe missing-profile and status-change results", async () => {
    mocks.findById.mockResolvedValueOnce(null);
    await expect(updateProfessional(admin, professionalId, payload)).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
    await updateProfessionalStatus(admin, professionalId, { status: "disabled" } as any);
    expect(mocks.findByIdAndUpdate).toHaveBeenCalledWith(professionalId, { status: "disabled" }, { new: true });
    mocks.findByIdAndUpdate.mockResolvedValueOnce(null);
    await expect(updateProfessionalStatus(admin, professionalId, { status: "active" } as any)).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
  });

  it("registers a professional profile, persists ownership, and issues an expiring session", async () => {
    const user = { _id: { toString: () => "user-1" }, role: "professional", professionalId: undefined, professionalMembershipRole: undefined, save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }) };
    mocks.userFindById.mockResolvedValueOnce(user); mocks.findById.mockResolvedValueOnce(null);
    const sign = vi.fn().mockResolvedValue("professional-session");
    const result = await registerProfessionalProfile({ jwt: { sign } } as any, professionalUser, payload);
    expect(result.token).toBe("professional-session"); expect(user.professionalMembershipRole).toBe("owner");
    expect(sign).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1", role: "professional" }), { expiresIn: "8h" });
    await expect(registerProfessionalProfile({ jwt: { sign } } as any, admin, payload)).rejects.toMatchObject({ statusCode: 403 } satisfies Partial<HttpError>);
    mocks.userFindById.mockResolvedValueOnce(null);
    await expect(registerProfessionalProfile({ jwt: { sign } } as any, professionalUser, payload)).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
    mocks.userFindById.mockResolvedValueOnce({ _id: "user-1", role: "investor" });
    await expect(registerProfessionalProfile({ jwt: { sign } } as any, professionalUser, payload)).rejects.toMatchObject({ statusCode: 403 } satisfies Partial<HttpError>);
    const existing = document();
    mocks.userFindById.mockResolvedValueOnce({ _id: { toString: () => "user-1" }, role: "professional", professionalId, save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(() => ({ id: "user-1" })) }); mocks.findById.mockResolvedValueOnce(existing);
    await registerProfessionalProfile({ jwt: { sign } } as any, professionalUser, { ...payload, serviceCategories: [], licenseMeta: undefined } as any);
    expect(mocks.findById).toHaveBeenCalledWith(professionalId);
  });

  it("submits only a complete, draft professional profile and records review outcomes", async () => {
    const submitted = document(); mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ _id: "user-1", role: "professional", professionalId })) }); mocks.findById.mockResolvedValueOnce(submitted);
    await submitProfessionalOnboarding(professionalUser);
    expect(submitted.onboardingStatus).toBe("submitted");
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ _id: "user-1", role: "professional", professionalId: undefined })) });
    await expect(submitProfessionalOnboarding(professionalUser)).rejects.toMatchObject({ statusCode: 422 } satisfies Partial<HttpError>);
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ _id: "user-1", role: "professional", professionalId })) }); mocks.findById.mockResolvedValueOnce(document({ onboardingStatus: "approved" }));
    await expect(submitProfessionalOnboarding(professionalUser)).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<HttpError>);
    await expect(submitProfessionalOnboarding(admin)).rejects.toMatchObject({ statusCode: 403 } satisfies Partial<HttpError>);
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean(null)) });
    await expect(submitProfessionalOnboarding(professionalUser)).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ professionalId })) }); mocks.findById.mockResolvedValueOnce(null);
    await expect(submitProfessionalOnboarding(professionalUser)).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
    mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ professionalId })) }); mocks.findById.mockResolvedValueOnce(document({ onboardingStatus: "in_review" }));
    await expect(submitProfessionalOnboarding(professionalUser)).rejects.toMatchObject({ statusCode: 409 } satisfies Partial<HttpError>);
    for (const invalid of [document({ name: "" }), document({ category: "" }), document({ contactEmail: "" }), document({ regions: [] }), document({ pricing: undefined }), document({ slaDays: 0 }), document({ licenseMeta: { issuer: "unknown body" } })]) {
      mocks.userFindById.mockReturnValueOnce({ select: vi.fn(() => lean({ professionalId })) }); mocks.findById.mockResolvedValueOnce(invalid);
      await expect(submitProfessionalOnboarding(professionalUser)).rejects.toMatchObject({ statusCode: 422 } satisfies Partial<HttpError>);
    }
    const reviewed = document(); mocks.findById.mockResolvedValueOnce(reviewed);
    await reviewProfessionalOnboarding(admin, professionalId, { status: "rejected", notes: "  Missing required document  " } as any);
    expect(reviewed).toMatchObject({ onboardingStatus: "rejected", status: "disabled", complianceNotes: "Missing required document" });
    mocks.findById.mockResolvedValueOnce(null);
    await expect(reviewProfessionalOnboarding(admin, professionalId, { status: "approved" } as any)).rejects.toMatchObject({ statusCode: 404 } satisfies Partial<HttpError>);
    const approved = document({ status: "disabled" }); mocks.findById.mockResolvedValueOnce(approved);
    await reviewProfessionalOnboarding(admin, professionalId, { status: "approved" } as any);
    expect(approved.status).toBe("active");
  });
});
