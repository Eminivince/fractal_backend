import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(), decimal: vi.fn((value: number) => value), escrowRef: vi.fn((offeringId: string) => `escrow:${offeringId}`), fetchTransfer: vi.fn(),
  ledgerCreate: vi.fn(), offeringFindById: vi.fn(), outboundFind: vi.fn(), outboundFindById: vi.fn(), reconciliationCreate: vi.fn(), runTransaction: vi.fn(),
  subscriptionFindById: vi.fn(), trancheFindById: vi.fn(), distributionLineUpdate: vi.fn(), env: { PAYSTACK_ENABLED: true, PAYSTACK_TRANSFER_WEBHOOK_TIMEOUT_MS: 60_000 },
}));

vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../db/models.js", () => ({
  DistributionLineModel: { updateOne: mocks.distributionLineUpdate, findById: vi.fn(), find: vi.fn() }, DistributionModel: { findById: vi.fn() },
  LedgerEntryModel: { create: mocks.ledgerCreate }, OfferingModel: { findById: mocks.offeringFindById }, OutboundTransferModel: { find: mocks.outboundFind, findById: mocks.outboundFindById },
  ReconciliationIssueModel: { create: mocks.reconciliationCreate }, SubscriptionModel: { findById: mocks.subscriptionFindById }, TrancheModel: { findById: mocks.trancheFindById },
}));
vi.mock("../../services/paystack.js", () => ({ fetchPaystackTransfer: mocks.fetchTransfer }));
vi.mock("../../services/ledger.js", () => ({ escrowAccountRef: mocks.escrowRef }));
vi.mock("../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../utils/audit.js", () => ({ appendEvent: mocks.audit }));
vi.mock("../../utils/tx.js", () => ({ runInTransaction: mocks.runTransaction }));

import { startTransferSettlementWorker } from "../transfer-settlement.worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
function sessionValue<T>(value: T) { return { session: vi.fn().mockResolvedValue(value) }; }
function updateSessionValue() { return { session: vi.fn().mockResolvedValue(undefined) }; }

beforeEach(() => {
  for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  mocks.env.PAYSTACK_ENABLED = true; mocks.env.PAYSTACK_TRANSFER_WEBHOOK_TIMEOUT_MS = 60_000;
  mocks.decimal.mockImplementation((value: number) => value); mocks.escrowRef.mockImplementation((offeringId: string) => `escrow:${offeringId}`);
  mocks.outboundFind.mockReturnValue({ limit: vi.fn().mockResolvedValue([]) });
  mocks.outboundFindById.mockReturnValue(sessionValue(null)); mocks.subscriptionFindById.mockReturnValue(sessionValue(null)); mocks.trancheFindById.mockReturnValue(sessionValue(null)); mocks.offeringFindById.mockReturnValue(sessionValue(null));
  mocks.distributionLineUpdate.mockReturnValue(updateSessionValue()); mocks.fetchTransfer.mockResolvedValue({ status: "pending" });
  mocks.runTransaction.mockImplementation(async (callback: (session: object) => Promise<unknown>) => callback({}));
  mocks.ledgerCreate.mockResolvedValue(undefined); mocks.reconciliationCreate.mockResolvedValue(undefined); mocks.audit.mockResolvedValue(undefined);
  log.info.mockReset(); log.warn.mockReset(); log.error.mockReset();
});

