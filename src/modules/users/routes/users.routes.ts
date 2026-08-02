import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";
import {
  BusinessModel,
  InvestorProfileModel,
  ProfessionalModel,
  UserModel,
} from "../../../db/models.js";
import { roles } from "../../../utils/constants.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";
import { requestPasswordReset } from "../../auth/services/account-security.service.js";

const createUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(2),
  role: z.enum(roles),
  businessId: z.string().optional(),
  professionalId: z.string().optional(),
});

export async function userRoutes(app: FastifyInstance) {
  app.get(
    "/v1/users",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "user");
      const query = z
        .object({
          role: z.enum(roles).optional(),
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
      if (payload.professionalId && !mongoose.isValidObjectId(payload.professionalId)) {
        throw new HttpError(400, "Invalid professionalId");
      }

      if (payload.role === "issuer") {
        if (!payload.businessId) throw new HttpError(422, "Issuer user requires businessId");
        const business = await BusinessModel.findById(payload.businessId).lean();
        if (!business) throw new HttpError(404, "Business not found");
      }
      if (payload.role === "professional") {
        if (!payload.professionalId) {
          throw new HttpError(422, "Professional user requires professionalId");
        }
        const professional = await ProfessionalModel.findById(
          payload.professionalId,
        ).lean();
        if (!professional) throw new HttpError(404, "Professional not found");
      }

      const existing = await UserModel.findOne({ email: payload.email.toLowerCase() }).lean();
      if (existing) throw new HttpError(409, "Email already exists");

      const user = await UserModel.create({
        email: payload.email.toLowerCase(),
        name: payload.name,
        role: payload.role,
        status: "active",
        businessId: payload.role === "issuer" ? payload.businessId : undefined,
        professionalId:
          payload.role === "professional"
            ? payload.professionalId
            : undefined,
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
      const payload = z
        .object({
          role: z.enum(roles),
          professionalId: z.string().optional(),
        })
        .parse(request.body);

      const user = await UserModel.findById(params.id);
      if (!user) throw new HttpError(404, "User not found");

      user.role = payload.role;
      if (payload.role !== "issuer") {
        user.businessId = undefined;
      }
      if (payload.role === "professional") {
        if (payload.professionalId && !mongoose.isValidObjectId(payload.professionalId)) {
          throw new HttpError(400, "Invalid professionalId");
        }

        const professionalId = payload.professionalId ?? user.professionalId?.toString();
        if (!professionalId) {
          throw new HttpError(422, "Professional user requires professionalId");
        }
        const professional = await ProfessionalModel.findById(professionalId).lean();
        if (!professional) throw new HttpError(404, "Professional not found");
        user.professionalId = professionalId as any;
      } else {
        user.professionalId = undefined;
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
      if (typeof user.email !== "string" || user.email.trim().length === 0) {
        throw new HttpError(422, "User has no email address on file");
      }

      // Use the real password-reset flow: generates a persisted, single-use,
      // time-boxed token (hashed at rest) and emails a reset link.
      await requestPasswordReset(user.email);

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "Password reset requested",
        notes: "Admin-initiated; reset link emailed to user.",
      });

      return { ok: true };
    },
  );

  // Per-user preferences (settings pages persist here).
  app.get(
    "/v1/users/me/preferences",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = await UserModel.findById(request.authUser.userId).select("preferences").lean();
      if (!user) throw new HttpError(404, "User not found");
      return { preferences: user.preferences ?? {} };
    },
  );

  app.put(
    "/v1/users/me/preferences",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const payload = z.object({ preferences: z.record(z.string(), z.any()) }).parse(request.body);
      const user = await UserModel.findByIdAndUpdate(
        request.authUser.userId,
        { $set: { preferences: payload.preferences } },
        { new: true },
      )
        .select("preferences")
        .lean();
      if (!user) throw new HttpError(404, "User not found");
      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(request.authUser.userId),
        action: "PreferencesUpdated",
      });
      return { preferences: user.preferences ?? {} };
    },
  );
}
