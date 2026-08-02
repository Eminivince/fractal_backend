import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  audit: vi.fn(),
  decimal: vi.fn((value: number) => value),
  distributionOutcome: vi.fn(),
  distributionFind: vi.fn(),
  distributionLineFind: vi.fn(),
  distributionLineFindById: vi.fn(),
  distributionLineUpdate: vi.fn(),
  escrowReceipt: vi.fn(),
  escrowRef: vi.fn((offeringId: string) => `escrow:${offeringId}`),
  ledgerCreate: vi.fn(),
  hash: vi.fn(),
  inbox: vi.fn(),
  notification: vi.fn(),
  offeringFindById: vi.fn(),
  outboundFind: vi.fn(),
  paymentReceipt: vi.fn(),
  paymentIntentFindById: vi.fn(),
  paymentIntentFindOne: vi.fn(),
  professionalOutcome: vi.fn(),
  reconciliationCreate: vi.fn(),
  runTransaction: vi.fn(),
  signature: vi.fn(),
  subscriptionFindById: vi.fn(),
  trancheFindById: vi.fn(),
  verifyTransaction: vi.fn(),
  env: { NODE_ENV: "development", PAYSTACK_ENABLED: true, PAYSTACK_INBOX_ENABLED: false },
}));
const InboxPayloadConflictError = vi.hoisted(() => class InboxPayloadConflictError extends Error {});
const PaymentIntentNotFoundError = vi.hoisted(() => class PaymentIntentNotFoundError extends Error {});

vi.mock("../../../../db/models.js", () => ({
  BusinessModel: {},
  DedicatedVirtualAccountModel: { findOneAndUpdate: vi.fn() },
  DistributionLineModel: { find: mocks.distributionLineFind, findById: mocks.distributionLineFindById, updateOne: mocks.distributionLineUpdate },
  DistributionModel: { findById: mocks.distributionFind },
  EscrowReceiptModel: { findOneAndUpdate: mocks.escrowReceipt },
  LedgerEntryModel: { create: mocks.ledgerCreate },
  OfferingModel: { findById: mocks.offeringFindById },
  OutboundTransferModel: { findOne: mocks.outboundFind },
  PaymentIntentModel: { findById: mocks.paymentIntentFindById, findOne: mocks.paymentIntentFindOne },
  ReconciliationIssueModel: { create: mocks.reconciliationCreate },
  SubscriptionModel: { findById: mocks.subscriptionFindById },
  TrancheModel: { findById: mocks.trancheFindById },
}));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/paystack.js", () => ({ verifyPaystackWebhookSignature: mocks.signature, verifyPaystackTransaction: mocks.verifyTransaction }));
vi.mock("../../../../platform/postgres-inbox.js", () => ({ InboxPayloadConflictError, receiveInboxEvent: mocks.inbox }));
vi.mock("../../../../utils/idempotency.js", () => ({ hashPayload: mocks.hash }));
vi.mock("../../../../platform/postgres-payments.js", () => ({ PaymentIntentNotFoundError, recordProviderPaymentReceipt: mocks.paymentReceipt }));
vi.mock("../../../../platform/postgres-professional-invoices.js", () => ({ recordProfessionalPayoutProviderOutcome: mocks.professionalOutcome }));
vi.mock("../../../../platform/postgres-distribution-payouts.js", () => ({ recordDistributionPayoutProviderOutcome: mocks.distributionOutcome }));
vi.mock("../../../../services/ledger.js", () => ({ escrowAccountRef: mocks.escrowRef, postLedger: vi.fn() }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.audit }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.runTransaction }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notification }));

import { PaystackInboxPayloadError, handleChargeSuccess, handleTransferFailed, handleTransferSuccess, processPaystackInboxEvent, paystackWebhookRoutes } from "../paystack-webhook.routes.js";

let app: ReturnType<typeof Fastify>;

function sessionValue<T>(value: T) {
  return { session: vi.fn().mockResolvedValue(value) };
}

