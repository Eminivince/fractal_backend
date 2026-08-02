import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    APP_BASE_URL: "https://app.fractal.test/",
    AUTH_EMAIL_DELIVERY_CLAIM_TIMEOUT_SECONDS: 60,
    AUTH_EMAIL_DELIVERY_BATCH_SIZE: 20,
    AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS: 3,
    AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS: 30,
    AUTH_EMAIL_DELIVERY_INTERVAL_MS: 60_000,
  },
  requirePostgres: vi.fn(),
  withTransaction: vi.fn(),
  appendAudit: vi.fn(),
}));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.requirePostgres, withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));

import {
  dispatchPendingSupportNotifications,
  enqueueSupportNotification,
  readSupportNotificationDeliveries,
  startSupportNotificationDispatcher,
} from "../postgres-support-notifications.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
function item(overrides: Record<string, unknown> = {}) {
  return { id: "delivery-1", case_id: "case-1", reference: "SUP-1", recipient_identity_id: "identity-1", identity_status: "active", email: "recipient@example.test", notification_type: "staff_reply", attempts: 1, ...overrides };
}

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
});
afterEach(() => vi.useRealTimers());

describe("support notification delivery", () => {
  it("queues a delivery and maps the retained delivery timeline", async () => {
    const enqueueClient = clientWith({});
    const id = await enqueueSupportNotification(enqueueClient as any, { caseId: "case-1", caseEventSequence: 4, recipientIdentityId: "identity-1", notificationType: "opened" });
    expect(enqueueClient.query).toHaveBeenCalledWith(expect.stringContaining("support_case_notification_deliveries"), expect.arrayContaining([id, "case-1", 4, "identity-1", "opened"]));

    const readClient = clientWith({ rows: [{ id: "delivery-1", case_event_sequence: 4, notification_type: "opened", channel: "email", status: "sent", attempts: 2, provider: "resend", requested_at: new Date("2026-07-01"), sent_at: new Date("2026-07-02"), terminal_at: null }], rowCount: 1 });
    await expect(readSupportNotificationDeliveries(readClient as any, "case-1")).resolves.toEqual([{
      id: "delivery-1", caseEventSequence: 4, notificationType: "opened", channel: "email", status: "sent", attempts: 2, provider: "resend", requestedAt: "2026-07-01T00:00:00.000Z", sentAt: "2026-07-02T00:00:00.000Z", terminalAt: null,
    }]);
  });

  it("sends active-recipient email without private case content", async () => {
    const claimClient = clientWith({ rows: [item()], rowCount: 1 });
    const sentClient = clientWith({ rows: [], rowCount: 1 });
    mocks.withTransaction
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claimClient))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(sentClient));
    const send = vi.fn().mockResolvedValue({ status: "sent", provider: "resend", providerMessageId: "message-1" });

    await expect(dispatchPendingSupportNotifications({ workerId: "worker-a", send, logger })).resolves.toBe(1);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "recipient@example.test", idempotencyKey: "fractal-support-delivery-1" }));
    const email = send.mock.calls[0]?.[0];
    expect(email.text).toContain("https://app.fractal.test/help");
    expect(email.text).toContain("no case description");
    expect(sentClient.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["delivery-1", "worker-a", "resend", "message-1"]));
    expect(mocks.appendAudit).toHaveBeenCalledWith(sentClient, expect.objectContaining({ action: "support.notification.sent" }));
    expect(logger.info).toHaveBeenCalled();
  });

  it("cancels delivery for an inactive identity without calling the mail provider", async () => {
    const claimClient = clientWith({ rows: [item({ identity_status: "disabled" })], rowCount: 1 });
    const cancelledClient = clientWith({ rows: [], rowCount: 1 });
    mocks.withTransaction
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claimClient))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(cancelledClient));
    const send = vi.fn();
    await dispatchPendingSupportNotifications({ workerId: "worker-a", send, logger });
    expect(send).not.toHaveBeenCalled();
    expect(cancelledClient.query.mock.calls[0]?.[0]).toContain("status='cancelled'");
    expect(mocks.appendAudit).toHaveBeenCalledWith(cancelledClient, expect.objectContaining({ action: "support.notification.cancelled" }));
  });

  it("records retry and terminal delivery failures with capped backoff", async () => {
    const retryClaim = clientWith({ rows: [item({ attempts: 2 })], rowCount: 1 });
    const retryUpdate = clientWith({ rows: [], rowCount: 1 });
    mocks.withTransaction
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(retryClaim))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(retryUpdate));
    await dispatchPendingSupportNotifications({ workerId: "worker-a", send: async () => ({ status: "failed", error: "transport unavailable" }), logger });
    expect(retryUpdate.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([false]));
    expect(mocks.appendAudit).toHaveBeenCalledWith(retryUpdate, expect.objectContaining({ action: "support.notification.retry_scheduled" }));

    const terminalClaim = clientWith({ rows: [item({ attempts: 3 })], rowCount: 1 });
    const terminalUpdate = clientWith({ rows: [], rowCount: 1 });
    mocks.withTransaction
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(terminalClaim))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(terminalUpdate));
    await dispatchPendingSupportNotifications({ workerId: "worker-a", send: async () => { throw new Error("provider failed"); }, logger });
    expect(terminalUpdate.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([true]));
    expect(mocks.appendAudit).toHaveBeenLastCalledWith(terminalUpdate, expect.objectContaining({ action: "support.notification.terminal" }));
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("keeps running after a lost send claim and reports the delivery failure", async () => {
    const claimClient = clientWith({ rows: [item()], rowCount: 1 });
    const lostClaim = clientWith({ rows: [], rowCount: 0 });
    const retryClient = clientWith({ rows: [], rowCount: 1 });
    mocks.withTransaction
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claimClient))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(lostClaim))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(retryClient));
    await expect(dispatchPendingSupportNotifications({ workerId: "worker-a", send: async () => ({ status: "sent", provider: "resend", providerMessageId: "message-1" }), logger })).resolves.toBe(1);
    expect(retryClient.query.mock.calls[0]?.[0]).toContain("delivery_retry_scheduled");
  });

  it("starts one dispatcher loop and stops its timer", async () => {
    const claimClient = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(claimClient));
    const dispatcher = startSupportNotificationDispatcher({ send: async () => ({ status: "sent", provider: "resend", providerMessageId: "message-1" }), logger });
    await vi.advanceTimersByTimeAsync(60_000);
    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claimClient.query).toHaveBeenCalled();
  });
});
