import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mocks, session, env } = vi.hoisted(() => {
  const mocks = {
    startSession: vi.fn(), runCreate: vi.fn(), runUpdate: vi.fn(), receiptFind: vi.fn(), ledgerFind: vi.fn(), transferFind: vi.fn(), lineFindById: vi.fn(), subscriptionFindById: vi.fn(), trancheFindById: vi.fn(), intentFind: vi.fn(), issueCreate: vi.fn(), decimal: vi.fn(),
  };
  const session = { withTransaction: vi.fn(), endSession: vi.fn() };
  const env = { RECONCILIATION_TOLERANCE: 0.01, RECONCILIATION_WORKER_ENABLED: false, RECONCILIATION_INTERVAL_MS: 60_000 };
  return { mocks, session, env };
});
vi.mock("mongoose", () => ({ default: { startSession: mocks.startSession } }));
vi.mock("../../db/models.js", () => ({
  ReconciliationRunModel: { create: mocks.runCreate, findByIdAndUpdate: mocks.runUpdate }, ReconciliationIssueModel: { create: mocks.issueCreate }, EscrowReceiptModel: { find: mocks.receiptFind }, LedgerEntryModel: { find: mocks.ledgerFind }, OutboundTransferModel: { find: mocks.transferFind }, DistributionLineModel: { findById: mocks.lineFindById }, SubscriptionModel: { findById: mocks.subscriptionFindById }, TrancheModel: { findById: mocks.trancheFindById }, PaymentIntentModel: { find: mocks.intentFind },
}));
vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
import { runReconciliation, startReconciliationWorker } from "../reconciliation.js";

function query(value: unknown) { return { session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) }; }
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  session.withTransaction.mockReset(); session.endSession.mockReset();
  session.withTransaction.mockImplementation(async (operation: () => Promise<void>) => operation()); session.endSession.mockResolvedValue(undefined); mocks.startSession.mockResolvedValue(session);
  Object.assign(env, { RECONCILIATION_TOLERANCE: 0.01, RECONCILIATION_WORKER_ENABLED: false, RECONCILIATION_INTERVAL_MS: 60_000 }); mocks.decimal.mockImplementation((value: number) => `decimal:${value}`);
  mocks.runCreate.mockResolvedValue([{ _id: "run-1" }]); mocks.runUpdate.mockResolvedValue(undefined); mocks.issueCreate.mockResolvedValue([]);
  mocks.receiptFind.mockReturnValue(query([])); mocks.ledgerFind.mockReturnValue(query([])); mocks.transferFind.mockReturnValue(query([])); mocks.intentFind.mockReturnValue(query([]));
  mocks.lineFindById.mockReturnValue(query(null)); mocks.subscriptionFindById.mockReturnValue(query(null)); mocks.trancheFindById.mockReturnValue(query(null));
  logger.info.mockReset(); logger.warn.mockReset(); logger.error.mockReset();
});
afterEach(() => { vi.useRealTimers(); });

describe("reconciliation service", () => {
  it("matches confirmed receipts with the net of their escrow ledger entries", async () => {
    mocks.receiptFind.mockReturnValue(query([{ externalRef: "receipt-1", amount: { toString: () => "100" } }]));
    mocks.ledgerFind.mockReturnValue(query([{ externalRef: "receipt-1", amount: "110", direction: "credit" }, { externalRef: "receipt-1", amount: 10, direction: "debit" }]));
    await expect(runReconciliation("bank")).resolves.toEqual({ runId: "run-1", status: "ok", matchedCount: 1, mismatchCount: 0 });
    expect(mocks.runUpdate).toHaveBeenCalledWith("run-1", expect.objectContaining({ status: "ok", matchedCount: 1, mismatchCount: 0 }), { session });
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("records receipt, transfer, and stale-payment mismatches with attributable evidence", async () => {
    mocks.receiptFind.mockReturnValue(query([{ externalRef: "missing-ledger", amount: 50 }, { externalRef: "wrong-amount", amount: 100 }]));
    mocks.ledgerFind.mockReturnValue(query([{ externalRef: "wrong-amount", amount: 90, direction: "credit", entityType: "subscription", entityId: "sub-1" }, { externalRef: "orphan", amount: 30, direction: "credit", entityType: "subscription", entityId: "sub-2" }]));
    mocks.transferFind.mockReturnValue(query([
      { entityType: "distribution_line", entityId: "line-1", transferCode: "transfer-line", amountKobo: 1000 },
      { entityType: "refund", entityId: "sub-1", transferCode: "transfer-refund", amountKobo: 2000 },
      { entityType: "tranche_release", entityId: "tranche-1", transferCode: "transfer-tranche", amountKobo: 3000 },
    ]));
    mocks.lineFindById.mockReturnValue(query({ status: "declared" })); mocks.subscriptionFindById.mockReturnValue(query({ status: "confirmed" })); mocks.trancheFindById.mockReturnValue(query({ status: "pending" }));
    mocks.intentFind.mockReturnValue(query([{ paystackReference: "pay-1", subscriptionId: "sub-1", expectedAmountKobo: 5000, receivedAmountKobo: 4000 }]));
    const result = await runReconciliation("provider");
    expect(result).toEqual({ runId: "run-1", status: "mismatch", matchedCount: 0, mismatchCount: 7 });
    expect(mocks.issueCreate).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ issueType: "missing_ledger", externalRef: "missing-ledger" }), expect.objectContaining({ issueType: "amount_mismatch", externalRef: "wrong-amount" }), expect.objectContaining({ issueType: "orphan_ledger", externalRef: "orphan" }), expect.objectContaining({ issueType: "transfer_entity_mismatch" }), expect.objectContaining({ issueType: "stale_amount_mismatch" }),
    ]), { session });
  });

  it("returns a durable failed run when a transactional reconciliation failure occurs", async () => {
    session.withTransaction.mockRejectedValueOnce(new Error("database unavailable"));
    mocks.runCreate.mockResolvedValueOnce([{ _id: "failed-run" }]);
    await expect(runReconciliation()).resolves.toEqual({ runId: "failed-run", status: "failed", matchedCount: 0, mismatchCount: 0 });
    expect(mocks.runCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ status: "failed", notes: "database unavailable" })]));
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  it("starts no timer when disabled and reports provider reconciliation results when enabled", async () => {
    const disabled = startReconciliationWorker(logger);
    await disabled.triggerNow(); expect(logger.info).toHaveBeenCalledWith("Reconciliation worker disabled (RECONCILIATION_WORKER_ENABLED=false)");
    env.RECONCILIATION_WORKER_ENABLED = true;
    const enabled = startReconciliationWorker(logger);
    await enabled.triggerNow(); expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Reconciliation ok: run=run-1"));
    mocks.receiptFind.mockReturnValue(query([{ externalRef: "missing-ledger", amount: 10 }]));
    await enabled.triggerNow(); expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Reconciliation mismatch: run=run-1 issues=1"));
    session.withTransaction.mockRejectedValueOnce(new Error("transaction failure"));
    await enabled.triggerNow(); expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("Reconciliation failed: run="));
    enabled.stop();
  });

  it("runs scheduled reconciliation ticks without overlapping the active worker", async () => {
    vi.useFakeTimers(); env.RECONCILIATION_WORKER_ENABLED = true; env.RECONCILIATION_INTERVAL_MS = 5;
    const handle = startReconciliationWorker(logger);
    await vi.advanceTimersByTimeAsync(5);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Reconciliation ok: run=run-1"));
    handle.stop();
  });
});