describe("transfer settlement worker", () => {
  it("does not start a payment sweep when Paystack is disabled", async () => {
    mocks.env.PAYSTACK_ENABLED = false;
    const worker = startTransferSettlementWorker(log);

    await worker.triggerNow();

    expect(mocks.outboundFind).not.toHaveBeenCalled();
    expect(log.info).toHaveBeenCalledWith("Transfer settlement worker disabled (PAYSTACK_ENABLED=false)");
  });

  it("settles a missed refund success and writes an escrow debit", async () => {
    const transfer = { _id: "transfer-1", transferCode: "transfer-success", reference: "refund-reference", entityType: "refund", entityId: "subscription-1", amountKobo: 50_000, currency: "NGN", createdAt: new Date(0) };
    const fresh = { ...transfer, status: "pending", save: vi.fn() };
    const subscription = { _id: "subscription-1", status: "refund_pending", offeringId: "offering-1", save: vi.fn() };
    mocks.outboundFind.mockReturnValue({ limit: vi.fn().mockResolvedValue([transfer]) });
    mocks.fetchTransfer.mockResolvedValue({ status: "success" });
    mocks.outboundFindById.mockReturnValue(sessionValue(fresh));
    mocks.subscriptionFindById.mockReturnValue(sessionValue(subscription));

    const worker = startTransferSettlementWorker(log);
    await worker.triggerNow();
    worker.stop();

    expect(fresh.status).toBe("success");
    expect(subscription.status).toBe("refunded");
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ accountRef: "escrow:offering-1", direction: "debit", idempotencyKey: "paystack:refund:sweep:refund-reference" })]), expect.anything());
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "TransferSettledBySweep" }), expect.anything());
    expect(log.info).toHaveBeenCalledWith({ settled: 1, failed: 0, alerted: 0 }, "Transfer settlement sweep completed");
  });

  it("marks a missed distribution failure and preserves its reconciliation state", async () => {
    const transfer = { _id: "transfer-2", transferCode: "transfer-failed", reference: "distribution-reference", entityType: "distribution_line", entityId: "line-1", amountKobo: 25_000, currency: "NGN", createdAt: new Date(0) };
    const fresh = { ...transfer, status: "pending", save: vi.fn() };
    mocks.outboundFind.mockReturnValue({ limit: vi.fn().mockResolvedValue([transfer]) });
    mocks.fetchTransfer.mockResolvedValue({ status: "failed", failures: "Account closed" });
    mocks.outboundFindById.mockReturnValue(sessionValue(fresh));

    const worker = startTransferSettlementWorker(log);
    await worker.triggerNow();
    worker.stop();

    expect(fresh.status).toBe("failed");
    expect(mocks.distributionLineUpdate).toHaveBeenCalledWith({ _id: "line-1" }, { status: "failed", failureReason: "Account closed" });
    expect(log.info).toHaveBeenCalledWith({ settled: 0, failed: 1, alerted: 0 }, "Transfer settlement sweep completed");
  });

  it("raises a reconciliation issue for a transfer still pending after forty-eight hours", async () => {
    const transfer = { _id: "transfer-3", transferCode: "transfer-stale", reference: "stale-reference", entityType: "fund_release", entityId: "offering-1", amountKobo: 10_000, currency: "NGN", createdAt: new Date(0) };
    mocks.outboundFind.mockReturnValue({ limit: vi.fn().mockResolvedValue([transfer]) });
    mocks.fetchTransfer.mockResolvedValue({ status: "pending" });
    const clock = vi.spyOn(Date, "now").mockReturnValue(72 * 60 * 60 * 1000);
    try {
      const worker = startTransferSettlementWorker(log);
      await worker.triggerNow();
      worker.stop();
    } finally { clock.mockRestore(); }

    expect(mocks.reconciliationCreate).toHaveBeenCalledWith([expect.objectContaining({ issueType: "stale_transfer", externalRef: "transfer-stale" })]);
    expect(log.info).toHaveBeenCalledWith({ settled: 0, failed: 0, alerted: 1 }, "Transfer settlement sweep completed");
  });

  it("contains a provider lookup error and continues the worker loop", async () => {
    const transfer = { _id: "transfer-4", transferCode: "transfer-provider-error", reference: "reference", entityType: "refund", entityId: "subscription-1", amountKobo: 10_000, currency: "NGN", createdAt: new Date(0) };
    mocks.outboundFind.mockReturnValue({ limit: vi.fn().mockResolvedValue([transfer]) });
    mocks.fetchTransfer.mockRejectedValue(new Error("Paystack unavailable"));

    const worker = startTransferSettlementWorker(log);
    await worker.triggerNow();
    worker.stop();

    expect(log.warn).toHaveBeenCalledWith({ err: "Paystack unavailable", transferCode: "transfer-provider-error" }, "Transfer settlement sweep: Paystack API error");
    expect(log.error).not.toHaveBeenCalled();
  });
});
