import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { InvestorProfileModel, OfferingModel, SubscriptionModel, WebhookEventModel } from "../../../db/models.js";
import { env } from "../../../config/env.js";
import { InboxPayloadConflictError, receiveInboxEvent } from "../../../platform/postgres-inbox.js";
import { recordSumsubIdentityVerificationEvidence } from "../../../platform/postgres-provider-identity-verification.js";
import { isOnchainEnabled, autowireKycWhitelist } from "../../../services/onchain-autowire.js";
import { initiateAmlCheck, parseAmlWebhookResult } from "../../../services/sumsub-aml.service.js";
import { verifySumsubWebhookSignature } from "../../../services/sumsub.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { appendEvent } from "../../../utils/audit.js";

const SYSTEM_ACTOR = { userId: "system", role: "admin" as const, email: "system@fractal", businessId: undefined };

const sumsubPayloadSchema = z.object({
  type: z.string().min(1), applicantId: z.string().min(1), inspectionId: z.string().optional(),
  externalUserId: z.string().min(1), reviewStatus: z.string().optional(),
  reviewResult: z.object({ reviewAnswer: z.enum(["GREEN", "RED"]), rejectLabels: z.array(z.string()).optional(), clientComment: z.string().optional() }).optional(),
  createdAtMs: z.string().optional(),
}).passthrough();
type SumsubWebhookPayload = z.infer<typeof sumsubPayloadSchema>;

export class SumsubInboxPayloadError extends Error {}

function externalEventId(event: SumsubWebhookPayload, rawBody: string) {
  return `${event.applicantId}:${event.type}:${event.createdAtMs ?? createHash("sha256").update(rawBody).digest("hex")}`;
}

async function markMongoWebhookProcessed(id: string) {
  await WebhookEventModel.updateOne({ _id: id }, { $set: { status: "processed", processedAt: new Date(), errorMessage: undefined } });
}

/**
 * Worker-owned Sumsub side effects. A durable PostgreSQL inbox must accept the
 * signed event before this function can run. Production records verified
 * provider evidence in PostgreSQL but never lets it mutate the retired Mongo
 * KYC authority or launch an automatic chain side effect: a governed human
 * compliance decision remains the only way to approve an investor profile.
 */
export async function processSumsubInboxEvent(input: {
  app: FastifyInstance; payload: unknown; externalEventId: string; rawBody: string; signature: string; receivedAt?: Date;
}): Promise<void> {
  const parsed = sumsubPayloadSchema.safeParse(input.payload);
  if (!parsed.success) throw new SumsubInboxPayloadError("Stored Sumsub inbox payload is malformed");
  const event = parsed.data;
  const { app } = input;

  if (env.SUMSUB_INBOX_ENABLED) {
    const evidence = await recordSumsubIdentityVerificationEvidence({
      externalEventId: input.externalEventId,
      externalUserId: event.externalUserId,
      applicantId: event.applicantId,
      eventType: event.type,
      reviewStatus: event.reviewStatus,
      reviewAnswer: event.reviewResult?.reviewAnswer,
      rejectLabels: event.reviewResult?.rejectLabels,
      createdAtMs: event.createdAtMs,
      rawPayload: input.rawBody,
      receivedAt: input.receivedAt,
    });
    app.log.info(
      { type: event.type, applicantId: event.applicantId, matchedIdentity: Boolean(evidence.identityId), duplicate: evidence.duplicate },
      "Sumsub identity-verification evidence recorded for governed review",
    );
  }

  if (env.NODE_ENV === "production") return;

  const existing = await WebhookEventModel.findOneAndUpdate(
    { provider: "sumsub", externalId: input.externalEventId },
    { $setOnInsert: { provider: "sumsub", eventType: event.type, externalId: input.externalEventId, rawPayload: input.rawBody, signature: input.signature, receivedAt: new Date(), status: "received" } },
    { upsert: true, new: true },
  );
  const storedWebhookId = String(existing._id);
  if (existing.status === "processed") return;

  app.log.info({ type: event.type, applicantId: event.applicantId, externalUserId: event.externalUserId }, "Sumsub inbox event processing");
  const profile = await InvestorProfileModel.findOne({ $or: [{ sumsubApplicantId: event.applicantId }, { sumsubExternalUserId: event.externalUserId }] });

  if (!profile) {
    app.log.warn({ applicantId: event.applicantId, externalUserId: event.externalUserId }, "No investor profile found for Sumsub webhook");
    await markMongoWebhookProcessed(storedWebhookId);
    return;
  }

  if (event.type === "applicantReviewed" && event.reviewResult) {
    const answer = event.reviewResult.reviewAnswer;
    profile.sumsubReviewAnswer = answer;
    profile.sumsubRejectLabels = event.reviewResult.rejectLabels ?? [];
    profile.sumsubReviewedAt = new Date();
    if (answer === "GREEN") {
      const newlyApproved = profile.kycStatus !== "approved";
      profile.kycStatus = "approved";
      profile.kycApprovedAt = new Date();
      await profile.save();
      if (newlyApproved) {
        try {
          await initiateAmlCheck(event.applicantId);
          app.log.info({ applicantId: event.applicantId }, "AML check initiated after KYC approval");
        } catch (error) {
          // AML dispatch is an external follow-up. The KYC evidence remains
          // durable; this legacy follow-up is retried by its own process today.
          app.log.error({ applicantId: event.applicantId, err: error }, "Failed to initiate AML check");
        }
        await createNotificationsFromEvent(SYSTEM_ACTOR as any, { entityType: "user", entityId: String(profile.userId), action: "KYCApproved", notes: "Your identity verification has been approved via Sumsub." });
        await appendEvent(SYSTEM_ACTOR as any, { entityType: "user", entityId: String(profile.userId), action: "KYCApproved", notes: `Sumsub auto-approved (applicantId: ${event.applicantId})` });
        if (isOnchainEnabled() && profile.walletAddress) {
          const subs = await SubscriptionModel.find({ investorUserId: profile.userId, status: { $in: ["paid", "allocation_confirmed"] } }).select("offeringId").lean();
          const offeringIds = [...new Set(subs.map((subscription: any) => String(subscription.offeringId)))];
          const offerings = await OfferingModel.find({ _id: { $in: offeringIds } }).select("tokenDeployment").lean();
          const tokenContractAddresses = offerings.map((offering: any) => offering.tokenDeployment?.status === "deployed" ? offering.tokenDeployment.contractAddress : undefined).filter((address: unknown): address is string => typeof address === "string");
          await autowireKycWhitelist({ investorProfileId: String(profile._id), walletAddress: profile.walletAddress, tokenContractAddresses });
        }
      }
    } else {
      const newlyRejected = profile.kycStatus !== "rejected";
      profile.kycStatus = "rejected";
      await profile.save();
      if (newlyRejected) {
        const reason = event.reviewResult.clientComment ?? event.reviewResult.rejectLabels?.join(", ") ?? "Verification failed";
        await createNotificationsFromEvent(SYSTEM_ACTOR as any, { entityType: "user", entityId: String(profile.userId), action: "KYCRejected", notes: `Your identity verification was not approved: ${reason}` });
        await appendEvent(SYSTEM_ACTOR as any, { entityType: "user", entityId: String(profile.userId), action: "KYCRejected", notes: `Sumsub rejected (applicantId: ${event.applicantId}): ${reason}` });
      }
    }
  } else if (event.type === "applicantPending" && profile.kycStatus !== "approved" && profile.kycStatus !== "rejected") {
    profile.kycStatus = "in_review";
    await profile.save();
  }

  if (event.type === "applicantReviewed") {
    const amlResult = parseAmlWebhookResult({ type: event.type, applicantId: event.applicantId, reviewResult: event.reviewResult });
    if (amlResult && profile.amlStatus === "pending") {
      profile.amlStatus = amlResult.status;
      profile.amlCheckedAt = new Date();
      await profile.save();
      await appendEvent(SYSTEM_ACTOR as any, { entityType: "user", entityId: String(profile.userId), action: "AMLScreeningCompleted", notes: `AML status: ${amlResult.status} (applicantId: ${event.applicantId})` });
    }
  }
  await markMongoWebhookProcessed(storedWebhookId);
}

