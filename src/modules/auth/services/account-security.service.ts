/**
 * Password reset + email verification flows.
 *
 * Password resets use random bearer links; email verification uses a six-digit
 * one-time code. Only SHA-256 hashes are stored, all secrets are single-use and
 * time-boxed, and password-reset responses never reveal whether an account exists.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcrypt";
import { UserModel } from "../../../db/models.js";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../utils/errors.js";
import { sendEmailWithFallback } from "../../../services/email.js";
import { revokeAllAuthSessionsForSubject } from "../../../platform/auth-sessions.js";
import { requestAuthEmailDelivery } from "../../../platform/postgres-auth-email-deliveries.js";
import {
  consumePostgresEmailVerificationToken,
  consumePostgresPasswordResetToken,
  getPostgresAuthIdentityByEmail,
  getPostgresAuthIdentityById,
  projectLegacyIdentity,
} from "../../../platform/postgres-identities.js";

const RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
const VERIFY_OTP_TTL_MS = 10 * 60 * 1000; // 10 minutes

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function createEmailVerificationOtp(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

function appUrl(path: string): string {
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path}`;
}

async function projectCurrentIdentity(user: any): Promise<void> {
  await projectLegacyIdentity({
    legacyMongoId: String(user._id), email: user.email, legalName: user.name, role: user.role,
    status: user.status === "disabled" ? "disabled" : "active", passwordHash: user.passwordHash ?? null,
    emailVerified: user.emailVerified === true, credentialInvalidatedAt: user.tokenInvalidatedAt ?? null,
    createdAt: user.createdAt ?? null, updatedAt: user.updatedAt ?? null,
  });
}

/** Generate + email a password-reset link. Always resolves (no account enumeration). */
export async function requestPasswordReset(email: string): Promise<void> {
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const identity = await getPostgresAuthIdentityByEmail(email);
    if (!identity || identity.status !== "active") return; // do not reveal non-existence
    await requestAuthEmailDelivery({ identityId: identity.id, deliveryType: "password_reset" });
    return;
  }

  const user = await UserModel.findOne({ email: email.toLowerCase() });
  if (!user) return; // do not reveal non-existence

  const token = randomBytes(32).toString("hex");
  user.passwordResetToken = hashToken(token);
  user.passwordResetExpires = new Date(Date.now() + RESET_TTL_MS);
  await user.save();

  const link = appUrl(`/account/reset?token=${token}`);
  await sendEmailWithFallback({
    to: user.email,
    subject: "Reset your Fractal password",
    text: `Reset your password using this link (valid 1 hour): ${link}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Reset your password using this link (valid 1 hour):</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can safely ignore this email.</p>`,
    idempotencyKey: `fractal-legacy-password-reset-${String(user._id)}-${user.passwordResetToken}`,
  });
}

/** Consume a reset token and set a new password. */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  if (newPassword.length < 12 || !/[A-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    throw new HttpError(422, "Password must be at least 12 characters and include an uppercase letter and number");
  }
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const identityId = await consumePostgresPasswordResetToken({
      tokenHash: hashToken(token),
      passwordHash: await bcrypt.hash(newPassword, 12),
    });
    if (!identityId) throw new HttpError(400, "Invalid or expired reset token");
    return;
  }

  const user = await UserModel.findOne({
    passwordResetToken: hashToken(token),
    passwordResetExpires: { $gt: new Date() },
  });
  if (!user) throw new HttpError(400, "Invalid or expired reset token");

  // Revoke durable refresh sessions before changing MongoDB state. If this
  // fails, the token remains valid and the user can retry safely; a partially
  // completed reset can only sign the account out, never leave it compromised.
  await revokeAllAuthSessionsForSubject(String(user._id), "password_reset");
  user.passwordHash = await bcrypt.hash(newPassword, 12);
  user.passwordResetToken = undefined;
  user.passwordResetExpires = undefined;
  // Invalidate existing sessions so a compromised session cannot persist.
  user.tokenInvalidatedAt = new Date();
  await user.save();
  await projectCurrentIdentity(user);
}

/** Generate + email a six-digit verification code for a user (by id). Safe no-op if already verified. */
export async function sendEmailVerification(userId: string): Promise<void> {
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const identity = await getPostgresAuthIdentityById(userId);
    if (!identity || identity.emailVerifiedAt) return;
    await requestAuthEmailDelivery({ identityId: identity.id, deliveryType: "email_verification" });
    return;
  }

  const user = await UserModel.findById(userId);
  if (!user || user.emailVerified) return;

  const code = createEmailVerificationOtp();
  user.emailVerifyToken = hashToken(code);
  user.emailVerifyExpires = new Date(Date.now() + VERIFY_OTP_TTL_MS);
  await user.save();

  await sendEmailWithFallback({
    to: user.email,
    subject: "Your Fractal verification code",
    text: `Your Fractal verification code is ${code}. It expires in 10 minutes. Do not share this code.`,
    html: `<p>Your Fractal verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:0.18em"><strong>${code}</strong></p><p>It expires in 10 minutes. Do not share this code.</p>`,
    idempotencyKey: `fractal-legacy-email-verification-${String(user._id)}-${user.emailVerifyToken}`,
  });
}

/** Consume a single-use six-digit email-verification code. */
export async function verifyEmail(email: string, code: string): Promise<void> {
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
    const verified = await consumePostgresEmailVerificationToken({
      email,
      tokenHash: hashToken(code),
    });
    if (!verified) throw new HttpError(400, "Invalid or expired verification code");
    return;
  }

  const user = await UserModel.findOne({
    email: email.toLowerCase(),
    emailVerifyToken: hashToken(code),
    emailVerifyExpires: { $gt: new Date() },
  });
  if (!user) throw new HttpError(400, "Invalid or expired verification code");

  user.emailVerified = true;
  user.emailVerifyToken = undefined;
  user.emailVerifyExpires = undefined;
  await user.save();
  await projectCurrentIdentity(user);
}
