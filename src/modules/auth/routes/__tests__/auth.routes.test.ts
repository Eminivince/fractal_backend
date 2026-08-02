import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ controller: vi.fn(), pgByEmail: vi.fn(), identity: vi.fn(), delivery: vi.fn(), grant: vi.fn(), confirm: vi.fn(), enroll: vi.fn(), status: vi.fn(), recover: vi.fn(), regenerate: vi.fn(), verify: vi.fn(), resetRequest: vi.fn(), reset: vi.fn(), sendVerification: vi.fn(), verifyEmail: vi.fn(), env: { MFA_TOTP_ENABLED: true, AUTH_STEP_UP_TTL_SECONDS: 900, AUTH_IDENTITY_AUTHORITY: "postgres" } }));
const { IdentityError, StepUpError, TotpError } = vi.hoisted(() => ({ IdentityError: class IdentityError extends Error {}, StepUpError: class StepUpError extends Error {}, TotpError: class TotpError extends Error {} }));
vi.mock("../../controllers/auth.controller.js", () => ({ createAuthController: mocks.controller }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../platform/postgres-identities.js", () => ({ getPostgresAuthIdentityByEmail: mocks.pgByEmail, PostgresIdentityUnavailableError: IdentityError, requirePostgresIdentityForSubject: mocks.identity }));
vi.mock("../../../../platform/postgres-auth-email-deliveries.js", () => ({ requestAuthEmailDelivery: mocks.delivery }));
vi.mock("../../../../platform/auth-step-up.js", () => ({ grantTotpStepUp: mocks.grant, StepUpRequiredError: StepUpError }));
vi.mock("../../../../platform/totp-factors.js", () => ({ confirmOrVerifyTotpFactor: mocks.confirm, enrollTotpFactor: mocks.enroll, getTotpFactorStatus: mocks.status, recoverTotpFactor: mocks.recover, regenerateTotpRecoveryCodes: mocks.regenerate, TotpFactorError: TotpError, verifyConfirmedTotpFactor: mocks.verify }));
vi.mock("../../services/account-security.service.js", () => ({ requestPasswordReset: mocks.resetRequest, resetPassword: mocks.reset, sendEmailVerification: mocks.sendVerification, verifyEmail: mocks.verifyEmail }));
import { authRoutes } from "../auth.routes.js";

let app: ReturnType<typeof Fastify>; let sessionId: string | undefined;
const controllerHandler = (name: string) => async () => ({ route: name });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) if (typeof mock === "function") mock.mockReset(); sessionId = "session-1"; Object.assign(mocks.env, { MFA_TOTP_ENABLED: true, AUTH_STEP_UP_TTL_SECONDS: 900, AUTH_IDENTITY_AUTHORITY: "postgres" });
  mocks.controller.mockReturnValue({ login: controllerHandler("login"), register: controllerHandler("register"), sync: controllerHandler("sync"), refresh: controllerHandler("refresh"), logout: controllerHandler("logout"), me: controllerHandler("me"), sessions: controllerHandler("sessions"), revokeSession: controllerHandler("revoke"), securityEvents: controllerHandler("events") });
  mocks.identity.mockResolvedValue("identity-1"); mocks.status.mockResolvedValue({ enrolled: true, confirmed: true, recoveryCodesRemaining: 8 }); mocks.enroll.mockResolvedValue({ secret: "secret", otpauthUrl: "otpauth://test" }); mocks.confirm.mockResolvedValue({ recoveryCodes: ["one"] }); mocks.verify.mockResolvedValue(undefined); mocks.grant.mockResolvedValue({ expiresAt: new Date("2026-01-01T00:00:00.000Z") }); mocks.regenerate.mockResolvedValue(["new-code"]); mocks.recover.mockResolvedValue({ secret: "new-secret" }); mocks.resetRequest.mockResolvedValue(undefined); mocks.reset.mockResolvedValue(undefined); mocks.sendVerification.mockResolvedValue(undefined); mocks.verifyEmail.mockResolvedValue(undefined); mocks.delivery.mockResolvedValue(undefined);
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? (error.name === "ZodError" ? 400 : 500)).send({ message: error.message })); app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", sessionId, role: "investor" }; }); await app.register(authRoutes);
});
afterEach(async () => { await app.close(); });

