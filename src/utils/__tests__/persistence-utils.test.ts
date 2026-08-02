import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  anchorCreate: vi.fn(),
  anchorFindOne: vi.fn(),
  eventCreate: vi.fn(),
  eventFindOne: vi.fn(),
  userFindById: vi.fn(),
  profileFindOne: vi.fn(),
  notifications: vi.fn(),
}));

vi.mock("../../db/models.js", () => ({
  AnchorModel: { create: mocks.anchorCreate, findOne: mocks.anchorFindOne },
  EventLogModel: { create: mocks.eventCreate, findOne: mocks.eventFindOne },
  UserModel: { findById: mocks.userFindById },
  InvestorProfileModel: { findOne: mocks.profileFindOne },
}));

vi.mock("../../services/notifications.js", () => ({
  createNotificationsFromEvent: mocks.notifications,
}));

import { anonymizeInvestor } from "../anonymize.js";
import { createAnchorRecord, hasAnchor } from "../anchor.js";
import { appendEvent } from "../audit.js";
import { hashPayload } from "../idempotency.js";

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("anchoring records", () => {
  it("writes a canonical payload hash and anchor metadata", async () => {
    mocks.anchorCreate.mockResolvedValue([{ _id: "anchor-1" }]);
    const payload = { b: 2, a: 1 };

    await expect(createAnchorRecord({ entityType: "payment" as any, entityId: "payment-1", eventType: "paid", payload, anchorStatus: "anchored", chainRef: "chain-1", txHash: "0xtx" }, "session" as any))
      .resolves.toEqual({ id: "anchor-1", canonicalHash: hashPayload({ entityType: "payment", entityId: "payment-1", eventType: "paid", payload }) });
    const [records, options] = mocks.anchorCreate.mock.calls[0]!;
    expect(options).toEqual({ session: "session" });
    expect(records[0]).toEqual(expect.objectContaining({
      entityType: "payment",
      entityId: "payment-1",
      eventType: "paid",
      payload,
      anchorStatus: "anchored",
      chainRef: "chain-1",
      txHash: "0xtx",
      anchoredAt: expect.any(Date),
    }));
  });

  it("defaults to a pending anchor and reports whether an anchor exists", async () => {
    mocks.anchorCreate.mockResolvedValue([{ _id: "anchor-2" }]);
    await createAnchorRecord({ entityType: "payment" as any, entityId: "payment-2", eventType: "created", payload: {} });
    expect(mocks.anchorCreate.mock.calls[0]![0][0]).toEqual(expect.objectContaining({ anchorStatus: "pending", anchoredAt: undefined }));

    mocks.anchorFindOne.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) }).mockReturnValueOnce({ lean: vi.fn().mockResolvedValue({ _id: "anchor-2" }) });
    await expect(hasAnchor("payment" as any, "payment-2", "created")).resolves.toBe(false);
    await expect(hasAnchor("payment" as any, "payment-2", "created")).resolves.toBe(true);
  });
});

describe("audit records", () => {
  it("chains the first event from the genesis hash and creates notifications", async () => {
    const sort = vi.fn().mockReturnThis();
    const select = vi.fn().mockReturnThis();
    const session = vi.fn().mockReturnThis();
    const lean = vi.fn().mockResolvedValue(null);
    mocks.eventFindOne.mockReturnValue({ sort, select, session, lean });
    mocks.eventCreate.mockResolvedValue([]);
    mocks.notifications.mockResolvedValue(undefined);

    await appendEvent({ userId: "user-1", role: "admin" } as any, { entityType: "payment" as any, entityId: "payment-1", action: "payment.approved", notes: "Checked", diff: { status: "approved" } }, "session" as any);

    expect(mocks.eventCreate).toHaveBeenCalledWith([expect.objectContaining({
      entityType: "payment",
      entityId: "payment-1",
      action: "payment.approved",
      actorUserId: "user-1",
      roleAtTime: "admin",
      prevHash: "0".repeat(64),
      hash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })], { session: "session" });
    expect(mocks.notifications).toHaveBeenCalledWith(expect.objectContaining({ userId: "user-1" }), expect.objectContaining({ action: "payment.approved" }), "session");
  });

  it("uses the previous event hash and null values for omitted audit fields", async () => {
    mocks.eventFindOne.mockReturnValue({ sort: vi.fn().mockReturnThis(), select: vi.fn().mockReturnThis(), session: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue({ hash: "a".repeat(64) }) });
    mocks.eventCreate.mockResolvedValue([]);
    mocks.notifications.mockResolvedValue(undefined);

    await appendEvent({ userId: "user-1", role: "admin" } as any, { entityType: "payment" as any, entityId: "payment-1", action: "payment.created" });
    expect(mocks.eventCreate.mock.calls[0]![0][0]).toEqual(expect.objectContaining({ prevHash: "a".repeat(64), notes: undefined, diff: undefined }));
  });
});

