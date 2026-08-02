import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BusinessModel, LedgerEntryModel, MilestoneModel, OfferingModel, OutboundTransferModel, TrancheModel } from "../../../db/models.js";
import { toDecimal } from "../../../utils/decimal.js";
import { escrowAccountRef, getEscrowBalance, postLedger } from "../../../services/ledger.js";
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
import {
  createPaystackTransferRecipient,
  getAvailableBalanceKobo,
  initiatePaystackTransfer,
  nairaToKobo,
} from "../../../services/paystack.js";

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

      // When Paystack is enabled, payoutReceiptRefs are optional — the transfer reference is generated.
      // When Paystack is disabled (manual mode), payoutReceiptRefs are required as proof of manual payout.
      const payload = z
        .object({
          payoutReceiptRefs: z.array(z.string().min(6)).min(1).optional(),
        })
        .parse(request.body);

      if (!env.PAYSTACK_ENABLED && (!payload.payoutReceiptRefs || payload.payoutReceiptRefs.length === 0)) {
        throw new HttpError(422, "payoutReceiptRefs required when Paystack is not enabled (manual payout mode)");
      }

      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/tranches/:id/release",
        payload: { id: params.id, payoutReceiptRefs: payload.payoutReceiptRefs },
        execute: () =>
          runInTransaction(async (session) => {
            // 3.4: Atomically claim the eligible tranche (eligible -> processing).
            // Concurrent/retried releases cannot both proceed.
            const tranche = await TrancheModel.findOneAndUpdate(
              { _id: params.id, status: "eligible" },
              { $set: { status: "processing" } },
              { session, new: true },
            );
            if (!tranche) {
              const current = await TrancheModel.findById(params.id).session(session);
              if (!current) throw new HttpError(404, "Tranche not found");
              if (["processing", "released"].includes(current.status)) {
                return serialize(current.toObject());
              }
              throw new HttpError(409, `Tranche is "${current.status}", expected "eligible"`);
            }

            const offering = await OfferingModel.findById(tranche.offeringId).session(session);
            if (!offering) throw new HttpError(404, "Offering not found for tranche");

            const business = await BusinessModel.findById(offering.businessId).session(session);
            if (!business) throw new HttpError(404, "Business not found for offering");
            const payoutAccount = (business as any).payoutBankAccount;
            const currency = payoutAccount?.currency ?? "NGN";

            const trancheAmountNaira = toNumber(tranche.amount);
            const amountKobo = nairaToKobo(trancheAmountNaira);
            if (amountKobo <= 0) {
              throw new HttpError(422, "Tranche amount must be positive");
            }

            // §4: Validate the release against ACTUAL collected escrow (not the
            // Paystack float balance). A partially-funded offering cannot over-release.
            const { balance: escrowBalanceNaira } = await getEscrowBalance(tranche.offeringId, session);
            if (trancheAmountNaira > escrowBalanceNaira) {
              throw new HttpError(
                422,
                `Tranche amount (${trancheAmountNaira}) exceeds collected escrow balance (${escrowBalanceNaira.toFixed(2)}).`,
              );
            }

            // --- Paystack-enabled path: initiate real bank transfer ---
            if (env.PAYSTACK_ENABLED) {
              if (!payoutAccount?.accountNumber || !payoutAccount?.bankCode) {
                throw new HttpError(
                  422,
                  "Business payout bank account is incomplete — accountNumber and bankCode required",
                );
              }

              // Balance pre-flight check
              if (env.PAYSTACK_BALANCE_CHECK_ENABLED) {
                const availableKobo = await getAvailableBalanceKobo();
                if (availableKobo < amountKobo) {
                  throw new HttpError(
                    422,
                    `Insufficient Paystack balance: available ${availableKobo / 100} NGN, required ${amountKobo / 100} NGN`,
                  );
                }
              }

              // Ensure business has a Paystack transfer recipient
              let recipientCode = payoutAccount.recipientCode;
              if (!recipientCode) {
                const recipient = await createPaystackTransferRecipient({
                  name: payoutAccount.accountName || (business as any).name,
                  accountNumber: payoutAccount.accountNumber,
                  bankCode: payoutAccount.bankCode,
                });
                recipientCode = recipient.recipient_code;
                // Persist recipient code so we don't re-create it
                await BusinessModel.updateOne(
                  { _id: business._id },
                  { $set: { "payoutBankAccount.recipientCode": recipientCode } },
                ).session(session);
              }

              // 3.4: Deterministic reference (no Date.now()) so Paystack's own
              // duplicate-reference protection guards against double release.
              const transferRef = `tranche-${String(tranche._id)}`;
              const transfer = await initiatePaystackTransfer({
                recipientCode,
                amountKobo,
                reference: transferRef,
                reason: `Tranche release for offering ${String(tranche.offeringId)}`,
              });

              // Create outbound transfer record for webhook lifecycle tracking
              await OutboundTransferModel.create(
                [
                  {
                    transferCode: transfer.transfer_code,
                    reference: transferRef,
                    recipientCode,
                    amountKobo,
                    currency: "NGN",
                    reason: `Tranche release for offering ${String(tranche.offeringId)}`,
                    status: "pending",
                    entityType: "tranche_release",
                    entityId: String(tranche._id),
                    paystackStatus: transfer.status,
                  },
                ],
                { session },
              );

              // Tranche was already atomically claimed to "processing". Released
              // happens via the transfer.success webhook.
              tranche.releasedBy = request.authUser.userId as any;
              tranche.payoutReceiptRefs = [transferRef] as any;
              await tranche.save({ session });

              await appendEvent(
                request.authUser,
                {
                  entityType: "tranche",
                  entityId: String(tranche._id),
                  action: "TrancheReleaseInitiated",
                  notes: `Paystack transfer initiated: ${transfer.transfer_code}`,
                },
                session,
              );

              return serialize(tranche.toObject());
            }

            // --- Manual mode (Paystack disabled): immediate release with receipt refs ---
            const receiptRefs = payload.payoutReceiptRefs!;
            const trancheLedgerKey = commandId ?? `tranche:${String(tranche._id)}`;

            assertTransition("tranche", tranche.status as any, "released", {
              hasPayoutReceipts: receiptRefs.length > 0,
            });
            tranche.status = "released";
            tranche.payoutReceiptRefs = receiptRefs as any;
            tranche.releasedBy = request.authUser.userId as any;
            tranche.releasedAt = new Date();
            await tranche.save({ session });

            // Debit the offering escrow (funds leaving escrow)
            await postLedger(
              {
                ledgerType: "tranche",
                accountRef: escrowAccountRef(tranche.offeringId),
                direction: "debit",
                amount: tranche.amount,
                currency,
                entityType: "tranche",
                entityId: String(tranche._id),
                externalRef: receiptRefs[0],
                idempotencyKey: `${trancheLedgerKey}:debit`,
                metadata: { payoutReceiptRefs: receiptRefs },
              },
              session,
            );

            // Credit the issuer (funds arriving at issuer)
            await postLedger(
              {
                ledgerType: "tranche",
                accountRef: `issuer:business:${String(offering.businessId)}`,
                direction: "credit",
                amount: tranche.amount,
                currency,
                entityType: "tranche",
                entityId: String(tranche._id),
                externalRef: receiptRefs[0],
                idempotencyKey: `${trancheLedgerKey}:credit`,
                metadata: {
                  payoutReceiptRefs: receiptRefs,
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
              session,
            );

            const anchor = await createAnchorRecord(
              {
                entityType: "tranche",
                entityId: String(tranche._id),
                eventType: "TrancheReleased",
                payload: {
                  payoutReceiptRefs: receiptRefs,
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
                  accountRef: escrowAccountRef(tranche.offeringId),
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
