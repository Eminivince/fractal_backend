import { beforeEach, describe, expect, it, vi } from "vitest";
const find = vi.hoisted(() => vi.fn()); const findById = vi.hoisted(() => vi.fn()); const updateMany = vi.hoisted(() => vi.fn()); const subscriptionFindById = vi.hoisted(() => vi.fn()); const receiptUpsert = vi.hoisted(() => vi.fn()); const ledgerCreate = vi.hoisted(() => vi.fn()); const verify = vi.hoisted(() => vi.fn()); const runTransaction = vi.hoisted(() => vi.fn()); const appendEvent = vi.hoisted(() => vi.fn()); const workerEnv = vi.hoisted(() => ({ PAYSTACK_ENABLED: false }));
vi.mock("../../config/env.js", () => ({ env: workerEnv }));
vi.mock("../../db/models.js", () => ({ PaymentIntentModel: { find, findById, updateMany }, SubscriptionModel: { findById: subscriptionFindById }, EscrowReceiptModel: { findOneAndUpdate: receiptUpsert }, LedgerEntryModel: { create: ledgerCreate } }));
vi.mock("../../services/paystack.js", () => ({ verifyPaystackTransaction: verify }));
vi.mock("../../utils/tx.js", () => ({ runInTransaction: runTransaction }));
vi.mock("../../utils/audit.js", () => ({ appendEvent }));
vi.mock("../../services/ledger.js", () => ({ escrowAccountRef: vi.fn((offeringId) => `escrow:${offeringId}`) }));
import { startPaymentVerificationWorker } from "../payment-verification.worker.js";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
const sessionResult = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
beforeEach(() => { vi.clearAllMocks(); runTransaction.mockImplementation(async (work: (session: unknown) => Promise<unknown>) => work({})); workerEnv.PAYSTACK_ENABLED = false; });
describe("payment verification worker", () => {
  it("stays inert when Paystack is disabled", async () => { const h = startPaymentVerificationWorker(log); await h.triggerNow(); h.stop(); expect(log.info).toHaveBeenCalledWith(expect.stringContaining("disabled")); });
  it("starts an enabled sweep, skips missing references, and reports expiry updates", async () => { workerEnv.PAYSTACK_ENABLED = true; find.mockReturnValue({ limit: vi.fn().mockResolvedValue([{ _id: "no-reference" }]) }); updateMany.mockResolvedValue({ modifiedCount: 1 }); const h = startPaymentVerificationWorker(log); await h.triggerNow(); h.stop(); expect(log.info).toHaveBeenCalledWith({ verified: 0, expired: 1 }, "Payment verification sweep completed"); });

  it("recovers a missed successful webhook in one transaction", async () => {
    workerEnv.PAYSTACK_ENABLED = true;
    const staleIntent = { _id: "intent-1", paystackReference: "reference-1", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) };
    const freshIntent: any = { ...staleIntent, status: "pending", subscriptionId: "subscription-1", save: vi.fn().mockResolvedValue(undefined) };
    const subscription: any = { _id: "subscription-1", status: "payment_pending", investorUserId: "investor-1", offeringId: "offering-1", save: vi.fn().mockResolvedValue(undefined) };
    find.mockReturnValue({ limit: vi.fn().mockResolvedValue([staleIntent]) });
    findById.mockReturnValue(sessionResult(freshIntent));
    subscriptionFindById.mockReturnValue(sessionResult(subscription));
    receiptUpsert.mockResolvedValue({ createdAt: new Date(1), updatedAt: new Date(1) });
    ledgerCreate.mockResolvedValue(undefined);
    verify.mockResolvedValue({ status: "success", amount: 12500, currency: "NGN", paid_at: "2026-07-01T00:00:00.000Z" });
    updateMany.mockResolvedValue({ modifiedCount: 0 });

    const h = startPaymentVerificationWorker(log);
    await h.triggerNow();
    h.stop();

    expect(freshIntent).toMatchObject({ status: "amount_matched", receivedAmountKobo: 12500 });
    expect(subscription).toMatchObject({ status: "paid", externalReceiptRef: "reference-1" });
    expect(ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ accountRef: "escrow:offering-1", externalRef: "reference-1" })]), expect.any(Object));
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "system" }), expect.objectContaining({ action: "SubscriptionPaid" }), expect.anything());
    expect(log.info).toHaveBeenCalledWith({ verified: 1, expired: 0 }, "Payment verification sweep completed");
  });

  it("expires abandoned intents and records provider errors without stopping the sweep", async () => {
    workerEnv.PAYSTACK_ENABLED = true;
    const abandoned: any = { _id: "intent-1", paystackReference: "abandoned", createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000), save: vi.fn().mockResolvedValue(undefined) };
    const rejected = { _id: "intent-2", paystackReference: "error", createdAt: new Date(Date.now() - 3 * 60 * 60 * 1000) };
    find.mockReturnValue({ limit: vi.fn().mockResolvedValue([abandoned, rejected]) });
    verify.mockResolvedValueOnce({ status: "abandoned" }).mockRejectedValueOnce(new Error("Provider unavailable"));
    updateMany.mockResolvedValue({ modifiedCount: 0 });
    const h = startPaymentVerificationWorker(log);
    await h.triggerNow();
    h.stop();
    expect(abandoned.status).toBe("expired");
    expect(abandoned.save).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ reference: "error" }), expect.stringContaining("API error"));
    expect(log.info).toHaveBeenCalledWith({ verified: 0, expired: 1 }, "Payment verification sweep completed");
  });

  it("records an outer sweep failure and resets its running state", async () => {
    workerEnv.PAYSTACK_ENABLED = true;
    find.mockReturnValue({ limit: vi.fn().mockRejectedValue(new Error("Database unavailable")) });
    const h = startPaymentVerificationWorker(log);
    await h.triggerNow();
    await h.triggerNow();
    h.stop();
    expect(log.error).toHaveBeenCalledWith({ err: "Database unavailable" }, "Payment verification sweep error");
    expect(find).toHaveBeenCalledTimes(2);
  });
});
