import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { z } from "zod";
import {
  CorporateActionModel,
  DedicatedVirtualAccountModel,
  EscrowReceiptModel,
  InvestorProfileModel,
  LedgerEntryModel,
  OfferingModel,
  OutboundTransferModel,
  PaymentIntentModel,
  PlatformConfigModel,
  SuitabilityAssessmentModel,
  SubscriptionModel,
  UserModel,
} from "../../../db/models.js";
import { toDecimal } from "../../../utils/decimal.js";
import { escrowAccountRef } from "../../../services/ledger.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { assertTransition } from "../../../utils/state-machine.js";
import { assertInvestorScope, assertIssuerBusinessScope } from "../../../utils/scope.js";
import { runInTransaction } from "../../../utils/tx.js";
import { serialize } from "../../../utils/serialize.js";
import { readCommandId, runIdempotentCommand } from "../../../utils/idempotency.js";
import { env } from "../../../config/env.js";
import {
  createPaystackCustomer,
  createPaystackDedicatedVirtualAccount,
  initializePaystackTransaction,
  initiatePaystackRefund,
  nairaToKobo,
} from "../../../services/paystack.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";

const subscribeSchema = z.object({
  amount: z.number().positive(),
  // E-signature: the investor must execute the subscription agreement.
  agreement: z.object({
    accepted: z.literal(true),
    signature: z.string().min(2).max(200), // typed full legal name
    agreementVersion: z.string().min(1).optional(),
    documentHash: z.string().min(16).optional(), // sha256 of the agreement the investor saw
  }),
});

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

            // C2: Accredited investor verification for high-risk offerings
            if (offering.minimumRiskTier >= 4) {
              if (profile?.accreditationStatus !== "verified") {
                await appendEvent(
                  request.authUser,
                  { entityType: "subscription", entityId: "pre-creation", action: "AccreditationCheckFailed", notes: `offering:${params.id} required tier >= 4` },
                  session,
                );
                throw new HttpError(422, "This offering requires accredited investor status. Please complete accreditation verification.");
              }
              const ACCREDITATION_VALIDITY_MONTHS = 12;
              if (profile.accreditationVerifiedAt) {
                const expiryDate = new Date(profile.accreditationVerifiedAt);
                expiryDate.setMonth(expiryDate.getMonth() + ACCREDITATION_VALIDITY_MONTHS);
                if (new Date() > expiryDate) {
                  throw new HttpError(422, "Your accreditation verification has expired. Please renew your accreditation.");
                }
              }
            }

            // C3: AML/sanctions screening gate
            const investorJurisdiction = profile?.jurisdiction;
            const juris = investorJurisdiction && (config.jurisdictions as any[])?.find(
              (j: any) => j.code === investorJurisdiction && j.enabled,
            );
            const amlRequired = juris ? juris.amlRequired !== false : true;
            if (amlRequired && profile?.amlStatus !== "clear") {
              await appendEvent(
                request.authUser,
                { entityType: "subscription", entityId: "pre-creation", action: "AMLCheckFailed", notes: `offering:${params.id} amlStatus:${profile?.amlStatus}` },
                session,
              );
              throw new HttpError(422, "AML screening is not cleared. Please wait for your screening to complete before subscribing.");
            }

            // C4: Suitability assessment enforcement
            if (offering.minimumRiskTier > 0) {
              const latestAssessment = await SuitabilityAssessmentModel.findOne({
                investorUserId: request.authUser.userId,
              }).sort({ completedAt: -1 }).session(session).lean();

              if (!latestAssessment || new Date() > new Date((latestAssessment as any).expiresAt)) {
                await appendEvent(
                  request.authUser,
                  { entityType: "subscription", entityId: "pre-creation", action: "SuitabilityCheckFailed", notes: `offering:${params.id} reason:${!latestAssessment ? "missing" : "expired"}` },
                  session,
                );
                throw new HttpError(422, !latestAssessment
                  ? "A suitability assessment is required before subscribing to this offering. Please complete the questionnaire."
                  : "Your suitability assessment has expired. Please retake the questionnaire.");
              }
              if ((latestAssessment as any).riskTier > offering.minimumRiskTier) {
                await appendEvent(
                  request.authUser,
                  { entityType: "subscription", entityId: "pre-creation", action: "SuitabilityCheckFailed", notes: `offering:${params.id} investorTier:${(latestAssessment as any).riskTier} requiredTier:${offering.minimumRiskTier}` },
                  session,
                );
                throw new HttpError(
                  422,
                  `Your risk profile (tier ${(latestAssessment as any).riskTier}) does not meet this offering's suitability requirement (tier ${offering.minimumRiskTier} or below).`,
                );
              }
            }

            // C6: Per-jurisdiction investment limits and eligible investor tiers
            if (juris) {
              if (juris.eligibleInvestorTiers?.length > 0 && !juris.eligibleInvestorTiers.includes(profile?.eligibility)) {
                await appendEvent(
                  request.authUser,
                  { entityType: "subscription", entityId: "pre-creation", action: "JurisdictionCheckFailed", notes: `offering:${params.id} jurisdiction:${juris.code} tier:${profile?.eligibility}` },
                  session,
                );
                throw new HttpError(422, `Investors with "${profile?.eligibility}" status are not eligible to invest from jurisdiction ${juris.name}.`);
              }
              const jurisMax = toNumber(juris.maxInvestmentAmount ?? 0);
              if (jurisMax > 0 && payload.amount > jurisMax) {
                await appendEvent(
                  request.authUser,
                  { entityType: "subscription", entityId: "pre-creation", action: "JurisdictionLimitExceeded", notes: `offering:${params.id} jurisdiction:${juris.code} amount:${payload.amount} max:${jurisMax}` },
                  session,
                );
                throw new HttpError(
                  422,
                  `Maximum investment amount for ${juris.name} is ${jurisMax.toLocaleString()} ${juris.maxInvestmentCurrency || "NGN"}.`,
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

            // §4: Cumulative oversubscription cap. The sum of all live subscriptions
            // plus this one must not exceed the offering's raise capacity.
            const raiseCapacity = toNumber((offering.terms as Record<string, unknown>).raiseAmount);
            const liveStatuses = ["committed", "payment_pending", "paid", "allocation_confirmed"];
            const [capAgg] = await SubscriptionModel.aggregate([
              { $match: { offeringId: offering._id, status: { $in: liveStatuses } } },
              { $group: { _id: null, total: { $sum: "$amount" } } },
            ]).session(session);
            const existingTotal = capAgg?.total ? toNumber(capAgg.total) : 0;
            if (raiseCapacity > 0 && existingTotal + payload.amount > raiseCapacity) {
              const remaining = Math.max(0, raiseCapacity - existingTotal);
              throw new HttpError(
                422,
                `This subscription would oversubscribe the offering. Remaining capacity: ${remaining.toLocaleString()} NGN.`,
              );
            }

            // §4: One active subscription per investor per offering. Prevents
            // double-subscribe (e.g. double-click without an idempotency key).
            const existingActive = await SubscriptionModel.findOne({
              offeringId: offering._id,
              investorUserId: request.authUser.userId,
              status: { $in: liveStatuses },
            })
              .session(session)
              .lean();
            if (existingActive) {
              throw new HttpError(409, "You already have an active subscription for this offering.");
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

            // E-signature: bind the execution to who/what/when for a tamper-evident
            // legal record (typed signature + document hash + IP + server-side hash).
            const acceptedAt = new Date();
            const executionHash = createHash("sha256")
              .update(
                JSON.stringify({
                  offeringId: String(offering._id),
                  investorUserId: String(request.authUser.userId),
                  amount: payload.amount,
                  signature: payload.agreement.signature,
                  agreementVersion: payload.agreement.agreementVersion ?? null,
                  documentHash: payload.agreement.documentHash ?? null,
                  acceptedAt: acceptedAt.toISOString(),
                }),
              )
              .digest("hex");

            const [subscription] = await SubscriptionModel.create(
              [
                {
                  offeringId: offering._id,
                  investorUserId: request.authUser.userId,
                  amount: toDecimal(payload.amount),
                  status: "committed",
                  cancellableUntil,
                  agreement: {
                    signature: payload.agreement.signature,
                    agreementVersion: payload.agreement.agreementVersion,
                    documentHash: payload.agreement.documentHash,
                    executionHash,
                    acceptedAt,
                    acceptedIp: request.ip,
                  },
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
            .enum(["committed", "payment_pending", "paid", "allocation_pending", "allocation_confirmed", "refund_pending", "redeemed", "cancelled", "refunded"])
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
                  accountRef: escrowAccountRef(subscription.offeringId),
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
      const commandId = readIdempotencyKey(request.headers);

      // §4: Wrap payment init in command idempotency so double-clicks collapse to
      // one PaymentIntent + one Paystack call.
      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/subscriptions/:id/initiate-payment",
        payload: { id: params.id, callbackUrl: payload.callbackUrl },
        execute: () =>
          runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");
        assertInvestorScope(request.authUser, String(subscription.investorUserId));

        if (!["committed", "payment_pending"].includes(subscription.status)) {
          throw new HttpError(422, "Subscription is not in a payable state");
        }

        const user = await UserModel.findById(request.authUser.userId).lean().session(session);
        if (!user) throw new HttpError(404, "User not found");

        const amountNaira = Number(subscription.amount.toString());
        // §4: Deterministic reference (no Date.now()). Once set it is always reused,
        // so concurrent first-clicks resolve to the same Paystack transaction.
        const reference = subscription.paystackReference ?? `fractal_sub_${String(subscription._id)}`;

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

        // Create PaymentIntent — source of truth for expected amount
        const amountKobo = Math.round(amountNaira * 100);
        await PaymentIntentModel.findOneAndUpdate(
          { subscriptionId: subscription._id, paystackReference: checkout.reference },
          {
            $setOnInsert: {
              subscriptionId: subscription._id,
              offeringId: subscription.offeringId,
              investorUserId: subscription.investorUserId,
              expectedAmountKobo: amountKobo,
              currency: "NGN",
              paystackReference: checkout.reference,
              method: "checkout",
              status: "pending",
              expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
            },
          },
          { upsert: true, new: true, session },
        );

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
          }),
      });
    },
  );

  // DVA-based payment: return virtual account details for bank transfer
  app.post(
    "/v1/subscriptions/:id/initiate-dva-payment",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
      if (!env.PAYSTACK_ENABLED) throw new HttpError(422, "Payment provider not configured");
      if (!env.PAYSTACK_DVA_ENABLED) throw new HttpError(422, "DVA payments not enabled");

      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const subscription = await SubscriptionModel.findById(params.id).session(session);
        if (!subscription) throw new HttpError(404, "Subscription not found");
        assertInvestorScope(request.authUser, String(subscription.investorUserId));

        if (!["committed", "payment_pending"].includes(subscription.status)) {
          throw new HttpError(422, "Subscription is not in a payable state");
        }

        const user = await UserModel.findById(request.authUser.userId).lean().session(session);
        if (!user) throw new HttpError(404, "User not found");

        // Find or create DVA for this investor
        let dva = await DedicatedVirtualAccountModel.findOne({
          investorUserId: request.authUser.userId,
          active: true,
        }).session(session);

        if (!dva) {
          // Create Paystack customer first
          const nameParts = ((user as any).name ?? "Investor").split(" ");
          const customer = await createPaystackCustomer({
            email: (user as any).email,
            firstName: nameParts[0] ?? "Investor",
            lastName: nameParts.slice(1).join(" ") || "User",
          });

          const dvaResult = await createPaystackDedicatedVirtualAccount({
            customerCode: customer.customer_code,
            preferredBank: env.PAYSTACK_DVA_PREFERRED_BANK,
          });

          [dva] = await DedicatedVirtualAccountModel.create(
            [
              {
                investorUserId: request.authUser.userId,
                paystackCustomerCode: customer.customer_code,
                bankName: dvaResult.bank.name,
                bankCode: String(dvaResult.bank.id),
                accountNumber: dvaResult.account_number,
                accountName: dvaResult.account_name,
                assignedAt: new Date(),
                active: true,
              },
            ],
            { session },
          );
        }

        const amountNaira = Number(subscription.amount.toString());
        const amountKobo = Math.round(amountNaira * 100);
        // §4: Deterministic reference (no Date.now()) — the DVA PaymentIntent is
        // matched by reference on the charge webhook.
        const dvaReference = `fractal_dva_${String(subscription._id)}`;

        // Create PaymentIntent for DVA payment
        await PaymentIntentModel.findOneAndUpdate(
          { subscriptionId: subscription._id, dvaAccountNumber: dva.accountNumber },
          {
            $setOnInsert: {
              subscriptionId: subscription._id,
              offeringId: subscription.offeringId,
              investorUserId: subscription.investorUserId,
              expectedAmountKobo: amountKobo,
              currency: "NGN",
              paystackReference: dvaReference,
              dvaAccountNumber: dva.accountNumber,
              method: "dva",
              status: "pending",
              expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000), // 72h for bank transfers
            },
          },
          { upsert: true, new: true, session },
        );

        if (subscription.status === "committed") {
          subscription.status = "payment_pending";
          await subscription.save({ session });
        }

        await appendEvent(
          request.authUser,
          {
            entityType: "subscription",
            entityId: String(subscription._id),
            action: "DVAPaymentInitiated",
            notes: `account:${dva.accountNumber} bank:${dva.bankName}`,
          },
          session,
        );

        return {
          subscriptionId: String(subscription._id),
          bankName: dva.bankName,
          accountNumber: dva.accountNumber,
          accountName: dva.accountName,
          amount: amountNaira,
          currency: "NGN",
          instructions: `Transfer exactly ₦${amountNaira.toLocaleString()} to the account above. Your subscription will be confirmed automatically once the transfer is received.`,
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

            // I-50: Paid subscription cooling-off cancellation → auto-refund
            if (
              request.authUser.role === "investor" &&
              (subscription.status === "paid" || subscription.status === "allocation_confirmed")
            ) {
              const cancellableUntil = (subscription as any).cancellableUntil;
              if (!cancellableUntil || new Date() > new Date(cancellableUntil)) {
                throw new HttpError(
                  422,
                  "The cooling-off period for this subscription has expired. Contact the platform operator to arrange a cancellation.",
                );
              }

              // Within cooling-off: auto-initiate refund instead of cancel
              if (env.PAYSTACK_ENABLED && subscription.externalReceiptRef) {
                const amountNaira = Number(subscription.amount.toString());
                const refundRef = `cooling-off-refund:${String(subscription._id)}:${Date.now()}`;

                const refundResult = await initiatePaystackRefund({
                  transactionReference: subscription.externalReceiptRef,
                  amountKobo: nairaToKobo(amountNaira),
                  merchantNote: `Cooling-off cancellation: ${payload.reason ?? "Investor cancelled within cooling-off period"}`,
                });

                await OutboundTransferModel.create(
                  [
                    {
                      transferCode: `refund_${refundResult.id}`,
                      reference: refundRef,
                      recipientCode: "refund",
                      amountKobo: nairaToKobo(amountNaira),
                      currency: "NGN",
                      reason: payload.reason ?? "Cooling-off cancellation",
                      status: "pending",
                      entityType: "refund",
                      entityId: String(subscription._id),
                      metadata: { paystackRefundId: refundResult.id, coolingOff: true },
                    },
                  ],
                  { session },
                );

                subscription.status = "refund_pending";
                await subscription.save({ session });

                await recalcOfferingMetrics(String(subscription.offeringId), session);

                await appendEvent(
                  request.authUser,
                  {
                    entityType: "subscription",
                    entityId: String(subscription._id),
                    action: "CoolingOffRefundInitiated",
                    notes: `paystack_refund:${refundResult.id} reason:${payload.reason ?? "cooling-off"}`,
                  },
                  session,
                );

                await createNotificationsFromEvent(
                  request.authUser,
                  {
                    entityType: "subscription",
                    entityId: String(subscription._id),
                    action: "CoolingOffRefundInitiated",
                    notes: `investorUserId:${String(subscription.investorUserId)} amount:${amountNaira}`,
                  },
                  session,
                );

                // Reverse platform fee
                const feeEntry = await LedgerEntryModel.findOne({
                  ledgerType: "fee",
                  accountRef: "platform:fees",
                  entityType: "subscription",
                  entityId: String(subscription._id),
                  direction: "credit",
                }).session(session);

                if (feeEntry) {
                  await LedgerEntryModel.create(
                    [
                      {
                        ledgerType: "fee",
                        accountRef: "platform:fees",
                        direction: "debit",
                        amount: feeEntry.amount,
                        currency: feeEntry.currency ?? "NGN",
                        entityType: "subscription",
                        entityId: String(subscription._id),
                        externalRef: refundRef,
                        idempotencyKey: `${commandId ?? refundRef}:fee-reversal`,
                        postedAt: new Date(),
                        metadata: { feeType: "platform_fee_reversal", reason: "cooling_off_cancellation" },
                      },
                    ],
                    { session },
                  );
                }

                return serialize(subscription.toObject());
              }

              // No Paystack — operator must handle the refund manually
              throw new HttpError(
                422,
                "Paid subscription cancellation requires a refund. Contact the platform operator.",
              );
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

            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionCancelled",
                notes: `investorUserId:${String(subscription.investorUserId)}`,
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
          reversalRef: z.string().min(6).optional(),
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

            // When Paystack is enabled, use refund_pending → webhook confirms.
            // When disabled, go directly to refunded (manual off-platform refund).
            if (env.PAYSTACK_ENABLED && subscription.externalReceiptRef) {
              assertTransition("subscription", subscription.status as any, "refund_pending");

              const amountNaira = Number(subscription.amount.toString());
              const refundRef = `refund:${String(subscription._id)}:${Date.now()}`;

              const refundResult = await initiatePaystackRefund({
                transactionReference: subscription.externalReceiptRef,
                amountKobo: nairaToKobo(amountNaira),
                merchantNote: payload.reason,
              });

              // Track outbound refund transfer
              await OutboundTransferModel.create(
                [
                  {
                    transferCode: `refund_${refundResult.id}`,
                    reference: refundRef,
                    recipientCode: "refund",
                    amountKobo: nairaToKobo(amountNaira),
                    currency: "NGN",
                    reason: payload.reason,
                    status: "pending",
                    entityType: "refund",
                    entityId: String(subscription._id),
                    metadata: { paystackRefundId: refundResult.id },
                  },
                ],
                { session },
              );

              subscription.status = "refund_pending";
              await subscription.save({ session });

              await appendEvent(
                request.authUser,
                {
                  entityType: "subscription",
                  entityId: String(subscription._id),
                  action: "RefundInitiated",
                  notes: `paystack_refund:${refundResult.id} reason:${payload.reason}`,
                },
                session,
              );

              await createNotificationsFromEvent(
                request.authUser,
                {
                  entityType: "subscription",
                  entityId: String(subscription._id),
                  action: "RefundInitiated",
                  notes: `investorUserId:${String(subscription.investorUserId)} amount:${amountNaira}`,
                },
                session,
              );

              // Reverse platform fee that was charged on this subscription's payment
              const feeEntry = await LedgerEntryModel.findOne({
                ledgerType: "fee",
                accountRef: "platform:fees",
                entityType: "subscription",
                entityId: String(subscription._id),
                direction: "credit",
              }).session(session);

              if (feeEntry) {
                await LedgerEntryModel.create(
                  [
                    {
                      ledgerType: "fee",
                      accountRef: "platform:fees",
                      direction: "debit",
                      amount: feeEntry.amount,
                      currency: feeEntry.currency ?? "NGN",
                      entityType: "subscription",
                      entityId: String(subscription._id),
                      externalRef: refundRef,
                      idempotencyKey: `${commandId ?? refundRef}:fee-reversal`,
                      postedAt: new Date(),
                      metadata: { feeType: "platform_fee_reversal", reason: payload.reason },
                    },
                  ],
                  { session },
                );
              }

              return serialize(subscription.toObject());
            }

            // Manual refund path (Paystack disabled or no external receipt)
            if (!payload.reversalRef) {
              throw new HttpError(422, "reversalRef is required for manual refunds");
            }

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
                  accountRef: escrowAccountRef(subscription.offeringId),
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

            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionRefunded",
                notes: `investorUserId:${String(subscription.investorUserId)} amount:${Number(subscription.amount.toString())}`,
              },
              session,
            );

            // Reverse platform fee that was charged on this subscription's payment
            const feeEntry = await LedgerEntryModel.findOne({
              ledgerType: "fee",
              accountRef: "platform:fees",
              entityType: "subscription",
              entityId: String(subscription._id),
              direction: "credit",
            }).session(session);

            if (feeEntry) {
              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "fee",
                    accountRef: "platform:fees",
                    direction: "debit",
                    amount: feeEntry.amount,
                    currency: feeEntry.currency ?? "NGN",
                    entityType: "subscription",
                    entityId: String(subscription._id),
                    externalRef: payload.reversalRef,
                    idempotencyKey: `${commandId ?? payload.reversalRef}:fee-reversal`,
                    postedAt: new Date(),
                    metadata: { feeType: "platform_fee_reversal", reason: payload.reason },
                  },
                ],
                { session },
              );
            }

            return serialize(subscription.toObject());
          }),
      });
    },
  );

  // 3.1: Payment status endpoint — used by frontend to poll after Paystack redirect
  app.get(
    "/v1/subscriptions/:id/payment-status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const params = z.object({ id: z.string() }).parse(request.params);

      const subscription = await SubscriptionModel.findById(params.id).lean();
      if (!subscription) throw new HttpError(404, "Subscription not found");

      // Investors can only check their own subscription; operators/admins can check any
      if (request.authUser.role === "investor") {
        assertInvestorScope(request.authUser, String((subscription as any).investorUserId));
      }

      // Find the latest PaymentIntent for this subscription
      const intent = await PaymentIntentModel.findOne({
        subscriptionId: (subscription as any)._id,
      })
        .sort({ createdAt: -1 })
        .lean();

      return serialize({
        subscriptionId: String((subscription as any)._id),
        offeringId: String((subscription as any).offeringId),
        status: (subscription as any).status,
        paystackReference: (subscription as any).paystackReference ?? null,
        paidAt: (subscription as any).updatedAt && (subscription as any).status === "paid"
          ? (subscription as any).updatedAt
          : null,
        paymentIntent: intent
          ? {
              status: (intent as any).status,
              method: (intent as any).method,
              expectedAmountKobo: (intent as any).expectedAmountKobo,
              receivedAmountKobo: (intent as any).receivedAmountKobo ?? null,
              matchedAt: (intent as any).matchedAt ?? null,
              expiresAt: (intent as any).expiresAt,
            }
          : null,
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
