/**
 * Transfer settlement sweep worker.
 *
 * Safety net: catches missed transfer.success / transfer.failed webhooks
 * by polling Paystack for pending OutboundTransfers older than a configurable
 * threshold. Also flags stale transfers (> 48h) as reconciliation issues.
 *
 * This worker is NOT the primary settlement path — webhooks are.
 */

import type { FastifyBaseLogger } from "fastify";
import {
  DistributionLineModel,
  DistributionModel,
  LedgerEntryModel,
  OfferingModel,
  OutboundTransferModel,
  ReconciliationIssueModel,
  SubscriptionModel,
  TrancheModel,
} from "../db/models.js";
import { fetchPaystackTransfer } from "../services/paystack.js";
import { escrowAccountRef } from "../services/ledger.js";
import { toDecimal } from "../utils/decimal.js";
import { appendEvent } from "../utils/audit.js";
import { runInTransaction } from "../utils/tx.js";
import { env } from "../config/env.js";
import type { AuthUser } from "../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };
const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const ALERT_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

export function startTransferSettlementWorker(log: FastifyBaseLogger) {
  if (!env.PAYSTACK_ENABLED) {
    log.info("Transfer settlement worker disabled (PAYSTACK_ENABLED=false)");
    return { stop: () => {}, triggerNow: async () => {} };
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const webhookTimeout = new Date(now.getTime() - env.PAYSTACK_TRANSFER_WEBHOOK_TIMEOUT_MS);
      const alertThreshold = new Date(now.getTime() - ALERT_THRESHOLD_MS);

      // Find pending transfers that have exceeded the webhook timeout
      const staleTransfers = await OutboundTransferModel.find({
        status: "pending",
        createdAt: { $lt: webhookTimeout },
      }).limit(50);

      let settledCount = 0;
      let failedCount = 0;
      let alertedCount = 0;

      for (const transfer of staleTransfers) {
        try {
          const paystackTransfer = await fetchPaystackTransfer(transfer.transferCode);

          if (paystackTransfer.status === "success") {
            log.warn(
              { transferCode: transfer.transferCode },
              "Transfer settlement sweep: caught missed transfer.success webhook",
            );

            await runInTransaction(async (session) => {
              const fresh = await OutboundTransferModel.findById(transfer._id).session(session);
              if (!fresh || fresh.status !== "pending") return;

              fresh.status = "success";
              fresh.paystackStatus = "success";
              fresh.settledAt = new Date();
              fresh.webhookReceivedAt = new Date();
              await fresh.save({ session });

              if (fresh.entityType === "distribution_line") {
                await DistributionLineModel.updateOne(
                  { _id: fresh.entityId },
                  { status: "paid", paymentRef: fresh.transferCode, paidAt: new Date() },
                ).session(session);

                // Check distribution completion
                const line = await DistributionLineModel.findById(fresh.entityId).session(session).lean();
                if (line) {
                  const lines = await DistributionLineModel.find({ distributionId: line.distributionId }).session(session).lean();
                  const allTerminal = lines.every((l: any) => ["paid", "failed", "skipped", "reversed"].includes(l.status));
                  if (allTerminal) {
                    const allPaid = lines.every((l: any) => ["paid", "skipped"].includes(l.status));
                    const dist = await DistributionModel.findById(line.distributionId).session(session);
                    if (dist && ["scheduled", "paying"].includes(dist.status)) {
                      dist.status = allPaid ? "paid" : "failed";
                      if (allPaid) dist.paidAt = new Date();
                      await dist.save({ session });
                    }
                  }
                }
              } else if (fresh.entityType === "refund") {
                const subscription = await SubscriptionModel.findById(fresh.entityId).session(session);
                if (subscription && subscription.status === "refund_pending") {
                  subscription.status = "refunded";
                  await subscription.save({ session });

                  await LedgerEntryModel.create(
                    [
                      {
                        ledgerType: "escrow",
                        accountRef: escrowAccountRef(subscription.offeringId),
                        direction: "debit",
                        amount: toDecimal(fresh.amountKobo / 100),
                        currency: fresh.currency,
                        entityType: "subscription",
                        entityId: String(subscription._id),
                        externalRef: fresh.transferCode,
                        idempotencyKey: `paystack:refund:sweep:${fresh.reference}`,
                        postedAt: new Date(),
                        metadata: { source: "settlement_sweep" },
                      },
                    ],
                    { session },
                  );
                }
              } else if (fresh.entityType === "tranche_release") {
                const tranche = await TrancheModel.findById(fresh.entityId).session(session);
                if (tranche && ["eligible", "processing"].includes(tranche.status)) {
                  tranche.status = "released";
                  tranche.releasedAt = new Date();
                  tranche.payoutReceiptRefs = [fresh.reference] as any;
                  await tranche.save({ session });

                  const offering = await OfferingModel.findById(tranche.offeringId).session(session).lean();
                  const businessId = offering?.businessId ? String(offering.businessId) : "unknown";

                  await LedgerEntryModel.create(
                    [
                      {
                        ledgerType: "tranche",
                        accountRef: escrowAccountRef(tranche.offeringId),
                        direction: "debit",
                        amount: toDecimal(fresh.amountKobo / 100),
                        currency: fresh.currency,
                        entityType: "tranche",
                        entityId: String(tranche._id),
                        externalRef: fresh.transferCode,
                        idempotencyKey: `paystack:tranche:sweep:${fresh.reference}:debit`,
                        postedAt: new Date(),
                        metadata: { source: "settlement_sweep", transferCode: fresh.transferCode },
                      },
                      {
                        ledgerType: "tranche",
                        accountRef: `issuer:business:${businessId}`,
                        direction: "credit",
                        amount: toDecimal(fresh.amountKobo / 100),
                        currency: fresh.currency,
                        entityType: "tranche",
                        entityId: String(tranche._id),
                        externalRef: fresh.transferCode,
                        idempotencyKey: `paystack:tranche:sweep:${fresh.reference}:credit`,
                        postedAt: new Date(),
                        metadata: { source: "settlement_sweep", transferCode: fresh.transferCode, disbursementType: "tranche_payout" },
                      },
                    ],
                    { session },
                  );
                }
              } else if (fresh.entityType === "fund_release") {
                const offering = await OfferingModel.findById(fresh.entityId).session(session);
                if (offering) {
                  const businessId = String(offering.businessId);
                  await LedgerEntryModel.create(
                    [
                      {
                        ledgerType: "tranche",
                        accountRef: escrowAccountRef(offering._id),
                        direction: "debit",
                        amount: toDecimal(fresh.amountKobo / 100),
                        currency: fresh.currency,
                        entityType: "offering",
                        entityId: String(offering._id),
                        externalRef: fresh.transferCode,
                        idempotencyKey: `paystack:fund-release:sweep:${fresh.reference}:debit`,
                        postedAt: new Date(),
                        metadata: { source: "settlement_sweep", transferCode: fresh.transferCode, disbursementType: "issuer_payout" },
                      },
                      {
                        ledgerType: "tranche",
                        accountRef: `issuer:business:${businessId}`,
                        direction: "credit",
                        amount: toDecimal(fresh.amountKobo / 100),
                        currency: fresh.currency,
                        entityType: "offering",
                        entityId: String(offering._id),
                        externalRef: fresh.transferCode,
                        idempotencyKey: `paystack:fund-release:sweep:${fresh.reference}:credit`,
                        postedAt: new Date(),
                        metadata: { source: "settlement_sweep", transferCode: fresh.transferCode, disbursementType: "issuer_payout" },
                      },
                    ],
                    { session },
                  );
                }
              }

              await appendEvent(
                SYSTEM_ACTOR as any,
                {
                  entityType: "outbound_transfer",
                  entityId: String(fresh._id),
                  action: "TransferSettledBySweep",
                  notes: `transferCode:${fresh.transferCode}`,
                },
                session,
              );
            });

            settledCount++;
          } else if (["failed", "reversed"].includes(paystackTransfer.status)) {
            await runInTransaction(async (session) => {
              const fresh = await OutboundTransferModel.findById(transfer._id).session(session);
              if (!fresh || fresh.status !== "pending") return;

              fresh.status = paystackTransfer.status as "failed" | "reversed";
              fresh.paystackStatus = paystackTransfer.status;
              fresh.failureReason = String(paystackTransfer.failures ?? "Detected by sweep");
              fresh.webhookReceivedAt = new Date();
              await fresh.save({ session });

              if (fresh.entityType === "distribution_line") {
                await DistributionLineModel.updateOne(
                  { _id: fresh.entityId },
                  { status: "failed", failureReason: fresh.failureReason },
                ).session(session);
              } else if (fresh.entityType === "refund") {
                const subscription = await SubscriptionModel.findById(fresh.entityId).session(session);
                if (subscription && subscription.status === "refund_pending") {
                  subscription.status = "paid";
                  await subscription.save({ session });
                }
              } else if (fresh.entityType === "tranche_release") {
                const tranche = await TrancheModel.findById(fresh.entityId).session(session);
                if (tranche && ["eligible", "processing"].includes(tranche.status)) {
                  tranche.status = "failed";
                  tranche.failedAt = new Date();
                  await tranche.save({ session });
                }
              }
            });

            failedCount++;
          } else if (new Date(transfer.createdAt as any) < alertThreshold) {
            // Transfer still pending after 48h — create alert
            await ReconciliationIssueModel.create([
              {
                issueType: "stale_transfer",
                externalRef: transfer.transferCode,
                entityType: transfer.entityType,
                entityId: transfer.entityId,
                actualAmount: toDecimal(transfer.amountKobo / 100),
                message: `Outbound transfer pending for > 48h. Paystack status: ${paystackTransfer.status}. Manual investigation required.`,
              },
            ]);
            alertedCount++;
          }
        } catch (err: any) {
          log.warn(
            { err: err.message, transferCode: transfer.transferCode },
            "Transfer settlement sweep: Paystack API error",
          );
        }
      }

      if (settledCount > 0 || failedCount > 0 || alertedCount > 0) {
        log.info(
          { settled: settledCount, failed: failedCount, alerted: alertedCount },
          "Transfer settlement sweep completed",
        );
      }
    } catch (err: any) {
      log.error({ err: err.message }, "Transfer settlement sweep error");
    } finally {
      running = false;
    }
  }

  timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  log.info(`Transfer settlement worker started (interval=${POLL_INTERVAL_MS}ms)`);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    triggerNow: tick,
  };
}
