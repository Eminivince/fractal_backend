import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { connectPostgres, disconnectPostgres } from "./db/postgres.js";
import { connectRedis, disconnectRedis, getRedis } from "./db/redis.js";
import { closeAllQueues } from "./services/queue.js";
import { startAnchorWorker } from "./services/anchor-worker.js";
import { startNotificationWorker } from "./services/notification-worker.js";
import { startReconciliationWorker } from "./services/reconciliation.js";
import { acquireWorkerLease } from "./services/worker-lease.js";
import { startWorkOrderSlaWorker } from "./services/work-order-sla-worker.js";
import { startPostgresOutboxDispatcher } from "./services/postgres-outbox-dispatcher.js";
import { startPostgresInboxDispatcher } from "./services/postgres-inbox-dispatcher.js";
import { startPaymentProviderInstructionDispatcher } from "./services/payment-instruction-dispatcher.js";
import { startIdentityVerificationApplicationDispatcher } from "./services/identity-verification-application-dispatcher.js";
import { startPaymentExpiryWorker } from "./services/payment-expiry-worker.js";
import { startProfessionalPayoutDispatcher } from "./services/professional-payout-dispatcher.js";
import { startProfessionalPayoutReconciliationWorker } from "./services/professional-payout-reconciliation.js";
import { startDistributionPayoutWorkers } from "./services/distribution-payout-worker.js";
import { startOfferingChainDeploymentExecutor } from "./services/postgres-offering-chain-executor.js";
import { startAllocationChainExecutor } from "./services/postgres-allocation-chain-executor.js";
import { startPostgresStorageCleanupWorker } from "./services/postgres-storage-cleanup-worker.js";
import { startPrivacyPackageWorker } from "./services/privacy-package-worker.js";
import { startPrivacyExternalSnapshotWorker } from "./services/privacy-external-snapshot-worker.js";
import { startPlatformConfigurationActivationWorker } from "./services/platform-configuration-activation-worker.js";
import { startPlatformContentPublicationWorker } from "./services/platform-content-publication-worker.js";
import { startSupportCaseServiceWorker } from "./services/support-case-service-worker.js";
import { startSupportNotificationDispatcher } from "./platform/postgres-support-notifications.js";
import { sendEmailWithFallback } from "./services/email.js";
import { projectSecurityEvent, securityEventTypes } from "./services/security-event-projection.js";
import { startAuthEmailDeliveryDispatcher } from "./platform/postgres-auth-email-deliveries.js";
import { startOrganizationInvitationDeliveryDispatcher } from "./platform/tenant-invitations.js";
import { projectPaymentIntentCreated } from "./platform/postgres-payment-instructions.js";
import { PaystackInboxPayloadError, processPaystackInboxEvent } from "./modules/webhooks/routes/paystack-webhook.routes.js";
import { SumsubInboxPayloadError, processSumsubInboxEvent } from "./modules/webhooks/routes/sumsub-webhook.routes.js";
import { startBlockchainWorker, stopBlockchainWorker } from "./workers/blockchain.worker.js";
import { startDocumentExpiryWorker } from "./workers/document-expiry.worker.js";
import { startKycReverificationWorker } from "./workers/kyc-reverification.worker.js";
import { startSanctionsRescreeningWorker } from "./workers/sanctions-rescreening.worker.js";
import { startOfferingClosureWorker } from "./workers/offering-closure.worker.js";
import { startPaymentVerificationWorker } from "./workers/payment-verification.worker.js";
import { startTransferSettlementWorker } from "./workers/transfer-settlement.worker.js";
import { startNotificationQueue } from "./workers/queues/notification.queue.js";
import { startPaymentVerificationQueue } from "./workers/queues/payment-verification.queue.js";

/**
 * Worker-only runtime. It is intentionally a separate process from the HTTP
 * API so scaling web traffic cannot duplicate scheduled or provider work.
 */
