import mongoose from "mongoose";
import {
  DistributionLineModel,
  EscrowReceiptModel,
  LedgerEntryModel,
  OutboundTransferModel,
  PaymentIntentModel,
  ReconciliationIssueModel,
  ReconciliationRunModel,
  SubscriptionModel,
  TrancheModel,
} from "../db/models.js";
import { env } from "../config/env.js";
import { toDecimal } from "../utils/decimal.js";

interface LoggerLike {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface ReconciliationResult {
  runId: string;
  status: "ok" | "mismatch" | "failed";
  matchedCount: number;
  mismatchCount: number;
}

function decimalToNumber(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number(value);
  if (value && typeof value === "object" && "toString" in value) return Number(value.toString());
  return Number(value ?? 0);
}

function absDiff(a: number, b: number): number {
  return Math.abs(a - b);
}

function isMatch(expected: number, actual: number): boolean {
  return absDiff(expected, actual) <= env.RECONCILIATION_TOLERANCE;
}

export async function runReconciliation(source: "manual" | "bank" | "onchain" | "provider" = "manual"): Promise<ReconciliationResult> {
  const session = await mongoose.startSession();
  try {
    let result: ReconciliationResult = {
      runId: "",
      status: "failed",
      matchedCount: 0,
      mismatchCount: 0,
    };

    await session.withTransaction(async () => {
      const [run] = await ReconciliationRunModel.create(
        [
          {
            source,
            status: "ok",
            checkedAt: new Date(),
            matchedCount: 0,
            mismatchCount: 0,
          },
        ],
        { session },
      );

      const receipts = await EscrowReceiptModel.find({ status: "confirmed" }).session(session).lean();
      const ledgerRows = await LedgerEntryModel.find({
        ledgerType: "escrow",
        externalRef: { $ne: null },
      })
        .session(session)
        .lean();

      const receiptsByRef = new Map<string, any>();
      for (const receipt of receipts) {
        if (receipt.externalRef) receiptsByRef.set(String(receipt.externalRef), receipt);
      }

      const ledgerByRef = new Map<string, any[]>();
      for (const row of ledgerRows) {
        const ref = row.externalRef ? String(row.externalRef) : null;
        if (!ref) continue;
        const existing = ledgerByRef.get(ref) ?? [];
        existing.push(row);
        ledgerByRef.set(ref, existing);
      }

      const issueDocs: any[] = [];
      let matchedCount = 0;

      for (const [externalRef, receipt] of receiptsByRef.entries()) {
        const relatedLedger = ledgerByRef.get(externalRef) ?? [];
        if (relatedLedger.length === 0) {
          issueDocs.push({
            runId: run._id,
            issueType: "missing_ledger",
            externalRef,
            expectedAmount: receipt.amount,
            message: "Confirmed receipt has no matching escrow ledger entry",
          });
          continue;
        }

        const expected = decimalToNumber(receipt.amount);
        const actualNet = relatedLedger.reduce((sum, row) => {
          const amount = decimalToNumber(row.amount);
          return row.direction === "credit" ? sum + amount : sum - amount;
        }, 0);

        if (!isMatch(expected, actualNet)) {
          issueDocs.push({
            runId: run._id,
            issueType: "amount_mismatch",
            externalRef,
            entityType: relatedLedger[0]?.entityType,
            entityId: relatedLedger[0]?.entityId,
            expectedAmount: toDecimal(expected),
            actualAmount: toDecimal(actualNet),
            message: `Receipt amount (${expected}) and escrow ledger net (${actualNet}) differ beyond tolerance`,
          });
        } else {
          matchedCount += 1;
        }
      }

      for (const [externalRef, rows] of ledgerByRef.entries()) {
        if (receiptsByRef.has(externalRef)) continue;
        const first = rows[0];
        issueDocs.push({
          runId: run._id,
          issueType: "orphan_ledger",
          externalRef,
          entityType: first?.entityType,
          entityId: first?.entityId,
          actualAmount: first?.amount,
          message: "Escrow ledger entry references an external receipt that was not found",
        });
      }

      // --- Outbound transfer reconciliation ---
      // Check: every "success" OutboundTransfer should have a corresponding "paid" entity
      const successTransfers = await OutboundTransferModel.find({ status: "success" }).session(session).lean();
      for (const transfer of successTransfers) {
        if (transfer.entityType === "distribution_line") {
          const line = await DistributionLineModel.findById(transfer.entityId).session(session).lean();
          if (line && line.status !== "paid") {
            issueDocs.push({
              runId: run._id,
              issueType: "transfer_entity_mismatch",
              externalRef: transfer.transferCode,
              entityType: "distribution_line",
              entityId: transfer.entityId,
              actualAmount: toDecimal(transfer.amountKobo / 100),
              message: `OutboundTransfer is "success" but DistributionLine is "${line.status}"`,
            });
          }
        } else if (transfer.entityType === "refund") {
          const sub = await SubscriptionModel.findById(transfer.entityId).session(session).lean();
          if (sub && sub.status !== "refunded") {
            issueDocs.push({
              runId: run._id,
              issueType: "transfer_entity_mismatch",
              externalRef: transfer.transferCode,
              entityType: "subscription",
              entityId: transfer.entityId,
              actualAmount: toDecimal(transfer.amountKobo / 100),
              message: `Refund OutboundTransfer is "success" but Subscription is "${sub.status}"`,
            });
          }
        } else if (transfer.entityType === "tranche_release") {
          const tranche = await TrancheModel.findById(transfer.entityId).session(session).lean();
          if (tranche && tranche.status !== "released") {
            issueDocs.push({
              runId: run._id,
              issueType: "transfer_entity_mismatch",
              externalRef: transfer.transferCode,
              entityType: "tranche",
              entityId: transfer.entityId,
              actualAmount: toDecimal(transfer.amountKobo / 100),
              message: `Tranche OutboundTransfer is "success" but Tranche is "${tranche.status}"`,
            });
          }
        }
      }

      // Check: stale amount_mismatch PaymentIntents > 24h unresolved
      const staleMismatches = await PaymentIntentModel.find({
        status: "amount_mismatch",
        updatedAt: { $lt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      }).session(session).lean();
      for (const intent of staleMismatches) {
        issueDocs.push({
          runId: run._id,
          issueType: "stale_amount_mismatch",
          externalRef: intent.paystackReference,
          entityType: "subscription",
          entityId: String(intent.subscriptionId),
          expectedAmount: toDecimal(intent.expectedAmountKobo / 100),
          actualAmount: intent.receivedAmountKobo ? toDecimal(intent.receivedAmountKobo / 100) : undefined,
          message: `PaymentIntent amount_mismatch unresolved for > 24h. Expected: ${intent.expectedAmountKobo} kobo, Received: ${intent.receivedAmountKobo ?? "?"} kobo`,
        });
      }

      if (issueDocs.length > 0) {
        await ReconciliationIssueModel.create(issueDocs, { session });
      }

      const status = issueDocs.length > 0 ? "mismatch" : "ok";
      await ReconciliationRunModel.findByIdAndUpdate(
        run._id,
        {
          status,
          matchedCount,
          mismatchCount: issueDocs.length,
        },
        { session },
      );

      result = {
        runId: String(run._id),
        status,
        matchedCount,
        mismatchCount: issueDocs.length,
      };
    });

    return result;
  } catch (error) {
    const [failedRun] = await ReconciliationRunModel.create([
      {
        source,
        status: "failed",
        checkedAt: new Date(),
        matchedCount: 0,
        mismatchCount: 0,
        notes: error instanceof Error ? error.message.slice(0, 500) : "Unknown reconciliation error",
      },
    ]);

    return {
      runId: String(failedRun._id),
      status: "failed",
      matchedCount: 0,
      mismatchCount: 0,
    };
  } finally {
    await session.endSession();
  }
}

export interface ReconciliationWorkerHandle {
  stop: () => void;
  triggerNow: () => Promise<void>;
}

export function startReconciliationWorker(log: LoggerLike): ReconciliationWorkerHandle {
  if (!env.RECONCILIATION_WORKER_ENABLED) {
    log.info("Reconciliation worker disabled (RECONCILIATION_WORKER_ENABLED=false)");
    return {
      stop: () => undefined,
      triggerNow: async () => undefined,
    };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await runReconciliation("provider");
      if (result.status === "mismatch") {
        log.warn(`Reconciliation mismatch: run=${result.runId} issues=${result.mismatchCount}`);
      } else if (result.status === "failed") {
        log.error(`Reconciliation failed: run=${result.runId}`);
      } else {
        log.info(`Reconciliation ok: run=${result.runId} matched=${result.matchedCount}`);
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, env.RECONCILIATION_INTERVAL_MS);

  log.info(`Reconciliation worker started (interval=${env.RECONCILIATION_INTERVAL_MS}ms)`);

  return {
    stop: () => clearInterval(timer),
    triggerNow: tick,
  };
}
