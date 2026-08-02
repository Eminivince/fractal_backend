import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PaystackInboxPayloadError = vi.hoisted(() => class PaystackInboxPayloadError extends Error {});
const SumsubInboxPayloadError = vi.hoisted(() => class SumsubInboxPayloadError extends Error {});

const mocks = vi.hoisted(() => ({
  allocationChain: vi.fn(), anchor: vi.fn(), authEmail: vi.fn(), blockchainStart: vi.fn(), blockchainStop: vi.fn(), buildApp: vi.fn(), closeQueues: vi.fn(), configuration: vi.fn(),
  connectMongo: vi.fn(), connectPostgres: vi.fn(), connectRedis: vi.fn(), distributionPayouts: vi.fn(), documentExpiry: vi.fn(),
  disconnectMongo: vi.fn(), disconnectPostgres: vi.fn(), disconnectRedis: vi.fn(), getRedis: vi.fn(), identityVerification: vi.fn(), inbox: vi.fn(),
  invitationDelivery: vi.fn(), kyc: vi.fn(), lease: vi.fn(), notificationQueue: vi.fn(), notificationWorker: vi.fn(), offeringChain: vi.fn(), offeringClosure: vi.fn(),
  outbox: vi.fn(), paymentExpiry: vi.fn(), paymentInstruction: vi.fn(), paymentQueue: vi.fn(), paymentVerification: vi.fn(), platformContent: vi.fn(), privacyExternal: vi.fn(), privacyPackage: vi.fn(),
  processPaystack: vi.fn(), processSumsub: vi.fn(), professionalPayout: vi.fn(), professionalReconciliation: vi.fn(), reconciliation: vi.fn(), sanctions: vi.fn(), storageCleanup: vi.fn(),
  supportCase: vi.fn(), supportNotifications: vi.fn(), transferSettlement: vi.fn(), workOrderSla: vi.fn(),
  env: {
    NODE_ENV: "development", WORKER_LEASE_KEY: "fractal:test-worker", WORKER_LEASE_TTL_MS: 30_000,
    OUTBOX_DISPATCH_ENABLED: true, PAYSTACK_ENABLED: true, PAYSTACK_INBOX_ENABLED: true, SUMSUB_ENABLED: true, SUMSUB_INBOX_ENABLED: true,
    CHAIN_DEPLOYMENT_EXECUTOR_ENABLED: true, ALLOCATION_CHAIN_EXECUTOR_ENABLED: true, PRIVACY_PACKAGE_WORKER_ENABLED: true,
    PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED: true, AUTH_EMAIL_DELIVERY_ENABLED: true, BLOCKCHAIN_WORKER_ENABLED: true, LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED: true,
  },
  app: { close: vi.fn(), log: { info: vi.fn(), warn: vi.fn() } },
  handles: {
    allocationChain: { stop: vi.fn() }, anchor: { stop: vi.fn() }, authEmail: { stop: vi.fn() }, configuration: { stop: vi.fn() }, distributionPayouts: { stop: vi.fn() },
    documentExpiry: { stop: vi.fn() }, identityVerification: { stop: vi.fn() }, inbox: { stop: vi.fn() }, invitationDelivery: { stop: vi.fn() }, kyc: { stop: vi.fn() },
    notificationQueue: { stop: vi.fn() }, notificationWorker: { stop: vi.fn() }, offeringChain: { stop: vi.fn() }, offeringClosure: { stop: vi.fn() }, outbox: { stop: vi.fn() },
    paymentExpiry: { stop: vi.fn() }, paymentInstruction: { stop: vi.fn() }, paymentQueue: { stop: vi.fn() }, paymentVerification: { stop: vi.fn() }, platformContent: { stop: vi.fn() },
    privacyExternal: { stop: vi.fn() }, privacyPackage: { stop: vi.fn() }, professionalPayout: { stop: vi.fn() }, professionalReconciliation: { stop: vi.fn() }, reconciliation: { stop: vi.fn() },
    sanctions: { stop: vi.fn() }, storageCleanup: { stop: vi.fn() }, supportCase: { stop: vi.fn() }, supportNotifications: { stop: vi.fn() }, transferSettlement: { stop: vi.fn() }, workOrderSla: { stop: vi.fn() },
  },
  release: vi.fn(),
}));

