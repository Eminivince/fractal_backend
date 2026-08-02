import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { expireAndQueuePrivacyPackageCleanup, materializeOnePrivacyPackage } from "../platform/postgres-privacy-package-deliveries.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

export function startPrivacyPackageWorker(input: { logger: Logger }) {
  const workerId = `privacy-package-${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const lifecycle = await expireAndQueuePrivacyPackageCleanup(new Date(), env.PRIVACY_PACKAGE_WORKER_BATCH_SIZE);
      let materialized = 0;
      while (materialized < env.PRIVACY_PACKAGE_WORKER_BATCH_SIZE
        && await materializeOnePrivacyPackage({ workerId })) materialized += 1;
      if (materialized > 0 || lifecycle.expired > 0 || lifecycle.cleanupQueued > 0) {
        input.logger.info({ workerId, materialized, ...lifecycle }, "Privacy package lifecycle batch completed");
      }
    } catch (error) {
      input.logger.error({ err: error, workerId }, "Privacy package worker polling failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), env.PRIVACY_PACKAGE_WORKER_INTERVAL_MS);
  timer.unref();
  void run();
  return { stop() { stopped = true; clearInterval(timer); } };
}
