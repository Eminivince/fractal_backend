/**
 * Payment verification sweep worker.
 *
 * Safety net: catches missed charge.success webhooks by polling Paystack
 * for pending PaymentIntents older than 2 hours. Also expires abandoned
 * intents older than 24 hours.
 *
 * This worker is NOT the primary payment confirmation path — webhooks are.
 * It exists purely as defense-in-depth against missed webhook delivery.
 */

import type { FastifyBaseLogger } from "fastify";
import { PaymentIntentModel, SubscriptionModel, EscrowReceiptModel, LedgerEntryModel } from "../db/models.js";
import { verifyPaystackTransaction } from "../services/paystack.js";
import { escrowAccountRef } from "../services/ledger.js";
import { toDecimal } from "../utils/decimal.js";
import { appendEvent } from "../utils/audit.js";
import { runInTransaction } from "../utils/tx.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const STALE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours
const EXPIRY_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function startPaymentVerificationWorker(log: FastifyBaseLogger) {
  if (!env.PAYSTACK_ENABLED) {
    log.info("Payment verification worker disabled (PAYSTACK_ENABLED=false)");
    return { stop: () => {}, triggerNow: async () => {} };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const staleThreshold = new Date(now.getTime() - STALE_THRESHOLD_MS);
      const expiryThreshold = new Date(now.getTime() - EXPIRY_THRESHOLD_MS);

      // 1. Find stale pending intents (older than 2h) and verify with Paystack
      const staleIntents = await PaymentIntentModel.find({
        status: "pending",
        createdAt: { $lt: staleThreshold },
      }).limit(50);

      let verifiedCount = 0;
      let expiredCount = 0;

      for (const intent of staleIntents) {
        if (!intent.paystackReference) continue;

        try {
          const verification = await verifyPaystackTransaction(intent.paystackReference);

          if (verification.status === "success") {
            // Webhook was missed — process the charge
            log.warn(
              { reference: intent.paystackReference, intentId: String(intent._id) },
              "Payment verification sweep: caught missed webhook",
            );

            await runInTransaction(async (session) => {
              const freshIntent = await PaymentIntentModel.findById(intent._id).session(session);
              if (!freshIntent || freshIntent.status !== "pending") return;

              freshIntent.receivedAmountKobo = verification.amount;
              freshIntent.status = "amount_matched";
              freshIntent.matchedAt = new Date();
              await freshIntent.save({ session });

              const subscription = await SubscriptionModel.findById(freshIntent.subscriptionId).session(session);
              if (!subscription || ["paid", "allocation_confirmed"].includes(subscription.status)) return;

              // Idempotent receipt
              const receipt = await EscrowReceiptModel.findOneAndUpdate(
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
                    metadata: { source: "verification_sweep" },
                  },
                },
                { upsert: true, new: true, session },
              );

              const isNew = receipt.createdAt?.getTime() === receipt.updatedAt?.getTime();
              if (!isNew) return;

              subscription.status = "paid";
              subscription.externalReceiptRef = intent.paystackReference;
              await subscription.save({ session });

              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "escrow",
                    accountRef: escrowAccountRef(subscription.offeringId),
                    direction: "credit",
                    amount: toDecimal(verification.amount / 100),
                    currency: verification.currency || "NGN",
                    entityType: "subscription",
                    entityId: String(subscription._id),
                    externalRef: intent.paystackReference,
                    idempotencyKey: `paystack:charge:${intent.paystackReference}`,
                    postedAt: new Date(),
                    metadata: { source: "verification_sweep" },
                  },
                ],
                { session },
              );

              await appendEvent(
                SYSTEM_ACTOR as any,
                {
                  entityType: "subscription",
                  entityId: String(subscription._id),
                  action: "SubscriptionPaid",
                  notes: `sweep:${intent.paystackReference}`,
                },
                session,
              );
            });

            verifiedCount++;
          } else if (
            verification.status === "abandoned" &&
            new Date(intent.createdAt as any) < expiryThreshold
          ) {
            intent.status = "expired";
            await intent.save();
            expiredCount++;
          }
        } catch (err: any) {
          log.warn(
            { err: err.message, reference: intent.paystackReference },
            "Payment verification sweep: Paystack API error",
          );
        }
      }

      // 2. Expire very old pending intents regardless of Paystack status
      const bulkExpired = await PaymentIntentModel.updateMany(
        {
          status: "pending",
          expiresAt: { $lt: now },
        },
        { $set: { status: "expired" } },
      );

      if (verifiedCount > 0 || expiredCount > 0 || (bulkExpired.modifiedCount ?? 0) > 0) {
        log.info(
          {
            verified: verifiedCount,
            expired: expiredCount + (bulkExpired.modifiedCount ?? 0),
          },
          "Payment verification sweep completed",
        );
      }
    } catch (err: any) {
      log.error({ err: err.message }, "Payment verification sweep error");
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info(`Payment verification worker started (interval=${POLL_INTERVAL_MS}ms)`);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    triggerNow: tick,
  };
}
