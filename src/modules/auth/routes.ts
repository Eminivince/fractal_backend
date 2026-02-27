import type { FastifyInstance, FastifyRequest } from "fastify";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { z } from "zod";
import { UserModel, InvestorProfileModel, ProfessionalModel } from "../../db/models.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { roles } from "../../utils/constants.js";
import { setAuthCookie, clearAuthCookie } from "../../plugins/auth.js";
import { createNotificationsFromEvent } from "../../services/notifications.js";
import { env } from "../../config/env.js";
import type { AuthUser } from "../../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };

export async function authRoutes(app: FastifyInstance) {
  app.post("/v1/auth/login", async (request: FastifyRequest, reply) => {
    const payload = z
      .object({
        email: z.string().email(),
        password: z.string().min(1, "Password is required"),
      })
      .parse(request.body);

    const user = await UserModel.findOne({ email: payload.email.toLowerCase() }).lean();
    if (!user) throw new HttpError(401, "Invalid credentials");
    if (user.status === "disabled") throw new HttpError(403, "User disabled");

    const passwordHash = (user as { passwordHash?: string }).passwordHash;
    if (!passwordHash) {
      throw new HttpError(401, "Password not set for this account. Use seed:admin or reset flow.");
    }
    const valid = await bcrypt.compare(payload.password, passwordHash);
    if (!valid) throw new HttpError(401, "Invalid credentials");

    const token = await app.jwt.sign({
      userId: user._id.toString(),
      role: user.role,
      businessId: user.businessId?.toString(),
    });

    // 1.3: Set httpOnly cookie
    setAuthCookie(reply, token);

    return {
      token,
      user: serialize(user),
    };
  });

  // Self-serve registration with email + password
  app.post("/v1/auth/register", async (request: FastifyRequest, reply) => {
    const SELF_SERVE_ROLES = ["issuer", "investor", "professional"] as const;
    type SelfServeRole = (typeof SELF_SERVE_ROLES)[number];
    const PROFESSIONAL_CATEGORIES = ["inspector", "valuer", "lawyer"] as const;

    const payload = z
      .object({
        email: z.string().email(),
        password: z.string().min(8, "Password must be at least 8 characters"),
        name: z.string().min(1, "Name is required").max(200),
        role: z.enum(SELF_SERVE_ROLES),
        professionalCategory: z.enum(PROFESSIONAL_CATEGORIES).optional(),
      })
      .refine(
        (data) => data.role !== "professional" || data.professionalCategory !== undefined,
        { message: "professionalCategory is required when role is professional", path: ["professionalCategory"] },
      )
      .parse(request.body);

    const email = payload.email.toLowerCase();
    const existing = await UserModel.findOne({ email }).lean();
    if (existing) throw new HttpError(409, "An account with this email already exists");

    const passwordHash = await bcrypt.hash(payload.password, 12);

    const user = await UserModel.create({
      email,
      name: payload.name,
      role: payload.role,
      status: "active",
      passwordHash,
    });

    if (payload.role === "investor") {
      const profile = await InvestorProfileModel.create({
        userId: user._id,
        kycStatus: "draft",
        eligibility: "retail",
        documents: [],
      });
      user.investorProfileId = profile._id;
      await user.save();
    }

    if (payload.role === "professional") {
      const professional = await ProfessionalModel.create({
        category: payload.professionalCategory,
        name: payload.name,
        regions: [],
        slaDays: 5,
        pricing: { model: "flat", amount: 0 },
        onboardingStatus: "draft",
        status: "active",
      });
      user.professionalId = professional._id;
      await user.save();
    }

    const token = await app.jwt.sign({
      userId: user._id.toString(),
      role: user.role,
    });

    setAuthCookie(reply, token);

    return {
      token,
      user: serialize(user.toObject()),
    };
  });

  // 1.4: Sync Clerk user — role assigned server-side only for new users.
  // Existing users keep their DB role. Frontend does NOT supply role.
  app.post("/v1/auth/sync", async (request: FastifyRequest, reply) => {
    const payload = z
      .object({
        email: z.string().email(),
        name: z.string().min(1),
        role: z.enum(roles).optional(),
      })
      .parse(request.body);

    const email = payload.email.toLowerCase();
    let user = await UserModel.findOne({ email }).lean();

    if (!user) {
      // Only allow self-serve roles for new sign-ups
      const selfServeRoles = ["issuer", "investor", "professional"] as const;
      const requestedRole = payload.role;
      const assignedRole =
        requestedRole && (selfServeRoles as readonly string[]).includes(requestedRole)
          ? requestedRole
          : "investor"; // default to investor if no valid role
      const created = await UserModel.create({
        email,
        name: payload.name,
        role: assignedRole,
        status: "active",
      });
      user = created.toObject();
    }
    // Existing users: role is never updated from client (source of truth is DB)

    if (user.status === "disabled") {
      throw new HttpError(403, "User disabled");
    }

    const token = await app.jwt.sign({
      userId: user._id.toString(),
      role: user.role,
      businessId: user.businessId?.toString(),
    });

    // 1.3: Set httpOnly cookie
    setAuthCookie(reply, token);

    return {
      token,
      user: serialize(user),
    };
  });

  app.get(
    "/v1/auth/me",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      const user = await UserModel.findById(request.authUser.userId).lean();
      if (!user) throw new HttpError(404, "User not found");
      return serialize(user);
    },
  );

  // 1.3: Logout - clear cookie
  app.post("/v1/auth/logout", async (_request: FastifyRequest, reply) => {
    clearAuthCookie(reply);
    return { ok: true };
  });

  // 1.8: Forgot password - generate reset token
  app.post("/v1/auth/forgot-password", async (request: FastifyRequest) => {
    const payload = z
      .object({
        email: z.string().email(),
      })
      .parse(request.body);

    const user = await UserModel.findOne({ email: payload.email.toLowerCase() });
    // Always return success to prevent email enumeration
    if (!user) return { ok: true };

    const resetToken = crypto.randomBytes(32).toString("hex");
    const hashedToken = crypto.createHash("sha256").update(resetToken).digest("hex");

    user.passwordResetToken = hashedToken;
    user.passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
    await user.save();

    const resetUrl = env.APP_BASE_URL
      ? `${env.APP_BASE_URL}/reset-password?token=${resetToken}`
      : `http://localhost:3000/reset-password?token=${resetToken}`;

    await createNotificationsFromEvent(SYSTEM_ACTOR, {
      entityType: "user",
      entityId: String(user._id),
      action: "PasswordResetRequested",
      notes: `Password reset link: ${resetUrl}`,
    });

    return { ok: true };
  });

  // 1.8: Reset password - validate token and set new password
  app.post("/v1/auth/reset-password", async (request: FastifyRequest) => {
    const payload = z
      .object({
        token: z.string().min(1),
        password: z.string().min(8, "Password must be at least 8 characters"),
      })
      .parse(request.body);

    const hashedToken = crypto.createHash("sha256").update(payload.token).digest("hex");

    const user = await UserModel.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    });

    if (!user) {
      throw new HttpError(400, "Invalid or expired reset token");
    }

    user.passwordHash = await bcrypt.hash(payload.password, 12);
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    return { ok: true };
  });
}
