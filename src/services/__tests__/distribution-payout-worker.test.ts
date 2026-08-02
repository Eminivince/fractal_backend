import { beforeEach, describe, expect, it, vi } from "vitest";

const requirePostgres = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());
const recordOutcome = vi.hoisted(() => vi.fn());
const initiateTransfer = vi.hoisted(() => vi.fn());
const verifyTransfer = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  DISTRIBUTION_PAYOUT_DISPATCH_LEASE_TIMEOUT_SECONDS: 300,
  DISTRIBUTION_PAYOUT_RECONCILIATION_BATCH_SIZE: 50,
  DISTRIBUTION_PAYOUT_DISPATCH_INTERVAL_MS: 1_000,
  DISTRIBUTION_PAYOUT_RECONCILIATION_INTERVAL_MS: 1_000,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres, withPostgresTransaction: withTransaction }));
vi.mock("../../platform/postgres-distribution-payouts.js", () => ({ recordDistributionPayoutProviderOutcome: recordOutcome }));
vi.mock("../paystack.js", () => ({ initiatePaystackTransfer: initiateTransfer, verifyPaystackTransfer: verifyTransfer }));

import { dispatchOneDistributionPayout, reconcileDistributionPayouts, recoverStaleDistributionPayoutDispatches, startDistributionPayoutWorkers } from "../distribution-payout-worker.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  withTransaction.mockImplementation(async (work: (client: any) => Promise<unknown>) => work({ query: vi.fn() }));
});

describe("distribution payout dispatch", () => {
  it("recovers expired dispatch leases", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 2 });
    requirePostgres.mockReturnValue({ query });
    await expect(recoverStaleDistributionPayoutDispatches(60)).resolves.toBe(2);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("Dispatch lease expired"), [60]);
  });

  it("returns false when there is no authorized payout instruction", async () => {
    withTransaction.mockResolvedValue(null);
    await expect(dispatchOneDistributionPayout("worker-1")).resolves.toBe(false);
  });

  it("submits a valid NGN payout and records its provider transfer code", async () => {
    const instruction = { id: "instruction-1", provider_recipient_reference: "recipient-1", amount_minor: "5000", reference: "payout-1", currency: "NGN" };
    withTransaction.mockResolvedValue(instruction);
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    requirePostgres.mockReturnValue({ query });
    const initiate = vi.fn().mockResolvedValue({ transfer_code: "transfer-1", status: "pending" });
    await expect(dispatchOneDistributionPayout("worker-1", initiate)).resolves.toBe(true);
    expect(initiate).toHaveBeenCalledWith({ recipientCode: "recipient-1", amountKobo: 5000, reference: "payout-1", reason: "Investor distribution payout-1" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status='submitted'"), ["instruction-1", "transfer-1"]);
  });

  it("uses the built-in claim, transfer, and verification adapters when callers do not supply them", async () => {
    const instruction = { id: "instruction-1", provider_recipient_reference: "recipient-1", amount_minor: "5000", reference: "payout-1", currency: "NGN" };
    const claimQuery = vi.fn().mockResolvedValue({ rows: [instruction] });
    withTransaction.mockImplementation(async (work: (client: any) => Promise<unknown>) => work({ query: claimQuery }));
    const query = vi.fn()
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ reference: "payout-1" }] });
    requirePostgres.mockReturnValue({ query });
    initiateTransfer.mockResolvedValue({ transfer_code: "transfer-1", status: "pending" });
    verifyTransfer.mockResolvedValue({ reference: "payout-1", status: "reversed", transfer_code: "transfer-1", amount: 5000, currency: "NGN", failures: null });
    recordOutcome.mockResolvedValue({ handled: true });
    await expect(dispatchOneDistributionPayout("worker-1")).resolves.toBe(true);
    await expect(reconcileDistributionPayouts({ logger })).resolves.toBe(1);
    expect(initiateTransfer).toHaveBeenCalledWith(expect.objectContaining({ reference: "payout-1" }));
    expect(verifyTransfer).toHaveBeenCalledWith("payout-1");
  });

  it("marks invalid or undurable dispatches uncertain and preserves the error", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    requirePostgres.mockReturnValue({ query });
    withTransaction.mockResolvedValue({ id: "instruction-1", provider_recipient_reference: "recipient-1", amount_minor: "5000", reference: "payout-1", currency: "USD" });
    await expect(dispatchOneDistributionPayout("worker-1")).rejects.toThrow("Unsupported distribution payout currency");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status='uncertain'"), ["instruction-1", "Unsupported distribution payout currency"]);

    withTransaction.mockResolvedValue({ id: "instruction-2", provider_recipient_reference: "recipient-1", amount_minor: "not-an-integer", reference: "payout-2", currency: "NGN" });
    await expect(dispatchOneDistributionPayout("worker-1")).rejects.toThrow("Invalid distribution payout amount");
  });
});

describe("distribution payout reconciliation", () => {
  it("records terminal provider outcomes and counts handled results", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reference: "paid" }, { reference: "pending" }, { reference: "failed" }] });
    requirePostgres.mockReturnValue({ query });
    const verify = vi.fn()
      .mockResolvedValueOnce({ reference: "paid", status: "success", transfer_code: "tr-1", amount: 5000, currency: "NGN", failures: null })
      .mockResolvedValueOnce({ reference: "pending", status: "pending", transfer_code: "tr-2", amount: 5000, currency: "NGN", failures: null })
      .mockResolvedValueOnce({ reference: "failed", status: "failed", transfer_code: "tr-3", amount: 5000, currency: "NGN", failures: "insufficient balance" });
    recordOutcome.mockResolvedValueOnce({ handled: true }).mockResolvedValueOnce({ handled: false });
    await expect(reconcileDistributionPayouts({ logger, limit: 3, verify })).resolves.toBe(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reference: "paid", outcome: "success", source: "verification" }));
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ reference: "failed", outcome: "failed", reason: "insufficient balance" }));
  });

  it("contains mismatched-reference and provider failures", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reference: "expected" }] });
    requirePostgres.mockReturnValue({ query });
    const verify = vi.fn().mockResolvedValue({ reference: "other", status: "success", transfer_code: "tr-1", amount: 5000, currency: "NGN", failures: null });
    await expect(reconcileDistributionPayouts({ logger, verify })).resolves.toBe(0);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ reference: "expected" }), expect.stringContaining("verification failed"));
  });
});

describe("distribution payout worker loop", () => {
  it("starts both loops and can stop safely", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [] });
      requirePostgres.mockReturnValue({ query });
      withTransaction.mockResolvedValue(null);
      const worker = startDistributionPayoutWorkers({ logger });
      await Promise.resolve();
      worker.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logger.error).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
