import { beforeEach, describe, expect, it, vi } from "vitest";

const requirePostgres = vi.hoisted(() => vi.fn());
const withTransaction = vi.hoisted(() => vi.fn());
const initiate = vi.hoisted(() => vi.fn());
const verify = vi.hoisted(() => vi.fn());
const recordOutcome = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  PROFESSIONAL_PAYOUT_DISPATCH_LEASE_TIMEOUT_SECONDS: 300,
  PROFESSIONAL_PAYOUT_DISPATCH_INTERVAL_MS: 1_000,
  PROFESSIONAL_PAYOUT_RECONCILIATION_BATCH_SIZE: 50,
  PROFESSIONAL_PAYOUT_RECONCILIATION_INTERVAL_MS: 1_000,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres, withPostgresTransaction: withTransaction }));
vi.mock("../paystack.js", () => ({ initiatePaystackTransfer: initiate, verifyPaystackTransfer: verify }));
vi.mock("../../platform/postgres-professional-invoices.js", () => ({ recordProfessionalPayoutProviderOutcome: recordOutcome }));

import { dispatchOneProfessionalPayout, recoverStaleProfessionalPayoutDispatches, startProfessionalPayoutDispatcher } from "../professional-payout-dispatcher.js";
import { reconcileProfessionalPayouts, startProfessionalPayoutReconciliationWorker } from "../professional-payout-reconciliation.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  withTransaction.mockImplementation(async (work: (client: any) => Promise<unknown>) => work({ query: vi.fn() }));
});

describe("professional payout dispatch", () => {
  it("recovers old dispatch leases and does nothing without an instruction", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 3 });
    requirePostgres.mockReturnValue({ query });
    await expect(recoverStaleProfessionalPayoutDispatches(60)).resolves.toBe(3);
    withTransaction.mockResolvedValue(null);
    await expect(dispatchOneProfessionalPayout("worker-1")).resolves.toBe(false);
  });

  it("claims, submits, and durably records a professional payout", async () => {
    const instruction = { id: "instruction-1", provider_recipient_reference: "recipient-1", amount_minor: "5000", reference: "payout-1", currency: "NGN" };
    withTransaction.mockImplementation(async (work: (client: any) => Promise<unknown>) => work({ query: vi.fn().mockResolvedValue({ rows: [instruction] }) }));
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    requirePostgres.mockReturnValue({ query });
    initiate.mockResolvedValue({ transfer_code: "transfer-1", status: "pending" });
    await expect(dispatchOneProfessionalPayout("worker-1")).resolves.toBe(true);
    expect(initiate).toHaveBeenCalledWith(expect.objectContaining({ reason: "Professional invoice payout payout-1", amountKobo: 5000 }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'submitted'"), ["instruction-1", "transfer-1"]);
  });

  it("marks invalid and undurable dispatches uncertain", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    requirePostgres.mockReturnValue({ query });
    withTransaction.mockResolvedValue({ id: "instruction-1", provider_recipient_reference: "recipient", amount_minor: "0", reference: "payout", currency: "NGN" });
    await expect(dispatchOneProfessionalPayout("worker-1")).rejects.toThrow("Invalid payout amount");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("status = 'uncertain'"), ["instruction-1", "Invalid payout amount"]);
    withTransaction.mockResolvedValue({ id: "instruction-2", provider_recipient_reference: "recipient", amount_minor: "5000", reference: "payout", currency: "USD" });
    await expect(dispatchOneProfessionalPayout("worker-1")).rejects.toThrow("Unsupported payout currency");
  });
});

describe("professional payout reconciliation", () => {
  it("records terminal outcomes and ignores non-terminal outcomes", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ reference: "paid" }, { reference: "waiting" }, { reference: "reversed" }] });
    requirePostgres.mockReturnValue({ query });
    const verifier = vi.fn()
      .mockResolvedValueOnce({ reference: "paid", status: "success", transfer_code: "tr-1", amount: 5000, currency: "NGN", failures: null })
      .mockResolvedValueOnce({ reference: "waiting", status: "pending", transfer_code: "tr-2", amount: 5000, currency: "NGN", failures: null })
      .mockResolvedValueOnce({ reference: "reversed", status: "reversed", transfer_code: "tr-3", amount: 5000, currency: "NGN", failures: "beneficiary rejected" });
    recordOutcome.mockResolvedValueOnce({ handled: true }).mockResolvedValueOnce({ handled: false });
    await expect(reconcileProfessionalPayouts({ logger, limit: 3, verify: verifier })).resolves.toBe(1);
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", reference: "paid" }));
    expect(recordOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "reversed", reason: "beneficiary rejected" }));
  });

  it("logs mismatched provider references and drives both worker loops", async () => {
    vi.useFakeTimers();
    try {
      const query = vi.fn().mockResolvedValue({ rowCount: 0, rows: [{ reference: "expected" }] });
      requirePostgres.mockReturnValue({ query });
      withTransaction.mockResolvedValue(null);
      verify.mockResolvedValue({ reference: "other", status: "success", transfer_code: "tr-1", amount: 1, currency: "NGN", failures: null });
      await expect(reconcileProfessionalPayouts({ logger })).resolves.toBe(0);
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ reference: "expected" }), expect.stringContaining("verification failed"));
      const dispatcher = startProfessionalPayoutDispatcher({ logger });
      const reconciler = startProfessionalPayoutReconciliationWorker({ logger });
      await Promise.resolve();
      dispatcher.stop();
      reconciler.stop();
    } finally { vi.useRealTimers(); }
  });

  it("contains dispatch and reconciliation loop failures", async () => {
    const query = vi.fn().mockRejectedValue(new Error("Database unavailable"));
    requirePostgres.mockReturnValue({ query });
    const dispatcher = startProfessionalPayoutDispatcher({ logger });
    const reconciler = startProfessionalPayoutReconciliationWorker({ logger });
    await Promise.resolve();
    await Promise.resolve();
    dispatcher.stop();
    reconciler.stop();
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "Professional payout requires reconciliation");
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "Professional payout reconciliation worker failed");
  });
});
