/**
 * C12: GDPR data privacy routes.
 * Data export, consent management, and deletion requests.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  DeletionRequestModel,
  EventLogModel,
  InvestorProfileModel,
  SubscriptionModel,
  SuitabilityAssessmentModel,
  UserModel,
} from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { appendEvent } from "../../../utils/audit.js";
import { serialize } from "../../../utils/serialize.js";
import { runInTransaction } from "../../../utils/tx.js";
import { verifyPrivyToken } from "../../../services/privy.service.js";

export async function dataPrivacyRoutes(app: FastifyInstance) {
  // C12-1: Data export — investor can download all data held about them
  app.get(
    "/v1/investor/data-export",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      const userId = request.authUser.userId;

      const [user, profile, subscriptions, assessments, events] = await Promise.all([
        UserModel.findById(userId).select("-passwordHash -passwordResetToken -passwordResetExpires").lean(),
        InvestorProfileModel.findOne({ userId }).lean(),
        SubscriptionModel.find({ investorUserId: userId }).lean(),
        SuitabilityAssessmentModel.find({ investorUserId: userId }).lean(),
        EventLogModel.find({ actorUserId: userId }).sort({ timestamp: -1 }).limit(500).lean(),
      ]);

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(userId),
        action: "DataExportRequested",
      });

      return serialize({
        exportedAt: new Date(),
        user,
        investorProfile: profile,
        subscriptions,
        suitabilityAssessments: assessments,
        auditEvents: events,
      });
    },
  );

  // C12-2: Consent management — grant consent
  app.post(
    "/v1/user/consent",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const payload = z.object({
        type: z.string().min(1).max(100),
      }).parse(request.body);

      const user = await UserModel.findById(request.authUser.userId);
      if (!user) throw new HttpError(404, "User not found");

      const consents = user.consents ?? [];
      const existing = consents.find((c: any) => c.type === payload.type && !c.revokedAt);
      if (existing) {
        return serialize({ message: "Consent already granted", consent: existing });
      }

      consents.push({
        type: payload.type,
        grantedAt: new Date(),
        ipAddress: request.ip,
      });
      user.consents = consents;
      await user.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "ConsentGranted",
        notes: `type:${payload.type}`,
      });

      return serialize({ message: "Consent granted", type: payload.type });
    },
  );

  // C12-3: Consent management — revoke consent
  app.delete(
    "/v1/user/consent/:type",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { type } = z.object({ type: z.string() }).parse(request.params);

      const user = await UserModel.findById(request.authUser.userId);
      if (!user) throw new HttpError(404, "User not found");

      const consents = user.consents ?? [];
      const active = consents.find((c: any) => c.type === type && !c.revokedAt);
      if (!active) throw new HttpError(404, "No active consent of this type found");

      active.revokedAt = new Date();
      user.consents = consents;
      await user.save();

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(user._id),
        action: "ConsentRevoked",
        notes: `type:${type}`,
      });

      return serialize({ message: "Consent revoked", type });
    },
  );

  // C12-4: Deletion request — investor requests account deletion
  app.post(
    "/v1/investor/deletion-request",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");

      const payload = z.object({
        reason: z.string().max(2000).optional(),
      }).parse(request.body);

      const existing = await DeletionRequestModel.findOne({
        userId: request.authUser.userId,
        status: "pending",
      });
      if (existing) {
        return serialize({ message: "A deletion request is already pending", request: existing });
      }

      const deletionRequest = await DeletionRequestModel.create({
        userId: request.authUser.userId,
        reason: payload.reason,
      });

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(request.authUser.userId),
        action: "DeletionRequested",
        notes: payload.reason,
      });

      return serialize({
        message: "Deletion request submitted. An administrator will review your request.",
        request: deletionRequest,
      });
    },
  );

  // GDPR erasure fulfillment (admin). Securities records must be retained, so we
  // ANONYMIZE PII rather than hard-delete: scrub identifying fields and disable the
  // account while preserving the ledger/subscription shell for regulatory audit.
  app.post(
    "/v1/admin/deletion-requests/:id/fulfill",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const dr = await DeletionRequestModel.findById(params.id).session(session);
        if (!dr) throw new HttpError(404, "Deletion request not found");
        if (dr.status === "completed") {
          return serialize({ message: "Already fulfilled", request: dr });
        }

        const userId = String(dr.userId);

        // 1) Scrub User PII + disable + invalidate all sessions.
        await UserModel.updateOne(
          { _id: dr.userId },
          {
            $set: {
              email: `deleted-${userId}@anonymized.invalid`,
              name: "Deleted User",
              status: "disabled",
              tokenInvalidatedAt: new Date(),
            },
            $unset: { phone: "", consents: "" },
          },
        ).session(session);

        // 2) Scrub InvestorProfile PII (bank details, KYC provider identifiers,
        //    uploaded documents) but keep the profile linked to financial records.
        await InvestorProfileModel.updateOne(
          { userId: dr.userId },
          {
            $set: {
              kycStatus: "renewal_required",
              sumsubReviewAnswer: null,
              anonymizedAt: new Date(),
            },
            $unset: {
              bankAccount: "",
              sumsubApplicantId: "",
              sumsubExternalUserId: "",
              sumsubRejectLabels: "",
              documents: "",
            },
          },
        ).session(session);

        dr.status = "completed";
        dr.completedAt = new Date();
        dr.reviewedBy = request.authUser.userId as any;
        dr.reviewedAt = new Date();
        await dr.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "user",
            entityId: userId,
            action: "DeletionFulfilledAnonymized",
            notes: "PII anonymized; financial records retained for regulatory compliance.",
          },
          session,
        );

        return serialize({ message: "User data anonymized", request: dr });
      });
    },
  );

  // Link the investor's Privy embedded wallet to their profile. The verified
  // wallet address drives on-chain auto-wiring (whitelist/mint).
  app.post(
    "/v1/investor/link-wallet",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      const { privyToken } = z.object({ privyToken: z.string().min(8) }).parse(request.body);

      const { userId: privyUserId, walletAddress } = await verifyPrivyToken(privyToken);
      if (!walletAddress) throw new HttpError(422, "Privy session has no embedded wallet");

      const profile = await InvestorProfileModel.findOneAndUpdate(
        { userId: request.authUser.userId },
        { $set: { privyUserId, walletAddress } },
        { new: true },
      ).lean();
      if (!profile) throw new HttpError(404, "Investor profile not found");

      await appendEvent(request.authUser, {
        entityType: "user",
        entityId: String(request.authUser.userId),
        action: "WalletLinked",
        notes: walletAddress,
      });

      return serialize({ walletAddress, privyUserId });
    },
  );

  // C12-5: List user's consents
  app.get(
    "/v1/user/consents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const user = await UserModel.findById(request.authUser.userId).select("consents").lean();
      if (!user) throw new HttpError(404, "User not found");
      return serialize({ consents: user.consents ?? [] });
    },
  );
}
