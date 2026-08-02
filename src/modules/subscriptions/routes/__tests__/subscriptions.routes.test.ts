import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  corporateActionCreate: vi.fn(),
  corporateActionFind: vi.fn(),
  dedicatedAccountFind: vi.fn(),
  escrowReceiptFind: vi.fn(),
  escrowReceiptCreate: vi.fn(),
  investorProfileFind: vi.fn(),
  ledgerCreate: vi.fn(),
  ledgerFind: vi.fn(),
  offeringById: vi.fn(),
  offeringFind: vi.fn(),
  offeringUpdate: vi.fn(),
  outboundTransferCreate: vi.fn(),
  paymentIntentFind: vi.fn(),
  paymentIntentUpdate: vi.fn(),
  configFind: vi.fn(),
  suitabilityFind: vi.fn(),
  subscriptionAggregate: vi.fn(),
  subscriptionCreate: vi.fn(),
  subscriptionFind: vi.fn(),
  subscriptionCount: vi.fn(),
  subscriptionById: vi.fn(),
  subscriptionFindOne: vi.fn(),
  userById: vi.fn(),
  transaction: vi.fn(),
  authorize: vi.fn(),
  event: vi.fn(),
  transition: vi.fn(),
  investorScope: vi.fn(),
  issuerScope: vi.fn(),
  serialize: vi.fn((value: unknown) => value),
  decimal: vi.fn((value: number) => `decimal:${value}`),
  idempotent: vi.fn(),
  readCommand: vi.fn(),
  paystackCustomer: vi.fn(),
  paystackDva: vi.fn(),
  paystackInitialize: vi.fn(),
  paystackRefund: vi.fn(),
  escrowAccountRef: vi.fn(),
  notify: vi.fn(),
  env: { PAYSTACK_ENABLED: false, PAYSTACK_DVA_ENABLED: false, PAYSTACK_DVA_PREFERRED_BANK: undefined },
}));

vi.mock("../../../../db/models.js", () => ({
  CorporateActionModel: { create: mocks.corporateActionCreate, findOne: mocks.corporateActionFind },
  DedicatedVirtualAccountModel: { findOne: mocks.dedicatedAccountFind, create: vi.fn() },
  EscrowReceiptModel: { findOne: mocks.escrowReceiptFind, create: mocks.escrowReceiptCreate },
  InvestorProfileModel: { findOne: mocks.investorProfileFind },
  LedgerEntryModel: { create: mocks.ledgerCreate, findOne: mocks.ledgerFind },
  OfferingModel: { findById: mocks.offeringById, find: mocks.offeringFind, findByIdAndUpdate: mocks.offeringUpdate },
  OutboundTransferModel: { create: mocks.outboundTransferCreate },
  PaymentIntentModel: { findOne: mocks.paymentIntentFind, findOneAndUpdate: mocks.paymentIntentUpdate },
  PlatformConfigModel: { findById: mocks.configFind },
  SuitabilityAssessmentModel: { findOne: mocks.suitabilityFind },
  SubscriptionModel: { aggregate: mocks.subscriptionAggregate, create: mocks.subscriptionCreate, find: mocks.subscriptionFind, countDocuments: mocks.subscriptionCount, findById: mocks.subscriptionById, findOne: mocks.subscriptionFindOne },
  UserModel: { findById: mocks.userById },
}));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.event }));
vi.mock("../../../../utils/state-machine.js", () => ({ assertTransition: mocks.transition }));
vi.mock("../../../../utils/scope.js", () => ({ assertInvestorScope: mocks.investorScope, assertIssuerBusinessScope: mocks.issuerScope }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../utils/idempotency.js", () => ({
  readCommandId: mocks.readCommand,
  runIdempotentCommand: mocks.idempotent,
}));
vi.mock("../../../../services/ledger.js", () => ({ escrowAccountRef: mocks.escrowAccountRef }));
vi.mock("../../../../services/paystack.js", () => ({
  createPaystackCustomer: mocks.paystackCustomer,
  createPaystackDedicatedVirtualAccount: mocks.paystackDva,
  initializePaystackTransaction: mocks.paystackInitialize,
  initiatePaystackRefund: mocks.paystackRefund,
  nairaToKobo: vi.fn(),
}));
vi.mock("../../../../services/notifications.js", () => ({ createNotificationsFromEvent: mocks.notify }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));

