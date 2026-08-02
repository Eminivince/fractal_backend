/**
 * B2: BullMQ-based payment verification worker.
 * Replaces the polling-based payment-verification.worker when Redis is available.
 */

import { createQueue } from "../../services/queue.js";
import { PaymentIntentModel, SubscriptionModel, EscrowReceiptModel, LedgerEntryModel } from "../../db/models.js";
import { verifyPaystackTransaction } from "../../services/paystack.js";
import { toDecimal } from "../../utils/decimal.js";
import { appendEvent } from "../../utils/audit.js";
import { runInTransaction } from "../../utils/tx.js";
import type { AuthUser } from "../../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000;

interface LoggerLike {
  info: (obj: any, msg?: string) => void;
  warn: (obj: any, msg?: string) => void;
  error: (obj: any, msg?: string) => void;
}

export function startPaymentVerificationQueue(log: LoggerLike) {
  const result = createQueue(
    "payment-verification",
    async () => {
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);

      const staleIntents = await PaymentIntentModel.find({
        status: "pending",
        createdAt: { $lt: staleThreshold },
      }).limit(50);

      let verifiedCount = 0;
      for (const intent of staleIntents) {
        if (!intent.paystackReference) continue;
        try {
          const verification = await verifyPaystackTransaction(intent.paystackReference);
          if (verification.status === "success") {
            log.warn({ reference: intent.paystackReference }, "BullMQ sweep: caught missed webhook");
            await runInTransaction(async (session) => {
              const freshIntent = await PaymentIntentModel.findById(intent._id).session(session);
              if (!freshIntent || freshIntent.status !== "pending") return;
              freshIntent.receivedAmountKobo = verification.amount;
              freshIntent.status = "amount_matched";
              freshIntent.matchedAt = new Date();
              await freshIntent.save({ session });

              const subscription = await SubscriptionModel.findById(freshIntent.subscriptionId).session(session);
              if (!subscription || ["paid", "allocation_confirmed"].includes(subscription.status)) return;

              await EscrowReceiptModel.findOneAndUpdate(
                { externalRef: intent.paystackReference },
                {
                  $setOnInsert: {
                    externalRef: intent.paystackReference,
                    source: "provider",
                    amount: toDecimal(verification.amount / 100),
                    payerRef: String(subscription.investorUserId),
                    currency: verification.currency || "NGN",
                    status: "confirmed",
                    occurredAt: new Date(verification.paid_at),
                    metadata: { source: "queue_sweep" },
                  },
                },
                { upsert: true, new: true, session },
              );

              subscription.status = "paid";
              subscription.externalReceiptRef = intent.paystackReference;
              await subscription.save({ session });

              await appendEvent(SYSTEM_ACTOR as any, {
                entityType: "subscription",
                entityId: String(subscription._id),
                action: "SubscriptionPaid",
                notes: `queue_sweep:${intent.paystackReference}`,
              }, session);
            });
            verifiedCount++;
          }
        } catch (err: any) {
          log.warn({ err: err.message, reference: intent.paystackReference }, "Queue sweep: Paystack API error");
        }
      }

      // Expire old pending intents
      const bulkExpired = await PaymentIntentModel.updateMany(
        { status: "pending", expiresAt: { $lt: now } },
        { $set: { status: "expired" } },
      );

      if (verifiedCount > 0 || (bulkExpired.modifiedCount ?? 0) > 0) {
        log.info({ verified: verifiedCount, expired: bulkExpired.modifiedCount ?? 0 }, "Queue sweep completed");
      }
    },
    { repeatEveryMs: 900_000 },
  );

  if (!result) {
    log.warn("[queue:payment-verification] Redis not available");
    return { stop: () => {}, triggerNow: async () => {} };
  }

  log.info("[queue:payment-verification] BullMQ payment verification worker started");
  return {
    stop: () => { result.worker.close().catch(() => {}); result.queue.close().catch(() => {}); },
    triggerNow: async () => { await result.queue.add("manual-trigger", {}, { priority: 1 }); },
  };
}
