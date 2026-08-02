import { beforeEach, describe, expect, it, vi } from "vitest";

const activateDue = vi.hoisted(() => vi.fn());
const publishDue = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  PLATFORM_CONFIGURATION_ACTIVATION_BATCH_SIZE: 20,
  PLATFORM_CONFIGURATION_ACTIVATION_INTERVAL_MS: 1_000,
  PLATFORM_CONTENT_PUBLICATION_BATCH_SIZE: 20,
  PLATFORM_CONTENT_PUBLICATION_INTERVAL_MS: 1_000,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../platform/postgres-platform-configuration.js", () => ({ activateDuePlatformConfigurationVersions: activateDue }));
vi.mock("../../platform/postgres-platform-content.js", () => ({ publishDuePlatformContent: publishDue }));

import { startPlatformConfigurationActivationWorker } from "../platform-configuration-activation-worker.js";
import { startPlatformContentPublicationWorker } from "../platform-content-publication-worker.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => vi.clearAllMocks());

describe("platform publication workers", () => {
  it("activates due configuration and reports material outcomes", async () => {
    vi.useFakeTimers();
    try {
      activateDue.mockResolvedValue({ activated: 1, failed: 0, alreadyTerminal: 0 });
      const worker = startPlatformConfigurationActivationWorker({ logger });
      await vi.runOnlyPendingTimersAsync();
      worker.stop();
      expect(activateDue).toHaveBeenCalledWith(expect.any(Date), 20);
      expect(logger.info).toHaveBeenCalledWith({ activated: 1, failed: 0, alreadyTerminal: 0 }, "Platform configuration activation cycle completed");
    } finally { vi.useRealTimers(); }
  });

  it("contains configuration activation errors and does not log empty outcomes", async () => {
    vi.useFakeTimers();
    try {
      activateDue.mockRejectedValue(new Error("Database unavailable"));
      const worker = startPlatformConfigurationActivationWorker({ logger });
      await vi.runOnlyPendingTimersAsync();
      worker.stop();
      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Platform configuration activation cycle failed");
    } finally { vi.useRealTimers(); }
  });

  it("publishes due legal content and contains publication errors", async () => {
    vi.useFakeTimers();
    try {
      publishDue.mockResolvedValueOnce({ published: 1, failed: 0, alreadyTerminal: 0 }).mockRejectedValueOnce(new Error("Database unavailable"));
      const worker = startPlatformContentPublicationWorker({ logger });
      await vi.runOnlyPendingTimersAsync();
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();
      expect(publishDue).toHaveBeenCalledWith(expect.any(Date), 20);
      expect(logger.info).toHaveBeenCalledWith({ published: 1, failed: 0, alreadyTerminal: 0 }, "Platform legal-content publication cycle completed");
      expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Platform legal-content publication cycle failed");
    } finally { vi.useRealTimers(); }
  });
});
