import { beforeEach, describe, expect, it, vi } from "vitest";

const withTransaction = vi.hoisted(() => vi.fn());
const claimInbox = vi.hoisted(() => vi.fn());
const markInboxProcessed = vi.hoisted(() => vi.fn());
const markInboxRetry = vi.hoisted(() => vi.fn());
const claimOutbox = vi.hoisted(() => vi.fn());
const markOutboxPublished = vi.hoisted(() => vi.fn());
const markOutboxRetry = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  INBOX_DISPATCH_BATCH_SIZE: 20, INBOX_CLAIM_TIMEOUT_SECONDS: 300, INBOX_MAX_ATTEMPTS: 3,
  INBOX_RETRY_BASE_SECONDS: 10, INBOX_DISPATCH_INTERVAL_MS: 1_000,
  OUTBOX_DISPATCH_BATCH_SIZE: 20, OUTBOX_CLAIM_TIMEOUT_SECONDS: 300,
  OUTBOX_RETRY_BASE_SECONDS: 10, OUTBOX_DISPATCH_INTERVAL_MS: 1_000,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: withTransaction }));
vi.mock("../../platform/postgres-inbox.js", () => ({
  claimInboxEvents: claimInbox, markInboxEventProcessed: markInboxProcessed, markInboxEventForRetry: markInboxRetry,
}));
vi.mock("../../platform/postgres-outbox.js", () => ({
  claimOutboxEvents: claimOutbox, markOutboxEventPublished: markOutboxPublished, markOutboxEventForRetry: markOutboxRetry,
}));

import { dispatchPendingInboxEvents, startPostgresInboxDispatcher } from "../postgres-inbox-dispatcher.js";
import { dispatchPendingOutboxEvents, startPostgresOutboxDispatcher } from "../postgres-outbox-dispatcher.js";

const logger = { info: vi.fn(), error: vi.fn() };
const inboxEvent = { id: "inbox-1", provider: "paystack", externalEventId: "event-1", payload: {}, receivedAt: new Date(), attempts: 1 };
const outboxEvent = { id: "outbox-1", aggregateType: "payment", aggregateId: "payment-1", eventType: "payment.updated", payload: {}, occurredAt: new Date(), attempts: 1 };

beforeEach(() => {
  vi.clearAllMocks();
  claimInbox.mockResolvedValue([]);
  claimOutbox.mockResolvedValue([]);
  withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
});

describe("Postgres inbox dispatcher", () => {
  it("claims provider events, processes them, and records completion", async () => {
    claimInbox.mockResolvedValue([inboxEvent]);
    const process = vi.fn().mockResolvedValue(undefined);
    await expect(dispatchPendingInboxEvents({ workerId: "inbox-worker", providers: ["paystack"], process, logger })).resolves.toBe(1);
    expect(claimInbox).toHaveBeenCalledWith({ workerId: "inbox-worker", providers: ["paystack"], limit: 20, claimTimeoutSeconds: 300 });
    expect(markInboxProcessed).toHaveBeenCalledWith(expect.anything(), "inbox-1", "inbox-worker");
    expect(logger.info).toHaveBeenCalledWith({ eventId: "inbox-1", provider: "paystack" }, "Postgres inbox event processed");
  });

  it("schedules retries, terminal errors, and exhausted events without losing the event", async () => {
    claimInbox.mockResolvedValue([{ ...inboxEvent, attempts: 1 }, { ...inboxEvent, id: "inbox-2", attempts: 3 }]);
    const process = vi.fn().mockRejectedValue(new Error("invalid provider data"));
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await expect(dispatchPendingInboxEvents({ workerId: "inbox-worker", providers: ["paystack"], process, isTerminalError: () => false, logger })).resolves.toBe(2);
    } finally { clock.mockRestore(); }
    expect(markInboxRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({ eventId: "inbox-1", terminal: false, retryAt: new Date(1_010_000) }));
    expect(markInboxRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({ eventId: "inbox-2", terminal: true, retryAt: new Date(1_040_000) }));
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("uses the terminal-error policy and creates an ID when none is supplied", async () => {
    claimInbox.mockResolvedValue([inboxEvent]);
    await dispatchPendingInboxEvents({ providers: ["sumsub"], process: vi.fn().mockRejectedValue("bad payload"), isTerminalError: () => true, logger });
    expect(claimInbox).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.any(String), providers: ["sumsub"] }));
    expect(markInboxRetry).toHaveBeenCalledWith(expect.objectContaining({ terminal: true, error: "bad payload" }));
  });

  it("treats an error as retryable when no terminal policy is provided", async () => {
    claimInbox.mockResolvedValue([inboxEvent]);
    await dispatchPendingInboxEvents({ workerId: "inbox-worker", providers: ["paystack"], process: vi.fn().mockRejectedValue(new Error("temporary")), logger });
    expect(markInboxRetry).toHaveBeenCalledWith(expect.objectContaining({ terminal: false }));
  });

  it("contains polling errors and prevents overlapping polls", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((value: unknown) => void) | undefined;
      claimInbox.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("database unavailable"));
      const worker = startPostgresInboxDispatcher({ workerId: "inbox-worker", providers: ["paystack"], process: vi.fn(), logger });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(claimInbox).toHaveBeenCalledOnce();
      finish?.([]);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Postgres inbox polling failed");
    } finally { vi.useRealTimers(); }
  });

  it("creates an inbox worker ID when the loop caller does not supply one", async () => {
    vi.useFakeTimers();
    try {
      const worker = startPostgresInboxDispatcher({ providers: [], process: vi.fn(), logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      expect(claimInbox).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.any(String) }));
    } finally { vi.useRealTimers(); }
  });
});

