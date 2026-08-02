import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  audit: vi.fn(),
  outbox: vi.fn(),
}));

vi.mock("../../db/postgres.js", () => ({
  withPostgresTransaction: async (work: (client: { query: typeof mocks.query }) => Promise<unknown>) => work({ query: mocks.query }),
}));
vi.mock("../../config/env.js", () => ({ env: { PAYMENT_EXPIRY_BATCH_SIZE: 50, PAYMENT_EXPIRY_INTERVAL_MS: 60_000 } }));
vi.mock("../../platform/postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../../platform/postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { expirePendingPaymentIntents, startPaymentExpiryWorker } from "../payment-expiry-worker.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.audit.mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockResolvedValue(undefined);
  logger.info.mockReset();
  logger.error.mockReset();
});

describe("payment expiry worker", () => {
  it("expires the full payment chain, cancels uninitialized provider work, and emits retained evidence", async () => {
    const now = new Date("2026-07-28T10:00:00.000Z");
    mocks.query.mockResolvedValueOnce({ rows: [{ id: "intent-1", commitment_id: "commitment-1", organization_id: "org-1" }], rowCount: 1 });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });

    await expect(expirePendingPaymentIntents(now)).resolves.toBe(1);

    expect(mocks.query).toHaveBeenNthCalledWith(1, expect.stringContaining("FOR UPDATE SKIP LOCKED"), [now, 50]);
    expect(mocks.query).toHaveBeenNthCalledWith(2, expect.stringContaining("payment_intents SET status = 'expired'"), ["intent-1"]);
    expect(mocks.query).toHaveBeenNthCalledWith(3, expect.stringContaining("investment_commitments SET status = 'expired'"), ["commitment-1"]);
    expect(mocks.query).toHaveBeenNthCalledWith(4, expect.stringContaining("investment_reservations SET status = 'expired'"), ["commitment-1"]);
    expect(mocks.query).toHaveBeenNthCalledWith(5, expect.stringContaining("payment_provider_instructions"), ["intent-1"]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      scopeKey: "organization:org-1", organizationId: "org-1", action: "payment.intent.expired", entityId: "intent-1",
      payload: { commitmentId: "commitment-1", expiredAt: now.toISOString() },
    }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), {
      aggregateType: "payment_intent", aggregateId: "intent-1", eventType: "payment.intent.expired",
      payload: { organizationId: "org-1", commitmentId: "commitment-1", auditEventId: "audit-1" },
    });
  });

  it("does not write evidence when no pending intent has reached its expiry boundary", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    await expect(expirePendingPaymentIntents()).resolves.toBe(0);
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.outbox).not.toHaveBeenCalled();
  });

  it("runs on startup, prevents overlapping work, and stops future expiry scans", async () => {
    vi.useFakeTimers();
    let resolveQuery: ((result: { rows: unknown[]; rowCount: number }) => void) | undefined;
    mocks.query.mockImplementationOnce(() => new Promise((resolve) => { resolveQuery = resolve; }));
    const worker = startPaymentExpiryWorker(logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.query).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    resolveQuery?.({ rows: [], rowCount: 0 });
    await vi.advanceTimersByTimeAsync(0);

    worker.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("records completed work and reports a failed expiry scan without throwing from the timer", async () => {
    vi.useFakeTimers();
    mocks.query.mockResolvedValueOnce({ rows: [{ id: "intent-1", commitment_id: "commitment-1", organization_id: "org-1" }], rowCount: 1 });
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
    const worker = startPaymentExpiryWorker(logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.info).toHaveBeenCalledWith({ count: 1 }, "Expired pending payment intents");
    worker.stop();
    vi.useRealTimers();

    vi.useFakeTimers();
    mocks.query.mockRejectedValue(new Error("database unavailable"));
    const failedWorker = startPaymentExpiryWorker(logger);
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Payment expiry worker failed");
    failedWorker.stop();
  });
});
