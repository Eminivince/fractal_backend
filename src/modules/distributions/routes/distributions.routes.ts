import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BusinessModel, DistributionLineModel, DistributionModel, InvestorProfileModel, LedgerEntryModel, OfferingModel, SubscriptionModel, UserModel } from "../../../db/models.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { toDecimal } from "../../../utils/decimal.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { assertTransition } from "../../../utils/state-machine.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { runInTransaction } from "../../../utils/tx.js";
import { serialize } from "../../../utils/serialize.js";
import { createAnchorRecord } from "../../../utils/anchor.js";
import { readCommandId, runIdempotentCommand } from "../../../utils/idempotency.js";
import { env } from "../../../config/env.js";
import { initiatePaystackTransfer, nairaToKobo } from "../../../services/paystack.js";

const createDistributionSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
  // I-33: Record date lifecycle
  announcementDate: z.string().optional(),
  recordDate: z.string().optional(),
  exDistributionDate: z.string().optional(),
  paymentDate: z.string().optional(),
  // I-29: WHT rate (default 10% per Nigerian law; can be overridden by operator)
  whtPct: z.number().min(0).max(100).default(10),
});

function csvSafe(value: string | number): string {
  const raw = String(value ?? "");
  if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export async function distributionRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings/:id/distributions",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "distribution");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = createDistributionSchema.parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        if (offering.templateCode !== "A") {
          throw new HttpError(422, "Distributions endpoint is only valid for Template A offerings");
        }

        // I-70: Validate distribution amount against escrow balance
        const escrowCredits = await LedgerEntryModel.find({
          ledgerType: { $in: ["escrow", "subscription"] },
          accountRef: `escrow:offering:${String(offering._id)}`,
          direction: "credit",
        })
          .session(session)
          .lean();

        const escrowDebits = await LedgerEntryModel.find({
          ledgerType: { $in: ["escrow", "subscription", "distribution", "tranche"] },
          accountRef: `escrow:offering:${String(offering._id)}`,
          direction: "debit",
        })
          .session(session)
          .lean();

        const totalCredits = escrowCredits.reduce(
          (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
          0,
        );
        const totalDebits = escrowDebits.reduce(
          (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
          0,
        );
        const escrowBalance = totalCredits - totalDebits;

        // Also check for pending approved/scheduled distributions
        const pendingDistributions = await DistributionModel.find({
          offeringId: offering._id,
          status: { $in: ["pending_approval", "approved", "scheduled"] },
        })
          .session(session)
          .lean();

        const pendingAmount = pendingDistributions.reduce(
          (sum: number, d: any) => sum + Number(d.amount?.toString() ?? "0"),
          0,
        );
        const availableBalance = escrowBalance - pendingAmount;

        if (payload.amount > availableBalance && availableBalance >= 0) {
          throw new HttpError(
            422,
            `Distribution amount (${payload.amount}) exceeds available escrow balance (${availableBalance.toFixed(2)}). ` +
              `Escrow balance: ${escrowBalance.toFixed(2)}, pending distributions: ${pendingAmount.toFixed(2)}.`,
          );
        }

        // I-29: Pre-compute WHT amounts
        const whtPct = payload.whtPct ?? 10;
        const whtAmount = (payload.amount * whtPct) / 100;
        const netAmount = payload.amount - whtAmount;

        const [distribution] = await DistributionModel.create(
          [
            {
              offeringId: offering._id,
              period: payload.period,
              amount: toDecimal(payload.amount),
              status: "draft",
              createdBy: request.authUser.userId,
              // I-33: Record date lifecycle
              announcementDate: payload.announcementDate
                ? new Date(payload.announcementDate)
                : new Date(),
              recordDate: payload.recordDate ? new Date(payload.recordDate) : undefined,
              exDistributionDate: payload.exDistributionDate
                ? new Date(payload.exDistributionDate)
                : undefined,
              paymentDate: payload.paymentDate ? new Date(payload.paymentDate) : undefined,
              // I-29: WHT
              whtPct: toDecimal(whtPct),
              whtAmount: toDecimal(whtAmount),
              netAmount: toDecimal(netAmount),
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "distribution",
            entityId: String(distribution._id),
            action: "DistributionDraftCreated",
            notes: payload.period,
          },
          session,
        );

        return serialize(distribution.toObject());
      });
    },
  );

  app.post(
    "/v1/distributions/:id/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "distribution");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distributions/:id/submit",
        payload: { id: params.id },
        execute: async () => {
          const distribution = await DistributionModel.findById(params.id);
          if (!distribution) throw new HttpError(404, "Distribution not found");

          const offering = await OfferingModel.findById(distribution.offeringId).lean();
          if (!offering) throw new HttpError(404, "Offering not found");
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));

          assertTransition("distribution", distribution.status as any, "pending_approval");
          distribution.status = "pending_approval";
          await distribution.save();

          await appendEvent(request.authUser, {
            entityType: "distribution",
            entityId: String(distribution._id),
            action: "DistributionSubmitted",
          });

          return serialize(distribution.toObject());
        },
      });
    },
  );

  app.post(
    "/v1/distributions/:id/approve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "approve", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distributions/:id/approve",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const distribution = await DistributionModel.findById(params.id).session(session);
            if (!distribution) throw new HttpError(404, "Distribution not found");

            assertTransition("distribution", distribution.status as any, "approved");
            distribution.status = "approved";
            distribution.approvedBy = request.authUser.userId as any;
            distribution.approvedAt = new Date();
            await distribution.save({ session });

            const anchor = await createAnchorRecord(
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                eventType: "DistributionDeclared",
                payload: {
                  period: distribution.period,
                  amount: distribution.amount.toString(),
                  offeringId: String(distribution.offeringId),
                },
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionApproved",
                notes: `anchor:${anchor.id}`,
              },
              session,
            );

            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionApproved",
                notes: `Distribution for period ${distribution.period} has been approved.`,
              },
              session,
            );

            return serialize(distribution.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/distributions/:id/schedule",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distributions/:id/schedule",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const distribution = await DistributionModel.findById(params.id).session(session);
            if (!distribution) throw new HttpError(404, "Distribution not found");

            assertTransition("distribution", distribution.status as any, "scheduled");
            distribution.status = "scheduled";
            distribution.scheduledAt = new Date();
            await distribution.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionScheduled",
              },
              session,
            );

            return serialize(distribution.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/distributions/:id/mark-paid",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ payoutReceiptRefs: z.array(z.string().min(6)).min(1) }).parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distributions/:id/mark-paid",
        payload: { id: params.id, payoutReceiptRefs: payload.payoutReceiptRefs },
        execute: () =>
          runInTransaction(async (session) => {
            const distribution = await DistributionModel.findById(params.id).session(session);
            if (!distribution) throw new HttpError(404, "Distribution not found");

            assertTransition("distribution", distribution.status as any, "paid", {
              hasPayoutReceipts: payload.payoutReceiptRefs.length > 0,
            });

            // Gross distribution amount (before fees)
            const grossAmount = Number(distribution.amount.toString());

            // Fetch the offering to read fee snapshot
            const offering = await OfferingModel.findById(distribution.offeringId).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            const servicingFeePct = Number(offering.feeSnapshot?.servicingFeePct?.toString() ?? "0");
            const servicingFeeAmount = (grossAmount * servicingFeePct) / 100;
            const netDistributable = grossAmount - servicingFeeAmount;

            distribution.status = "paid";
            distribution.payoutReceiptRefs = payload.payoutReceiptRefs as any;
            distribution.paidAt = new Date();
            await distribution.save({ session });

            // Aggregate ledger entry for the full distribution debit from offering escrow
            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "distribution",
                  accountRef: `offering:${String(distribution.offeringId)}`,
                  direction: "debit",
                  amount: toDecimal(grossAmount),
                  currency: "NGN",
                  entityType: "distribution",
                  entityId: String(distribution._id),
                  externalRef: payload.payoutReceiptRefs[0],
                  idempotencyKey: commandId,
                  postedAt: new Date(),
                  metadata: { payoutReceiptRefs: payload.payoutReceiptRefs },
                },
              ],
              { session },
            );

            // Fee ledger entry: servicing fee credited to platform
            if (servicingFeeAmount > 0) {
              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "fee",
                    accountRef: "platform:fees",
                    direction: "credit",
                    amount: toDecimal(servicingFeeAmount),
                    currency: "NGN",
                    entityType: "distribution",
                    entityId: String(distribution._id),
                    idempotencyKey: `fee:servicing:${commandId}`,
                    postedAt: new Date(),
                    metadata: {
                      feeType: "servicing",
                      servicingFeePct,
                      offeringId: String(distribution.offeringId),
                    },
                  },
                ],
                { session },
              );
            }

            // Per-investor payout ledger entries + optional Paystack transfers
            const allocatedSubs = await SubscriptionModel.find({
              offeringId: distribution.offeringId,
              status: "allocation_confirmed",
            })
              .session(session)
              .lean();

            const totalAllocated = allocatedSubs.reduce(
              (sum: number, sub: any) => sum + Number(sub.amount.toString()),
              0,
            );

            // I-29: WHT rate from distribution record, default 10%
            const whtPct = Number((distribution as any).whtPct?.toString() ?? "10");

            const paystackTransferRefs: string[] = [];

            for (const sub of allocatedSubs) {
              const investorShare = totalAllocated > 0 ? Number(sub.amount.toString()) / totalAllocated : 0;
              const investorGross = netDistributable * investorShare;
              if (investorGross <= 0) continue;

              // I-29: Compute per-investor WHT
              const investorWht = (investorGross * whtPct) / 100;
              const investorNet = investorGross - investorWht;

              const investorRef = `dist:${String(distribution._id)}:inv:${String(sub.investorUserId)}`;

              // I-34: Create per-investor DistributionLine
              await DistributionLineModel.create(
                [
                  {
                    distributionId: distribution._id,
                    offeringId: distribution.offeringId,
                    subscriptionId: sub._id,
                    investorUserId: sub.investorUserId,
                    sharePercent: toDecimal(investorShare * 100),
                    grossAmount: toDecimal(investorGross),
                    servicingFeeAmount: toDecimal(0),
                    whtPct: toDecimal(whtPct),
                    whtAmount: toDecimal(investorWht),
                    netAmount: toDecimal(investorNet),
                    currency: "NGN",
                    status: "pending",
                  },
                ],
                { session },
              );

              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "distribution",
                    accountRef: `investor:${String(sub.investorUserId)}`,
                    direction: "credit",
                    amount: toDecimal(investorNet),
                    currency: "NGN",
                    entityType: "distribution",
                    entityId: String(distribution._id),
                    idempotencyKey: investorRef,
                    postedAt: new Date(),
                    metadata: {
                      distributionId: String(distribution._id),
                      subscriptionId: String(sub._id),
                      investorShare,
                      grossAmount: investorGross,
                      whtAmount: investorWht,
                      netAmount: investorNet,
                    },
                  },
                ],
                { session },
              );

              // I-29: WHT ledger entry — credited to FIRS suspense account
              if (investorWht > 0) {
                await LedgerEntryModel.create(
                  [
                    {
                      ledgerType: "tax",
                      accountRef: "firs:wht:suspense",
                      direction: "credit",
                      amount: toDecimal(investorWht),
                      currency: "NGN",
                      entityType: "distribution",
                      entityId: String(distribution._id),
                      idempotencyKey: `wht:${investorRef}`,
                      postedAt: new Date(),
                      metadata: {
                        distributionId: String(distribution._id),
                        investorUserId: String(sub.investorUserId),
                        whtPct,
                        grossAmount: investorGross,
                      },
                    },
                  ],
                  { session },
                );
              }

              // Trigger Paystack transfer if investor has a registered bank account
              if (env.PAYSTACK_ENABLED) {
                const profile = await InvestorProfileModel.findOne({
                  userId: sub.investorUserId,
                })
                  .session(session)
                  .lean();

                if (profile?.bankAccount?.recipientCode) {
                  try {
                    const transfer = await initiatePaystackTransfer({
                      recipientCode: profile.bankAccount.recipientCode,
                      amountKobo: nairaToKobo(investorNet),
                      reference: investorRef,
                      reason: `Distribution ${distribution.period} — ${offering.name}`,
                    });
                    paystackTransferRefs.push(transfer.transfer_code);

                    // Mark the distribution line as paid
                    await DistributionLineModel.updateOne(
                      { distributionId: distribution._id, investorUserId: sub.investorUserId },
                      { status: "paid", paymentRef: transfer.transfer_code, paidAt: new Date() },
                    ).session(session);
                  } catch (err: any) {
                    // Log but do not fail the transaction — manual follow-up required
                    app.log.warn(
                      { err: err.message, investorUserId: String(sub.investorUserId) },
                      "Paystack transfer initiation failed; manual payout required",
                    );
                    await DistributionLineModel.updateOne(
                      { distributionId: distribution._id, investorUserId: sub.investorUserId },
                      { status: "failed", failureReason: err.message },
                    ).session(session);
                  }
                }
              }
            }

            const anchor = await createAnchorRecord(
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                eventType: "DistributionPaid",
                payload: {
                  payoutReceiptRefs: payload.payoutReceiptRefs,
                  amount: distribution.amount.toString(),
                  servicingFeeAmount: servicingFeeAmount.toFixed(2),
                  netDistributable: netDistributable.toFixed(2),
                  investorCount: allocatedSubs.length,
                  ...(paystackTransferRefs.length > 0 ? { paystackTransferRefs } : {}),
                },
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionPaid",
                notes: `anchor:${anchor.id}`,
              },
              session,
            );

            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionPaid",
                notes: `Distribution for period ${distribution.period} has been paid.`,
              },
              session,
            );

            return serialize(distribution.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/distributions/:id/mark-failed",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3) }).parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distributions/:id/mark-failed",
        payload: { id: params.id, reason: payload.reason },
        execute: () =>
          runInTransaction(async (session) => {
            const distribution = await DistributionModel.findById(params.id).session(session);
            if (!distribution) throw new HttpError(404, "Distribution not found");

            assertTransition("distribution", distribution.status as any, "failed");
            distribution.status = "failed";
            await distribution.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionFailed",
                notes: payload.reason,
              },
              session,
            );

            return serialize(distribution.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/distributions/:id/reverse",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          reason: z.string().min(3),
          trusteeTicket: z.string().min(3),
          confirm: z.literal("REVERSE"),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distributions/:id/reverse",
        payload: { id: params.id, ...payload },
        execute: () =>
          runInTransaction(async (session) => {
            const distribution = await DistributionModel.findById(params.id).session(session);
            if (!distribution) throw new HttpError(404, "Distribution not found");

            assertTransition("distribution", distribution.status as any, "reversed", {
              trusteeProcessCompleted: true,
            });

            distribution.status = "reversed";
            distribution.reversalReason = payload.reason;
            distribution.reversedAt = new Date();
            await distribution.save({ session });

            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "distribution",
                  accountRef: `offering:${String(distribution.offeringId)}`,
                  direction: "credit",
                  amount: distribution.amount,
                  currency: "NGN",
                  entityType: "distribution",
                  entityId: String(distribution._id),
                  externalRef: payload.trusteeTicket,
                  idempotencyKey: commandId,
                  postedAt: new Date(),
                  metadata: { reason: payload.reason },
                },
              ],
              { session },
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionReversed",
                notes: payload.reason,
              },
              session,
            );

            return serialize(distribution.toObject());
          }),
      });
    },
  );

  app.get(
    "/v1/offerings/:id/distributions",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      if (request.authUser.role === "investor") {
        const hasSubscription = await SubscriptionModel.exists({
          offeringId: offering._id,
          investorUserId: request.authUser.userId,
        });
        if (!hasSubscription) throw new HttpError(403, "Investor has no access to this offering distributions");
      }

      const rows = await DistributionModel.find({ offeringId: offering._id }).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/distributions/:id/statement",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);

      const distribution = await DistributionModel.findById(params.id).lean();
      if (!distribution) throw new HttpError(404, "Distribution not found");

      const offering = await OfferingModel.findById(distribution.offeringId).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      if (request.authUser.role === "investor") {
        const hasSubscription = await SubscriptionModel.exists({
          offeringId: offering._id,
          investorUserId: request.authUser.userId,
        });
        if (!hasSubscription) throw new HttpError(403, "Investor has no access to this offering distribution");
      }

      const csvRows = [
        ["distributionId", "offeringId", "offeringName", "period", "amount", "status", "createdAt"],
        [
          String(distribution._id),
          String(offering._id),
          offering.name,
          distribution.period,
          distribution.amount.toString(),
          distribution.status,
          new Date(distribution.createdAt as any).toISOString(),
        ],
      ];

      const csv = `${csvRows
        .map((row) => row.map((value) => csvSafe(value)).join(","))
        .join("\n")}\n`;

      const fileName = `distribution_${distribution.period}_${String(distribution._id)}.csv`;

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csv);
    },
  );

  // P3-06: Offering performance report for issuers
  app.get(
    "/v1/offerings/:id/report",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "distribution");

      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Forbidden");
      }

      const distributions = await DistributionModel.find({ offeringId: offering._id })
        .sort({ createdAt: 1 })
        .lean();

      const subscriptions = await SubscriptionModel.find({ offeringId: offering._id }).lean();

      const totalSubscribed = subscriptions.reduce(
        (sum: number, s: any) => sum + Number(s.amount.toString()),
        0,
      );
      const totalDistributed = distributions
        .filter((d: any) => d.status === "paid")
        .reduce((sum: number, d: any) => sum + Number(d.amount.toString()), 0);

      const headerRows = [
        ["offeringId", "offeringName", "status", "opensAt", "closesAt", "raiseAmount", "subscribedAmount", "investorCount", "totalDistributed"],
        [
          String(offering._id),
          offering.name,
          offering.status,
          offering.opensAt ? new Date(offering.opensAt).toISOString() : "",
          offering.closesAt ? new Date(offering.closesAt).toISOString() : "",
          offering.metrics?.raiseAmount?.toString() ?? "0",
          offering.metrics?.subscribedAmount?.toString() ?? String(totalSubscribed),
          String(offering.metrics?.investorCount ?? subscriptions.length),
          String(totalDistributed),
        ],
      ];

      const distRows: string[][] = [
        [],
        ["--- Distributions ---"],
        ["distributionId", "period", "amount", "status", "approvedAt", "paidAt"],
        ...distributions.map((d: any) => [
          String(d._id),
          d.period,
          d.amount.toString(),
          d.status,
          d.approvedAt ? new Date(d.approvedAt).toISOString() : "",
          d.paidAt ? new Date(d.paidAt).toISOString() : "",
        ]),
      ];

      const allRows = [...headerRows, ...distRows];
      const csv = `${allRows.map((row) => row.map((v) => csvSafe(v)).join(",")).join("\n")}\n`;

      const fileName = `offering_report_${String(offering._id)}.csv`;
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csv);
    },
  );

  // I-37: Retry a failed individual distribution line payout
  app.post(
    "/v1/distribution-lines/:lineId/retry",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "distribution");
      const params = z.object({ lineId: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/distribution-lines/:lineId/retry",
        payload: { lineId: params.lineId },
        execute: () =>
          runInTransaction(async (session) => {
            const line = await DistributionLineModel.findById(params.lineId).session(session);
            if (!line) throw new HttpError(404, "Distribution line not found");

            if (line.status !== "failed") {
              throw new HttpError(422, `Distribution line is in "${line.status}" status — only failed lines can be retried`);
            }

            const distribution = await DistributionModel.findById(line.distributionId).session(session);
            if (!distribution) throw new HttpError(404, "Parent distribution not found");

            const offering = await OfferingModel.findById(distribution.offeringId).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            const netAmount = Number(line.netAmount.toString());
            const investorRef = `retry:dist:${String(line.distributionId)}:inv:${String(line.investorUserId)}:${Date.now()}`;

            if (env.PAYSTACK_ENABLED) {
              const profile = await InvestorProfileModel.findOne({ userId: line.investorUserId })
                .session(session)
                .lean();

              if (!profile?.bankAccount?.recipientCode) {
                throw new HttpError(
                  422,
                  "Investor has no registered Paystack transfer recipient. Ask the investor to add their bank account.",
                );
              }

              const transfer = await initiatePaystackTransfer({
                recipientCode: profile.bankAccount.recipientCode,
                amountKobo: nairaToKobo(netAmount),
                reference: investorRef,
                reason: `Retry: Distribution ${distribution.period} — ${offering.name}`,
              });

              line.status = "paid";
              line.paymentRef = transfer.transfer_code;
              line.paidAt = new Date();
              line.failureReason = undefined as any;
              await line.save({ session });

              await appendEvent(
                request.authUser,
                {
                  entityType: "distribution",
                  entityId: String(distribution._id),
                  action: "DistributionLineRetrySucceeded",
                  notes: `lineId:${params.lineId} ref:${transfer.transfer_code}`,
                },
                session,
              );

              return serialize({
                lineId: params.lineId,
                status: "paid",
                transferCode: transfer.transfer_code,
                amount: netAmount,
                currency: "NGN",
              });
            }

            // If Paystack not enabled, mark as manually resolved
            line.status = "paid";
            line.paymentRef = `manual:${investorRef}`;
            line.paidAt = new Date();
            line.failureReason = undefined as any;
            await line.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                action: "DistributionLineManuallyResolved",
                notes: `lineId:${params.lineId}`,
              },
              session,
            );

            return serialize({ lineId: params.lineId, status: "paid", manual: true });
          }),
      });
    },
  );

  // I-34: Get per-investor distribution lines for a specific distribution
  app.get(
    "/v1/distributions/:id/lines",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);

      const distribution = await DistributionModel.findById(params.id).lean();
      if (!distribution) throw new HttpError(404, "Distribution not found");

      const offering = await OfferingModel.findById(distribution.offeringId).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (request.authUser.role === "investor") {
        const hasSubscription = await SubscriptionModel.exists({
          offeringId: offering._id,
          investorUserId: request.authUser.userId,
        });
        if (!hasSubscription) throw new HttpError(403, "No access to this distribution");
      }

      const lines = await DistributionLineModel.find({
        distributionId: distribution._id,
        ...(request.authUser.role === "investor"
          ? { investorUserId: request.authUser.userId }
          : {}),
      })
        .sort({ createdAt: 1 })
        .lean();

      return serialize(lines);
    },
  );

  // P3-06: Per-investor distribution report for an offering (issuer/operator)
  app.get(
    "/v1/offerings/:id/investor-distributions",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "distribution");

      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Forbidden");
      }

      const distributions = await DistributionModel.find({
        offeringId: offering._id,
        status: "paid",
      }).lean();

      const subscriptions = await SubscriptionModel.find({
        offeringId: offering._id,
        status: "allocation_confirmed",
      }).lean();

      const totalAllocated = subscriptions.reduce(
        (sum: number, s: any) => sum + Number(s.amount.toString()),
        0,
      );

      const investorIds = subscriptions.map((s: any) => s.investorUserId);
      const users = await UserModel.find({ _id: { $in: investorIds } })
        .select("_id name email")
        .lean();
      const userMap = new Map(users.map((u: any) => [String(u._id), u]));

      const rows: string[][] = [
        ["investorUserId", "investorName", "investorEmail", "subscriptionAmount", "sharePercent", ...distributions.map((d: any) => `dist_${d.period}`)],
      ];

      for (const sub of subscriptions) {
        const investorId = String((sub as any).investorUserId);
        const user = userMap.get(investorId);
        const subAmount = Number((sub as any).amount.toString());
        const sharePercent = totalAllocated > 0 ? ((subAmount / totalAllocated) * 100).toFixed(4) : "0";

        const distAmounts = distributions.map((d: any) => {
          const grossAmount = Number(d.amount.toString());
          const servicingFeePct = Number(offering.feeSnapshot?.servicingFeePct?.toString() ?? "0");
          const net = grossAmount - (grossAmount * servicingFeePct) / 100;
          const investorNet = totalAllocated > 0 ? (net * subAmount) / totalAllocated : 0;
          return investorNet.toFixed(2);
        });

        rows.push([
          investorId,
          (user as any)?.name ?? "",
          (user as any)?.email ?? "",
          subAmount.toFixed(2),
          sharePercent,
          ...distAmounts,
        ]);
      }

      const csv = `${rows.map((row) => row.map((v) => csvSafe(v)).join(",")).join("\n")}\n`;
      const fileName = `investor_distributions_${String(offering._id)}.csv`;
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csv);
    },
  );

  // P3-06: AUM summary report for operators
  app.get(
    "/v1/operator/reports/aum",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "read", "distribution");

      const offerings = await OfferingModel.find({ status: { $in: ["live", "closed"] } }).lean();

      let totalAum = 0;
      const rows: string[][] = [
        ["offeringId", "offeringName", "status", "raiseAmount", "subscribedAmount", "investorCount", "totalDistributed"],
      ];

      for (const offering of offerings) {
        const paidDistributions = await DistributionModel.find({
          offeringId: (offering as any)._id,
          status: "paid",
        }).lean();

        const totalDistributed = paidDistributions.reduce(
          (sum: number, d: any) => sum + Number(d.amount.toString()),
          0,
        );

        const subscribedAmount = Number((offering as any).metrics?.subscribedAmount?.toString() ?? "0");
        totalAum += subscribedAmount;

        rows.push([
          String((offering as any)._id),
          (offering as any).name,
          (offering as any).status,
          (offering as any).metrics?.raiseAmount?.toString() ?? "0",
          subscribedAmount.toFixed(2),
          String((offering as any).metrics?.investorCount ?? 0),
          totalDistributed.toFixed(2),
        ]);
      }

      rows.push([]);
      rows.push(["TOTAL AUM", "", "", "", totalAum.toFixed(2), "", ""]);

      const csv = `${rows.map((row) => row.map((v) => csvSafe(v)).join(",")).join("\n")}\n`;
      const fileName = `aum_report_${new Date().toISOString().slice(0, 10)}.csv`;
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csv);
    },
  );

  // P3-06: Regulatory compliance report for operators
  app.get(
    "/v1/operator/reports/compliance",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "read", "distribution");

      const [investorProfiles, businesses, offerings, distributions] = await Promise.all([
        InvestorProfileModel.find().lean(),
        BusinessModel.find().lean(),
        OfferingModel.find().lean(),
        DistributionModel.find().lean(),
      ]);

      // KYC summary
      const kycCounts: Record<string, number> = {};
      for (const p of investorProfiles) {
        const status = (p as any).kycStatus ?? "unknown";
        kycCounts[status] = (kycCounts[status] ?? 0) + 1;
      }

      // KYB summary
      const kybCounts: Record<string, number> = {};
      for (const b of businesses) {
        const status = (b as any).kybStatus ?? "unknown";
        kybCounts[status] = (kybCounts[status] ?? 0) + 1;
      }

      // Offering status summary
      const offeringCounts: Record<string, number> = {};
      for (const o of offerings) {
        const status = (o as any).status ?? "unknown";
        offeringCounts[status] = (offeringCounts[status] ?? 0) + 1;
      }

      // Distribution status summary
      const distributionCounts: Record<string, number> = {};
      for (const d of distributions) {
        const status = (d as any).status ?? "unknown";
        distributionCounts[status] = (distributionCounts[status] ?? 0) + 1;
      }

      const rows: string[][] = [
        ["section", "metric", "count"],
        ...Object.entries(kycCounts).map(([status, count]) => ["KYC", status, String(count)]),
        ...Object.entries(kybCounts).map(([status, count]) => ["KYB", status, String(count)]),
        ...Object.entries(offeringCounts).map(([status, count]) => ["Offering", status, String(count)]),
        ...Object.entries(distributionCounts).map(([status, count]) => ["Distribution", status, String(count)]),
      ];

      const csv = `${rows.map((row) => row.map((v) => csvSafe(v)).join(",")).join("\n")}\n`;
      const fileName = `compliance_report_${new Date().toISOString().slice(0, 10)}.csv`;
      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csv);
    },
  );
}