describe("Postgres outbox dispatcher", () => {
  it("projects claimed events atomically and publishes them", async () => {
    claimOutbox.mockResolvedValue([outboxEvent]);
    const project = vi.fn().mockResolvedValue(undefined);
    await expect(dispatchPendingOutboxEvents({ workerId: "outbox-worker", eventTypes: ["payment.updated"], project, logger })).resolves.toBe(1);
    expect(claimOutbox).toHaveBeenCalledWith({ workerId: "outbox-worker", eventTypes: ["payment.updated"], limit: 20, claimTimeoutSeconds: 300 });
    expect(project).toHaveBeenCalledWith(expect.anything(), outboxEvent);
    expect(markOutboxPublished).toHaveBeenCalledWith(expect.anything(), "outbox-1", "outbox-worker");
    expect(logger.info).toHaveBeenCalledWith({ eventId: "outbox-1", eventType: "payment.updated" }, "Postgres outbox event dispatched");
  });

  it("retries projection failures with exponential delay", async () => {
    claimOutbox.mockResolvedValue([{ ...outboxEvent, attempts: 3 }]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
    try {
      await dispatchPendingOutboxEvents({ workerId: "outbox-worker", eventTypes: ["payment.updated"], project: vi.fn().mockRejectedValue(new Error("projection unavailable")), logger });
    } finally { clock.mockRestore(); }
    expect(markOutboxRetry).toHaveBeenCalledWith(expect.objectContaining({ eventId: "outbox-1", workerId: "outbox-worker", retryAt: new Date(1_040_000), error: expect.any(Error) }));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ eventId: "outbox-1", delaySeconds: 40 }), "Postgres outbox dispatch failed");
  });

  it("creates a worker ID when none is supplied", async () => {
    await dispatchPendingOutboxEvents({ eventTypes: [], project: vi.fn(), logger });
    expect(claimOutbox).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.any(String), eventTypes: [] }));
  });

  it("contains polling errors and prevents overlapping polls", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((value: unknown) => void) | undefined;
      claimOutbox.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("database unavailable"));
      const worker = startPostgresOutboxDispatcher({ workerId: "outbox-worker", eventTypes: ["payment.updated"], project: vi.fn(), logger });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(claimOutbox).toHaveBeenCalledOnce();
      finish?.([]);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Postgres outbox polling failed");
    } finally { vi.useRealTimers(); }
  });

  it("creates an outbox worker ID when the loop caller does not supply one", async () => {
    vi.useFakeTimers();
    try {
      const worker = startPostgresOutboxDispatcher({ eventTypes: [], project: vi.fn(), logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      expect(claimOutbox).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.any(String) }));
    } finally { vi.useRealTimers(); }
  });
});
