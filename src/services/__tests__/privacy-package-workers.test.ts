import { beforeEach, describe, expect, it, vi } from "vitest";

const expirePackages = vi.hoisted(() => vi.fn());
const materializePackage = vi.hoisted(() => vi.fn());
const expireSnapshots = vi.hoisted(() => vi.fn());
const materializeSnapshot = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  PRIVACY_PACKAGE_WORKER_BATCH_SIZE: 2,
  PRIVACY_PACKAGE_WORKER_INTERVAL_MS: 1_000,
  PRIVACY_EXTERNAL_COLLECTION_WORKER_BATCH_SIZE: 2,
  PRIVACY_EXTERNAL_COLLECTION_WORKER_INTERVAL_MS: 1_000,
  PRIVACY_CHAIN_ADAPTER_SHA256: undefined as string | undefined,
  PRIVACY_RESEND_ADAPTER_SHA256: undefined as string | undefined,
  PRIVACY_RESEND_COLLECTION_API_KEY: undefined as string | undefined,
  PRIVACY_SUMSUB_ADAPTER_SHA256: undefined as string | undefined,
  SUMSUB_PRIVACY_APP_TOKEN: undefined as string | undefined,
  SUMSUB_PRIVACY_SECRET_KEY: undefined as string | undefined,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../platform/postgres-privacy-package-deliveries.js", () => ({
  expireAndQueuePrivacyPackageCleanup: expirePackages,
  materializeOnePrivacyPackage: materializePackage,
}));
vi.mock("../../platform/postgres-privacy-external-snapshots.js", () => ({
  expireAndQueuePrivacyExternalSnapshotCleanup: expireSnapshots,
  materializeOnePrivacyExternalSnapshot: materializeSnapshot,
}));

import { startPrivacyPackageWorker } from "../privacy-package-worker.js";
import {
  resolvePrivacyExternalWorkerSourceKeys,
  startPrivacyExternalSnapshotWorker,
} from "../privacy-external-snapshot-worker.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  expirePackages.mockResolvedValue({ expired: 0, cleanupQueued: 0 });
  materializePackage.mockResolvedValue(false);
  expireSnapshots.mockResolvedValue({ expired: 0, cleanupQueued: 0 });
  materializeSnapshot.mockResolvedValue(false);
  env.PRIVACY_CHAIN_ADAPTER_SHA256 = undefined;
  env.PRIVACY_RESEND_ADAPTER_SHA256 = undefined;
  env.PRIVACY_RESEND_COLLECTION_API_KEY = undefined;
  env.PRIVACY_SUMSUB_ADAPTER_SHA256 = undefined;
  env.SUMSUB_PRIVACY_APP_TOKEN = undefined;
  env.SUMSUB_PRIVACY_SECRET_KEY = undefined;
});

