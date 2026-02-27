import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";
import { BusinessModel, InvestorProfileModel, UserModel } from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { sendEmailWithFallback } from "../../services/email.js";

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  role: z.enum(["admin", "operator", "issuer", "investor"]),
  businessId: z.string().optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.get(
    "/v1/users",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "user");
      const query = z
        .object({
          role: z.enum(["admin", "operator", "issuer", "investor"]).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {};
      if (query.role) filter.role = query.role;
      if (query.status) filter.status = query.status;

      const rows = await UserModel.find(filter).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );

  app.post(
    "/v1/users",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "user");
      const payload = createUserSchema.parse(request.body);

      if (payload.businessId && !mongoose.isValidObjectId(payload.businessId)) {
        throw new HttpError(400, "Invalid businessId");
      }

      if (payload.role === "issuer") {
        if (!payload.businessId) throw new HttpError(422, "Issuer user requires businessId");
        const business = await BusinessModel.findById(payload.businessId).lean();
        if (!business) throw new HttpError(404, "Business not found");
      }

      const existing = await UserModel.findOne({ email: payload.email.toLowerCase() }).lean();
      if (existing) throw new HttpError(409, "Email already exists");

      const user = await UserModel.create({
        email: payload.email.toLowerCase(),
        name: payload.name,
        role: payload.role,
        status: "active",
        businessId: payload.role === "issuer" ? payload.businessId : undefined,
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

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "User created",
        notes: `${payload.role}:${payload.email.toLowerCase()}`,
      });

      return serialize(user.toObject());
    },
  );

  app.patch(
    "/v1/users/:id/role",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "user");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ role: z.enum(["admin", "operator", "issuer", "investor"]) }).parse(request.body);

      const user = await UserModel.findById(params.id);
      if (!user) throw new HttpError(404, "User not found");

      user.role = payload.role;
      if (payload.role !== "issuer") {
        user.businessId = undefined;
      }

      if (payload.role === "investor" && !user.investorProfileId) {
        const profile = await InvestorProfileModel.create({
          userId: user._id,
          kycStatus: "draft",
          eligibility: "retail",
          documents: [],
        });
        user.investorProfileId = profile._id;
      }

      await user.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "User role changed",
        notes: payload.role,
      });

      return serialize(user.toObject());
    },
  );

  app.patch(
    "/v1/users/:id/status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "user");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ status: z.enum(["active", "disabled"]) }).parse(request.body);

      const user = await UserModel.findByIdAndUpdate(params.id, { status: payload.status }, { new: true }).lean();
      if (!user) throw new HttpError(404, "User not found");

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "User status changed",
        notes: payload.status,
      });

      return serialize(user);
    },
  );

  app.post(
    "/v1/users/:id/reset-password",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "user");
      const params = z.object({ id: z.string() }).parse(request.params);
      const user = await UserModel.findById(params.id).lean();
      if (!user) throw new HttpError(404, "User not found");

      const resetCode = Math.random().toString(36).slice(2, 10).toUpperCase();
      const delivery =
        typeof user.email === "string" && user.email.trim().length > 0
          ? await sendEmailWithFallback({
              to: user.email,
              subject: "Fractal account access reset request",
              text: `A reset request was created for your account. Verification code: ${resetCode}`,
              html: `<p>A reset request was created for your account.</p><p><strong>Verification code:</strong> ${resetCode}</p>`,
            })
          : {
              status: "skipped" as const,
              error: "User has no email",
            };

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "Password reset requested",
        notes:
          delivery.status === "sent"
            ? `email:${delivery.provider ?? "unknown"}`
            : delivery.error,
      });

      return {
        ok: true,
        delivery: delivery.status,
      };
    },
  );
}
