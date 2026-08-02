import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createAuthController } from "../controllers/auth.controller.js";
import { env } from "../../../config/env.js";
import {
  getPostgresAuthIdentityByEmail,
  PostgresIdentityUnavailableError,
  requirePostgresIdentityForSubject,
} from "../../../platform/postgres-identities.js";
import { requestAuthEmailDelivery } from "../../../platform/postgres-auth-email-deliveries.js";
import { grantTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import {
  confirmOrVerifyTotpFactor,
  enrollTotpFactor,
  getTotpFactorStatus,
  recoverTotpFactor,
  regenerateTotpRecoveryCodes,
  TotpFactorError,
  verifyConfirmedTotpFactor,
} from "../../../platform/totp-factors.js";
import { HttpError } from "../../../utils/errors.js";
import {
  requestPasswordReset,
  resetPassword,
  sendEmailVerification,
  verifyEmail,
} from "../services/account-security.service.js";

export async function authRoutes(app: FastifyInstance) {
  const controller = createAuthController(app);

  const mfaCode = z.object({ code: z.string().regex(/^\d{6}$/) });
  const mfaIdentity = async (request: FastifyRequest) => {
    try {
      return await requirePostgresIdentityForSubject(request.authUser.userId);
    } catch (error) {
      if (error instanceof PostgresIdentityUnavailableError) {
        throw new HttpError(409, "Your account migration is not ready for multi-factor authentication.");
      }
      throw error;
    }
  };
  const requireMfa = () => {
    if (!env.MFA_TOTP_ENABLED) {
      throw new HttpError(409, "Authenticator-app multi-factor authentication is not enabled in this environment.");
    }
  };
  const verifyAndGrant = async (request: FastifyRequest, allowEnrollmentConfirmation: boolean) => {
    requireMfa();
    if (!request.authUser.sessionId) {
      throw new HttpError(401, "A server-backed session is required for authenticator confirmation and step-up.");
    }
    const identityId = await mfaIdentity(request);
    const { code } = mfaCode.parse(request.body);
    try {
      const confirmation = allowEnrollmentConfirmation
        ? await confirmOrVerifyTotpFactor(identityId, code)
        : (await verifyConfirmedTotpFactor(identityId, code), { recoveryCodes: [] });
      const grant = await grantTotpStepUp({ sessionId: request.authUser.sessionId, identityId });
      return { identityId, expiresAt: grant.expiresAt.toISOString(), recoveryCodes: confirmation.recoveryCodes ?? [] };
    } catch (error) {
      if (error instanceof TotpFactorError) throw new HttpError(422, "The authenticator code is invalid, expired, or already used.");
      if (error instanceof StepUpRequiredError) throw new HttpError(401, error.message);
      throw error;
    }
  };
  const recoveryCode = z.object({ code: z.string().min(1).max(64) });

  app.post("/v1/auth/login", controller.login);
  app.post("/v1/auth/register", controller.register);
  app.post("/v1/auth/sync", controller.sync);
  app.post("/v1/auth/refresh", controller.refresh);
  app.post("/v1/auth/logout", { preHandler: [app.authenticate] }, controller.logout);
  app.get("/v1/auth/me", { preHandler: [app.authenticate] }, controller.me);
  app.get("/v1/auth/sessions", { preHandler: [app.authenticate] }, controller.sessions);
  app.post("/v1/auth/sessions/:id/revoke", { preHandler: [app.authenticate] }, controller.revokeSession);
  app.get("/v1/auth/security-events", { preHandler: [app.authenticate] }, controller.securityEvents);

  app.get("/v1/auth/mfa/totp", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (!env.MFA_TOTP_ENABLED) return { enabled: false, enrolled: false, confirmed: false, recoveryCodesRemaining: 0, stepUpTtlSeconds: env.AUTH_STEP_UP_TTL_SECONDS };
    const status = await getTotpFactorStatus(await mfaIdentity(request));
    return { enabled: true, ...status, stepUpTtlSeconds: env.AUTH_STEP_UP_TTL_SECONDS };
  });

  app.post("/v1/auth/mfa/totp/enroll", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply) => {
    requireMfa();
    try {
      const enrollment = await enrollTotpFactor(await mfaIdentity(request));
      reply.header("Cache-Control", "no-store");
      return enrollment;
    } catch (error) {
      if (error instanceof TotpFactorError) throw new HttpError(409, error.message);
      throw error;
    }
  });

  app.post("/v1/auth/mfa/totp/confirm", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    const grant = await verifyAndGrant(request, true);
    return { confirmed: true, recoveryCodes: grant.recoveryCodes, stepUpExpiresAt: grant.expiresAt };
  });

  app.post("/v1/auth/mfa/step-up", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    const grant = await verifyAndGrant(request, false);
    return { method: "totp", stepUpExpiresAt: grant.expiresAt };
  });

  app.post("/v1/auth/mfa/recovery-codes/regenerate", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply) => {
    requireMfa();
    try {
      const codes = await regenerateTotpRecoveryCodes(await mfaIdentity(request), mfaCode.parse(request.body).code);
      reply.header("Cache-Control", "no-store");
      return { recoveryCodes: codes };
    } catch (error) {
      if (error instanceof TotpFactorError) throw new HttpError(422, "The authenticator code is invalid, expired, or already used.");
      throw error;
    }
  });

  app.post("/v1/auth/mfa/totp/recover", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply) => {
    requireMfa();
    if (!request.authUser.sessionId) throw new HttpError(401, "A server-backed session is required for MFA recovery.");
    try {
      const enrollment = await recoverTotpFactor({
        identityId: await mfaIdentity(request),
        sessionId: request.authUser.sessionId,
        code: recoveryCode.parse(request.body).code,
      });
      reply.header("Cache-Control", "no-store");
      return enrollment;
    } catch (error) {
      if (error instanceof TotpFactorError) throw new HttpError(422, "The recovery code is invalid, expired, already used, or cannot be used in this session.");
      throw error;
    }
  });

  // Password reset — request always returns 200 (no account enumeration).
  app.post("/v1/auth/forgot-password", async (request: FastifyRequest) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body);
    await requestPasswordReset(email);
    return { message: "If an account exists for that email, a reset link has been sent." };
  });

  // This public request deliberately has the same non-enumerating response for
  // missing, disabled, and already-verified identities. It lets a user who
  // closed the registration browser recover their verification email without
  // needing a session that cannot exist until verification is complete.
  app.post("/v1/auth/request-email-verification", async (request: FastifyRequest) => {
    const { email } = z.object({ email: z.string().email() }).parse(request.body);
    if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
      const identity = await getPostgresAuthIdentityByEmail(email);
      if (identity?.status === "active" && !identity.emailVerifiedAt) {
        await requestAuthEmailDelivery({ identityId: identity.id, deliveryType: "email_verification" });
      }
    }
    return { message: "If an unverified account exists for that email, a verification code has been sent." };
  });

  app.post("/v1/auth/reset-password", async (request: FastifyRequest) => {
    const { token, password } = z
      .object({
        token: z.string().min(16),
        password: z.string().min(12).regex(/[A-Z]/).regex(/[0-9]/),
      })
      .parse(request.body);
    await resetPassword(token, password);
    return { message: "Password updated. Please sign in with your new password." };
  });

  // Email verification uses a short-lived one-time code. Middleware combines
  // a strict account-keyed ceiling with a broader peer-address abuse ceiling.
  app.post("/v1/auth/verify-email", async (request: FastifyRequest) => {
    const { email, code } = z.object({
      email: z.string().email(),
      code: z.string().regex(/^\d{6}$/),
    }).parse(request.body);
    await verifyEmail(email, code);
    return { message: "Email verified." };
  });

  app.post(
    "/v1/auth/resend-verification",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      await sendEmailVerification(request.authUser.userId);
      return { message: "Verification code sent if your address is unverified." };
    },
  );
}