describe("privacy package worker", () => {
  it("materializes a bounded package batch and records the lifecycle outcome", async () => {
    vi.useFakeTimers();
    try {
      expirePackages.mockResolvedValue({ expired: 1, cleanupQueued: 2 });
      materializePackage.mockResolvedValueOnce(true).mockResolvedValueOnce(true);
      const worker = startPrivacyPackageWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();

      expect(expirePackages).toHaveBeenCalledWith(expect.any(Date), 2);
      expect(materializePackage).toHaveBeenCalledTimes(2);
      expect(materializePackage).toHaveBeenCalledWith({ workerId: expect.stringMatching(/^privacy-package-/) });
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ materialized: 2, expired: 1, cleanupQueued: 2 }),
        "Privacy package lifecycle batch completed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report an empty lifecycle batch", async () => {
    vi.useFakeTimers();
    try {
      const worker = startPrivacyPackageWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      expect(logger.info).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains errors and prevents duplicate work while a poll is pending", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((result: unknown) => void) | undefined;
      expirePackages.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("database unavailable"));
      const worker = startPrivacyPackageWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(expirePackages).toHaveBeenCalledOnce();
      finish?.({ expired: 0, cleanupQueued: 0 });
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error), workerId: expect.any(String) }), "Privacy package worker polling failed");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("external privacy snapshot worker", () => {
  it("resolves only source keys with complete configuration", () => {
    expect(resolvePrivacyExternalWorkerSourceKeys({
      chainAdapterSha256: "chain", resendAdapterSha256: "resend", resendCollectionApiKey: "key",
      sumsubAdapterSha256: "sumsub", sumsubAppToken: "token", sumsubSecretKey: "secret",
    })).toEqual([
      "external.chain.public_records",
      "external.resend.delivery",
      "external.identity_verification.provider",
    ]);
    expect(resolvePrivacyExternalWorkerSourceKeys({
      resendAdapterSha256: "resend", sumsubAdapterSha256: "sumsub", sumsubAppToken: "token",
    })).toEqual([]);
  });

  it("rejects startup when no complete external adapter is configured", () => {
    expect(() => startPrivacyExternalSnapshotWorker({ logger })).toThrow("At least one complete external privacy adapter configuration");
  });

  it("collects snapshots with complete adapter configuration and records material outcomes", async () => {
    vi.useFakeTimers();
    try {
      env.PRIVACY_CHAIN_ADAPTER_SHA256 = "chain";
      env.PRIVACY_RESEND_ADAPTER_SHA256 = "resend";
      env.PRIVACY_RESEND_COLLECTION_API_KEY = "resend-key";
      expireSnapshots.mockResolvedValue({ expired: 1, cleanupQueued: 1 });
      materializeSnapshot.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
      const worker = startPrivacyExternalSnapshotWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();

      expect(materializeSnapshot).toHaveBeenCalledWith(expect.objectContaining({
        workerId: expect.stringMatching(/^privacy-external-/), resendApiKey: "resend-key",
        supportedSourceKeys: ["external.chain.public_records", "external.resend.delivery"], logger,
      }));
      expect(logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ materialized: 1, expired: 1, cleanupQueued: 1 }),
        "External privacy snapshot lifecycle batch completed",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports expiry and cleanup outcomes even when no snapshot materializes", async () => {
    vi.useFakeTimers();
    try {
      env.PRIVACY_CHAIN_ADAPTER_SHA256 = "chain";
      expireSnapshots
        .mockResolvedValueOnce({ expired: 1, cleanupQueued: 0 })
        .mockResolvedValueOnce({ expired: 0, cleanupQueued: 1 })
        .mockResolvedValueOnce({ expired: 0, cleanupQueued: 0 });
      const worker = startPrivacyExternalSnapshotWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();

      expect(logger.info).toHaveBeenCalledTimes(2);
      expect(logger.info).toHaveBeenNthCalledWith(2, expect.objectContaining({ materialized: 0, cleanupQueued: 1 }), "External privacy snapshot lifecycle batch completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains polling errors and stops future snapshot polls", async () => {
    vi.useFakeTimers();
    try {
      env.PRIVACY_CHAIN_ADAPTER_SHA256 = "chain";
      expireSnapshots.mockRejectedValue(new Error("database unavailable"));
      const worker = startPrivacyExternalSnapshotWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      await vi.advanceTimersByTimeAsync(2_000);

      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error), workerId: expect.any(String) }),
        "External privacy snapshot worker polling failed",
      );
      expect(expireSnapshots).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not run a second snapshot poll while the first poll is pending", async () => {
    vi.useFakeTimers();
    try {
      env.PRIVACY_CHAIN_ADAPTER_SHA256 = "chain";
      let finish: ((result: unknown) => void) | undefined;
      expireSnapshots.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const worker = startPrivacyExternalSnapshotWorker({ logger });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(expireSnapshots).toHaveBeenCalledOnce();
      finish?.({ expired: 0, cleanupQueued: 0 });
      await Promise.resolve();
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