function sessionLeanValue<T>(value: T) {
  return { session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

function updateSessionValue() {
  return { session: vi.fn().mockResolvedValue(undefined) };
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.env.NODE_ENV = "development";
  mocks.env.PAYSTACK_ENABLED = true;
  mocks.env.PAYSTACK_INBOX_ENABLED = false;
  mocks.signature.mockReturnValue(true);
  mocks.hash.mockReturnValue("body-hash");
  mocks.decimal.mockImplementation((value: number) => value);
  mocks.escrowRef.mockImplementation((offeringId: string) => `escrow:${offeringId}`);
  mocks.paymentReceipt.mockResolvedValue({ paymentIntentId: "intent-1", receiptId: "receipt-1", status: "matched" });
  mocks.distributionOutcome.mockResolvedValue({ handled: false });
  mocks.professionalOutcome.mockResolvedValue({ handled: false });
  mocks.runTransaction.mockImplementation(async (fn: (session: object) => Promise<unknown>) => fn({}));
  mocks.verifyTransaction.mockResolvedValue({ status: "success" });
  mocks.subscriptionFindById.mockReturnValue(sessionValue(null));
  mocks.paymentIntentFindOne.mockReturnValue(sessionValue(null));
  mocks.paymentIntentFindById.mockReturnValue(sessionValue(null));
  mocks.outboundFind.mockReturnValue(sessionValue(null));
  mocks.distributionLineFindById.mockReturnValue(sessionLeanValue(null));
  mocks.distributionLineFind.mockReturnValue(sessionLeanValue([]));
  mocks.distributionFind.mockReturnValue(sessionValue(null));
  mocks.offeringFindById.mockReturnValue(sessionLeanValue(null));
  mocks.trancheFindById.mockReturnValue(sessionValue(null));
  mocks.escrowReceipt.mockResolvedValue({ createdAt: new Date(1), updatedAt: new Date(1) });
  mocks.ledgerCreate.mockResolvedValue(undefined);
  mocks.reconciliationCreate.mockResolvedValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  mocks.notification.mockResolvedValue(undefined);
  app = Fastify();
  await app.register(paystackWebhookRoutes);
});

afterEach(async () => { await app.close(); });

describe("Paystack webhook intake", () => {
  it("queues a signed charge event with a stable external event id", async () => {
    mocks.env.PAYSTACK_INBOX_ENABLED = true;
    mocks.inbox.mockResolvedValue({ duplicate: false });
    const payload = { event: "charge.success", data: { reference: "payment-1", amount: 50_000, currency: "NGN" } };

    const response = await app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": "signed" }, payload: JSON.stringify(payload) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, queued: true, deduplicated: false });
    expect(mocks.inbox).toHaveBeenCalledWith(expect.objectContaining({ provider: "paystack", externalEventId: "charge.success:payment-1" }));
  });

  it("handles disabled, unsigned, invalid, and unavailable intake states", async () => {
    const payload = JSON.stringify({ event: "unknown", data: {} });
    mocks.env.PAYSTACK_ENABLED = false;
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json" }, payload })).resolves.toMatchObject({ statusCode: 200 });
    mocks.env.PAYSTACK_ENABLED = true;
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json" }, payload })).resolves.toMatchObject({ statusCode: 400 });
    mocks.signature.mockReturnValueOnce(false);
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": "bad" }, payload })).resolves.toMatchObject({ statusCode: 401 });
    mocks.env.NODE_ENV = "production";
    mocks.env.PAYSTACK_INBOX_ENABLED = false;
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": "signed" }, payload })).resolves.toMatchObject({ statusCode: 503 });
  });

  it("returns conflict and retryable errors from durable intake", async () => {
    mocks.env.PAYSTACK_INBOX_ENABLED = true;
    mocks.inbox.mockRejectedValueOnce(new InboxPayloadConflictError("conflict"));
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": "signed" }, payload: JSON.stringify({ event: "unknown", data: {} }) })).resolves.toMatchObject({ statusCode: 409 });
    mocks.inbox.mockRejectedValueOnce(new Error("unavailable"));
    await expect(app.inject({ method: "POST", url: "/v1/webhooks/paystack", headers: { "content-type": "application/json", "x-paystack-signature": "signed" }, payload: JSON.stringify({ event: "unknown", data: {} }) })).resolves.toMatchObject({ statusCode: 503 });
  });
});

describe("Paystack inbox processing", () => {
  it("records a valid provider payment receipt before legacy handling", async () => {
    await processPaystackInboxEvent(app, "charge.success", { reference: "payment-1", amount: 50_000, currency: "NGN", metadata: {} }, "provider-event-1", new Date("2026-01-01"));
    expect(mocks.paymentReceipt).toHaveBeenCalledWith(expect.objectContaining({ providerReference: "payment-1", providerEventId: "provider-event-1", amountMinor: 50_000 }));
  });

  it("records handled distribution and professional payout outcomes before legacy handling", async () => {
    mocks.distributionOutcome.mockResolvedValueOnce({ handled: true, payoutInstructionId: "distribution-payout-1", status: "paid" });
    await processPaystackInboxEvent(app, "transfer.success", { reference: "transfer-1", transfer_code: "code-1", amount: 50_000, currency: "NGN" });
    expect(mocks.distributionOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "success", reference: "transfer-1" }));

    mocks.distributionOutcome.mockResolvedValueOnce({ handled: false });
    mocks.professionalOutcome.mockResolvedValueOnce({ handled: true, payoutInstructionId: "professional-payout-1", status: "failed" });
    await processPaystackInboxEvent(app, "transfer.failed", { reference: "transfer-2", transfer_code: "code-2", amount: 50_000, currency: "NGN", reason: "Bank rejected" });
    expect(mocks.professionalOutcome).toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed", reason: "Bank rejected" }));
  });

  it("rejects malformed known events and ignores unknown events", async () => {
    await expect(processPaystackInboxEvent(app, "charge.success", { reference: "payment-1" })).rejects.toBeInstanceOf(PaystackInboxPayloadError);
    await expect(processPaystackInboxEvent(app, "unrecognised.event", {})).resolves.toBeUndefined();
  });
});

