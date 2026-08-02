import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  identity: vi.fn(),
  stepUp: vi.fn(),
  serialize: vi.fn(),
  checkout: vi.fn(),
  authorize: vi.fn(),
  commandId: vi.fn(),
  randomUUID: vi.fn(() => "provider-reference"),
}));
const { TestCheckoutPolicyError, TestPostgresIdentityUnavailableError, TestStepUpRequiredError } = vi.hoisted(() => ({
  TestCheckoutPolicyError: class TestCheckoutPolicyError extends Error {},
  TestPostgresIdentityUnavailableError: class TestPostgresIdentityUnavailableError extends Error {},
  TestStepUpRequiredError: class TestStepUpRequiredError extends Error {},
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: mocks.randomUUID,
}));
vi.mock("../../../../config/env.js", () => ({ env: { PAYSTACK_ENABLED: true } }));
vi.mock("../../../../db/postgres.js", () => ({ requirePostgres: () => ({ query: mocks.query }) }));
vi.mock("../../../../platform/postgres-identities.js", () => ({
  requirePostgresIdentityForSubject: mocks.identity,
  PostgresIdentityUnavailableError: TestPostgresIdentityUnavailableError,
}));
vi.mock("../../../../platform/auth-step-up.js", () => ({
  requireFreshTotpStepUp: mocks.stepUp,
  StepUpRequiredError: TestStepUpRequiredError,
}));
vi.mock("../../../../platform/postgres-payment-status.js", () => ({ serializePaymentIntentStatus: mocks.serialize }));
vi.mock("../../../../platform/postgres-offering-checkout.js", () => ({
  CheckoutPolicyError: TestCheckoutPolicyError,
  createCheckout: mocks.checkout,
}));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/idempotency.js", () => ({ readCommandId: mocks.commandId }));

import { paymentCheckoutRoutes } from "../checkout.routes.js";
import { env } from "../../../../config/env.js";

let role = "investor";
let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "investor";
  env.PAYSTACK_ENABLED = true;
  mocks.randomUUID.mockReturnValue("provider-reference");
  mocks.commandId.mockImplementation((headers: Record<string, string | undefined>) => headers["x-command-id"]);
  mocks.identity.mockResolvedValue("identity-1");
  mocks.stepUp.mockResolvedValue(undefined);
  mocks.authorize.mockReturnValue(undefined);
  mocks.checkout.mockResolvedValue({ reservationId: "reservation-1", paymentIntentId: "intent-1" });
  mocks.query.mockResolvedValue({ rows: [{ expires_at: new Date("2026-08-01T12:00:00.000Z") }] });
  mocks.serialize.mockReturnValue({ id: "intent-1", state: "provider_ready" });
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : 500;
    return reply.status(statusCode).send({ message: error.message });
  });
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    request.authUser = { userId: "subject-1", role, sessionId: "session-1" };
  });
  await app.register(paymentCheckoutRoutes);
});

afterEach(async () => {
  await app.close();
});

const payload = { amountMinor: 125050, signatureName: "Amina Investor", agreementDocumentHash: "a".repeat(64) };

describe("payment checkout routes", () => {
  it("creates a command-bound checkout only after investor authority and fresh step-up", async () => {
    const response = await app.inject({
      method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      checkoutId: "reservation-1", paymentIntentId: "intent-1", paymentState: "initializing_provider_instruction", expiresAt: "2026-08-01T12:00:00.000Z",
    });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "investor" }), "create", "subscription");
    expect(mocks.stepUp).toHaveBeenCalledWith({ sessionId: "session-1", identityId: "identity-1" });
    expect(mocks.checkout).toHaveBeenCalledWith(expect.objectContaining({
      publicReference: "OFF-001", investorIdentityId: "identity-1", provider: "paystack", providerReference: "fractal-provider-reference", commandKey: "command-1",
      ...payload,
    }));
    expect(mocks.query).toHaveBeenCalledWith("SELECT expires_at FROM fractal.payment_intents WHERE id = $1", ["intent-1"]);
  });

  it("fails closed before it creates a checkout for role, command, payload, identity, step-up, and provider configuration errors", async () => {
    role = "issuer";
    await expect(app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload })).resolves.toMatchObject({ statusCode: 403 });
    role = "investor";
    await expect(app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", payload })).resolves.toMatchObject({ statusCode: 400 });
    await expect(app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload: { ...payload, amountMinor: 0 } })).resolves.toMatchObject({ statusCode: 400 });

    mocks.identity.mockRejectedValueOnce(new TestPostgresIdentityUnavailableError("not migrated"));
    await expect(app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload })).resolves.toMatchObject({ statusCode: 409 });
    mocks.stepUp.mockRejectedValueOnce(new TestStepUpRequiredError("Complete authenticator-app step-up"));
    await expect(app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload })).resolves.toMatchObject({ statusCode: 403 });
    expect(mocks.checkout).not.toHaveBeenCalled();
  });

  it("does not hide unexpected identity or step-up service failures as an authorization result", async () => {
    mocks.identity.mockRejectedValueOnce(new Error("identity database unavailable"));
    const identityFailure = await app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload });
    expect(identityFailure.statusCode).toBe(500);
    expect(identityFailure.json()).toMatchObject({ message: "identity database unavailable" });

    mocks.stepUp.mockRejectedValueOnce(new Error("step-up database unavailable"));
    const stepUpFailure = await app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload });
    expect(stepUpFailure.statusCode).toBe(500);
    expect(stepUpFailure.json()).toMatchObject({ message: "step-up database unavailable" });
  });

  it("turns a governed checkout policy rejection into a safe client error", async () => {
    mocks.checkout.mockRejectedValue(new TestCheckoutPolicyError("The investor is not eligible for this offering."));

    const response = await app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ message: "The investor is not eligible for this offering." });
  });

  it("does not create a payment when the provider is unavailable and never returns a checkout with a missing intent", async () => {
    env.PAYSTACK_ENABLED = false;
    const unavailable = await app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload });
    expect(unavailable.statusCode).toBe(422);
    expect(mocks.checkout).not.toHaveBeenCalled();

    env.PAYSTACK_ENABLED = true;
    mocks.query.mockResolvedValueOnce({ rows: [] });
    const disappeared = await app.inject({ method: "POST", url: "/v1/offerings/OFF-001/checkout", headers: { "x-command-id": "command-1" }, payload });
    expect(disappeared.statusCode).toBe(500);
    expect(disappeared.json()).toMatchObject({ message: "Checkout payment intent disappeared" });
  });

  it("returns an investor-owned payment state and never returns a missing or foreign payment intent", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{
      id: "intent-1", status: "pending", expires_at: new Date("2026-08-01T12:00:00.000Z"), currency: "NGN", expected_minor: "125050",
      instruction_status: "initialized", checkout_url: "https://paystack.test/checkout", last_error: null, terminal_at: null,
    }] });
    const found = await app.inject({ method: "GET", url: "/v1/payment-intents/intent-1" });
    expect(found.statusCode).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("commitment.investor_identity_id = $2"), ["intent-1", "identity-1"]);
    expect(mocks.serialize).toHaveBeenCalledWith(expect.objectContaining({ id: "intent-1", amountMinor: "125050" }));

    mocks.query.mockResolvedValueOnce({ rows: [] });
    const missing = await app.inject({ method: "GET", url: "/v1/payment-intents/missing" });
    expect(missing.statusCode).toBe(404);
  });
});
