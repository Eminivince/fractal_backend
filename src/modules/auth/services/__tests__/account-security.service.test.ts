import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findOne: vi.fn(), findById: vi.fn(), sendEmail: vi.fn(), revoke: vi.fn(), delivery: vi.fn(), pgByEmail: vi.fn(), pgById: vi.fn(), consumeReset: vi.fn(), consumeVerify: vi.fn(), project: vi.fn(), bcryptHash: vi.fn(), randomBytes: vi.fn(), randomInt: vi.fn(), env: { AUTH_IDENTITY_AUTHORITY: "legacy", APP_BASE_URL: "https://app.fractal.test/" } }));
vi.mock("node:crypto", async (importOriginal) => ({ ...(await importOriginal<typeof import("node:crypto")>()), randomBytes: mocks.randomBytes, randomInt: mocks.randomInt }));
vi.mock("bcrypt", () => ({ default: { hash: mocks.bcryptHash } }));
vi.mock("../../../../db/models.js", () => ({ UserModel: { findOne: mocks.findOne, findById: mocks.findById } }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/email.js", () => ({ sendEmailWithFallback: mocks.sendEmail }));
vi.mock("../../../../platform/auth-sessions.js", () => ({ revokeAllAuthSessionsForSubject: mocks.revoke }));
vi.mock("../../../../platform/postgres-auth-email-deliveries.js", () => ({ requestAuthEmailDelivery: mocks.delivery }));
vi.mock("../../../../platform/postgres-identities.js", () => ({ consumePostgresEmailVerificationToken: mocks.consumeVerify, consumePostgresPasswordResetToken: mocks.consumeReset, getPostgresAuthIdentityByEmail: mocks.pgByEmail, getPostgresAuthIdentityById: mocks.pgById, projectLegacyIdentity: mocks.project }));
import { requestPasswordReset, resetPassword, sendEmailVerification, verifyEmail } from "../account-security.service.js";

function user(overrides: Record<string, unknown> = {}) { return { _id: "user-1", email: "member@example.test", name: "Member", role: "investor", status: "active", passwordHash: "old-hash", emailVerified: false, save: vi.fn().mockResolvedValue(undefined), ...overrides } as any; }
beforeEach(() => {
  for (const mock of Object.values(mocks)) if (typeof mock === "function") mock.mockReset();
  Object.assign(mocks.env, { AUTH_IDENTITY_AUTHORITY: "legacy", APP_BASE_URL: "https://app.fractal.test/" }); mocks.randomBytes.mockReturnValue({ toString: () => "reset-token" }); mocks.randomInt.mockReturnValue(42); mocks.bcryptHash.mockResolvedValue("new-password-hash"); mocks.sendEmail.mockResolvedValue({ status: "sent" }); mocks.revoke.mockResolvedValue(undefined); mocks.project.mockResolvedValue(undefined); mocks.delivery.mockResolvedValue(undefined);
});

describe("account security service", () => {
  it("sends a legacy reset link without disclosing unknown accounts", async () => {
    const account = user(); mocks.findOne.mockResolvedValueOnce(account);
    await requestPasswordReset("MEMBER@example.test");
    expect(account.passwordResetToken).toMatch(/^[0-9a-f]{64}$/); expect(account.save).toHaveBeenCalledOnce();
    expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ to: "member@example.test", idempotencyKey: expect.stringContaining("fractal-legacy-password-reset-user-1") }));
    mocks.findOne.mockResolvedValueOnce(null);
    await requestPasswordReset("absent@example.test"); expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("rejects weak or expired resets and safely replaces a legacy password", async () => {
    await expect(resetPassword("token", "weak")).rejects.toMatchObject({ statusCode: 422 });
    mocks.findOne.mockResolvedValueOnce(null);
    await expect(resetPassword("token", "ValidPassword1")).rejects.toMatchObject({ statusCode: 400 });
    const account = user({ passwordResetToken: "hashed" }); mocks.findOne.mockResolvedValueOnce(account);
    await resetPassword("token", "ValidPassword1");
    expect(mocks.revoke).toHaveBeenCalledWith("user-1", "password_reset"); expect(account).toMatchObject({ passwordHash: "new-password-hash", passwordResetToken: undefined, passwordResetExpires: undefined }); expect(account.save).toHaveBeenCalledOnce(); expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ legacyMongoId: "user-1", emailVerified: false }));
  });

  it("sends and consumes a single-use legacy email verification code", async () => {
    const account = user(); mocks.findById.mockResolvedValueOnce(account);
    await sendEmailVerification("user-1");
    expect(account.emailVerifyToken).toMatch(/^[0-9a-f]{64}$/); expect(mocks.sendEmail).toHaveBeenCalledWith(expect.objectContaining({ subject: "Your Fractal verification code", text: expect.stringContaining("000042") }));
    mocks.findById.mockResolvedValueOnce(user({ emailVerified: true }));
    await sendEmailVerification("verified-user"); expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    mocks.findById.mockResolvedValueOnce(null); await sendEmailVerification("missing-user");
    mocks.findOne.mockResolvedValueOnce(null); await expect(verifyEmail("member@example.test", "000042")).rejects.toMatchObject({ statusCode: 400 });
    const verified = user(); mocks.findOne.mockResolvedValueOnce(verified); await verifyEmail("MEMBER@example.test", "000042");
    expect(verified).toMatchObject({ emailVerified: true, emailVerifyToken: undefined, emailVerifyExpires: undefined }); expect(mocks.project).toHaveBeenCalledWith(expect.objectContaining({ emailVerified: true }));
  });

  it("uses PostgreSQL identity delivery and consumption when it is the configured authority", async () => {
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres";
    mocks.pgByEmail.mockResolvedValueOnce({ id: "identity-1", status: "active" }); await requestPasswordReset("member@example.test");
    expect(mocks.delivery).toHaveBeenCalledWith({ identityId: "identity-1", deliveryType: "password_reset" });
    mocks.pgByEmail.mockResolvedValueOnce({ id: "disabled", status: "disabled" }); await requestPasswordReset("disabled@example.test");
    mocks.consumeReset.mockResolvedValueOnce(null); await expect(resetPassword("token", "ValidPassword1")).rejects.toMatchObject({ statusCode: 400 });
    mocks.consumeReset.mockResolvedValueOnce("identity-1"); await expect(resetPassword("token", "ValidPassword1")).resolves.toBeUndefined();
    mocks.pgById.mockResolvedValueOnce({ id: "identity-1", emailVerifiedAt: null }); await sendEmailVerification("identity-1");
    expect(mocks.delivery).toHaveBeenCalledWith({ identityId: "identity-1", deliveryType: "email_verification" });
    mocks.pgById.mockResolvedValueOnce({ id: "identity-1", emailVerifiedAt: new Date() }); await sendEmailVerification("already-verified");
    mocks.consumeVerify.mockResolvedValueOnce(false); await expect(verifyEmail("member@example.test", "000042")).rejects.toMatchObject({ statusCode: 400 });
    mocks.consumeVerify.mockResolvedValueOnce(true); await expect(verifyEmail("member@example.test", "000042")).resolves.toBeUndefined();
  });
});
