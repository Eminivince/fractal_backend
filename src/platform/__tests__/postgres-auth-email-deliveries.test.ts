import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    APP_BASE_URL: "https://app.fractal.test/",
    EMAIL_DELIVERY_SECRET_KEY: "email-secret",
    JWT_SECRET: "jwt-secret",
    AUTH_EMAIL_DELIVERY_CLAIM_TIMEOUT_SECONDS: 60,
    AUTH_EMAIL_DELIVERY_BATCH_SIZE: 20,
    AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS: 3,
    AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS: 30,
    AUTH_EMAIL_DELIVERY_INTERVAL_MS: 60_000,
    AUTH_EMAIL_DELIVERY_HEALTH_LOG_INTERVAL_MS: 60_000,
    AUTH_EMAIL_DELIVERY_MAX_PENDING_AGE_SECONDS: 300,
  },
  requirePostgres: vi.fn(),
  withTransaction: vi.fn(),
  appendAudit: vi.fn(),
}));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.requirePostgres, withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));

import {
  AuthEmailDeliveryError,
  claimAuthEmailDeliveries,
  dispatchPendingAuthEmailDeliveries,
  enqueueAdministratorActivationDelivery,
  enqueueInitialEmailVerificationDelivery,
  getAuthEmailDeliveryHealth,
  requestAuthEmailDelivery,
  startAuthEmailDeliveryDispatcher,
} from "../postgres-auth-email-deliveries.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
function delivery(overrides: Record<string, unknown> = {}) {
  return { id: "delivery-1", identity_id: "identity-1", delivery_type: "email_verification", attempts: 1, requested_at: new Date(Date.now()), ...overrides };
}
const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-07-29T12:00:00.000Z"));
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.requirePostgres.mockReturnValue({ query: vi.fn() });
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
});
afterEach(() => vi.useRealTimers());