import { subscriptionRoutes } from "../subscriptions.routes.js";

const offeringId = "507f1f77bcf86cd799439011";
const investorId = "507f1f77bcf86cd799439012";
let role = "investor";
let app: ReturnType<typeof Fastify>;

function sessionValue(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) };
}

function activeQuery(value: unknown) {
  return { session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

function assessmentQuery(value: unknown) {
  return { sort: vi.fn(() => ({ session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })) };
}

function aggregateValue(value: unknown) {
  return { session: vi.fn().mockResolvedValue(value) };
}

function paginatedQuery(value: unknown) {
  return {
    sort: vi.fn(() => ({
      skip: vi.fn(() => ({
        limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })),
      })),
    })),
  };
}

function leanSessionValue(value: unknown) {
  return { lean: vi.fn(() => ({ session: vi.fn().mockResolvedValue(value) })) };
}

function sessionLeanValue(value: unknown) {
  return { session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

function leanValue(value: unknown) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function selectLeanValue(value: unknown) {
  return { select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

function sortedLeanValue(value: unknown) {
  return { sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

function offering(overrides: Record<string, unknown> = {}) {
  return {
    _id: offeringId,
    status: "open",
    templateCode: "A",
    minimumRiskTier: 0,
    terms: { minTicket: 100, maxTicket: 0, raiseAmount: 10_000 },
    metrics: { maxSingleInvestorPct: 0 },
    ...overrides,
  };
}

function profile(overrides: Record<string, unknown> = {}) {
  return {
    userId: investorId,
    kycStatus: "approved",
    amlStatus: "clear",
    eligibility: "retail",
    jurisdiction: "NG",
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}) {
  return {
    complianceRules: {
      requireKycToSubscribe: true,
      minInvestmentByTemplate: { A: 100, B: 100 },
      coolingOffDays: 14,
      ...overrides,
    },
    jurisdictions: [{ code: "NG", name: "Nigeria", enabled: true, amlRequired: true }],
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    _id: "subscription-1",
    offeringId,
    investorUserId: investorId,
    amount: "decimal:500",
    status: "committed",
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }),
    ...overrides,
  };
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  role = "investor";
  mocks.env.PAYSTACK_ENABLED = false;
  mocks.env.PAYSTACK_DVA_ENABLED = false;
  mocks.env.PAYSTACK_DVA_PREFERRED_BANK = undefined;
  mocks.transaction.mockImplementation(async (operation: (session: unknown) => Promise<unknown>) => operation({ id: "session-1" }));
  mocks.idempotent.mockImplementation(async ({ execute }: { execute: () => Promise<unknown> }) => execute());
  mocks.authorize.mockReturnValue(undefined);
  mocks.transition.mockReturnValue(undefined);
  mocks.event.mockResolvedValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.decimal.mockImplementation((value: number) => `decimal:${value}`);
  mocks.offeringById.mockReturnValue(sessionValue(offering()));
  mocks.configFind.mockReturnValue(sessionValue(config()));
  mocks.investorProfileFind.mockReturnValue(sessionValue(profile()));
  mocks.subscriptionAggregate.mockReturnValue(aggregateValue([{ total: 0 }]));
  mocks.subscriptionFindOne.mockReturnValue(activeQuery(null));
  mocks.subscriptionCreate.mockResolvedValue([subscription()]);
  mocks.offeringUpdate.mockResolvedValue(undefined);

  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    return reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message });
  });
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    request.authUser = { userId: investorId, role, businessId: "business-1" };
  });
  await app.register(subscriptionRoutes);
});

