import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";
import {
  EscrowReceiptModel,
  InvestorProfileModel,
  LedgerEntryModel,
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
import { readCommandId, runIdempotentCommand } from "../../utils/idempotency.js";

const subscribeSchema = z.object({ amount: z.number().positive() });

const paymentReceiptSchema = z.object({
  externalRef: z.string().min(6),
  source: z.enum(["bank", "onchain", "provider"]),
  occurredAt: z.string().optional(),
  payerRef: z.string().optional(),
  currency: z.string().min(3).max(5).default("NGN"),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toString" in value) return Number(value.toString());
  return Number(value ?? 0);
}

function readIdempotencyKey(headers: FastifyRequest["headers"]): string | undefined {
  const raw = headers["idempotency-key"];
  if (!raw) return readCommandId(headers);
  const key = Array.isArray(raw) ? raw[0] : raw;
  return key?.trim() || readCommandId(headers);
}

async function recalcOfferingMetrics(offeringId: string, session: mongoose.ClientSession) {
  const liveStatuses = ["committed", "payment_pending", "paid", "allocation_confirmed"];
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
      const commandId = readIdempotencyKey(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/subscribe",
        payload: { offeringId: params.id, amount: payload.amount },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");
            if (offering.status !== "open") throw new HttpError(422, "Offering is not open for subscription");

            const config = await PlatformConfigModel.findById("platform_config").session(session);
            if (!config) throw new HttpError(404, "Platform config not found");

            const profile = await InvestorProfileModel.findOne({ userId: request.authUser.userId }).session(session);
            const kycApproved = !config.complianceRules.requireKycToSubscribe || profile?.kycStatus === "approved";
            const eligibilitySatisfied = Boolean(profile);

            const minByTemplate =
              offering.templateCode === "A"
                ? toNumber(config.complianceRules.minInvestmentByTemplate.A)
                : toNumber(config.complianceRules.minInvestmentByTemplate.B);

            const minTicket = toNumber((offering.terms as Record<string, unknown>).minTicket);
            const effectiveMin = Math.max(minByTemplate, minTicket || 0);
            if (payload.amount < effectiveMin) throw new HttpError(422, `Minimum subscription is ${effectiveMin}`);

            assertTransition("subscription", "draft", "committed", {
              kycApproved,
              eligibilitySatisfied,
            });

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

            await recalcOfferingMetrics(String(offering._id), session);

            await appendEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionCommitted",
                notes: `offering:${params.id}`,
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: params.id,
                action: "InvestorSubscribed",
                notes: String(payload.amount),
              },
              session,
            );

            return serialize(subscription.toObject());
          }),
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
              paidCount: { $sum: { $cond: [{ $in: ["$status", ["paid", "allocation_confirmed"]] }, 1, 0] } },
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
    "/v1/subscriptions/:id/mark-payment-pending",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/subscriptions/:id/mark-payment-pending",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const subscription = await SubscriptionModel.findById(params.id).session(session);
            if (!subscription) throw new HttpError(404, "Subscription not found");

            assertTransition("subscription", subscription.status as any, "payment_pending");
            subscription.status = "payment_pending";
            await subscription.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionPaymentPending",
              },
              session,
            );

            return serialize(subscription.toObject());
          }),
      });
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
      const payload = paymentReceiptSchema.parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/subscriptions/:id/mark-paid",
        payload: { id: params.id, receipt: payload },
        execute: () =>
          runInTransaction(async (session) => {
            const subscription = await SubscriptionModel.findById(params.id).session(session);
            if (!subscription) throw new HttpError(404, "Subscription not found");

            assertTransition("subscription", subscription.status as any, "paid", { hasVerifiedReceipt: true });

            const existingReceipt = await EscrowReceiptModel.findOne({ externalRef: payload.externalRef }).session(session);
            if (!existingReceipt) {
              await EscrowReceiptModel.create(
                [
                  {
                    externalRef: payload.externalRef,
                    source: payload.source,
                    amount: subscription.amount,
                    payerRef: payload.payerRef,
                    currency: payload.currency,
                    status: "confirmed",
                    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : new Date(),
                    metadata: payload.metadata ?? {},
                  },
                ],
                { session },
              );
            }

            subscription.status = "paid";
            subscription.externalReceiptRef = payload.externalRef;
            await subscription.save({ session });

            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "escrow",
                  accountRef: `offering:${String(subscription.offeringId)}`,
                  direction: "credit",
                  amount: subscription.amount,
                  currency: payload.currency,
                  entityType: "subscription",
                  entityId: String(subscription._id),
                  externalRef: payload.externalRef,
                  idempotencyKey: commandId,
                  postedAt: new Date(),
                  metadata: {
                    source: payload.source,
                    investorUserId: String(subscription.investorUserId),
                  },
                },
              ],
              { session },
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionPaid",
                notes: payload.externalRef,
              },
              session,
            );

            return serialize(subscription.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/subscriptions/:id/cancel",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3).optional() }).parse(request.body ?? {});
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/subscriptions/:id/cancel",
        payload: { id: params.id, reason: payload.reason ?? null },
        execute: () =>
          runInTransaction(async (session) => {
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
                action: "SubscriptionCancelled",
                notes: payload.reason,
              },
              session,
            );

            return serialize(subscription.toObject());
          }),
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
      const payload = z
        .object({
          reason: z.string().min(3),
          reversalRef: z.string().min(6),
          confirm: z.literal("REFUND"),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/subscriptions/:id/refund",
        payload: { id: params.id, ...payload },
        execute: () =>
          runInTransaction(async (session) => {
            const subscription = await SubscriptionModel.findById(params.id).session(session);
            if (!subscription) throw new HttpError(404, "Subscription not found");

            assertTransition("subscription", subscription.status as any, "refunded", {
              hasReversalRecord: true,
              approvalPolicySatisfied: true,
            });

            subscription.status = "refunded";
            await subscription.save({ session });

            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "escrow",
                  accountRef: `offering:${String(subscription.offeringId)}`,
                  direction: "debit",
                  amount: subscription.amount,
                  currency: "NGN",
                  entityType: "subscription",
                  entityId: String(subscription._id),
                  externalRef: payload.reversalRef,
                  idempotencyKey: commandId,
                  postedAt: new Date(),
                  metadata: {
                    reason: payload.reason,
                    reversedBy: request.authUser.userId,
                  },
                },
              ],
              { session },
            );

            await recalcOfferingMetrics(String(subscription.offeringId), session);

            await appendEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionRefunded",
                notes: payload.reason,
              },
              session,
            );

            return serialize(subscription.toObject());
          }),
      });
    },
  );
}