export async function sumsubWebhookRoutes(app: FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as any).rawBody = body;
    try { done(null, JSON.parse(body as string)); } catch (error) { done(error as Error); }
  });

  app.post("/v1/webhooks/sumsub", {}, async (request: FastifyRequest, reply) => {
    if (!env.SUMSUB_ENABLED) {
      return reply.status(env.NODE_ENV === "production" ? 503 : 200).send(
        env.NODE_ENV === "production" ? { error: "Identity-verification webhook is not enabled" } : { ok: true },
      );
    }
    const rawBody = (request as any).rawBody as string | undefined;
    if (!rawBody) return reply.status(400).send({ error: "Raw body unavailable" });
    const signature = request.headers["x-payload-digest"] ?? request.headers["x-sumsub-signature"];
    if (typeof signature !== "string") return reply.status(401).send({ error: "Missing signature header" });
    if (!verifySumsubWebhookSignature(rawBody, signature)) return reply.status(401).send({ error: "Invalid signature" });
    const event = request.body as unknown;
    const parsed = sumsubPayloadSchema.safeParse(event);
    if (!parsed.success) return reply.status(400).send({ error: "Malformed Sumsub payload" });
    const id = externalEventId(parsed.data, rawBody);

    if (!env.SUMSUB_INBOX_ENABLED) {
      if (env.NODE_ENV === "production") {
        return reply.status(503).send({ error: "Identity-verification webhook intake is not configured" });
      }
      await processSumsubInboxEvent({ app, payload: parsed.data, externalEventId: id, rawBody, signature });
      return reply.status(200).send({ ok: true, legacy: true });
    }
    try {
      const accepted = await receiveInboxEvent({ provider: "sumsub", externalEventId: id, payload: { event: parsed.data, rawBody, signature } });
      return reply.status(200).send({ ok: true, queued: true, deduplicated: accepted.duplicate });
    } catch (error) {
      if (error instanceof InboxPayloadConflictError) {
        app.log.error({ err: error, externalEventId: id }, "Conflicting Sumsub webhook replay");
        return reply.status(409).send({ error: "Conflicting webhook replay" });
      }
      app.log.error({ err: error, externalEventId: id }, "Unable to durably accept Sumsub webhook");
      return reply.status(503).send({ error: "Webhook intake unavailable" });
    }
  });
}
