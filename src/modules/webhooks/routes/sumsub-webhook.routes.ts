import type { FastifyInstance, FastifyRequest } from "fastify";
import { InvestorProfileModel } from "../../../db/models.js";
import { appendEvent } from "../../../utils/audit.js";
import { verifySumsubWebhookSignature } from "../../../services/sumsub.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { initiateAmlCheck, parseAmlWebhookResult } from "../../../services/sumsub-aml.service.js";
import { env } from "../../../config/env.js";

const SYSTEM_ACTOR = {
  userId: "system",
  role: "admin" as const,
  email: "system@fractal",
  businessId: undefined,
};

interface SumsubWebhookPayload {
  type: string;
  applicantId: string;
  inspectionId?: string;
  externalUserId: string;
  reviewStatus?: string;
  reviewResult?: {
    reviewAnswer: "GREEN" | "RED";
    rejectLabels?: string[];
    clientComment?: string;
  };
  createdAtMs?: string;
}

export async function sumsubWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      done(err as Error);
    }
  });

  app.post(
    "/v1/webhooks/sumsub",
    {},
    async (request: FastifyRequest, reply) => {
      if (!env.SUMSUB_ENABLED) {
        return reply.status(200).send({ ok: true });
      }

      const rawBody = (request as any).rawBody as string | undefined;
      if (!rawBody) {
        return reply.status(400).send({ error: "Raw body unavailable" });
      }

      const digestHeader = request.headers["x-payload-digest"] ?? request.headers["x-sumsub-signature"];
      if (typeof digestHeader !== "string") {
        return reply.status(401).send({ error: "Missing signature header" });
      }
      if (!verifySumsubWebhookSignature(rawBody, digestHeader)) {
        return reply.status(401).send({ error: "Invalid signature" });
      }

      const event = request.body as SumsubWebhookPayload;
      const { type, applicantId, externalUserId, reviewResult } = event;

      app.log.info({ type, applicantId, externalUserId }, "Sumsub webhook received");

      if (type === "applicantReviewed" || type === "applicantPending") {
        const profile = await InvestorProfileModel.findOne({
          $or: [
            { sumsubApplicantId: applicantId },
            { sumsubExternalUserId: externalUserId },
          ],
        });

        if (!profile) {
          app.log.warn({ applicantId, externalUserId }, "No investor profile found for Sumsub webhook");
          return reply.status(200).send({ ok: true });
        }

        if (type === "applicantReviewed" && reviewResult) {
          const answer = reviewResult.reviewAnswer;

          profile.sumsubReviewAnswer = answer;
          profile.sumsubRejectLabels = reviewResult.rejectLabels ?? [];
          profile.sumsubReviewedAt = new Date();

          if (answer === "GREEN") {
            profile.kycStatus = "approved";
            profile.kycApprovedAt = new Date();
            await profile.save();

            // 2.4: Trigger AML screening when KYC is approved
            try {
              await initiateAmlCheck(applicantId);
              app.log.info({ applicantId }, "AML check initiated after KYC approval");
            } catch (amlErr) {
              app.log.error({ applicantId, err: amlErr }, "Failed to initiate AML check");
            }

            await createNotificationsFromEvent(SYSTEM_ACTOR as any, {
              entityType: "user",
              entityId: String(profile.userId),
              action: "KYCApproved",
              notes: "Your identity verification has been approved via Sumsub.",
            });

            await appendEvent(SYSTEM_ACTOR as any, {
              entityType: "user",
              entityId: String(profile.userId),
              action: "KYCApproved",
              notes: `Sumsub auto-approved (applicantId: ${applicantId})`,
            });
          } else if (answer === "RED") {
            profile.kycStatus = "rejected";
            await profile.save();

            const rejectReason = reviewResult.clientComment
              ?? reviewResult.rejectLabels?.join(", ")
              ?? "Verification failed";

            await createNotificationsFromEvent(SYSTEM_ACTOR as any, {
              entityType: "user",
              entityId: String(profile.userId),
              action: "KYCRejected",
              notes: `Your identity verification was not approved: ${rejectReason}`,
            });

            await appendEvent(SYSTEM_ACTOR as any, {
              entityType: "user",
              entityId: String(profile.userId),
              action: "KYCRejected",
              notes: `Sumsub rejected (applicantId: ${applicantId}): ${rejectReason}`,
            });
          }
        } else if (type === "applicantPending") {
          if (profile.kycStatus !== "approved" && profile.kycStatus !== "rejected") {
            profile.kycStatus = "in_review";
            await profile.save();
          }
        }
      }

      // 2.4: Handle AML screening results (Sumsub sends these via same webhook)
      if (type === "applicantReviewed") {
        const amlResult = parseAmlWebhookResult({ type, applicantId, reviewResult });
        if (amlResult) {
          const amlProfile = await InvestorProfileModel.findOne({
            $or: [
              { sumsubApplicantId: applicantId },
              { sumsubExternalUserId: externalUserId },
            ],
          });
          if (amlProfile && amlProfile.amlStatus === "pending") {
            amlProfile.amlStatus = amlResult.status;
            amlProfile.amlCheckedAt = new Date();
            await amlProfile.save();

            await appendEvent(SYSTEM_ACTOR as any, {
              entityType: "user",
              entityId: String(amlProfile.userId),
              action: "AMLScreeningCompleted",
              notes: `AML status: ${amlResult.status} (applicantId: ${applicantId})`,
            });
          }
        }
      }

      return reply.status(200).send({ ok: true });
    },
  );
}
