/**
 * Secondary market — compliant peer-to-peer transfers of an investor's position.
 *
 * Flow: a holder (seller) requests a transfer of part/all of their position in an
 * offering to another investor (buyer). An operator/admin runs the compliance gate
 * (off-chain mirror of the on-chain `canTransfer`: KYC/AML, lockup, concentration)
 * and approves — which atomically moves the ownership ledger and (when the on-chain
 * stack is configured) enqueues the on-chain token transfer. Gated by the platform
 * `enableSecondaryTransfers` flag.
 */
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  InvestorProfileModel,
  OfferingModel,
  PlatformConfigModel,
  SecondaryTransferModel,
  UserModel,
} from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { authorize } from "../../../utils/rbac.js";
import { assertInvestorScope } from "../../../utils/scope.js";
import { serialize } from "../../../utils/serialize.js";
import { toDecimal } from "../../../utils/decimal.js";
import { runInTransaction } from "../../../utils/tx.js";
import { appendEvent } from "../../../utils/audit.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";
import { postLedger, getOwnershipHolding } from "../../../services/ledger.js";
import { isOnchainEnabled } from "../../../services/onchain-autowire.js";
import { enqueueBlockchainOp } from "../../../workers/blockchain.worker.js";

function toNumber(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  return Number((value as { toString(): string }).toString());
}

const requestSchema = z.object({
  toEmail: z.string().email(),
  units: z.number().positive(),
  pricePerUnit: z.number().nonnegative().optional(),
});

/** Off-chain compliance gate mirroring the on-chain canTransfer checks. Throws on failure. */
async function assertTransferCompliance(args: {
  offering: any;
  buyerUserId: string;
  sellerUserId: string;
  units: number;
  session: any;
}): Promise<Record<string, unknown>> {
  const { offering, buyerUserId, units, session } = args;

  // Buyer must be a fully-cleared investor.
  const buyerProfile = await InvestorProfileModel.findOne({ userId: buyerUserId }).session(session).lean();
  if (!buyerProfile) throw new HttpError(422, "Recipient has no investor profile");
  if (buyerProfile.kycStatus !== "approved") throw new HttpError(422, "Recipient KYC is not approved");
  if (buyerProfile.amlStatus && buyerProfile.amlStatus !== "clear") {
    throw new HttpError(422, "Recipient AML screening is not clear");
  }

  // Lockup: secondary transfers are blocked until the holding period elapses.
  const config = await PlatformConfigModel.findById("platform_config").session(session).lean();
  const lockupDays = toNumber(
    (offering.terms as Record<string, unknown>)?.lockupDays ??
      (config?.complianceRules as any)?.defaultLockupDays ??
      0,
  );
  if (lockupDays > 0 && offering.closesAt) {
    const lockupEnd = new Date(new Date(offering.closesAt).getTime() + lockupDays * 24 * 60 * 60 * 1000);
    if (new Date() < lockupEnd) {
      throw new HttpError(422, `Transfers are locked until ${lockupEnd.toISOString().slice(0, 10)} (holding period).`);
    }
  }

  // Concentration cap: the buyer's resulting position must respect maxSingleInvestorPct.
  const maxSinglePct = toNumber((offering as any).metrics?.maxSingleInvestorPct ?? 0);
  const raiseAmount = toNumber((offering.terms as Record<string, unknown>)?.raiseAmount ?? 0);
  if (maxSinglePct > 0 && raiseAmount > 0) {
    const buyerHolding = await getOwnershipHolding(buyerUserId, String(offering._id), session);
    const resultingPct = ((buyerHolding + units) / raiseAmount) * 100;
    if (resultingPct > maxSinglePct) {
      throw new HttpError(
        422,
        `Transfer would breach the single-investor concentration limit of ${maxSinglePct}%.`,
      );
    }
  }

  return {
    buyerKyc: "approved",
    buyerAml: buyerProfile.amlStatus ?? "n/a",
    lockupDays,
    maxSinglePct,
    checkedAt: new Date().toISOString(),
  };
}

