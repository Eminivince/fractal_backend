import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BusinessModel, LedgerEntryModel, MilestoneModel, OfferingModel, TrancheModel } from "../../../db/models.js";
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

const milestoneInputSchema = z.object({
  milestones: z
    .array(
      z.object({
        name: z.string().min(2),
        percent: z.number().positive(),
      }),
    )
    .min(1)
    .optional(),
});

const evidenceDocSchema = z.object({
  docId: z.string().min(2),
  filename: z.string().min(2),
});

function parseTermsMilestones(terms: Record<string, unknown>): Array<{ name: string; percent: number }> {
  const raw = terms.milestones;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name : null;
      const percent =
        typeof row.percent === "number" ? row.percent : typeof row.amountPct === "number" ? row.amountPct : null;
      if (!name || percent === null) return null;
      return { name, percent };
    })
    .filter(Boolean) as Array<{ name: string; percent: number }>;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toString" in value) return Number(value.toString());
  return 0;
}

export async function milestoneRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings/:id/milestones",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "milestone");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = milestoneInputSchema.parse(request.body ?? {});

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");
        if (offering.templateCode !== "B") throw new HttpError(422, "Milestones apply only to Template B offerings");

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        const existingCount = await MilestoneModel.countDocuments({ offeringId: offering._id }).session(session);
        if (existingCount > 0) throw new HttpError(409, "Milestones already exist for this offering");

        const raiseAmount = toNumber((offering.terms as Record<string, unknown>).raiseAmount);
        const milestones = payload.milestones ?? parseTermsMilestones(offering.terms as Record<string, unknown>);

        if (!milestones.length) throw new HttpError(422, "No milestone definitions supplied");
        const totalPct = milestones.reduce((sum, item) => sum + item.percent, 0);
        if (Math.round(totalPct) !== 100) throw new HttpError(422, "Milestones percentage must total 100");

        const createdMilestones = [];
        for (const milestone of milestones) {
          const [created] = await MilestoneModel.create(
            [
              {
                offeringId: offering._id,
                name: milestone.name,
                percent: milestone.percent,
                status: "not_started",
                evidenceDocs: [],
              },
            ],
            { session },
          );

          await TrancheModel.create(
            [
              {
                offeringId: offering._id,
                milestoneId: created._id,
                amount: toDecimal((raiseAmount * milestone.percent) / 100),
                status: "locked",
              },
            ],
            { session },
          );

          createdMilestones.push(created);
        }

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "MilestonesInitialized",
            notes: `${createdMilestones.length} milestones`,
          },
          session,
        );

        return serialize(createdMilestones.map((item) => item.toObject()));
      });
    },
  );

  app.post(
    "/v1/milestones/:id/request-verification",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "milestone");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ evidenceDocs: z.array(evidenceDocSchema).min(1) }).parse(request.body ?? {});
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/milestones/:id/request-verification",
        payload: { id: params.id, evidenceDocs: payload.evidenceDocs },
        execute: () =>
          runInTransaction(async (session) => {
            const milestone = await MilestoneModel.findById(params.id).session(session);
            if (!milestone) throw new HttpError(404, "Milestone not found");

            const offering = await OfferingModel.findById(milestone.offeringId).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");
            assertIssuerBusinessScope(request.authUser, String(offering.businessId));

            assertTransition("milestone", milestone.status as any, "evidence_submitted");
            milestone.evidenceDocs = payload.evidenceDocs as any;
            milestone.status = "evidence_submitted";
            await milestone.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "milestone",
                entityId: String(milestone._id),
                action: "MilestoneEvidenceSubmitted",
              },
              session,
            );

            return serialize(milestone.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/milestones/:id/start-review",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "review", "milestone");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/milestones/:id/start-review",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const milestone = await MilestoneModel.findById(params.id).session(session);
            if (!milestone) throw new HttpError(404, "Milestone not found");

            assertTransition("milestone", milestone.status as any, "in_review");
            milestone.status = "in_review";
            await milestone.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "milestone",
                entityId: String(milestone._id),
                action: "MilestoneReviewStarted",
              },
              session,
            );

            return serialize(milestone.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/milestones/:id/verify",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "approve", "milestone");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ evidenceDocs: z.array(evidenceDocSchema).optional() }).parse(request.body ?? {});
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/milestones/:id/verify",
        payload: { id: params.id, evidenceDocs: payload.evidenceDocs ?? [] },
        execute: () =>
          runInTransaction(async (session) => {
            const milestone = await MilestoneModel.findById(params.id).session(session);
            if (!milestone) throw new HttpError(404, "Milestone not found");

            if (payload.evidenceDocs?.length) milestone.evidenceDocs = payload.evidenceDocs as any;

            assertTransition("milestone", milestone.status as any, "verified", {
              hasEvidence: milestone.evidenceDocs.length > 0,
            });

            milestone.status = "verified";
            milestone.verifiedBy = request.authUser.userId as any;
            milestone.verifiedAt = new Date();
            await milestone.save({ session });

            const tranche = await TrancheModel.findOne({ offeringId: milestone.offeringId, milestoneId: milestone._id }).session(
              session,
            );
            if (!tranche) throw new HttpError(404, "Tranche not found for milestone");

            assertTransition("tranche", tranche.status as any, "eligible");
            tranche.status = "eligible";
            await tranche.save({ session });

            const anchor = await createAnchorRecord(
              {
                entityType: "milestone",
                entityId: String(milestone._id),
                eventType: "MilestoneVerified",
                payload: {
                  offeringId: String(milestone.offeringId),
                  evidenceDocs: milestone.evidenceDocs,
                  verifiedBy: request.authUser.userId,
                },
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "milestone",
                entityId: String(milestone._id),
                action: "MilestoneVerified",
                notes: `anchor:${anchor.id}`,
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "tranche",
                entityId: String(tranche._id),
                action: "TrancheEligible",
              },
              session,
            );

            return serialize({ milestone: milestone.toObject(), tranche: tranche.toObject() });
          }),
      });
    },
  );

  app.post(
    "/v1/milestones/:id/reject",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "approve", "milestone");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3) }).parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/milestones/:id/reject",
        payload: { id: params.id, reason: payload.reason },
        execute: () =>
          runInTransaction(async (session) => {
            const milestone = await MilestoneModel.findById(params.id).session(session);
            if (!milestone) throw new HttpError(404, "Milestone not found");

            assertTransition("milestone", milestone.status as any, "rejected");
            milestone.status = "rejected";
            await milestone.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "milestone",
                entityId: String(milestone._id),
                action: "MilestoneRejected",
                notes: payload.reason,
              },
              session,
            );

            return serialize(milestone.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/tranches/:id/release",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "tranche");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ payoutReceiptRefs: z.array(z.string().min(6)).min(1) }).parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/tranches/:id/release",
        payload: { id: params.id, payoutReceiptRefs: payload.payoutReceiptRefs },
        execute: () =>
          runInTransaction(async (session) => {
            const tranche = await TrancheModel.findById(params.id).session(session);
            if (!tranche) throw new HttpError(404, "Tranche not found");

            const offering = await OfferingModel.findById(tranche.offeringId).session(session);
            if (!offering) throw new HttpError(404, "Offering not found for tranche");

            const business = await BusinessModel.findById(offering.businessId).session(session);
            const payoutAccount = business ? (business as any).payoutBankAccount : null;
            const currency = payoutAccount?.currency ?? "NGN";

            assertTransition("tranche", tranche.status as any, "released", {
              hasPayoutReceipts: payload.payoutReceiptRefs.length > 0,
            });
            tranche.status = "released";
            tranche.payoutReceiptRefs = payload.payoutReceiptRefs as any;
            tranche.releasedBy = request.authUser.userId as any;
            tranche.releasedAt = new Date();
            await tranche.save({ session });

            // Debit the offering escrow (funds leaving escrow)
            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "tranche",
                  accountRef: `escrow:offering:${String(tranche.offeringId)}`,
                  direction: "debit",
                  amount: tranche.amount,
                  currency,
                  entityType: "tranche",
                  entityId: String(tranche._id),
                  externalRef: payload.payoutReceiptRefs[0],
                  idempotencyKey: commandId ? `${commandId}:debit` : undefined,
                  postedAt: new Date(),
                  metadata: { payoutReceiptRefs: payload.payoutReceiptRefs },
                },
              ],
              { session },
            );

            // Credit the issuer (funds arriving at issuer)
            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "tranche",
                  accountRef: `issuer:business:${String(offering.businessId)}`,
                  direction: "credit",
                  amount: tranche.amount,
                  currency,
                  entityType: "tranche",
                  entityId: String(tranche._id),
                  externalRef: payload.payoutReceiptRefs[0],
                  idempotencyKey: commandId ? `${commandId}:credit` : undefined,
                  postedAt: new Date(),
                  metadata: {
                    payoutReceiptRefs: payload.payoutReceiptRefs,
                    disbursementType: "tranche_payout",
                    ...(payoutAccount?.accountNumber
                      ? {
                          bankName: payoutAccount.bankName,
                          accountNumber: payoutAccount.accountNumber,
                          accountName: payoutAccount.accountName,
                        }
                      : {}),
                  },
                },
              ],
              { session },
            );

            const anchor = await createAnchorRecord(
              {
                entityType: "tranche",
                entityId: String(tranche._id),
                eventType: "TrancheReleased",
                payload: {
                  payoutReceiptRefs: payload.payoutReceiptRefs,
                  amount: tranche.amount.toString(),
                },
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "tranche",
                entityId: String(tranche._id),
                action: "TrancheReleased",
                notes: `anchor:${anchor.id}`,
              },
              session,
            );

            return serialize(tranche.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/tranches/:id/mark-failed",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "tranche");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3) }).parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/tranches/:id/mark-failed",
        payload: { id: params.id, reason: payload.reason },
        execute: () =>
          runInTransaction(async (session) => {
            const tranche = await TrancheModel.findById(params.id).session(session);
            if (!tranche) throw new HttpError(404, "Tranche not found");

            assertTransition("tranche", tranche.status as any, "failed");
            tranche.status = "failed";
            tranche.failedAt = new Date();
            await tranche.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "tranche",
                entityId: String(tranche._id),
                action: "TrancheFailed",
                notes: payload.reason,
              },
              session,
            );

            return serialize(tranche.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/tranches/:id/reverse",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "tranche");
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
        route: "POST:/v1/tranches/:id/reverse",
        payload: { id: params.id, ...payload },
        execute: () =>
          runInTransaction(async (session) => {
            const tranche = await TrancheModel.findById(params.id).session(session);
            if (!tranche) throw new HttpError(404, "Tranche not found");

            assertTransition("tranche", tranche.status as any, "reversed", { trusteeProcessCompleted: true });
            tranche.status = "reversed";
            tranche.reversedAt = new Date();
            tranche.reversalReason = payload.reason;
            await tranche.save({ session });

            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "tranche",
                  accountRef: `offering:${String(tranche.offeringId)}`,
                  direction: "credit",
                  amount: tranche.amount,
                  currency: "NGN",
                  entityType: "tranche",
                  entityId: String(tranche._id),
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
                entityType: "tranche",
                entityId: String(tranche._id),
                action: "TrancheReversed",
                notes: payload.reason,
              },
              session,
            );

            return serialize(tranche.toObject());
          }),
      });
    },
  );

  app.get(
    "/v1/offerings/:id/milestones",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "milestone");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");
      if (request.authUser.role === "issuer") assertIssuerBusinessScope(request.authUser, String(offering.businessId));

      const rows = await MilestoneModel.find({ offeringId: offering._id }).sort({ createdAt: 1 }).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/offerings/:id/tranches",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "tranche");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");
      if (request.authUser.role === "issuer") assertIssuerBusinessScope(request.authUser, String(offering.businessId));

      const rows = await TrancheModel.find({ offeringId: offering._id }).sort({ createdAt: 1 }).lean();
      return serialize(rows);
    },
  );
}