describe("investor anonymization", () => {
  it("fails when the identity no longer exists", async () => {
    mocks.userFindById.mockReturnValue({ session: vi.fn().mockResolvedValue(null) });
    await expect(anonymizeInvestor("missing-user")).rejects.toThrow("User missing-user not found");
  });

  it("redacts identity and investor profile data while retaining the record", async () => {
    const user = { email: "investor@example.test", name: "Investor Name", passwordHash: "hash", passwordResetToken: "token", passwordResetExpires: new Date(), status: "active", save: vi.fn().mockResolvedValue(undefined) };
    const profile = {
      bankAccount: { accountNumber: "1234567890", accountName: "Investor Name", recipientCode: "recipient" },
      kycStatus: "approved", sumsubApplicantId: "applicant", sumsubExternalUserId: "external", documents: [{ id: "doc" }], accreditationDocs: [{ id: "accreditation" }],
      save: vi.fn().mockResolvedValue(undefined),
    };
    mocks.userFindById.mockReturnValue({ session: vi.fn().mockResolvedValue(user) });
    mocks.profileFindOne.mockReturnValue({ session: vi.fn().mockResolvedValue(profile) });

    const result = await anonymizeInvestor("user-1", "session" as any);
    expect(result).toEqual({ anonymizedUserId: "user-1", originalEmail: expect.stringMatching(/^\[REDACTED-[a-f0-9]{8}\]$/) });
    expect(user).toEqual(expect.objectContaining({ status: "disabled", passwordHash: undefined, passwordResetToken: undefined, passwordResetExpires: undefined, tokenInvalidatedAt: expect.any(Date) }));
    expect(user.email).toMatch(/^\[REDACTED-/);
    expect(user.name).toMatch(/^\[REDACTED-/);
    expect(user.save).toHaveBeenCalledWith({ session: "session" });
    expect(profile).toEqual(expect.objectContaining({ kycStatus: "rejected", sumsubApplicantId: undefined, sumsubExternalUserId: undefined, documents: [], accreditationDocs: [] }));
    expect(profile.bankAccount).toEqual({ accountNumber: expect.stringMatching(/^\[REDACTED-/), accountName: expect.stringMatching(/^\[REDACTED-/), recipientCode: undefined });
    expect(profile.save).toHaveBeenCalledWith({ session: "session" });
  });

  it("anonymizes the user even when no investor profile exists", async () => {
    const user = { email: "investor@example.test", name: "Investor Name", save: vi.fn().mockResolvedValue(undefined) };
    mocks.userFindById.mockReturnValue({ session: vi.fn().mockResolvedValue(user) });
    mocks.profileFindOne.mockReturnValue({ session: vi.fn().mockResolvedValue(null) });
    await expect(anonymizeInvestor("user-1")).resolves.toEqual(expect.objectContaining({ anonymizedUserId: "user-1" }));
    expect(user.save).toHaveBeenCalledWith({ session: undefined });
  });

  it("handles an investor profile that has no stored bank account", async () => {
    const user = { email: "investor@example.test", name: "Investor Name", save: vi.fn().mockResolvedValue(undefined) };
    const profile = { kycStatus: "pending", documents: [], accreditationDocs: [], save: vi.fn().mockResolvedValue(undefined) };
    mocks.userFindById.mockReturnValue({ session: vi.fn().mockResolvedValue(user) });
    mocks.profileFindOne.mockReturnValue({ session: vi.fn().mockResolvedValue(profile) });

    await anonymizeInvestor("user-1");
    expect(profile).toEqual(expect.objectContaining({ kycStatus: "rejected", documents: [], accreditationDocs: [] }));
    expect(profile.save).toHaveBeenCalledWith({ session: undefined });
  });
});
