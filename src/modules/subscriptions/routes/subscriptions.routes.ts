import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";
import {
  CorporateActionModel,
  EscrowReceiptModel,
  InvestorProfileModel,
  LedgerEntryModel,
  OfferingModel,
  PlatformConfigModel,
  SubscriptionModel,
  UserModel,
} from "../../../db/models.js";
import { toDecimal } from "../../../utils/decimal.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { assertTransition } from "../../../utils/state-machine.js";
import { assertInvestorScope, assertIssuerBusinessScope } from "../../../utils/scope.js";
import { runInTransaction } from "../../../utils/tx.js";
import { serialize } from "../../../utils/serialize.js";
import { readCommandId, runIdempotentCommand } from "../../../utils/idempotency.js";
import { env } from "../../../config/env.js";
import { initializePaystackTransaction } from "../../../services/paystack.js";

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

            // I-22: Enforce per-investor max ticket cap
            const maxTicket = toNumber((offering.terms as Record<string, unknown>).maxTicket);
            if (maxTicket > 0 && payload.amount > maxTicket) {
              throw new HttpError(422, `Maximum subscription per investor is ${maxTicket}`);
            }

            // I-22: Enforce maxSingleInvestorPct (concentration limit)
            const maxSinglePct = toNumber((offering as any).metrics?.maxSingleInvestorPct ?? 0);
            if (maxSinglePct > 0) {
              const raiseAmount = toNumber((offering.terms as Record<string, unknown>).raiseAmount);
              if (raiseAmount > 0) {
                const investorPct = (payload.amount / raiseAmount) * 100;
                if (investorPct > maxSinglePct) {
                  const maxAllowed = Math.floor((raiseAmount * maxSinglePct) / 100);
                  throw new HttpError(422, `Subscription exceeds the single-investor concentration limit of ${maxSinglePct}%. Maximum allowed: ${maxAllowed}`);
                }
              }
            }

            // I-52: Enforce annual investment limit for retail investors
            const retailLimit = toNumber((config.complianceRules as any).retailAnnualInvestmentLimit ?? 0);
            if (retailLimit > 0 && profile?.eligibility === "retail") {
              const yearStart = new Date(new Date().getFullYear(), 0, 1);
              const annualTotal = await SubscriptionModel.aggregate([
                {
                  $match: {
                    investorUserId: new mongoose.Types.ObjectId(String(request.authUser.userId)),
                    status: { $in: ["committed", "payment_pending", "paid", "allocation_confirmed"] },
                    createdAt: { $gte: yearStart },
                  },
                },
                { $group: { _id: null, total: { $sum: "$amount" } } },
              ]).session(session);

              const existingTotal = annualTotal[0]?.total ? toNumber(annualTotal[0].total) : 0;
              if (existingTotal + payload.amount > retailLimit) {
                const remaining = Math.max(0, retailLimit - existingTotal);
                throw new HttpError(
                  422,
                  `This subscription would exceed your annual retail investment limit of ${retailLimit.toLocaleString()} NGN. You have ${remaining.toLocaleString()} NGN remaining for this year.`,
                );
              }
            }

            // I-21: Enforce private/invitation-only offering whitelist
            if ((offering as any).isPrivate) {
              const whitelistIds = ((offering as any).investorWhitelistUserIds ?? []).map((id: any) => String(id));
              if (!whitelistIds.includes(String(request.authUser.userId))) {
                throw new HttpError(403, "This is a private offering. You are not on the investor whitelist.");
              }
            }

            assertTransition("subscription", "draft", "committed", {
              kycApproved,
              eligibilitySatisfied,
            });

            // I-50: Compute cooling-off end date from platform config
            const coolingOffDays = toNumber((config.complianceRules as any).coolingOffDays ?? 14);
            const cancellableUntil = coolingOffDays > 0
              ? new Date(Date.now() + coolingOffDays * 24 * 60 * 60 * 1000)
              : undefined;

            const [subscription] = await SubscriptionModel.create(
              [
                {
                  offeringId: offering._id,
                  investorUserId: request.authUser.userId,
                  amount: toDecimal(payload.amount),
                  status: "committed",
                  cancellableUntil,
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
      const query = z
        .object({
          offeringId: z.string().optional(),
          status: z
            .enum(["committed", "payment_pending", "paid", "allocation_pending", "allocation_confirmed", "redeemed", "cancelled", "refunded"])
            .optional(),
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(100).default(20),
        })
        .parse(request.query);

      const { page, limit } = query;
      const skip = (page - 1) * limit;

      if (request.authUser.role === "investor") {
        const filter: Record<string, unknown> = { investorUserId: request.authUser.userId };
        if (query.offeringId) filter.offeringId = query.offeringId;
        if (query.status) filter.status = query.status;
        const [rows, total] = await Promise.all([
          SubscriptionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
          SubscriptionModel.countDocuments(filter),
        ]);
        return serialize({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
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
      if (query.status) filter.status = query.status;
      const [rows, total] = await Promise.all([
        SubscriptionModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
        SubscriptionModel.countDocuments(filter),
      ]);
      return serialize({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
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

            // I-30: Deduct platform fee from subscription payment
            const subOffering = await OfferingModel.findById(subscription.offeringId).session(session).lean();
            if (subOffering?.feeSnapshot) {
              const platformFeePct = Number((subOffering.feeSnapshot as any).platformFeePct?.toString() ?? "0");
              const platformFeeAmount = (Number(subscription.amount.toString()) * platformFeePct) / 100;
              if (platformFeeAmount > 0) {
                await LedgerEntryModel.create(
                  [
                    {
                      ledgerType: "fee",
                      accountRef: "platform:fees",
                      direction: "credit",
                      amount: toDecimal(platformFeeAmount),
                      currency: payload.currency,
                      entityType: "subscription",
                      entityId: String(subscription._id),
                      idempotencyKey: `fee:platform:${commandId ?? String(subscription._id)}`,
                      postedAt: new Date(),
                      metadata: {
                        feeType: "platform",
                        platformFeePct,
                        offeringId: String(subscription.offeringId),
                        investorUserId: String(subscription.investorUserId),
                      },
                    },
                  ],
                  { session },
                );
              }
            }

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
    "/v1/subscriptions/:id/initiate-payment",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      if (!env.PAYSTACK_ENABLED) throw new HttpError(422, "Payment provider not configured");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ callbackUrl: z.string().url().optional() }).parse(request.body ?? {});

      return runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");
        assertInvestorScope(request.authUser, String(subscription.investorUserId));

        if (!["committed", "payment_pending"].includes(subscription.status)) {
          throw new HttpError(422, "Subscription is not in a payable state");
        }

        const user = await UserModel.findById(request.authUser.userId).lean().session(session);
        if (!user) throw new HttpError(404, "User not found");

        const amountNaira = Number(subscription.amount.toString());
        const reference = subscription.paystackReference ?? `fractal_sub_${String(subscription._id)}_${Date.now()}`;

        const checkout = await initializePaystackTransaction({
          email: user.email,
          amountKobo: Math.round(amountNaira * 100),
          reference,
          callbackUrl: payload.callbackUrl,
          metadata: {
            subscriptionId: String(subscription._id),
            offeringId: String(subscription.offeringId),
            investorUserId: String(subscription.investorUserId),
          },
        });

        subscription.paystackReference = checkout.reference;
        if (subscription.status === "committed") {
          subscription.status = "payment_pending";
        }
        await subscription.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "SubscriptionPaymentInitiated",
            notes: `ref:${checkout.reference}`,
          },
          session,
        );

        return {
          subscriptionId: String(subscription._id),
          paymentUrl: checkout.authorization_url,
          reference: checkout.reference,
          accessCode: checkout.access_code,
        };
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

            // I-50: After cooling-off period expires, paid subscriptions cannot be self-cancelled by investors
            if (
              request.authUser.role === "investor" &&
              subscription.status === "paid" &&
              (subscription as any).cancellableUntil &&
              new Date() > new Date((subscription as any).cancellableUntil)
            ) {
              throw new HttpError(
                422,
                "The cooling-off period for this subscription has expired. Contact the platform operator to arrange a cancellation.",
              );
            }

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

  // I-41: Digital ownership certificate for investors
  app.get(
    "/v1/subscriptions/:id/certificate",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "subscription");
      const params = z.object({ id: z.string() }).parse(request.params);

      const subscription = await SubscriptionModel.findById(params.id).lean();
      if (!subscription) throw new HttpError(404, "Subscription not found");

      // Investors can only access their own certificate; operators/admins/issuers can access all
      if (request.authUser.role === "investor") {
        assertInvestorScope(request.authUser, String((subscription as any).investorUserId));
      }

      // Only allocation_confirmed subscriptions have a valid certificate
      if ((subscription as any).status !== "allocation_confirmed") {
        throw new HttpError(422, "Certificate is only available for confirmed allocations. Current status: " + (subscription as any).status);
      }

      const [offering, investor] = await Promise.all([
        OfferingModel.findById((subscription as any).offeringId)
          .select("name summary businessId templateCode terms metrics")
          .lean(),
        UserModel.findById((subscription as any).investorUserId)
          .select("name email")
          .lean(),
      ]);

      if (!offering || !investor) throw new HttpError(404, "Offering or investor not found");

      const raiseAmount = Number((offering as any).terms?.raiseAmount?.toString() ?? "0");
      const subscriptionAmount = Number((subscription as any).amount?.toString() ?? "0");
      const sharePercent = raiseAmount > 0 ? ((subscriptionAmount / raiseAmount) * 100).toFixed(4) : "0";

      const certificate = {
        certificateType: "DIGITAL_OWNERSHIP_CERTIFICATE",
        certificateId: `DOC-${String((subscription as any)._id).slice(-8).toUpperCase()}`,
        issuedAt: new Date().toISOString(),
        // Holder
        holderName: (investor as any).name,
        holderEmail: request.authUser.role === "investor" ? (investor as any).email : undefined,
        // Offering
        offeringName: (offering as any).name,
        offeringId: String((offering as any)._id),
        templateCode: (offering as any).templateCode,
        // Investment
        subscriptionId: String((subscription as any)._id),
        investmentAmount: subscriptionAmount,
        currency: "NGN",
        sharePercent: Number(sharePercent),
        allocationConfirmedAt: (subscription as any).allocationConfirmedAt ?? null,
        // Status
        status: (subscription as any).status,
        // Disclaimers
        disclaimer: "This certificate is a digital record of ownership interest. It does not constitute a negotiable instrument or bearer certificate.",
      };

      return serialize(certificate);
    },
  );

  // I-57: Request a forced transfer of subscription to another investor
  app.post(
    "/v1/subscriptions/:id/request-forced-transfer",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "subscription");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Only operators and admins can request forced transfers");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          toUserId: z.string().min(1),
          reason: z.string().min(10),
          legalDocumentId: z.string().optional(),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");

        if (!["allocation_confirmed"].includes((subscription as any).status)) {
          throw new HttpError(422, "Forced transfers can only be applied to allocation-confirmed subscriptions");
        }

        const toUser = await UserModel.findById(payload.toUserId).session(session).lean();
        if (!toUser) throw new HttpError(404, "Recipient user not found");
        if ((toUser as any).role !== "investor") {
          throw new HttpError(422, "Recipient must be a registered investor");
        }

        // Create a pending corporate action
        await CorporateActionModel.create(
          [
            {
              offeringId: (subscription as any).offeringId,
              type: "forced_transfer",
              status: "pending",
              payload: {
                subscriptionId: String((subscription as any)._id),
                fromUserId: String((subscription as any).investorUserId),
                toUserId: payload.toUserId,
                reason: payload.reason,
                legalDocumentId: payload.legalDocumentId,
              },
              requestedBy: request.authUser.userId,
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String((subscription as any)._id),
            action: "ForcedTransferRequested",
            notes: `to:${payload.toUserId} reason:${payload.reason.slice(0, 80)}`,
          },
          session,
        );

        return serialize({ message: "Forced transfer request created. Pending second-level approval." });
      });
    },
  );

  // I-57: Execute a forced transfer (second-level admin approval)
  app.post(
    "/v1/subscriptions/:id/execute-forced-transfer",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "subscription");
      if (request.authUser.role !== "admin") {
        throw new HttpError(403, "Admin role required to execute forced transfers");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          corporateActionId: z.string(),
          confirm: z.literal("FORCED_TRANSFER"),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/subscriptions/:id/execute-forced-transfer",
        payload: { id: params.id, corporateActionId: payload.corporateActionId },
        execute: () =>
          runInTransaction(async (session) => {
            const subscription = await SubscriptionModel.findById(params.id).session(session);
            if (!subscription) throw new HttpError(404, "Subscription not found");

            const action = await CorporateActionModel.findOne({
              _id: payload.corporateActionId,
              type: "forced_transfer",
              status: "pending",
            }).session(session);
            if (!action) throw new HttpError(404, "Forced transfer corporate action not found or already processed");

            const { fromUserId, toUserId } = (action as any).payload;

            if (String((subscription as any).investorUserId) !== String(fromUserId)) {
              throw new HttpError(422, "Subscription holder mismatch — action may be stale");
            }

            // Transfer the subscription
            (subscription as any).investorUserId = toUserId;
            await (subscription as any).save({ session });

            // Update ownership ledger entries
            const transferAmount = (subscription as any).amount;
            const transferRef = `forced-transfer:${String((action as any)._id)}`;

            await LedgerEntryModel.create(
              [
                // Debit old holder
                {
                  ledgerType: "ownership",
                  accountRef: `investor:${String(fromUserId)}`,
                  direction: "debit",
                  amount: transferAmount,
                  currency: "NGN",
                  entityType: "subscription",
                  entityId: String((subscription as any)._id),
                  externalRef: transferRef,
                  idempotencyKey: `${transferRef}:debit`,
                  postedAt: new Date(),
                  metadata: { transferType: "forced_transfer", fromUserId, toUserId },
                },
                // Credit new holder
                {
                  ledgerType: "ownership",
                  accountRef: `investor:${String(toUserId)}`,
                  direction: "credit",
                  amount: transferAmount,
                  currency: "NGN",
                  entityType: "subscription",
                  entityId: String((subscription as any)._id),
                  externalRef: transferRef,
                  idempotencyKey: `${transferRef}:credit`,
                  postedAt: new Date(),
                  metadata: { transferType: "forced_transfer", fromUserId, toUserId },
                },
              ],
              { session },
            );

            (action as any).status = "executed";
            (action as any).approvedBy = request.authUser.userId;
            (action as any).executedAt = new Date();
            await (action as any).save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String((subscription as any)._id),
                action: "ForcedTransferExecuted",
                notes: `from:${fromUserId} to:${toUserId}`,
              },
              session,
            );

            return serialize({
              subscriptionId: String((subscription as any)._id),
              fromUserId: String(fromUserId),
              toUserId: String(toUserId),
              transferRef,
            });
          }),
      });
    },
  );
}