vi.mock("../app.js", () => ({ buildApp: mocks.buildApp }));
vi.mock("../config/env.js", () => ({ env: mocks.env }));
vi.mock("../db/mongo.js", () => ({ connectMongo: mocks.connectMongo, disconnectMongo: mocks.disconnectMongo }));
vi.mock("../db/postgres.js", () => ({ connectPostgres: mocks.connectPostgres, disconnectPostgres: mocks.disconnectPostgres }));
vi.mock("../db/redis.js", () => ({ connectRedis: mocks.connectRedis, disconnectRedis: mocks.disconnectRedis, getRedis: mocks.getRedis }));
vi.mock("../services/queue.js", () => ({ closeAllQueues: mocks.closeQueues }));
vi.mock("../services/anchor-worker.js", () => ({ startAnchorWorker: mocks.anchor }));
vi.mock("../services/notification-worker.js", () => ({ startNotificationWorker: mocks.notificationWorker }));
vi.mock("../services/reconciliation.js", () => ({ startReconciliationWorker: mocks.reconciliation }));
vi.mock("../services/worker-lease.js", () => ({ acquireWorkerLease: mocks.lease }));
vi.mock("../services/work-order-sla-worker.js", () => ({ startWorkOrderSlaWorker: mocks.workOrderSla }));
vi.mock("../services/postgres-outbox-dispatcher.js", () => ({ startPostgresOutboxDispatcher: mocks.outbox }));
vi.mock("../services/postgres-inbox-dispatcher.js", () => ({ startPostgresInboxDispatcher: mocks.inbox }));
vi.mock("../services/payment-instruction-dispatcher.js", () => ({ startPaymentProviderInstructionDispatcher: mocks.paymentInstruction }));
vi.mock("../services/identity-verification-application-dispatcher.js", () => ({ startIdentityVerificationApplicationDispatcher: mocks.identityVerification }));
vi.mock("../services/payment-expiry-worker.js", () => ({ startPaymentExpiryWorker: mocks.paymentExpiry }));
vi.mock("../services/professional-payout-dispatcher.js", () => ({ startProfessionalPayoutDispatcher: mocks.professionalPayout }));
vi.mock("../services/professional-payout-reconciliation.js", () => ({ startProfessionalPayoutReconciliationWorker: mocks.professionalReconciliation }));
vi.mock("../services/distribution-payout-worker.js", () => ({ startDistributionPayoutWorkers: mocks.distributionPayouts }));
vi.mock("../services/postgres-offering-chain-executor.js", () => ({ startOfferingChainDeploymentExecutor: mocks.offeringChain }));
vi.mock("../services/postgres-allocation-chain-executor.js", () => ({ startAllocationChainExecutor: mocks.allocationChain }));
vi.mock("../services/postgres-storage-cleanup-worker.js", () => ({ startPostgresStorageCleanupWorker: mocks.storageCleanup }));
vi.mock("../services/privacy-package-worker.js", () => ({ startPrivacyPackageWorker: mocks.privacyPackage }));
vi.mock("../services/privacy-external-snapshot-worker.js", () => ({ startPrivacyExternalSnapshotWorker: mocks.privacyExternal }));
vi.mock("../services/platform-configuration-activation-worker.js", () => ({ startPlatformConfigurationActivationWorker: mocks.configuration }));
vi.mock("../services/platform-content-publication-worker.js", () => ({ startPlatformContentPublicationWorker: mocks.platformContent }));
vi.mock("../services/support-case-service-worker.js", () => ({ startSupportCaseServiceWorker: mocks.supportCase }));
vi.mock("../platform/postgres-support-notifications.js", () => ({ startSupportNotificationDispatcher: mocks.supportNotifications }));
vi.mock("../services/email.js", () => ({ sendEmailWithFallback: vi.fn() }));
vi.mock("../services/security-event-projection.js", () => ({ projectSecurityEvent: vi.fn(), securityEventTypes: ["security.event"] }));
vi.mock("../platform/postgres-auth-email-deliveries.js", () => ({ startAuthEmailDeliveryDispatcher: mocks.authEmail }));
vi.mock("../platform/tenant-invitations.js", () => ({ startOrganizationInvitationDeliveryDispatcher: mocks.invitationDelivery }));
vi.mock("../platform/postgres-payment-instructions.js", () => ({ projectPaymentIntentCreated: vi.fn() }));
vi.mock("../modules/webhooks/routes/paystack-webhook.routes.js", () => ({ PaystackInboxPayloadError, processPaystackInboxEvent: mocks.processPaystack }));
vi.mock("../modules/webhooks/routes/sumsub-webhook.routes.js", () => ({ SumsubInboxPayloadError, processSumsubInboxEvent: mocks.processSumsub }));
vi.mock("../workers/blockchain.worker.js", () => ({ startBlockchainWorker: mocks.blockchainStart, stopBlockchainWorker: mocks.blockchainStop }));
vi.mock("../workers/document-expiry.worker.js", () => ({ startDocumentExpiryWorker: mocks.documentExpiry }));
vi.mock("../workers/kyc-reverification.worker.js", () => ({ startKycReverificationWorker: mocks.kyc }));
vi.mock("../workers/sanctions-rescreening.worker.js", () => ({ startSanctionsRescreeningWorker: mocks.sanctions }));
vi.mock("../workers/offering-closure.worker.js", () => ({ startOfferingClosureWorker: mocks.offeringClosure }));
vi.mock("../workers/payment-verification.worker.js", () => ({ startPaymentVerificationWorker: mocks.paymentVerification }));
vi.mock("../workers/transfer-settlement.worker.js", () => ({ startTransferSettlementWorker: mocks.transferSettlement }));
vi.mock("../workers/queues/notification.queue.js", () => ({ startNotificationQueue: mocks.notificationQueue }));
vi.mock("../workers/queues/payment-verification.queue.js", () => ({ startPaymentVerificationQueue: mocks.paymentQueue }));

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("worker runtime", () => {
  const signalHandlers: Record<string, () => void> = {};
  let processOnSpy: any;
  let exitSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    for (const handle of Object.values(mocks.handles)) handle.stop.mockReset();
    Object.assign(mocks.env, {
      NODE_ENV: "development", OUTBOX_DISPATCH_ENABLED: true, PAYSTACK_ENABLED: true, PAYSTACK_INBOX_ENABLED: true, SUMSUB_ENABLED: true, SUMSUB_INBOX_ENABLED: true,
      CHAIN_DEPLOYMENT_EXECUTOR_ENABLED: true, ALLOCATION_CHAIN_EXECUTOR_ENABLED: true, PRIVACY_PACKAGE_WORKER_ENABLED: true, PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED: true,
      AUTH_EMAIL_DELIVERY_ENABLED: true, BLOCKCHAIN_WORKER_ENABLED: true, LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED: true,
    });
    mocks.app.close.mockReset(); mocks.app.close.mockResolvedValue(undefined); mocks.app.log.info.mockReset(); mocks.app.log.warn.mockReset();
    mocks.connectMongo.mockResolvedValue(undefined); mocks.connectRedis.mockResolvedValue(undefined); mocks.connectPostgres.mockResolvedValue(undefined);
    mocks.disconnectMongo.mockResolvedValue(undefined); mocks.disconnectRedis.mockResolvedValue(undefined); mocks.disconnectPostgres.mockResolvedValue(undefined);
    mocks.closeQueues.mockResolvedValue(undefined); mocks.buildApp.mockResolvedValue(mocks.app); mocks.getRedis.mockReturnValue({ id: "redis" }); mocks.release.mockResolvedValue(undefined);
    mocks.lease.mockResolvedValue({ release: mocks.release });
    for (const [name, handle] of Object.entries(mocks.handles)) (mocks as Record<string, any>)[name]?.mockReturnValue(handle);
    mocks.outbox.mockReturnValue(mocks.handles.outbox); mocks.inbox.mockReturnValue(mocks.handles.inbox);
    mocks.processPaystack.mockResolvedValue(undefined); mocks.processSumsub.mockResolvedValue(undefined); mocks.blockchainStop.mockResolvedValue(undefined);
    for (const key of Object.keys(signalHandlers)) delete signalHandlers[key];
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: () => void) => { signalHandlers[String(event)] = listener; return process; }) as never);
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => { processOnSpy.mockRestore(); exitSpy.mockRestore(); consoleErrorSpy.mockRestore(); });

  it("starts every enabled worker once and releases the lease during shutdown", async () => {
    await import("../worker.js");
    await flushAsyncWork();

    expect(mocks.lease).toHaveBeenCalledWith(expect.objectContaining({ key: "fractal:test-worker", ttlMs: 30_000 }));
    expect(mocks.anchor).toHaveBeenCalledWith(mocks.app.log);
    expect(mocks.blockchainStart).toHaveBeenCalledOnce();
    expect(mocks.inbox).toHaveBeenCalledWith(expect.objectContaining({ providers: ["paystack", "sumsub"] }));
    expect(signalHandlers.SIGTERM).toBeTypeOf("function");

    signalHandlers.SIGTERM!();
    await flushAsyncWork();

    expect(mocks.handles.anchor.stop).toHaveBeenCalledOnce();
    expect(mocks.handles.inbox.stop).toHaveBeenCalledOnce();
    expect(mocks.handles.storageCleanup.stop).toHaveBeenCalledOnce();
    expect(mocks.blockchainStop).toHaveBeenCalledOnce();
    expect(mocks.closeQueues).toHaveBeenCalledOnce();
    expect(mocks.release).toHaveBeenCalledOnce();
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("processes valid provider inbox events and makes malformed payloads terminal", async () => {
    await import("../worker.js");
    await flushAsyncWork();
    const options = mocks.inbox.mock.calls[0]![0];

    await options.process({ provider: "paystack", externalEventId: "event-1", receivedAt: new Date("2026-01-01"), payload: { eventType: "charge.success", data: { reference: "payment-1" } } });
    await options.process({ provider: "sumsub", externalEventId: "event-2", receivedAt: new Date("2026-01-01"), payload: { event: { type: "applicantReviewed" }, rawBody: "{}", signature: "signed" } });

    expect(mocks.processPaystack).toHaveBeenCalledWith(mocks.app, "charge.success", { reference: "payment-1" }, "event-1", expect.any(Date));
    expect(mocks.processSumsub).toHaveBeenCalledWith(expect.objectContaining({ app: mocks.app, externalEventId: "event-2", signature: "signed" }));
    await expect(options.process({ provider: "paystack", externalEventId: "bad", receivedAt: new Date(), payload: {} })).rejects.toBeInstanceOf(PaystackInboxPayloadError);
    await expect(options.process({ provider: "sumsub", externalEventId: "bad", receivedAt: new Date(), payload: {} })).rejects.toBeInstanceOf(SumsubInboxPayloadError);
    await expect(options.process({ provider: "unknown", externalEventId: "bad", receivedAt: new Date(), payload: {} })).rejects.toThrow("Unsupported inbox provider");
    expect(options.isTerminalError(new PaystackInboxPayloadError("bad"))).toBe(true);
    expect(options.isTerminalError(new SumsubInboxPayloadError("bad"))).toBe(true);
    expect(options.isTerminalError(new Error("retry"))).toBe(false);
  });

  it("uses direct polling fallbacks when Redis becomes unavailable after leasing", async () => {
    mocks.getRedis.mockReturnValueOnce({ id: "redis" }).mockReturnValue(undefined);
    Object.assign(mocks.env, {
      OUTBOX_DISPATCH_ENABLED: false, PAYSTACK_ENABLED: false, PAYSTACK_INBOX_ENABLED: false, SUMSUB_ENABLED: false, SUMSUB_INBOX_ENABLED: false,
      CHAIN_DEPLOYMENT_EXECUTOR_ENABLED: false, ALLOCATION_CHAIN_EXECUTOR_ENABLED: false, PRIVACY_PACKAGE_WORKER_ENABLED: false,
      PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED: false, AUTH_EMAIL_DELIVERY_ENABLED: false, BLOCKCHAIN_WORKER_ENABLED: false,
    });

    await import("../worker.js");
    await flushAsyncWork();

    expect(mocks.notificationWorker).toHaveBeenCalledWith(mocks.app.log);
    expect(mocks.paymentVerification).toHaveBeenCalledWith(mocks.app.log);
    expect(mocks.inbox).not.toHaveBeenCalled();
    expect(mocks.blockchainStart).not.toHaveBeenCalled();
    expect(mocks.supportNotifications).not.toHaveBeenCalled();
  });

  it("disables legacy MongoDB automation in production", async () => {
    mocks.env.NODE_ENV = "production";
    Object.assign(mocks.env, { PAYSTACK_ENABLED: false, SUMSUB_ENABLED: false, OUTBOX_DISPATCH_ENABLED: false, AUTH_EMAIL_DELIVERY_ENABLED: false, BLOCKCHAIN_WORKER_ENABLED: false });

    await import("../worker.js");
    await flushAsyncWork();

    expect(mocks.reconciliation).not.toHaveBeenCalled();
    expect(mocks.notificationQueue).not.toHaveBeenCalled();
    expect(mocks.workOrderSla).not.toHaveBeenCalled();
    expect(mocks.app.log.warn).toHaveBeenCalledWith(expect.objectContaining({ worker: "reconciliation" }), expect.stringContaining("disabled in production"));
  });

  it("reports a failed dependency connection and exits without starting workers", async () => {
    const failure = new Error("Redis unavailable");
    mocks.connectRedis.mockRejectedValueOnce(failure);

    await import("../worker.js");
    await flushAsyncWork();

    expect(consoleErrorSpy).toHaveBeenCalledWith(failure);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.buildApp).not.toHaveBeenCalled();
  });

  it("fails closed when Redis cannot provide a lease client", async () => {
    mocks.getRedis.mockReturnValue(null);

    await import("../worker.js");
    await flushAsyncWork();

    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.objectContaining({ message: "Redis is required for the worker runtime" }));
    expect(mocks.lease).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