async function start() {
  await connectMongo();
  await connectRedis();
  await connectPostgres();

  const redis = getRedis();
  if (!redis) throw new Error("Redis is required for the worker runtime");

  let close: ((signal: string) => Promise<void>) | undefined;
  const lease = await acquireWorkerLease({
    redis,
    key: env.WORKER_LEASE_KEY,
    ttlMs: env.WORKER_LEASE_TTL_MS,
    onLost: () => {
      console.error("Worker runtime lost its Redis lease; shutting down to avoid duplicate work");
      void close?.("lease-lost");
    },
  });

  // Temporary composition bridge: the SLA worker injects its internal command.
  // It is not exposed on a port in this process and will be replaced by a domain
  // use case when the platform kernel introduces dependency injection.
  const app = await buildApp();
  // The production HTTP boundary already rejects legacy Mongo capability
  // routes. Do not let background intervals mutate that retired authority
  // behind the boundary. Their replacement jobs must be PostgreSQL-backed,
  // durable, and independently proved before they are enabled in production.
  const legacyMongoAutomationEnabled = env.NODE_ENV !== "production";
  const disabledLegacyWorker = (name: string) => {
    app.log.warn({ worker: name }, "Legacy MongoDB polling automation is disabled in production");
    return { stop: () => undefined };
  };
  const anchorWorker = await startAnchorWorker(app.log);
  const reconciliationWorker = legacyMongoAutomationEnabled
    ? startReconciliationWorker(app.log)
    : disabledLegacyWorker("reconciliation");
  const notificationWorker = legacyMongoAutomationEnabled
    ? getRedis()
      ? startNotificationQueue(app.log)
      : startNotificationWorker(app.log)
    : disabledLegacyWorker("notification delivery");
  const workOrderSlaWorker = legacyMongoAutomationEnabled
    ? startWorkOrderSlaWorker(app, app.log)
    : disabledLegacyWorker("work-order SLA");
  const documentExpiryWorker = legacyMongoAutomationEnabled
    ? startDocumentExpiryWorker(app.log)
    : disabledLegacyWorker("document expiry");
  const kycReverificationWorker = legacyMongoAutomationEnabled
    ? startKycReverificationWorker(app.log)
    : disabledLegacyWorker("KYC reverification");
  const sanctionsRescreeningWorker = legacyMongoAutomationEnabled
    ? startSanctionsRescreeningWorker(app.log)
    : disabledLegacyWorker("sanctions rescreening");
  const offeringClosureWorker = legacyMongoAutomationEnabled
    ? startOfferingClosureWorker(app.log)
    : disabledLegacyWorker("offering closure");
  const paymentVerificationWorker = legacyMongoAutomationEnabled
    ? getRedis()
      ? startPaymentVerificationQueue(app.log)
      : startPaymentVerificationWorker(app.log)
    : disabledLegacyWorker("payment verification");
  const transferSettlementWorker = legacyMongoAutomationEnabled
    ? startTransferSettlementWorker(app.log)
    : disabledLegacyWorker("transfer settlement");
  const outboxDispatcher = env.OUTBOX_DISPATCH_ENABLED
    ? startPostgresOutboxDispatcher({
        eventTypes: securityEventTypes,
        project: projectSecurityEvent,
        logger: app.log,
      })
    : undefined;
  const providerInboxDispatcher = (env.PAYSTACK_ENABLED && env.PAYSTACK_INBOX_ENABLED) || (env.SUMSUB_ENABLED && env.SUMSUB_INBOX_ENABLED)
    ? startPostgresInboxDispatcher({
        providers: [
          ...(env.PAYSTACK_ENABLED && env.PAYSTACK_INBOX_ENABLED ? ["paystack"] : []),
          ...(env.SUMSUB_ENABLED && env.SUMSUB_INBOX_ENABLED ? ["sumsub"] : []),
        ],
        process: async (event) => {
          if (event.provider === "paystack") {
            const payload = event.payload as { eventType?: unknown; data?: unknown };
            if (typeof payload.eventType !== "string" || !payload.data || typeof payload.data !== "object" || Array.isArray(payload.data)) {
              throw new PaystackInboxPayloadError("Stored Paystack inbox payload is malformed");
            }
            await processPaystackInboxEvent(app, payload.eventType, payload.data as Record<string, unknown>, event.externalEventId, event.receivedAt);
            return;
          }
          if (event.provider === "sumsub") {
            const payload = event.payload as { event?: unknown; rawBody?: unknown; signature?: unknown };
            if (!payload.event || typeof payload.event !== "object" || Array.isArray(payload.event) || typeof payload.rawBody !== "string" || typeof payload.signature !== "string") {
              throw new SumsubInboxPayloadError("Stored Sumsub inbox payload is malformed");
            }
            await processSumsubInboxEvent({ app, payload: payload.event, externalEventId: event.externalEventId, rawBody: payload.rawBody, signature: payload.signature, receivedAt: event.receivedAt });
            return;
          }
          throw new Error(`Unsupported inbox provider: ${event.provider}`);
        },
        isTerminalError: (error) => error instanceof PaystackInboxPayloadError || error instanceof SumsubInboxPayloadError,
        logger: app.log,
      })
    : undefined;
  const paymentOutboxDispatcher = env.PAYSTACK_ENABLED
    ? startPostgresOutboxDispatcher({
        eventTypes: ["payment.intent.created"],
        project: projectPaymentIntentCreated,
        logger: app.log,
      })
    : undefined;
  const paymentInstructionDispatcher = env.PAYSTACK_ENABLED
    ? startPaymentProviderInstructionDispatcher({ logger: app.log })
    : undefined;
  const identityVerificationApplicationDispatcher = env.SUMSUB_ENABLED
    ? startIdentityVerificationApplicationDispatcher({ logger: app.log })
    : undefined;
  const paymentExpiryWorker = startPaymentExpiryWorker(app.log);
  const professionalPayoutDispatcher = env.PAYSTACK_ENABLED ? startProfessionalPayoutDispatcher({ logger: app.log }) : undefined;
  const professionalPayoutReconciliationWorker = env.PAYSTACK_ENABLED ? startProfessionalPayoutReconciliationWorker({ logger: app.log }) : undefined;
  const distributionPayoutWorkers = env.PAYSTACK_ENABLED ? startDistributionPayoutWorkers({ logger: app.log }) : undefined;
  const offeringChainDeploymentExecutor = env.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED
    ? startOfferingChainDeploymentExecutor({ logger: app.log })
    : undefined;
  const allocationChainExecutor = env.ALLOCATION_CHAIN_EXECUTOR_ENABLED
    ? startAllocationChainExecutor({ logger: app.log })
    : undefined;
  const storageCleanupWorker = startPostgresStorageCleanupWorker({ logger: app.log });
  const privacyPackageWorker = env.PRIVACY_PACKAGE_WORKER_ENABLED ? startPrivacyPackageWorker({logger:app.log}) : undefined;
  const privacyExternalSnapshotWorker = env.PRIVACY_EXTERNAL_COLLECTION_WORKER_ENABLED
    ? startPrivacyExternalSnapshotWorker({ logger: app.log })
    : undefined;
  const platformConfigurationActivationWorker = startPlatformConfigurationActivationWorker({ logger: app.log });
  const platformContentPublicationWorker = startPlatformContentPublicationWorker({ logger: app.log });
  const supportCaseServiceWorker = startSupportCaseServiceWorker({ logger: app.log });
  const supportNotificationDispatcher = env.AUTH_EMAIL_DELIVERY_ENABLED
    ? startSupportNotificationDispatcher({ send: sendEmailWithFallback, logger: app.log })
    : undefined;
  const authEmailDeliveryDispatcher = env.AUTH_EMAIL_DELIVERY_ENABLED
    ? startAuthEmailDeliveryDispatcher({ send: sendEmailWithFallback, logger: app.log })
    : undefined;
  const organizationInvitationDeliveryDispatcher = env.AUTH_EMAIL_DELIVERY_ENABLED
    ? startOrganizationInvitationDeliveryDispatcher({ send: sendEmailWithFallback, logger: app.log })
    : undefined;

  if (env.BLOCKCHAIN_WORKER_ENABLED && env.LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED) startBlockchainWorker();

  close = async (signal: string) => {
    app.log.info(`Worker shutting down (${signal})`);
    anchorWorker.stop();
    reconciliationWorker.stop();
    notificationWorker.stop();
    workOrderSlaWorker.stop();
    documentExpiryWorker.stop();
    kycReverificationWorker.stop();
    sanctionsRescreeningWorker.stop();
    offeringClosureWorker.stop();
    paymentVerificationWorker.stop();
    transferSettlementWorker.stop();
    outboxDispatcher?.stop();
    providerInboxDispatcher?.stop();
    paymentOutboxDispatcher?.stop();
    paymentInstructionDispatcher?.stop();
    identityVerificationApplicationDispatcher?.stop();
    paymentExpiryWorker.stop();
    professionalPayoutDispatcher?.stop();
    professionalPayoutReconciliationWorker?.stop();
    distributionPayoutWorkers?.stop();
    offeringChainDeploymentExecutor?.stop();
    allocationChainExecutor?.stop();
    storageCleanupWorker.stop();
    privacyPackageWorker?.stop();
    privacyExternalSnapshotWorker?.stop();
    platformConfigurationActivationWorker.stop();
    platformContentPublicationWorker.stop();
    supportCaseServiceWorker.stop();
    supportNotificationDispatcher?.stop();
    authEmailDeliveryDispatcher?.stop();
    organizationInvitationDeliveryDispatcher?.stop();
    stopBlockchainWorker();
    await closeAllQueues();
    await app.close();
    await lease.release();
    await disconnectRedis();
    await disconnectPostgres();
    await disconnectMongo();
    process.exit(0);
  };

  process.on("SIGINT", () => void close("SIGINT"));
  process.on("SIGTERM", () => void close("SIGTERM"));
  app.log.info("Fractal worker runtime started");
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