describe("authentication routes", () => {
  it("registers each controller route with the expected public or authenticated boundary", async () => {
    for (const [method, url, payload] of [["POST", "/v1/auth/login", {}], ["POST", "/v1/auth/register", {}], ["POST", "/v1/auth/sync", {}], ["POST", "/v1/auth/refresh", {}], ["POST", "/v1/auth/logout", {}], ["GET", "/v1/auth/me", undefined], ["GET", "/v1/auth/sessions", undefined], ["POST", "/v1/auth/sessions/11111111-1111-4111-8111-111111111111/revoke", {}], ["GET", "/v1/auth/security-events", undefined]] as const) {
      const response = await app.inject({ method, url, payload }); expect(response.statusCode).toBe(200);
    }
  });

  it("returns MFA state and performs enrollment, confirmation, step-up, recovery, and recovery-code rotation", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/auth/mfa/totp" })).resolves.toMatchObject({ statusCode: 200 });
    const enroll = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll" }); expect(enroll.statusCode).toBe(200); expect(enroll.headers["cache-control"]).toBe("no-store");
    await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/step-up", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/recovery-codes/regenerate", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/recover", payload: { code: "recovery-code" } })).resolves.toMatchObject({ statusCode: 200 });
    expect(mocks.grant).toHaveBeenCalledWith({ sessionId: "session-1", identityId: "identity-1" });
  });

  it("fails MFA closed when disabled, migration is unavailable, session is absent, or codes are invalid", async () => {
    mocks.env.MFA_TOTP_ENABLED = false; await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll" })).resolves.toMatchObject({ statusCode: 409 });
    mocks.env.MFA_TOTP_ENABLED = true; mocks.identity.mockRejectedValueOnce(new IdentityError("migration")); await expect(app.inject({ method: "GET", url: "/v1/auth/mfa/totp" })).resolves.toMatchObject({ statusCode: 409 });
    sessionId = undefined;
    await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/step-up", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 401 });
    sessionId = "session-1";
    mocks.identity.mockRejectedValueOnce(new Error("identity database unavailable")); await expect(app.inject({ method: "GET", url: "/v1/auth/mfa/totp" })).resolves.toMatchObject({ statusCode: 500 });
    mocks.confirm.mockRejectedValueOnce(new TotpError("invalid")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.confirm.mockRejectedValueOnce(new StepUpError("session not eligible")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 401 });
    mocks.confirm.mockRejectedValueOnce(new Error("totp database unavailable")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 500 });
    mocks.enroll.mockRejectedValueOnce(new TotpError("already enrolled")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll" })).resolves.toMatchObject({ statusCode: 409 });
    mocks.enroll.mockRejectedValueOnce(new Error("enrollment store unavailable")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll" })).resolves.toMatchObject({ statusCode: 500 });
    mocks.regenerate.mockRejectedValueOnce(new TotpError("invalid")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/recovery-codes/regenerate", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.regenerate.mockRejectedValueOnce(new Error("recovery store unavailable")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/recovery-codes/regenerate", payload: { code: "123456" } })).resolves.toMatchObject({ statusCode: 500 });
    mocks.recover.mockRejectedValueOnce(new TotpError("invalid")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/recover", payload: { code: "recovery-code" } })).resolves.toMatchObject({ statusCode: 422 });
    mocks.recover.mockRejectedValueOnce(new Error("recovery store unavailable")); await expect(app.inject({ method: "POST", url: "/v1/auth/mfa/totp/recover", payload: { code: "recovery-code" } })).resolves.toMatchObject({ statusCode: 500 });
  });

  it("keeps password and email-verification public responses non-enumerating", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/auth/forgot-password", payload: { email: "member@example.test" } })).resolves.toMatchObject({ statusCode: 200 });
    mocks.pgByEmail.mockResolvedValueOnce({ id: "identity-1", status: "active", emailVerifiedAt: null });
    await expect(app.inject({ method: "POST", url: "/v1/auth/request-email-verification", payload: { email: "member@example.test" } })).resolves.toMatchObject({ statusCode: 200 }); expect(mocks.delivery).toHaveBeenCalledWith({ identityId: "identity-1", deliveryType: "email_verification" });
    await expect(app.inject({ method: "POST", url: "/v1/auth/reset-password", payload: { token: "a".repeat(16), password: "ValidPassword1" } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/auth/verify-email", payload: { email: "member@example.test", code: "123456" } })).resolves.toMatchObject({ statusCode: 200 });
    await expect(app.inject({ method: "POST", url: "/v1/auth/resend-verification" })).resolves.toMatchObject({ statusCode: 200 });
  });
});
