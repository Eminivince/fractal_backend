import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";
import {
  IdempotencyKeyModel,
  InvestorProfileModel,
  OfferingModel,
  PlatformConfigModel,
  SubscriptionModel,
} from "../../db/models.js";
import { toDecimal } from "../../utils/decimal.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { assertTransition } from "../../utils/state-machine.js";
import { assertInvestorScope, assertIssuerBusinessScope } from "../../utils/scope.js";
import { runInTransaction } from "../../utils/tx.js";
import { serialize } from "../../utils/serialize.js";

const subscribeSchema = z.object({ amount: z.number().positive() });

function hashPayload(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toString" in value) return Number(value.toString());
  return Number(value ?? 0);
}

async function recalcOfferingMetrics(offeringId: string, session: mongoose.ClientSession) {
  const liveStatuses = ["committed", "pending_payment", "paid"];
  const [aggregate] = await SubscriptionModel.aggregate([
    { $match: { offeringId: new mongoose.Types.ObjectId(offeringId), status: { $in: liveStatuses } } },
    {
      $group: {
        _id: "$offeringId",
        subscribedAmount: { $sum: "$amount" },
        investors: { $addToSet: "$investorUserId" },
      },
    },
  ]).session(session);

  const subscribedAmount = aggregate?.subscribedAmount ? toDecimal(aggregate.subscribedAmount.toString()) : toDecimal(0);
  const investorCount = Array.isArray(aggregate?.investors) ? aggregate.investors.length : 0;

  await OfferingModel.findByIdAndUpdate(
    offeringId,
    {
      "metrics.subscribedAmount": subscribedAmount,
      "metrics.investorCount": investorCount,
    },
    { session },
  );
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings/:id/subscribe",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      authorize(request.authUser, "create", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = subscribeSchema.parse(request.body);

      const key = request.headers["idempotency-key"];
      const route = `POST:/v1/offerings/${params.id}/subscribe`;
      const requestHash = hashPayload({ offeringId: params.id, ...payload });

      if (typeof key === "string" && key.trim().length > 0) {
        const existing = await IdempotencyKeyModel.findOne({
          key,
          userId: request.authUser.userId,
          route,
        }).lean();

        if (existing) {
          if (existing.requestHash !== requestHash) {
            throw new HttpError(409, "Idempotency key already used with different payload");
          }
          return existing.responseBody;
        }
      }

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");
        if (offering.status !== "open") throw new HttpError(422, "Offering is not open for subscription");

        const config = await PlatformConfigModel.findById("platform_config").session(session);
        if (!config) throw new HttpError(404, "Platform config not found");

        if (config.complianceRules.requireKycToSubscribe) {
          const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId }).session(session);
          if (!profile || profile.kycStatus !== "approved") {
            throw new HttpError(403, "KYC required before subscribing");
          }
        }

        const minByTemplate =
          offering.templateCode === "A"
            ? toNumber(config.complianceRules.minInvestmentByTemplate.A)
            : toNumber(config.complianceRules.minInvestmentByTemplate.B);

        const minTicket = toNumber((offering.terms as Record<string, unknown>).minTicket);
        const effectiveMin = Math.max(minByTemplate, minTicket || 0);
        if (payload.amount < effectiveMin) {
          throw new HttpError(422, `Minimum subscription is ${effectiveMin}`);
        }

        const [subscription] = await SubscriptionModel.create(
          [
            {
              offeringId: offering._id,
              investorUserId: request.authUser.userId,
              amount: toDecimal(payload.amount),
              status: "committed",
            },
          ],
          { session },
        );

        const currentSubscribed = toNumber(offering.metrics.subscribedAmount);
        const nextSubscribed = currentSubscribed + payload.amount;
        offering.metrics.subscribedAmount = toDecimal(nextSubscribed);
        offering.metrics.investorCount = await SubscriptionModel.countDocuments({
          offeringId: offering._id,
          status: { $in: ["committed", "pending_payment", "paid"] },
        }).session(session);
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "Subscription created",
            notes: `offering:${params.id}`,
          },
          session,
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: params.id,
            action: "Investor subscribed",
            notes: String(payload.amount),
          },
          session,
        );

        const responseBody = serialize(subscription.toObject());

        if (typeof key === "string" && key.trim().length > 0) {
          await IdempotencyKeyModel.create(
            [
              {
                key,
                userId: request.authUser.userId,
                route,
                requestHash,
                responseBody,
                createdAt: new Date(),
              },
            ],
            { session },
          );
        }

        return responseBody;
      });
    },
  );

  app.get(
    "/v1/subscriptions",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "subscription");
      const query = z.object({ offeringId: z.string().optional() }).parse(request.query);

      if (request.authUser.role === "investor") {
        const filter: Record<string, unknown> = { investorUserId: request.authUser.userId };
        if (query.offeringId) filter.offeringId = query.offeringId;
        const rows = await SubscriptionModel.find(filter).sort({ createdAt: -1 }).lean();
        return serialize(rows);
      }

      if (request.authUser.role === "issuer") {
        const offeringFilter: Record<string, unknown> = { businessId: request.authUser.businessId };
        if (query.offeringId) offeringFilter._id = query.offeringId;

        const issuerOfferings = await OfferingModel.find(offeringFilter).select("_id name status").lean();
        const ids = issuerOfferings.map((item: any) => item._id);

        const aggregate = await SubscriptionModel.aggregate([
          { $match: { offeringId: { $in: ids } } },
          {
            $group: {
              _id: "$offeringId",
              totalAmount: { $sum: "$amount" },
              totalCount: { $sum: 1 },
              paidCount: { $sum: { $cond: [{ $eq: ["$status", "paid"] }, 1, 0] } },
            },
          },
        ]);

        return serialize(
          aggregate.map((item: any) => {
            const offering = issuerOfferings.find((row: any) => String(row._id) === String(item._id));
            return {
              offeringId: String(item._id),
              offeringName: offering?.name,
              totalAmount: item.totalAmount,
              totalCount: item.totalCount,
              paidCount: item.paidCount,
            };
          }),
        );
      }

      const filter: Record<string, unknown> = {};
      if (query.offeringId) filter.offeringId = query.offeringId;
      const rows = await SubscriptionModel.find(filter).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );

  app.post(
    "/v1/subscriptions/:id/mark-paid",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");

        assertTransition("subscription", subscription.status as any, "paid");
        subscription.status = "paid";
        await subscription.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "Subscription marked paid",
          },
          session,
        );

        return serialize(subscription.toObject());
      });
    },
  );

  app.post(
    "/v1/subscriptions/:id/cancel",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");

        if (request.authUser.role === "investor") {
          assertInvestorScope(request.authUser, String(subscription.investorUserId));
        }

        if (request.authUser.role === "issuer") {
          const offering = await OfferingModel.findById(subscription.offeringId).session(session);
          if (!offering) throw new HttpError(404, "Offering not found");
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        assertTransition("subscription", subscription.status as any, "cancelled");
        subscription.status = "cancelled";
        await subscription.save({ session });

        await recalcOfferingMetrics(String(subscription.offeringId), session);

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "Subscription cancelled",
          },
          session,
        );

        return serialize(subscription.toObject());
      });
    },
  );

  app.post(
    "/v1/subscriptions/:id/refund",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");

        assertTransition("subscription", subscription.status as any, "refunded");
        subscription.status = "refunded";
        await subscription.save({ session });

        await recalcOfferingMetrics(String(subscription.offeringId), session);

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "Subscription refunded",
          },
          session,
        );

        return serialize(subscription.toObject());
      });
    },
  );
}
