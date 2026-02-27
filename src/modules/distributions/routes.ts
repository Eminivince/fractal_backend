import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DistributionModel, LedgerEntryModel, OfferingModel, SubscriptionModel } from "../../db/models.js";
import { toDecimal } from "../../utils/decimal.js";
import mongoose from "mongoose";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { assertTransition } from "../../utils/state-machine.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";
import { runInTransaction } from "../../utils/tx.js";
import { serialize } from "../../utils/serialize.js";
import { createAnchorRecord } from "../../utils/anchor.js";
import { readCommandId, runIdempotentCommand } from "../../utils/idempotency.js";

const createDistributionSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
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

        // I-26: Offering must be in servicing or closed status to create distributions
        if (!["servicing", "closed"].includes(offering.status)) {
          throw new HttpError(422, `Cannot submit a distribution for an offering in "${offering.status}" status. Offering must be in servicing or closed status.`);
        }

        // I-26: Prevent duplicate distribution period
        const existingForPeriod = await DistributionModel.findOne({
          offeringId: offering._id,
          period: payload.period,
          status: { $nin: ["cancelled"] },
        }).session(session);
        if (existingForPeriod) {
          throw new HttpError(
            422,
            `A distribution for period "${payload.period}" already exists (status: ${(existingForPeriod as any).status}). Cancel or update the existing distribution before submitting a new one for the same period.`,
          );
        }

        // I-26: Validate amount against available escrow balance
        const [credits, debits, pendingDistributions] = await Promise.all([
          LedgerEntryModel.find({
            ledgerType: { $in: ["escrow", "subscription"] },
            accountRef: `escrow:offering:${String(offering._id)}`,
            direction: "credit",
          })
            .select("amount")
            .session(session)
            .lean(),
          LedgerEntryModel.find({
            ledgerType: { $in: ["escrow", "subscription", "distribution", "tranche"] },
            accountRef: `escrow:offering:${String(offering._id)}`,
            direction: "debit",
          })
            .select("amount")
            .session(session)
            .lean(),
          DistributionModel.find({
            offeringId: offering._id,
            status: { $in: ["pending_approval", "approved", "scheduled"] },
          })
            .select("amount")
            .session(session)
            .lean(),
        ]);

        const totalCredits = credits.reduce((s: number, e: any) => s + Number(e.amount?.toString() ?? "0"), 0);
        const totalDebits = debits.reduce((s: number, e: any) => s + Number(e.amount?.toString() ?? "0"), 0);
        const pendingAmount = pendingDistributions.reduce((s: number, d: any) => s + Number(d.amount?.toString() ?? "0"), 0);
        const availableForDistribution = totalCredits - totalDebits - pendingAmount;

        if (payload.amount > availableForDistribution) {
          throw new HttpError(
            422,
            `Distribution amount (${payload.amount.toLocaleString()} NGN) exceeds available escrow balance (${availableForDistribution.toFixed(2)} NGN). Reduce the amount or wait for escrow to be funded.`,
          );
        }

        const [distribution] = await DistributionModel.create(
          [
            {
              offeringId: offering._id,
              period: payload.period,
              amount: toDecimal(payload.amount),
              status: "draft",
              createdBy: request.authUser.userId,
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

            distribution.status = "paid";
            distribution.payoutReceiptRefs = payload.payoutReceiptRefs as any;
            distribution.paidAt = new Date();
            await distribution.save({ session });

            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "distribution",
                  accountRef: `offering:${String(distribution.offeringId)}`,
                  direction: "debit",
                  amount: distribution.amount,
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

            const anchor = await createAnchorRecord(
              {
                entityType: "distribution",
                entityId: String(distribution._id),
                eventType: "DistributionPaid",
                payload: {
                  payoutReceiptRefs: payload.payoutReceiptRefs,
                  amount: distribution.amount.toString(),
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
}
