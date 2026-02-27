import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvestorProfileModel, UserModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";
import { env } from "../../../config/env.js";
import { createPaystackTransferRecipient } from "../../../services/paystack.js";
import { persistKycBinary, retrieveFile } from "../../../services/storage.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { createApplicant, generateAccessToken } from "../../../services/sumsub.js";

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
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {};
      if (request.authUser.role === "investor") {
        filter.userId = request.authUser.userId;
      } else if (query.userId) {
        filter.userId = query.userId;
      }
      if (query.kycStatus) filter.kycStatus = query.kycStatus;

      const page = query.page;
      const limit = query.limit;
      const skip = (page - 1) * limit;

      const [rows, total] = await Promise.all([
        InvestorProfileModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        InvestorProfileModel.countDocuments(filter),
      ]);
      return serialize({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
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
    "/v1/investor/bank-account",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "update", "investor_profile");

      const payload = z
        .object({
          accountNumber: z.string().min(10).max(10),
          bankCode: z.string().min(3).max(10),
          accountName: z.string().min(3),
        })
        .parse(request.body);

      const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId });
      if (!profile) throw new HttpError(404, "Investor profile not found. Please complete KYC first.");

      let recipientCode: string | undefined;
      if (env.PAYSTACK_ENABLED) {
        try {
          const recipient = await createPaystackTransferRecipient({
            name: payload.accountName,
            accountNumber: payload.accountNumber,
            bankCode: payload.bankCode,
          });
          recipientCode = recipient.recipient_code;
        } catch (err: any) {
          throw new HttpError(422, `Bank account verification failed: ${err.message}`);
        }
      }

      profile.bankAccount = {
        accountNumber: payload.accountNumber,
        bankCode: payload.bankCode,
        accountName: payload.accountName,
        recipientCode,
        verifiedAt: new Date(),
      };
      await profile.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: request.authUser.userId,
        action: "BankAccountRegistered",
        notes: `bank:${payload.bankCode}`,
      });

      return serialize(profile.toObject());
    },
  );

  app.post(
    "/v1/investor/kyc/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "submit", "investor_profile");
      const payload = submitKycSchema.parse(request.body);

      const profile = await InvestorProfileModel.findOneAndUpdate(
        { userId: request.authUser.userId },
        {
          $setOnInsert: {
            userId: request.authUser.userId,
            kycStatus: "draft",
            eligibility: "retail",
            documents: [],
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
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
      await UserModel.findByIdAndUpdate(request.authUser.userId, {
        $set: { investorProfileId: profile._id },
      });

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

      await createNotificationsFromEvent(request.authUser, {
        entityType: "user",
        entityId: payload.investorUserId,
        action: "KYCApproved",
        notes: "Your identity verification (KYC) has been approved.",
      });

      return serialize(profile);
    },
  );

  app.post(
    "/v1/investor/kyc/documents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "update", "investor_profile");

      const payload = z
        .object({
          type: z.string().min(2),
          filename: z.string().min(2),
          contentBase64: z.string().min(8),
          mimeType: z.string().optional(),
        })
        .parse(request.body);

      const profile = await InvestorProfileModel.findOneAndUpdate(
        { userId: request.authUser.userId },
        { $setOnInsert: { userId: request.authUser.userId, kycStatus: "draft", eligibility: "retail", documents: [] } },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      if (!profile) throw new HttpError(404, "Investor profile not found");

      const persisted = await persistKycBinary({
        investorUserId: request.authUser.userId,
        filename: payload.filename,
        contentBase64: payload.contentBase64,
        mimeType: payload.mimeType,
      });

      const docId = `doc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      profile.documents.push({
        docId,
        type: payload.type,
        filename: payload.filename,
        mimeType: payload.mimeType,
        storageKey: persisted.storageKey,
        uploadedAt: new Date(),
      } as any);

      await profile.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: request.authUser.userId,
        action: "KYC document uploaded",
        notes: `${payload.type}: ${payload.filename}`,
      });

      const doc = profile.documents[profile.documents.length - 1];
      return serialize(doc?.toObject ? doc.toObject() : doc);
    },
  );

  app.get(
    "/v1/investor/kyc/documents/:docId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "investor_profile");
      const params = z.object({ docId: z.string() }).parse(request.params);

      let profile: any;
      if (request.authUser.role === "investor") {
        profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId }).lean();
      } else if (["operator", "admin"].includes(request.authUser.role)) {
        const query = z.object({ investorUserId: z.string().optional() }).parse(request.query);
        if (!query.investorUserId) throw new HttpError(400, "investorUserId query param required for operator/admin");
        profile = await InvestorProfileModel.findOne({ userId: query.investorUserId }).lean();
      } else {
        throw new HttpError(403, "Forbidden");
      }

      if (!profile) throw new HttpError(404, "Investor profile not found");

      const doc = (profile.documents ?? []).find((d: any) => d.docId === params.docId);
      if (!doc) throw new HttpError(404, "Document not found");
      if (!doc.storageKey) throw new HttpError(404, "Document file was not persisted");

      const { buffer, redirectUrl } = await retrieveFile(doc.storageKey);

      if (redirectUrl) {
        return reply.redirect(redirectUrl, 302);
      }

      const mimeType = doc.mimeType ?? "application/octet-stream";
      reply.header("Content-Type", mimeType);
      reply.header("Content-Disposition", `attachment; filename="${doc.filename}"`);
      reply.header("Content-Length", buffer.length);
      return reply.send(buffer);
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

      await createNotificationsFromEvent(request.authUser, {
        entityType: "user",
        entityId: payload.investorUserId,
        action: "KYCRejected",
        notes: payload.reason ?? "Your identity verification (KYC) was not approved. Please resubmit with correct documents.",
      });

      return serialize(profile);
    },
  );

  app.post(
    "/v1/investor/kyc/sumsub/access-token",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");

      if (!env.SUMSUB_ENABLED) {
        throw new HttpError(503, "Sumsub KYC is not enabled");
      }

      const externalUserId = request.authUser.userId;

      let profile = await InvestorProfileModel.findOneAndUpdate(
        { userId: request.authUser.userId },
        {
          $setOnInsert: {
            userId: request.authUser.userId,
            kycStatus: "draft",
            eligibility: "retail",
            documents: [],
          },
        },
        { new: true, upsert: true, setDefaultsOnInsert: true },
      );
      if (!profile) throw new HttpError(500, "Could not create investor profile");

      await UserModel.findByIdAndUpdate(request.authUser.userId, {
        $set: { investorProfileId: profile._id },
      });

      if (!profile.sumsubApplicantId) {
        const user = await UserModel.findById(request.authUser.userId);
        const email = user?.email ?? `${externalUserId}@investor.fractal`;
        const applicant = await createApplicant(externalUserId, email);
        profile.sumsubApplicantId = applicant.id;
        profile.sumsubExternalUserId = externalUserId;
        if (profile.kycStatus === "draft") {
          profile.kycStatus = "in_review";
        }
        await profile.save();
      }

      const result = await generateAccessToken(externalUserId, env.SUMSUB_LEVEL_NAME);

      return {
        token: result.token,
        applicantId: profile.sumsubApplicantId,
        externalUserId,
      };
    },
  );

  // 4.1: Accreditation status
  app.get(
    "/v1/investor/accreditation/status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId }).lean();
      if (!profile) throw new HttpError(404, "Investor profile not found");
      return serialize({
        accreditationStatus: (profile as any).accreditationStatus ?? "unverified",
        accreditationDocs: (profile as any).accreditationDocs ?? [],
      });
    },
  );

  // 4.1: Submit accreditation docs
  app.post(
    "/v1/investor/accreditation/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      const payload = z.object({
        docs: z.array(z.object({
          docType: z.string().min(1),
          storageKey: z.string().min(1),
          expiresAt: z.string().optional(),
        })).min(1),
      }).parse(request.body);

      const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId });
      if (!profile) throw new HttpError(404, "Investor profile not found. Complete KYC first.");

      profile.accreditationDocs = payload.docs.map((d) => ({
        docType: d.docType,
        storageKey: d.storageKey,
        uploadedAt: new Date(),
        expiresAt: d.expiresAt ? new Date(d.expiresAt) : undefined,
      }));
      profile.accreditationStatus = "pending";
      await profile.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: request.authUser.userId,
        action: "AccreditationSubmitted",
      });

      return serialize(profile.toObject());
    },
  );

  // 4.1: Admin verify accreditation
  app.post(
    "/v1/investor/accreditation/:id/verify",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) throw new HttpError(403, "Admin role required");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({
        decision: z.enum(["verified", "rejected"]),
        notes: z.string().optional(),
      }).parse(request.body);

      const profile = await InvestorProfileModel.findOne({ userId: id });
      if (!profile) throw new HttpError(404, "Investor profile not found");

      profile.accreditationStatus = payload.decision;
      if (payload.decision === "verified") {
        profile.accreditationVerifiedAt = new Date();
        profile.accreditationVerifiedBy = request.authUser.userId;
      }
      await profile.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: id,
        action: payload.decision === "verified" ? "AccreditationVerified" : "AccreditationRejected",
        notes: payload.notes,
      });

      return serialize(profile.toObject());
    },
  );
}
