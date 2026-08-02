import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  initialize: vi.fn(),
  markInitialized: vi.fn(),
  markRetry: vi.fn(),
  query: vi.fn(),
  randomUUID: vi.fn(() => "worker-123"),
}));
const { TestPaystackRequestError } = vi.hoisted(() => ({
  TestPaystackRequestError: class TestPaystackRequestError extends Error {
    constructor(message: string, readonly retryable: boolean) {
      super(message);
    }
  },
}));

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  randomUUID: mocks.randomUUID,
}));
vi.mock("../../config/env.js", () => ({
  env: {
    OUTBOX_DISPATCH_BATCH_SIZE: 10,
    PAYMENT_INSTRUCTION_CLAIM_TIMEOUT_SECONDS: 30,
    PAYMENT_INSTRUCTION_MAX_ATTEMPTS: 3,
    PAYMENT_INSTRUCTION_RETRY_BASE_SECONDS: 10,
    PAYMENT_INSTRUCTION_DISPATCH_INTERVAL_MS: 60_000,
  },
}));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query: mocks.query }) }));
vi.mock("../paystack.js", () => ({
  PaystackRequestError: TestPaystackRequestError,
  initializePaystackTransaction: mocks.initialize,
}));
vi.mock("../../platform/postgres-payment-instructions.js", () => ({
  claimPaymentProviderInstructions: mocks.claim,
  markPaymentInstructionInitialized: mocks.markInitialized,
  markPaymentInstructionForRetry: mocks.markRetry,
}));

import {
  dispatchPendingPaymentProviderInstructions,
  processPaymentProviderInstruction,
  startPaymentProviderInstructionDispatcher,
} from "../payment-instruction-dispatcher.js";

const logger = { info: vi.fn(), error: vi.fn() };
const instruction = { id: "instruction-1", paymentIntentId: "intent-1", provider: "paystack", attempts: 1 };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.randomUUID.mockReturnValue("worker-123");
  logger.info.mockReset();
  logger.error.mockReset();
  mocks.markInitialized.mockResolvedValue(undefined);
  mocks.markRetry.mockResolvedValue(undefined);
  mocks.initialize.mockResolvedValue({ authorization_url: "https://paystack.test/checkout", access_code: "access-1", reference: "payment-reference-1" });
  mocks.query.mockResolvedValue({ rows: [{
    email: "investor@example.test", expected_minor: "125050", currency: "NGN", provider_reference: "payment-reference-1",
    payment_intent_id: "intent-1", commitment_id: "commitment-1",
  }] });
});

describe("payment instruction dispatcher", () => {
  it("loads authoritative payment facts, initializes Paystack, and records the provider checkout", async () => {
    await processPaymentProviderInstruction(instruction, "worker-123");

    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("FROM fractal.payment_provider_instructions"), ["instruction-1"]);
    expect(mocks.initialize).toHaveBeenCalledWith({
      email: "investor@example.test", amountKobo: 125050, reference: "payment-reference-1",
      metadata: { paymentIntentId: "intent-1", commitmentId: "commitment-1" },
    });
    expect(mocks.markInitialized).toHaveBeenCalledWith({
      instructionId: "instruction-1", workerId: "worker-123", checkoutUrl: "https://paystack.test/checkout", accessCode: "access-1",
    });
  });

  it("rejects provider, record, currency, and amount states that cannot create a safe checkout", async () => {
    await expect(processPaymentProviderInstruction({ ...instruction, provider: "manual" }, "worker-123")).rejects.toThrow("Unsupported payment provider");

    mocks.query.mockResolvedValueOnce({ rows: [] });
    await expect(processPaymentProviderInstruction(instruction, "worker-123")).rejects.toThrow("was not found");

    mocks.query.mockResolvedValueOnce({ rows: [{ email: "investor@example.test", expected_minor: "125050", currency: "USD", provider_reference: "reference", payment_intent_id: "intent-1", commitment_id: "commitment-1" }] });
    await expect(processPaymentProviderInstruction(instruction, "worker-123")).rejects.toThrow("unsupported currency USD");

    mocks.query.mockResolvedValueOnce({ rows: [{ email: "investor@example.test", expected_minor: "0", currency: "NGN", provider_reference: "reference", payment_intent_id: "intent-1", commitment_id: "commitment-1" }] });
    await expect(processPaymentProviderInstruction(instruction, "worker-123")).rejects.toThrow("Invalid Paystack instruction amount");
  });

  it("retries ordinary provider failures and marks unsupported or terminal provider failures final", async () => {
    mocks.claim.mockResolvedValue([
      { ...instruction, id: "unsupported", provider: "manual" },
      { ...instruction, id: "retryable", attempts: 1 },
      { ...instruction, id: "terminal", attempts: 2 },
    ]);
    mocks.initialize
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockRejectedValueOnce(new TestPaystackRequestError("invalid provider request", false));

    await expect(dispatchPendingPaymentProviderInstructions({ logger, workerId: "worker-123" })).resolves.toBe(3);

    expect(mocks.markRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ instructionId: "unsupported", workerId: "worker-123", terminal: true, error: expect.any(Error) }));
    expect(mocks.markRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ instructionId: "retryable", workerId: "worker-123", terminal: false, error: expect.any(Error) }));
    expect(mocks.markRetry).toHaveBeenNthCalledWith(3, expect.objectContaining({ instructionId: "terminal", workerId: "worker-123", terminal: true, error: expect.any(TestPaystackRequestError) }));
    expect(mocks.markRetry.mock.calls[1]?.[0].retryAt.getTime()).toBeGreaterThan(Date.now());
    expect(logger.error).toHaveBeenCalledTimes(3);
  });

  it("does not call the provider when no instruction is claimable", async () => {
    mocks.claim.mockResolvedValue([]);

    await expect(dispatchPendingPaymentProviderInstructions({ logger })).resolves.toBe(0);
    expect(mocks.markInitialized).not.toHaveBeenCalled();
    expect(mocks.markRetry).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("reports each successfully initialized instruction to the worker logger", async () => {
    mocks.claim.mockResolvedValue([instruction]);

    await expect(dispatchPendingPaymentProviderInstructions({ logger, workerId: "worker-123" })).resolves.toBe(1);
    expect(logger.info).toHaveBeenCalledWith(
      { instructionId: "instruction-1", paymentIntentId: "intent-1" },
      "Payment provider instruction initialized",
    );
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("runs once at startup, prevents overlapping dispatches, and stops its timer", async () => {
    vi.useFakeTimers();
    let resolveClaim: ((instructions: Array<typeof instruction>) => void) | undefined;
    mocks.claim.mockImplementation(() => new Promise<Array<typeof instruction>>((resolve) => { resolveClaim = resolve; }));

    const dispatcher = startPaymentProviderInstructionDispatcher({ logger });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.claim).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    resolveClaim?.([]);
    await vi.advanceTimersByTimeAsync(0);

    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.claim).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("reports an unexpected dispatcher failure without leaving the loop running", async () => {
    vi.useFakeTimers();
    mocks.claim.mockRejectedValue(new Error("database unavailable"));

    const dispatcher = startPaymentProviderInstructionDispatcher({ logger });
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Payment instruction dispatcher failed");
    dispatcher.stop();
    vi.useRealTimers();
  });
});
