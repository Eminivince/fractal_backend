import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvestorProfileModel, UserModel } from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";

const submitKycSchema = z.object({
  eligibility: z.enum(["retail", "sophisticated", "institutional"]).optional(),
  documents: z
    .array(
      z.object({
        type: z.string().min(2),
        filename: z.string().min(2),
      }),
    )
    .optional(),
});

export async function investorRoutes(app: FastifyInstance) {
  app.get(
    "/v1/investor/profiles",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "investor_profile");
      const query = z
        .object({
          userId: z.string().optional(),
          kycStatus: z.enum(["draft", "submitted", "in_review", "approved", "rejected"]).optional(),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {};
      if (request.authUser.role === "investor") {
        filter.userId = request.authUser.userId;
      } else if (query.userId) {
        filter.userId = query.userId;
      }
      if (query.kycStatus) filter.kycStatus = query.kycStatus;

      const rows = await InvestorProfileModel.find(filter).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/investor/profile",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "read", "investor_profile");

      const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId }).lean();
      if (!profile) throw new HttpError(404, "Investor profile not found");
      return serialize(profile);
    },
  );

  app.post(
    "/v1/investor/kyc/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "submit", "investor_profile");
      const payload = submitKycSchema.parse(request.body);

      const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId });
      if (!profile) throw new HttpError(404, "Investor profile not found");

      profile.kycStatus = "in_review";
      if (payload.eligibility) profile.eligibility = payload.eligibility;
      if (payload.documents?.length) {
        profile.documents = payload.documents.map((doc) => ({
          docId: `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: doc.type,
          filename: doc.filename,
        }));
      }

      await profile.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: request.authUser.userId,
        action: "KYC submitted",
      });

      return serialize(profile.toObject());
    },
  );

  app.post(
    "/v1/investor/kyc/approve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "approve", "investor_profile");

      const payload = z.object({ investorUserId: z.string() }).parse(request.body);

      const user = await UserModel.findById(payload.investorUserId).lean();
      if (!user) throw new HttpError(404, "User not found");
      if (user.role !== "investor") throw new HttpError(422, "User is not an investor");

      const profile = await InvestorProfileModel.findOneAndUpdate(
        { userId: payload.investorUserId },
        { kycStatus: "approved" },
        { new: true },
      ).lean();
      if (!profile) throw new HttpError(404, "Investor profile not found");

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: payload.investorUserId,
        action: "KYC approved",
      });

      return serialize(profile);
    },
  );

  app.post(
    "/v1/investor/kyc/reject",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "approve", "investor_profile");

      const payload = z.object({ investorUserId: z.string(), reason: z.string().optional() }).parse(request.body);

      const user = await UserModel.findById(payload.investorUserId).lean();
      if (!user) throw new HttpError(404, "User not found");
      if (user.role !== "investor") throw new HttpError(422, "User is not an investor");

      const profile = await InvestorProfileModel.findOneAndUpdate(
        { userId: payload.investorUserId },
        { kycStatus: "rejected" },
        { new: true },
      ).lean();
      if (!profile) throw new HttpError(404, "Investor profile not found");

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: payload.investorUserId,
        action: "KYC rejected",
        notes: payload.reason,
      });

      return serialize(profile);
    },
  );
}
