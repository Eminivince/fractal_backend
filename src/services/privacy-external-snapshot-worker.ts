import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import type { ExternalPrivacySourceKey } from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import {
  expireAndQueuePrivacyExternalSnapshotCleanup,
  materializeOnePrivacyExternalSnapshot,
} from "../platform/postgres-privacy-external-snapshots.js";

type Logger = {
  info: (value: unknown, message?: string) => void;
  error: (value: unknown, message?: string) => void;
};

export function resolvePrivacyExternalWorkerSourceKeys(input: {
  chainAdapterSha256?: string;
  resendAdapterSha256?: string;
  resendCollectionApiKey?: string;
  sumsubAdapterSha256?: string;
  sumsubAppToken?: string;
  sumsubSecretKey?: string;
}): ExternalPrivacySourceKey[] {
  const supportedSourceKeys: ExternalPrivacySourceKey[] = [];
  if (input.chainAdapterSha256) {
    supportedSourceKeys.push("external.chain.public_records");
  }
  if (input.resendAdapterSha256 && input.resendCollectionApiKey) {
    supportedSourceKeys.push("external.resend.delivery");
  }
  if (
    input.sumsubAdapterSha256
    && input.sumsubAppToken
    && input.sumsubSecretKey
  ) {
    supportedSourceKeys.push("external.identity_verification.provider");
  }
  return supportedSourceKeys;
}

export function startPrivacyExternalSnapshotWorker(input: { logger: Logger }) {
  const supportedSourceKeys = resolvePrivacyExternalWorkerSourceKeys({
    chainAdapterSha256: env.PRIVACY_CHAIN_ADAPTER_SHA256,
    resendAdapterSha256: env.PRIVACY_RESEND_ADAPTER_SHA256,
    resendCollectionApiKey: env.PRIVACY_RESEND_COLLECTION_API_KEY,
    sumsubAdapterSha256: env.PRIVACY_SUMSUB_ADAPTER_SHA256,
    sumsubAppToken: env.SUMSUB_PRIVACY_APP_TOKEN,
    sumsubSecretKey: env.SUMSUB_PRIVACY_SECRET_KEY,
  });
  if (!supportedSourceKeys.length) {
    throw new Error("At least one complete external privacy adapter configuration is required for the collection worker.");
  }
  const resendApiKey = env.PRIVACY_RESEND_COLLECTION_API_KEY;
  const workerId = `privacy-external-${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let running = false;

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const lifecycle = await expireAndQueuePrivacyExternalSnapshotCleanup(
        new Date(),
        env.PRIVACY_EXTERNAL_COLLECTION_WORKER_BATCH_SIZE,
      );
      let materialized = 0;
      while (
        materialized < env.PRIVACY_EXTERNAL_COLLECTION_WORKER_BATCH_SIZE
        && await materializeOnePrivacyExternalSnapshot({
          workerId,
          resendApiKey,
          sumsubAppToken: env.SUMSUB_PRIVACY_APP_TOKEN,
          sumsubSecretKey: env.SUMSUB_PRIVACY_SECRET_KEY,
          supportedSourceKeys,
          logger: input.logger,
        })
      ) {
        materialized += 1;
      }
      if (materialized > 0 || lifecycle.expired > 0 || lifecycle.cleanupQueued > 0) {
        input.logger.info(
          { workerId, materialized, ...lifecycle },
          "External privacy snapshot lifecycle batch completed",
        );
      }
    } catch (error) {
      input.logger.error({ err: error, workerId }, "External privacy snapshot worker polling failed");
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void run(), env.PRIVACY_EXTERNAL_COLLECTION_WORKER_INTERVAL_MS);
  timer.unref();
  void run();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