describe("auth email queue requests", () => {
  it("queues initial verification and sealed administrator activation deliveries", async () => {
    const client = clientWith({}, {});
    const verification = await enqueueInitialEmailVerificationDelivery(client as any, "identity-1");
    const activation = await enqueueAdministratorActivationDelivery(client as any, "identity-1");
    expect(verification).toEqual(expect.any(String));
    expect(activation).toEqual(expect.any(String));
    expect(client.query.mock.calls[0]?.[1]).toEqual([verification, "identity-1"]);
    expect(client.query.mock.calls[1]?.[1]).toEqual([activation, "identity-1"]);
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "identity.auth_email_delivery.requested" }));
    expect(mocks.appendAudit).toHaveBeenLastCalledWith(client, expect.objectContaining({ action: "identity.administrator_activation.requested", actorType: "operator" }));
  });

  it("does not disclose inactive or verified identities and validates public request input", async () => {
    await expect(requestAuthEmailDelivery({ identityId: " ", deliveryType: "email_verification" })).rejects.toBeInstanceOf(AuthEmailDeliveryError);
    const inactive = clientWith({ rows: [{ id: "identity-1", status: "disabled", email_verified_at: null }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(inactive));
    await expect(requestAuthEmailDelivery({ identityId: "identity-1", deliveryType: "password_reset" })).resolves.toEqual({ deliveryId: null, queued: false });
    const verified = clientWith({ rows: [{ id: "identity-1", status: "active", email_verified_at: new Date() }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(verified));
    await expect(requestAuthEmailDelivery({ identityId: "identity-1", deliveryType: "email_verification" })).resolves.toEqual({ deliveryId: null, queued: false });
  });

  it("reuses a recent request, requeues an old retry, and creates a new durable request", async () => {
    const identity = { id: "identity-1", status: "active", email_verified_at: null };
    const recent = clientWith({ rows: [identity], rowCount: 1 }, { rows: [{ id: "recent", status: "requested", requested_at: new Date(Date.now() - 30_000) }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(recent));
    await expect(requestAuthEmailDelivery({ identityId: "identity-1", deliveryType: "email_verification" })).resolves.toEqual({ deliveryId: "recent", queued: true });

    const requeue = clientWith({ rows: [identity], rowCount: 1 }, { rows: [{ id: "failed", status: "failed", requested_at: new Date(Date.now() - 61_000) }], rowCount: 1 }, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(requeue));
    await expect(requestAuthEmailDelivery({ identityId: "identity-1", deliveryType: "password_reset" })).resolves.toEqual({ deliveryId: "failed", queued: true });
    expect(mocks.appendAudit).toHaveBeenCalledWith(requeue, expect.objectContaining({ action: "identity.auth_email_delivery.requeued" }));

    const newRequest = clientWith({ rows: [identity], rowCount: 1 }, { rows: [{ id: "sent", status: "sent", requested_at: new Date(Date.now() - 61_000) }], rowCount: 1 }, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(newRequest));
    await expect(requestAuthEmailDelivery({ identityId: "identity-1", deliveryType: "password_reset" })).resolves.toMatchObject({ deliveryId: expect.any(String), queued: true });
    expect(newRequest.query.mock.calls[2]?.[0]).toContain("INSERT INTO fractal.auth_email_deliveries");
  });

  it("returns aggregate health without recipient data", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ pending_count: 2, terminal_count: 1, oldest_pending_age_seconds: 91 }], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(getAuthEmailDeliveryHealth({ identityId: " identity-1 " })).resolves.toEqual({ pendingCount: 2, terminalCount: 1, oldestPendingAgeSeconds: 91 });
    expect(query.mock.calls[0]?.[1]).toEqual(["identity-1"]);
  });

  it("claims valid queue records and rejects an invalid stored delivery type", async () => {
    await expect(claimAuthEmailDeliveries({ workerId: "worker-a", limit: 0, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    const client = clientWith({ rows: [delivery()], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(claimAuthEmailDeliveries({ workerId: "worker-a", limit: 1, claimTimeoutSeconds: 90 })).resolves.toEqual([expect.objectContaining({ deliveryType: "email_verification", identityId: "identity-1" })]);
    const invalid = clientWith({ rows: [delivery({ delivery_type: "unknown" })], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(invalid));
    await expect(claimAuthEmailDeliveries({ workerId: "worker-a", limit: 1, claimTimeoutSeconds: 90 })).rejects.toBeInstanceOf(AuthEmailDeliveryError);
  });
});

describe("auth email dispatch", () => {
  it("records a verification code before it sends the email", async () => {
    const claim = clientWith({ rows: [delivery()], rowCount: 1 });
    const sent = clientWith({ rows: [{ identity_id: "identity-1" }], rowCount: 1 });
    mocks.withTransaction
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claim))
      .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(sent));
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ email: "person@example.test", status: "active", email_verified_at: null }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });
    const send = vi.fn().mockResolvedValue({ status: "sent", provider: "resend", providerMessageId: "message-1" });

    await expect(dispatchPendingAuthEmailDeliveries({ workerId: "worker-a", send, logger })).resolves.toBe(1);
    expect(query.mock.calls[1]?.[0]).toContain("email_verification_token_hash");
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ subject: "Your Fractal verification code", text: expect.stringMatching(/\b\d{6}\b/) }));
    expect(mocks.appendAudit).toHaveBeenCalledWith(sent, expect.objectContaining({ action: "identity.auth_email_delivery.sent" }));
  });

  it("sends password-reset and administrator-activation links with their correct purpose", async () => {
    for (const [deliveryType, expectedSubject, expectedPurpose] of [
      ["password_reset", "Reset your Fractal password", "password_reset"],
      ["administrator_activation", "Activate your Fractal administrator account", "administrator_activation"],
    ] as const) {
      const claim = clientWith({ rows: [delivery({ delivery_type: deliveryType })], rowCount: 1 });
      const sent = clientWith({ rows: [{ identity_id: "identity-1" }], rowCount: 1 });
      mocks.withTransaction
        .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claim))
        .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(sent));
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ email: "person@example.test", status: "active", email_verified_at: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mocks.requirePostgres.mockReturnValue({ query });
      const send = vi.fn().mockResolvedValue({ status: "sent", provider: "resend", providerMessageId: "message-1" });
      await dispatchPendingAuthEmailDeliveries({ workerId: "worker-a", send, logger });
      expect(query.mock.calls[1]?.[1]?.[3]).toBe(expectedPurpose);
      expect(send.mock.calls[0]?.[0]).toMatchObject({ subject: expectedSubject, text: expect.stringContaining("/account/reset?token=") });
    }
  });

  it("cancels disabled, verified, expired, and unrecordable deliveries", async () => {
    for (const [item, identity, tokenResult] of [
      [delivery(), { email: "person@example.test", status: "disabled", email_verified_at: null }, undefined],
      [delivery(), { email: "person@example.test", status: "active", email_verified_at: new Date() }, undefined],
      [delivery({ requested_at: new Date(Date.now() - 700_000) }), { email: "person@example.test", status: "active", email_verified_at: null }, undefined],
      [delivery(), { email: "person@example.test", status: "active", email_verified_at: null }, { rows: [], rowCount: 0 }],
    ] as const) {
      const claim = clientWith({ rows: [item], rowCount: 1 });
      const cancelled = clientWith({ rows: [{ identity_id: "identity-1" }], rowCount: 1 });
      mocks.withTransaction
        .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claim))
        .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(cancelled));
      const query = vi.fn().mockResolvedValueOnce({ rows: [identity], rowCount: 1 });
      if (tokenResult) query.mockResolvedValueOnce(tokenResult);
      mocks.requirePostgres.mockReturnValue({ query });
      const send = vi.fn();
      await dispatchPendingAuthEmailDeliveries({ workerId: "worker-a", send, logger });
      expect(send).not.toHaveBeenCalled();
      expect(cancelled.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([true]));
    }
  });

  it("records retry and terminal failure when a transport rejects a delivery", async () => {
    for (const [attempts, expectedTerminal] of [[2, false], [3, true]] as const) {
      const claim = clientWith({ rows: [delivery({ attempts })], rowCount: 1 });
      const retry = clientWith({ rows: [{ identity_id: "identity-1" }], rowCount: 1 });
      mocks.withTransaction
        .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(claim))
        .mockImplementationOnce(async (work: (client: unknown) => Promise<unknown>) => work(retry));
      const query = vi.fn()
        .mockResolvedValueOnce({ rows: [{ email: "person@example.test", status: "active", email_verified_at: null }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 1 });
      mocks.requirePostgres.mockReturnValue({ query });
      await dispatchPendingAuthEmailDeliveries({ workerId: "worker-a", send: async () => ({ status: "failed", error: "provider unavailable" }), logger });
      expect(retry.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([expectedTerminal]));
      expect(mocks.appendAudit).toHaveBeenLastCalledWith(retry, expect.objectContaining({ action: expectedTerminal ? "identity.auth_email_delivery.terminal" : "identity.auth_email_delivery.retry_scheduled" }));
    }
  });

  it("starts the dispatcher, emits health alerts, and stops its timer", async () => {
    const claim = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(claim));
    const query = vi.fn().mockResolvedValue({ rows: [{ pending_count: 1, terminal_count: 1, oldest_pending_age_seconds: 400 }], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });
    const dispatcher = startAuthEmailDeliveryDispatcher({ send: async () => ({ status: "sent", provider: "resend", providerMessageId: "message-1" }), logger });
    await vi.advanceTimersByTimeAsync(60_000);
    dispatcher.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ terminalCount: 1 }), "Authentication email delivery requires operational attention");
  });
});
