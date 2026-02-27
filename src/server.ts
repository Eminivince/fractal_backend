import { buildApp } from "./app.js";
import { env } from "./config/env.js";
import { connectMongo, disconnectMongo } from "./db/mongo.js";
import { startAnchorWorker } from "./services/anchor-worker.js";
import { startNotificationWorker } from "./services/notification-worker.js";
import { startReconciliationWorker } from "./services/reconciliation.js";
import { startWorkOrderSlaWorker } from "./services/work-order-sla-worker.js";
import { startBlockchainWorker, stopBlockchainWorker } from "./workers/blockchain.worker.js";
import { startDocumentExpiryWorker } from "./workers/document-expiry.worker.js";
import { startKycReverificationWorker } from "./workers/kyc-reverification.worker.js";
import { startOfferingClosureWorker } from "./workers/offering-closure.worker.js";

async function start() {
  await connectMongo();
  const app = await buildApp();
  const anchorWorker = await startAnchorWorker(app.log);
  const reconciliationWorker = startReconciliationWorker(app.log);
  const notificationWorker = startNotificationWorker(app.log);
  const workOrderSlaWorker = startWorkOrderSlaWorker(app, app.log);

  const documentExpiryWorker = startDocumentExpiryWorker(app.log);
  const kycReverificationWorker = startKycReverificationWorker(app.log);
  const offeringClosureWorker = startOfferingClosureWorker(app.log);

  if (env.BLOCKCHAIN_WORKER_ENABLED) {
    startBlockchainWorker();
  }

  const close = async (signal: string) => {
    app.log.info(`Shutting down (${signal})`);
    anchorWorker.stop();
    reconciliationWorker.stop();
    notificationWorker.stop();
    workOrderSlaWorker.stop();
    documentExpiryWorker.stop();
    kycReverificationWorker.stop();
    offeringClosureWorker.stop();
    stopBlockchainWorker();
    await app.close();
    await disconnectMongo();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void close("SIGINT");
  });

  process.on("SIGTERM", () => {
    void close("SIGTERM");
  });

  await app.listen({
    port: env.PORT,
    host: "0.0.0.0",
  });

  void anchorWorker.triggerNow();
  void reconciliationWorker.triggerNow();
  void notificationWorker.triggerNow();
  void workOrderSlaWorker.triggerNow();

  app.log.info(`API listening on ${env.PORT}`);
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