describe("Paystack legacy financial handlers", () => {
  it("leaves a charge unchanged when its subscription no longer exists", async () => {
    await handleChargeSuccess(app, { reference: "charge-missing-subscription", amount: 50_000, metadata: { subscriptionId: "subscription-1" } });
    expect(mocks.verifyTransaction).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("holds a mismatched charge for reconciliation instead of crediting escrow", async () => {
    const subscription = { _id: "subscription-1", status: "payment_pending", investorUserId: "investor-1", offeringId: "offering-1", externalReceiptRef: undefined as string | undefined, save: vi.fn() };
    const intent = { expectedAmountKobo: 50_000, status: "pending", save: vi.fn() };
    mocks.subscriptionFindById.mockReturnValue(sessionValue(subscription));
    mocks.paymentIntentFindOne.mockReturnValue(sessionValue(intent));

    await handleChargeSuccess(app, { reference: "charge-mismatch", amount: 49_000, currency: "NGN", metadata: { subscriptionId: "subscription-1" } });

    expect(intent.status).toBe("amount_mismatch");
    expect(mocks.reconciliationCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ issueType: "amount_mismatch", externalRef: "charge-mismatch" })]), expect.anything());
    expect(subscription.save).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).not.toHaveBeenCalled();
  });

  it("credits a verified matching charge exactly once", async () => {
    const subscription = { _id: "subscription-1", status: "payment_pending", investorUserId: "investor-1", offeringId: "offering-1", externalReceiptRef: undefined as string | undefined, save: vi.fn() };
    const intent = { expectedAmountKobo: 50_000, status: "pending", save: vi.fn() };
    mocks.subscriptionFindById.mockReturnValue(sessionValue(subscription));
    mocks.paymentIntentFindOne.mockReturnValue(sessionValue(intent));

    await handleChargeSuccess(app, { reference: "charge-paid", amount: 50_000, currency: "NGN", metadata: { subscriptionId: "subscription-1" } });

    expect(mocks.verifyTransaction).toHaveBeenCalledWith("charge-paid");
    expect(subscription.status).toBe("paid");
    expect(subscription.externalReceiptRef).toBe("charge-paid");
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ direction: "credit", externalRef: "charge-paid", idempotencyKey: "paystack:charge:charge-paid" })]), expect.anything());
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "SubscriptionPaid" }), expect.anything());
  });

  it("credits a matched dedicated-account charge through its payment intent", async () => {
    const intent = { _id: "intent-1", status: "pending", expectedAmountKobo: 50_000, subscriptionId: "subscription-1", save: vi.fn() };
    const subscription = { _id: "subscription-1", status: "payment_pending", investorUserId: "investor-1", offeringId: "offering-1", save: vi.fn() };
    mocks.paymentIntentFindOne.mockResolvedValue({ _id: "intent-1" });
    mocks.paymentIntentFindById.mockReturnValue(sessionValue(intent));
    mocks.subscriptionFindById.mockReturnValue(sessionValue(subscription));

    await processPaystackInboxEvent(app, "charge.success", { reference: "dva-charge", amount: 50_000, currency: "NGN", metadata: {} });

    expect(intent.status).toBe("amount_matched");
    expect(subscription.status).toBe("paid");
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ idempotencyKey: "paystack:charge:dva-charge", metadata: expect.objectContaining({ via: "dva" }) })]), expect.anything());
  });

  it("settles a refund transfer and writes its escrow debit", async () => {
    const transfer = { _id: "transfer-1", status: "pending", entityType: "refund", entityId: "subscription-1", amountKobo: 50_000, currency: "NGN", save: vi.fn() };
    const subscription = { _id: "subscription-1", status: "refund_pending", investorUserId: "investor-1", offeringId: "offering-1", save: vi.fn() };
    mocks.outboundFind.mockReturnValue(sessionValue(transfer));
    mocks.subscriptionFindById.mockReturnValue(sessionValue(subscription));

    await handleTransferSuccess(app, { transfer_code: "transfer-success", reference: "refund-reference", status: "success" });

    expect(transfer.status).toBe("success");
    expect(subscription.status).toBe("refunded");
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ direction: "debit", idempotencyKey: "paystack:refund:refund-reference" })]), expect.anything());
    expect(mocks.notification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "SubscriptionRefunded" }), expect.anything());
  });

  it("returns a failed refund to paid and creates a reconciliation issue", async () => {
    const transfer = { _id: "transfer-2", status: "pending", entityType: "refund", entityId: "subscription-2", amountKobo: 50_000, currency: "NGN", save: vi.fn() };
    const subscription = { _id: "subscription-2", status: "refund_pending", offeringId: "offering-1", save: vi.fn() };
    mocks.outboundFind.mockReturnValue(sessionValue(transfer));
    mocks.subscriptionFindById.mockReturnValue(sessionValue(subscription));

    await handleTransferFailed(app, { transfer_code: "transfer-failed", reference: "refund-failed", reason: "Bank rejected the destination" });

    expect(transfer.status).toBe("failed");
    expect(subscription.status).toBe("paid");
    expect(mocks.reconciliationCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ issueType: "transfer_failed", externalRef: "transfer-failed" })]), expect.anything());
  });

  it("settles a tranche release with matching escrow debit and issuer credit", async () => {
    const transfer = { _id: "transfer-4", status: "processing", entityType: "tranche_release", entityId: "tranche-1", amountKobo: 125_000, currency: "NGN", save: vi.fn() };
    const tranche = { _id: "tranche-1", status: "eligible", offeringId: "offering-1", save: vi.fn() };
    mocks.outboundFind.mockReturnValue(sessionValue(transfer));
    mocks.trancheFindById.mockReturnValue(sessionValue(tranche));
    mocks.offeringFindById.mockReturnValue(sessionLeanValue({ businessId: "business-1" }));

    await handleTransferSuccess(app, { transfer_code: "tranche-transfer", reference: "tranche-reference" });

    expect(tranche.status).toBe("released");
    expect(mocks.ledgerCreate).toHaveBeenNthCalledWith(1, expect.arrayContaining([expect.objectContaining({ accountRef: "escrow:offering-1", direction: "debit" })]), expect.anything());
    expect(mocks.ledgerCreate).toHaveBeenNthCalledWith(2, expect.arrayContaining([expect.objectContaining({ accountRef: "issuer:business:business-1", direction: "credit" })]), expect.anything());
  });

  it("marks a failed distribution payout and preserves an operator reconciliation record", async () => {
    const transfer = { _id: "transfer-5", status: "pending", entityType: "distribution_line", entityId: "line-2", amountKobo: 30_000, currency: "NGN", save: vi.fn() };
    mocks.outboundFind.mockReturnValue(sessionValue(transfer));
    mocks.distributionLineUpdate.mockReturnValue(updateSessionValue());
    mocks.distributionLineFindById.mockReturnValue(sessionLeanValue({ _id: "line-2", distributionId: "distribution-2", investorUserId: "investor-2" }));
    mocks.distributionLineFind.mockReturnValue(sessionLeanValue([]));

    await handleTransferFailed(app, { transfer_code: "distribution-failed", reference: "distribution-reference", reason: "Account closed" });

    expect(mocks.distributionLineUpdate).toHaveBeenCalledWith({ _id: "line-2" }, { status: "failed", failureReason: "Account closed" });
    expect(mocks.notification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DistributionLineFailed" }), expect.anything());
    expect(mocks.reconciliationCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ entityType: "distribution_line" })]), expect.anything());
  });

  it("credits escrow when a settled distribution transfer is reversed", async () => {
    const transfer = { _id: "transfer-3", status: "success", entityType: "distribution_line", entityId: "line-1", amountKobo: 50_000, currency: "NGN", save: vi.fn() };
    const line = { _id: "line-1", distributionId: "distribution-1", offeringId: "offering-1", status: "paid", save: vi.fn() };
    mocks.outboundFind.mockReturnValue(sessionValue(transfer));
    mocks.distributionLineFindById.mockReturnValue(sessionValue(line));
    mocks.distributionLineFind.mockReturnValue(sessionLeanValue([]));

    await processPaystackInboxEvent(app, "transfer.reversed", { transfer_code: "transfer-reversed", reference: "distribution-reference", amount: 50_000, currency: "NGN" });

    expect(transfer.status).toBe("reversed");
    expect(line.status).toBe("reversed");
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ direction: "credit", idempotencyKey: "paystack:reversal:transfer-reversed" })]), expect.anything());
    expect(mocks.reconciliationCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ issueType: "transfer_reversed" })]), expect.anything());
  });
});
