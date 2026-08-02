import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));

import { claimPaymentProviderInstructions, markPaymentInstructionForRetry, markPaymentInstructionInitialized, projectPaymentIntentCreated } from "../postgres-payment-instructions.js";

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => mocks.transaction.mockReset());

describe("payment provider instructions", () => {
  it("projects only committed payment-intent events into idempotent provider instructions", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [{ provider: "paystack" }] }).mockResolvedValueOnce({}) };
    await expect(projectPaymentIntentCreated(client as never, { id: "event-1", aggregateId: "intent-1", eventType: "payment.intent.created" } as never)).resolves.toBeUndefined();
    expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining("ON CONFLICT (outbox_event_id) DO NOTHING"), [expect.any(String), "intent-1", "event-1", "paystack"]);
    await expect(projectPaymentIntentCreated(client as never, { id: "event-1", aggregateId: "intent-1", eventType: "other" } as never)).rejects.toThrow("Unsupported payment event");
  });

  it("fails closed when a payment intent is missing", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [] }) };
    await expect(projectPaymentIntentCreated(client as never, { id: "event-1", aggregateId: "intent-1", eventType: "payment.intent.created" } as never)).rejects.toThrow("was not found");
  });

  it("returns no instructions when the worker limit is not positive", async () => {
    await expect(claimPaymentProviderInstructions({ workerId: "worker-1", limit: 0, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("claims pending instructions using a worker-specific timeout", async () => {
    const query = transactionWithResponses({ rows: [{ id: "instruction-1", payment_intent_id: "intent-1", provider: "paystack", attempts: 2 }] });
    await expect(claimPaymentProviderInstructions({ workerId: "worker-1", limit: 10, claimTimeoutSeconds: 120 })).resolves.toEqual([{ id: "instruction-1", paymentIntentId: "intent-1", provider: "paystack", attempts: 2 }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FOR UPDATE SKIP LOCKED"), [120, 10, "worker-1"]);
  });

  it("requires a current claim to mark provider initialization or retry", async () => {
    transactionWithResponses({ rowCount: 1 });
    await expect(markPaymentInstructionInitialized({ instructionId: "instruction-1", workerId: "worker-1", checkoutUrl: "https://pay.example/checkout", accessCode: "code" })).resolves.toBeUndefined();
    transactionWithResponses({ rowCount: 0 });
    await expect(markPaymentInstructionInitialized({ instructionId: "instruction-1", workerId: "worker-1", checkoutUrl: "https://pay.example/checkout" })).rejects.toThrow("no longer claimed");
    const retry = transactionWithResponses({ rowCount: 1 });
    await expect(markPaymentInstructionForRetry({ instructionId: "instruction-1", workerId: "worker-1", retryAt: new Date("2026-08-01"), error: new Error("provider unavailable"), terminal: false })).resolves.toBeUndefined();
    expect(retry).toHaveBeenCalledWith(expect.stringContaining("next_attempt_at"), ["instruction-1", "worker-1", expect.any(Date), false, "provider unavailable"]);
  });
});