afterEach(async () => {
  await app.close();
});

describe("subscription routes", () => {
  it("creates a signed subscription, updates metrics, and records both audit events", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/offerings/${offeringId}/subscribe`,
      headers: { "idempotency-key": "subscription-command-1" },
      payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace", agreementVersion: "2026-01", documentHash: "a".repeat(64) } },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.subscriptionCreate).toHaveBeenCalledWith(
      [expect.objectContaining({ offeringId, investorUserId: investorId, amount: "decimal:500", status: "committed", agreement: expect.objectContaining({ signature: "Ada Lovelace", executionHash: expect.stringMatching(/^[a-f0-9]{64}$/) }) })],
      { session: { id: "session-1" } },
    );
    expect(mocks.offeringUpdate).toHaveBeenCalledWith(offeringId, expect.objectContaining({ "metrics.subscribedAmount": "decimal:0", "metrics.investorCount": 0 }), { session: { id: "session-1" } });
    expect(mocks.event).toHaveBeenCalledTimes(2);
    expect(mocks.idempotent).toHaveBeenCalledWith(expect.objectContaining({ commandId: "subscription-command-1", payload: { offeringId, amount: 500 } }));
  });

  it("rejects an actor that is not an investor before it reads offering data", async () => {
    role = "issuer";
    const response = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(response.statusCode).toBe(403);
    expect(response.json().message).toBe("Investor role required");
    expect(mocks.offeringById).not.toHaveBeenCalled();
  });

  it("rejects a missing or closed offering", async () => {
    mocks.offeringById.mockReturnValueOnce(sessionValue(null));
    const missing = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(missing.statusCode).toBe(404);

    mocks.offeringById.mockReturnValueOnce(sessionValue(offering({ status: "closed" })));
    const closed = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(closed.statusCode).toBe(422);
    expect(closed.json().message).toBe("Offering is not open for subscription");
  });

  it("enforces minimum, maximum, and concentration ticket limits", async () => {
    const tooSmall = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 99, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(tooSmall.statusCode).toBe(422);
    expect(tooSmall.json().message).toBe("Minimum subscription is 100");

    mocks.offeringById.mockReturnValueOnce(sessionValue(offering({ terms: { minTicket: 100, maxTicket: 400, raiseAmount: 10_000 } })));
    const tooLarge = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(tooLarge.statusCode).toBe(422);
    expect(tooLarge.json().message).toBe("Maximum subscription per investor is 400");

    mocks.offeringById.mockReturnValueOnce(sessionValue(offering({ metrics: { maxSingleInvestorPct: 2 } })));
    const concentrated = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(concentrated.statusCode).toBe(422);
    expect(concentrated.json().message).toContain("single-investor concentration limit");
  });

  it("blocks active duplicate subscriptions and subscriptions above remaining capacity", async () => {
    mocks.subscriptionAggregate.mockReturnValueOnce(aggregateValue([{ total: 9_700 }]));
    const oversubscribed = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(oversubscribed.statusCode).toBe(422);
    expect(oversubscribed.json().message).toContain("oversubscribe");

    mocks.subscriptionAggregate.mockReturnValueOnce(aggregateValue([{ total: 0 }]));
    mocks.subscriptionFindOne.mockReturnValueOnce(activeQuery({ _id: "existing-subscription" }));
    const duplicate = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toBe("You already have an active subscription for this offering.");
  });

  it("blocks failed AML, private-offering, and suitability gates and records their audit event", async () => {
    mocks.investorProfileFind.mockReturnValueOnce(sessionValue(profile({ amlStatus: "pending" })));
    const aml = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(aml.statusCode).toBe(422);
    expect(aml.json().message).toContain("AML screening is not cleared");
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "AMLCheckFailed" }), expect.anything());

    mocks.offeringById.mockReturnValueOnce(sessionValue(offering({ isPrivate: true, investorWhitelistUserIds: [] })));
    const privateOffering = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(privateOffering.statusCode).toBe(403);

    mocks.offeringById.mockReturnValueOnce(sessionValue(offering({ minimumRiskTier: 2 })));
    mocks.suitabilityFind.mockReturnValueOnce(assessmentQuery(null));
    const suitability = await app.inject({ method: "POST", url: `/v1/offerings/${offeringId}/subscribe`, payload: { amount: 500, agreement: { accepted: true, signature: "Ada Lovelace" } } });
    expect(suitability.statusCode).toBe(422);
    expect(suitability.json().message).toContain("suitability assessment is required");
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "SuitabilityCheckFailed" }), expect.anything());
  });

  it("lists only the investor's subscriptions and applies the requested filters and page", async () => {
    mocks.subscriptionFind.mockReturnValueOnce(paginatedQuery([{ _id: "subscription-1", investorUserId: investorId }]));
    mocks.subscriptionCount.mockResolvedValueOnce(21);

    const response = await app.inject({ method: "GET", url: "/v1/subscriptions?offeringId=offering-1&status=paid&page=2&limit=10" });

    expect(response.statusCode).toBe(200);
    expect(mocks.subscriptionFind).toHaveBeenCalledWith({ investorUserId: investorId, offeringId: "offering-1", status: "paid" });
    expect(response.json()).toEqual({ data: [{ _id: "subscription-1", investorUserId: investorId }], total: 21, page: 2, limit: 10, pages: 3 });
  });

  it("returns grouped issuer figures only for the issuer's offerings", async () => {
    role = "issuer";
    mocks.offeringFind.mockReturnValueOnce({ select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: offeringId, name: "Income note" }]) })) });
    mocks.subscriptionAggregate.mockReturnValueOnce([{ _id: offeringId, totalAmount: "1500", totalCount: 2, paidCount: 1 }]);

    const response = await app.inject({ method: "GET", url: "/v1/subscriptions?offeringId=offering-1" });

    expect(response.statusCode).toBe(200);
    expect(mocks.offeringFind).toHaveBeenCalledWith({ businessId: "business-1", _id: "offering-1" });
    expect(response.json()).toEqual([{ offeringId, offeringName: "Income note", totalAmount: "1500", totalCount: 2, paidCount: 1 }]);
  });

  it("gives an operator a paginated global register and rejects invalid page limits", async () => {
    role = "operator";
    mocks.subscriptionFind.mockReturnValueOnce(paginatedQuery([{ _id: "subscription-1" }]));
    mocks.subscriptionCount.mockResolvedValueOnce(1);

    const response = await app.inject({ method: "GET", url: "/v1/subscriptions?limit=1" });
    expect(response.statusCode).toBe(200);
    expect(mocks.subscriptionFind).toHaveBeenCalledWith({});
    expect(response.json()).toEqual({ data: [{ _id: "subscription-1" }], total: 1, page: 1, limit: 1, pages: 1 });

    const invalid = await app.inject({ method: "GET", url: "/v1/subscriptions?limit=101" });
    expect(invalid.statusCode).toBe(400);
  });

  it("lets an operator move an existing subscription to payment pending and records the state change", async () => {
    role = "operator";
    const current = subscription();
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));

    const response = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/mark-payment-pending", headers: { "x-command-id": "pending-command-1" } });

    expect(response.statusCode).toBe(200);
    expect(current.status).toBe("payment_pending");
    expect(current.save).toHaveBeenCalledWith({ session: { id: "session-1" } });
    expect(mocks.transition).toHaveBeenCalledWith("subscription", "committed", "payment_pending");
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "SubscriptionPaymentPending" }), expect.anything());
  });

  it("rejects payment state changes from investors and reports a missing subscription", async () => {
    const forbidden = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/mark-payment-pending" });
    expect(forbidden.statusCode).toBe(403);

    role = "admin";
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(null));
    const missing = await app.inject({ method: "POST", url: "/v1/subscriptions/missing/mark-payment-pending" });
    expect(missing.statusCode).toBe(404);
  });

  it("records a verified payment receipt, escrow credit, and platform fee exactly once", async () => {
    role = "operator";
    const current = subscription({ status: "payment_pending", amount: { toString: () => "500" } });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.escrowReceiptFind.mockReturnValueOnce(sessionValue(null));
    mocks.offeringById.mockReturnValueOnce({ session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({ feeSnapshot: { platformFeePct: "2" } }) })) });

    const response = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/subscription-1/mark-paid",
      headers: { "x-command-id": "paid-command-1" },
      payload: { externalRef: "receipt-100", source: "bank", payerRef: "payer-1", currency: "NGN" },
    });

    expect(response.statusCode).toBe(200);
    expect(current.status).toBe("paid");
    expect((current as any).externalReceiptRef).toBe("receipt-100");
    expect(mocks.escrowReceiptCreate).toHaveBeenCalledWith([expect.objectContaining({ externalRef: "receipt-100", status: "confirmed" })], { session: { id: "session-1" } });
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(2);
    expect(mocks.ledgerCreate).toHaveBeenNthCalledWith(2, [expect.objectContaining({ ledgerType: "fee", amount: "decimal:10" })], { session: { id: "session-1" } });
    expect(mocks.transition).toHaveBeenCalledWith("subscription", "payment_pending", "paid", { hasVerifiedReceipt: true });
  });

  it("does not create a second receipt when the external reference already exists", async () => {
    role = "admin";
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(subscription({ status: "payment_pending", amount: { toString: () => "500" } })));
    mocks.escrowReceiptFind.mockReturnValueOnce(sessionValue({ _id: "receipt-existing" }));
    mocks.offeringById.mockReturnValueOnce({ session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({}) })) });

    const response = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/mark-paid", payload: { externalRef: "receipt-100", source: "bank" } });

    expect(response.statusCode).toBe(200);
    expect(mocks.escrowReceiptCreate).not.toHaveBeenCalled();
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(1);
  });

  it("starts one card payment for the subscription owner and persists its expected amount", async () => {
    mocks.env.PAYSTACK_ENABLED = true;
    const current = subscription({ amount: { toString: () => "500" } });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.userById.mockReturnValueOnce(leanSessionValue({ email: "ada@example.test" }));
    mocks.paystackInitialize.mockResolvedValueOnce({ reference: "fractal_sub_subscription-1", authorization_url: "https://pay.example.test/checkout", access_code: "access-code" });

    const response = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-payment", headers: { "idempotency-key": "checkout-command-1" }, payload: { callbackUrl: "https://app.example.test/payments/complete" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ subscriptionId: "subscription-1", paymentUrl: "https://pay.example.test/checkout", reference: "fractal_sub_subscription-1", accessCode: "access-code" });
    expect(mocks.investorScope).toHaveBeenCalledWith(expect.objectContaining({ userId: investorId }), investorId);
    expect(mocks.paystackInitialize).toHaveBeenCalledWith(expect.objectContaining({ email: "ada@example.test", amountKobo: 50_000, reference: "fractal_sub_subscription-1" }));
    expect(mocks.paymentIntentUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $setOnInsert: expect.objectContaining({ expectedAmountKobo: 50_000, method: "checkout" }) }), expect.objectContaining({ upsert: true, session: { id: "session-1" } }));
    expect(current.status).toBe("payment_pending");
  });

  it("blocks payment setup when the provider is disabled, the actor is not the owner, or the state is not payable", async () => {
    const disabled = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-payment", payload: {} });
    expect(disabled.statusCode).toBe(422);
    expect(disabled.json().message).toBe("Payment provider not configured");

    mocks.env.PAYSTACK_ENABLED = true;
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(subscription({ investorUserId: "other-investor" })));
    mocks.investorScope.mockImplementationOnce(() => { throw new HttpError(403, "Out of scope"); });
    const outOfScope = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-payment", payload: {} });
    expect(outOfScope.statusCode).toBe(403);

    mocks.subscriptionById.mockReturnValueOnce(sessionValue(subscription({ status: "paid" })));
    const notPayable = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-payment", payload: {} });
    expect(notPayable.statusCode).toBe(422);
    expect(notPayable.json().message).toBe("Subscription is not in a payable state");
  });

  it("returns an existing dedicated virtual account and creates a DVA payment intent", async () => {
    mocks.env.PAYSTACK_ENABLED = true;
    mocks.env.PAYSTACK_DVA_ENABLED = true;
    const current = subscription({ amount: { toString: () => "500" } });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.userById.mockReturnValueOnce(leanSessionValue({ email: "ada@example.test", name: "Ada Lovelace" }));
    mocks.dedicatedAccountFind.mockReturnValueOnce(sessionValue({ bankName: "Test Bank", accountNumber: "0011223344", accountName: "Ada Lovelace" }));

    const response = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-dva-payment" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ subscriptionId: "subscription-1", bankName: "Test Bank", accountNumber: "0011223344", amount: 500, currency: "NGN" });
    expect(mocks.paymentIntentUpdate).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ $setOnInsert: expect.objectContaining({ expectedAmountKobo: 50_000, method: "dva", paystackReference: "fractal_dva_subscription-1" }) }), expect.objectContaining({ upsert: true }));
    expect(current.status).toBe("payment_pending");
    expect(mocks.event).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "DVAPaymentInitiated" }), expect.anything());
  });

  it("requires both payment-provider switches before it starts a DVA payment", async () => {
    const noProvider = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-dva-payment" });
    expect(noProvider.statusCode).toBe(422);
    expect(noProvider.json().message).toBe("Payment provider not configured");

    mocks.env.PAYSTACK_ENABLED = true;
    const noDva = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/initiate-dva-payment" });
    expect(noDva.statusCode).toBe(422);
    expect(noDva.json().message).toBe("DVA payments not enabled");
  });

  it("cancels an unpaid subscription, recalculates metrics, and notifies the investor", async () => {
    const current = subscription({ status: "committed" });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));

    const response = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/subscription-1/cancel",
      headers: { "x-command-id": "cancel-command-1" },
      payload: { reason: "Investor changed plans" },
    });

    expect(response.statusCode).toBe(200);
    expect(current.status).toBe("cancelled");
    expect(mocks.offeringUpdate).toHaveBeenCalled();
    expect(mocks.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "SubscriptionCancelled" }), expect.anything());
  });

  it("starts a cooling-off refund for a paid subscription when the provider is enabled", async () => {
    mocks.env.PAYSTACK_ENABLED = true;
    const current = subscription({
      status: "paid",
      amount: { toString: () => "500" },
      externalReceiptRef: "receipt-100",
      cancellableUntil: new Date(Date.now() + 86_400_000),
    });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.paystackRefund.mockResolvedValueOnce({ id: "refund-100" });
    mocks.ledgerFind.mockReturnValueOnce(sessionValue({ amount: "decimal:10", currency: "NGN" }));

    const response = await app.inject({ method: "POST", url: "/v1/subscriptions/subscription-1/cancel", payload: { reason: "Cooling-off request" } });

    expect(response.statusCode).toBe(200);
    expect(current.status).toBe("refund_pending");
    expect(mocks.outboundTransferCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ entityType: "refund" })]), expect.any(Object));
    expect(mocks.paystackRefund).toHaveBeenCalled();
  });

  it("processes a manual refund and reverses the platform fee", async () => {
    role = "operator";
    const current = subscription({ status: "paid", amount: { toString: () => "500" } });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.ledgerFind.mockReturnValueOnce(sessionValue({ amount: "decimal:10", currency: "NGN" }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/subscription-1/refund",
      payload: { reason: "Verified refund", reversalRef: "bank-refund-100", confirm: "REFUND" },
    });

    expect(response.statusCode).toBe(200);
    expect(current.status).toBe("refunded");
    expect(mocks.ledgerCreate).toHaveBeenCalledTimes(2);
    expect(mocks.notify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "SubscriptionRefunded" }), expect.anything());
  });

  it("starts a provider refund when an external payment receipt exists", async () => {
    role = "admin";
    mocks.env.PAYSTACK_ENABLED = true;
    const current = subscription({ status: "paid", amount: { toString: () => "500" }, externalReceiptRef: "receipt-100" });
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.paystackRefund.mockResolvedValueOnce({ id: "refund-100" });
    mocks.ledgerFind.mockReturnValueOnce(sessionValue(null));

    const response = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/subscription-1/refund",
      payload: { reason: "Provider refund", confirm: "REFUND" },
    });

    expect(response.statusCode).toBe(200);
    expect(current.status).toBe("refund_pending");
    expect(mocks.outboundTransferCreate).toHaveBeenCalled();
  });

  it("returns payment status only to the subscription owner", async () => {
    mocks.subscriptionById.mockReturnValueOnce(leanValue(subscription({ status: "paid", updatedAt: new Date("2026-01-01") })));
    mocks.paymentIntentFind.mockReturnValueOnce(sortedLeanValue({ status: "matched", method: "checkout", expectedAmountKobo: 50_000, expiresAt: new Date("2026-02-01") }));

    const response = await app.inject({ method: "GET", url: "/v1/subscriptions/subscription-1/payment-status" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ subscriptionId: "subscription-1", status: "paid", paymentIntent: { status: "matched", expectedAmountKobo: 50_000 } });
    expect(mocks.investorScope).toHaveBeenCalledWith(expect.anything(), investorId);
  });

  it("issues an ownership certificate only after allocation confirmation", async () => {
    mocks.subscriptionById.mockReturnValueOnce(leanValue(subscription({ status: "allocation_confirmed", amount: { toString: () => "500" } })));
    mocks.offeringById.mockReturnValueOnce(selectLeanValue({ _id: offeringId, name: "Income Note", templateCode: "A", terms: { raiseAmount: 10_000 } }));
    mocks.userById.mockReturnValueOnce(selectLeanValue({ name: "Ada Lovelace", email: "ada@example.test" }));

    const response = await app.inject({ method: "GET", url: "/v1/subscriptions/subscription-1/certificate" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ certificateType: "DIGITAL_OWNERSHIP_CERTIFICATE", holderName: "Ada Lovelace", sharePercent: 5 });
  });

  it("creates a pending forced-transfer request for an allocation-confirmed subscription", async () => {
    role = "operator";
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(subscription({ status: "allocation_confirmed" })));
    mocks.userById.mockReturnValueOnce(sessionLeanValue({ _id: "investor-2", role: "investor" }));

    const response = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/subscription-1/request-forced-transfer",
      payload: { toUserId: "investor-2", reason: "Court order requires the ownership transfer." },
    });

    expect(response.statusCode).toBe(200);
    expect(mocks.corporateActionCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ type: "forced_transfer", status: "pending" })]), expect.any(Object));
  });

  it("executes an approved forced transfer and posts paired ownership entries", async () => {
    role = "admin";
    const current = subscription({ status: "allocation_confirmed", amount: "decimal:500" });
    const action: any = { _id: "action-1", status: "pending", payload: { fromUserId: investorId, toUserId: "investor-2" }, save: vi.fn().mockResolvedValue(undefined) };
    mocks.subscriptionById.mockReturnValueOnce(sessionValue(current));
    mocks.corporateActionFind.mockReturnValueOnce(sessionValue(action));

    const response = await app.inject({
      method: "POST",
      url: "/v1/subscriptions/subscription-1/execute-forced-transfer",
      payload: { corporateActionId: "action-1", confirm: "FORCED_TRANSFER" },
    });

    expect(response.statusCode).toBe(200);
    expect(current.investorUserId).toBe("investor-2");
    expect(mocks.ledgerCreate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ direction: "debit" }), expect.objectContaining({ direction: "credit" })]), expect.any(Object));
    expect(action.status).toBe("executed");
  });
});