export async function secondaryTransferRoutes(app: FastifyInstance) {
  // Seller initiates a transfer request.
  app.post(
    "/v1/offerings/:id/transfers",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "transfer");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = requestSchema.parse(request.body);

      return runInTransaction(async (session) => {
        const config = await PlatformConfigModel.findById("platform_config").session(session).lean();
        if (!config?.featureFlags?.enableSecondaryTransfers) {
          throw new HttpError(422, "Secondary transfers are not enabled on this platform.");
        }

        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");
        if (offering.status !== "servicing") {
          throw new HttpError(422, "Secondary transfers are only allowed while the offering is in servicing.");
        }

        const sellerUserId = String(request.authUser.userId);
        assertInvestorScope(request.authUser, sellerUserId);

        const buyer = await UserModel.findOne({ email: payload.toEmail.toLowerCase(), role: "investor" })
          .session(session)
          .lean();
        if (!buyer) throw new HttpError(404, "Recipient investor not found");
        if (String(buyer._id) === sellerUserId) throw new HttpError(422, "Cannot transfer to yourself");

        const holding = await getOwnershipHolding(sellerUserId, String(offering._id), session);
        if (payload.units > holding) {
          throw new HttpError(422, `Transfer exceeds your position (${holding.toFixed(2)}).`);
        }

        const [transfer] = await SecondaryTransferModel.create(
          [
            {
              offeringId: offering._id,
              fromUserId: sellerUserId,
              toUserId: buyer._id,
              units: toDecimal(payload.units),
              pricePerUnit: payload.pricePerUnit != null ? toDecimal(payload.pricePerUnit) : undefined,
              status: "pending_approval",
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          { entityType: "offering", entityId: String(offering._id), action: "SecondaryTransferRequested", notes: `${payload.units} -> ${payload.toEmail}` },
          session,
        );

        return serialize(transfer.toObject());
      });
    },
  );

  // List transfers (scoped).
  app.get(
    "/v1/transfers",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "transfer");
      const query = z.object({ offeringId: z.string().optional(), status: z.string().optional() }).parse(request.query);
      const filter: Record<string, unknown> = {};
      if (query.offeringId) filter.offeringId = query.offeringId;
      if (query.status) filter.status = query.status;
      if (request.authUser.role === "investor") {
        filter.$or = [{ fromUserId: request.authUser.userId }, { toUserId: request.authUser.userId }];
      } else if (request.authUser.role === "issuer") {
        const offerings = await OfferingModel.find({ businessId: request.authUser.businessId }).select("_id").lean();
        filter.offeringId = { $in: offerings.map((o: any) => o._id) };
      }
      const rows = await SecondaryTransferModel.find(filter).sort({ createdAt: -1 }).limit(200).lean();
      return serialize({ data: rows });
    },
  );

  // Operator/admin approves -> runs compliance + executes the ownership move.
  app.post(
    "/v1/transfers/:id/approve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "transfer");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const transfer = await SecondaryTransferModel.findById(params.id).session(session);
        if (!transfer) throw new HttpError(404, "Transfer not found");
        if (transfer.status !== "pending_approval") {
          throw new HttpError(422, `Transfer is "${transfer.status}", expected "pending_approval"`);
        }
        const offering = await OfferingModel.findById(transfer.offeringId).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        const units = toNumber(transfer.units);
        const sellerId = String(transfer.fromUserId);
        const buyerId = String(transfer.toUserId);

        // Re-check seller still holds enough, then full compliance gate.
        const holding = await getOwnershipHolding(sellerId, String(offering._id), session);
        if (units > holding) throw new HttpError(422, "Seller no longer holds enough to transfer");
        const checks = await assertTransferCompliance({ offering, buyerUserId: buyerId, sellerUserId: sellerId, units, session });

        // Move ownership in the ledger (debit seller, credit buyer), scoped to the offering.
        await postLedger(
          {
            ledgerType: "ownership",
            accountRef: `investor:${sellerId}`,
            direction: "debit",
            amount: units,
            entityType: "offering",
            entityId: String(offering._id),
            idempotencyKey: `xfer:${String(transfer._id)}:debit`,
            metadata: { secondaryTransferId: String(transfer._id), counterparty: buyerId },
          },
          session,
        );
        await postLedger(
          {
            ledgerType: "ownership",
            accountRef: `investor:${buyerId}`,
            direction: "credit",
            amount: units,
            entityType: "offering",
            entityId: String(offering._id),
            idempotencyKey: `xfer:${String(transfer._id)}:credit`,
            metadata: { secondaryTransferId: String(transfer._id), counterparty: sellerId },
          },
          session,
        );

        transfer.status = "executed";
        transfer.complianceChecks = checks;
        transfer.reviewedBy = request.authUser.userId as any;
        transfer.reviewedAt = new Date();
        transfer.executedAt = new Date();

        // On-chain leg (gated): whitelist buyer + transfer tokens when configured.
        const td = (offering as any).tokenDeployment;
        if (isOnchainEnabled() && td?.contractAddress && td?.status === "deployed") {
          const [sellerProfile, buyerProfile] = await Promise.all([
            InvestorProfileModel.findOne({ userId: sellerId }).select("walletAddress").session(session).lean(),
            InvestorProfileModel.findOne({ userId: buyerId }).select("walletAddress").session(session).lean(),
          ]);
          if (sellerProfile?.walletAddress && buyerProfile?.walletAddress) {
            await enqueueBlockchainOp({
              opType: "forced_transfer" as any,
              entityType: "offering",
              entityId: String(offering._id),
              payload: {
                contractAddress: td.contractAddress,
                from: sellerProfile.walletAddress,
                to: buyerProfile.walletAddress,
                amount: units,
                secondaryTransferId: String(transfer._id),
              },
            });
            transfer.onchainEnqueued = true;
          }
        }

        await transfer.save({ session });

        await appendEvent(
          request.authUser,
          { entityType: "offering", entityId: String(offering._id), action: "SecondaryTransferExecuted", notes: String(transfer._id) },
          session,
        );
        await createNotificationsFromEvent(
          request.authUser,
          { entityType: "offering", entityId: String(offering._id), action: "SecondaryTransferExecuted", notes: `Transfer of ${units} executed.` },
          session,
        );

        return serialize(transfer.toObject());
      });
    },
  );

  // Operator/admin rejects.
  app.post(
    "/v1/transfers/:id/reject",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "transfer");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3) }).parse(request.body);
      const transfer = await SecondaryTransferModel.findById(params.id);
      if (!transfer) throw new HttpError(404, "Transfer not found");
      if (transfer.status !== "pending_approval") throw new HttpError(422, "Only pending transfers can be rejected");
      transfer.status = "rejected";
      transfer.reviewNotes = payload.reason;
      transfer.reviewedBy = request.authUser.userId as any;
      transfer.reviewedAt = new Date();
      await transfer.save();
      return serialize(transfer.toObject());
    },
  );

  // Seller cancels their own pending request.
  app.post(
    "/v1/transfers/:id/cancel",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "transfer");
      const params = z.object({ id: z.string() }).parse(request.params);
      const transfer = await SecondaryTransferModel.findById(params.id);
      if (!transfer) throw new HttpError(404, "Transfer not found");
      if (request.authUser.role === "investor") {
        assertInvestorScope(request.authUser, String(transfer.fromUserId));
      }
      if (transfer.status !== "pending_approval") throw new HttpError(422, "Only pending transfers can be cancelled");
      transfer.status = "cancelled";
      await transfer.save();
      return serialize(transfer.toObject());
    },
  );
}
