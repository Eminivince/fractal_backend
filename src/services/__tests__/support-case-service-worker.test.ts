import { beforeEach, describe, expect, it, vi } from "vitest";

const sweepDeadlines = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  SUPPORT_SERVICE_SWEEP_BATCH_SIZE: 25,
  SUPPORT_SERVICE_SWEEP_INTERVAL_MS: 1_000,
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../platform/postgres-support-service-levels.js", () => ({
  sweepSupportCaseServiceDeadlines: sweepDeadlines,
}));

import { startSupportCaseServiceWorker } from "../support-case-service-worker.js";

const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  sweepDeadlines.mockResolvedValue({ acknowledgementBreaches: 0, escalations: 0, resolutionBreaches: 0 });
});

describe("support case service worker", () => {
  it("records governed deadline events when a sweep creates an outcome", async () => {
    sweepDeadlines.mockResolvedValue({ acknowledgementBreaches: 1, escalations: 2, resolutionBreaches: 3 });
    const worker = startSupportCaseServiceWorker({ logger, workerId: "support-worker" });
    await vi.waitFor(() => expect(sweepDeadlines).toHaveBeenCalledOnce());
    worker.stop();

    expect(sweepDeadlines).toHaveBeenCalledWith({ workerId: "support-worker", limit: 25 });
    expect(logger.info).toHaveBeenCalledWith(
      { acknowledgementBreaches: 1, escalations: 2, resolutionBreaches: 3 },
      "Support service deadline cycle recorded governed events",
    );
  });

  it("does not create a log record when a sweep has no outcome", async () => {
    const worker = startSupportCaseServiceWorker({ logger, workerId: "support-worker" });
    await vi.waitFor(() => expect(sweepDeadlines).toHaveBeenCalledOnce());
    worker.stop();

    expect(logger.info).not.toHaveBeenCalled();
  });

  it("creates an ID when the caller does not provide a worker ID", async () => {
    const worker = startSupportCaseServiceWorker({ logger });
    await vi.waitFor(() => expect(sweepDeadlines).toHaveBeenCalledOnce());
    worker.stop();

    expect(sweepDeadlines).toHaveBeenCalledWith(expect.objectContaining({ workerId: expect.any(String) }));
  });

  it("records a sweep failure and continues on the next timer cycle", async () => {
    vi.useFakeTimers();
    try {
      sweepDeadlines.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce({
        acknowledgementBreaches: 0, escalations: 0, resolutionBreaches: 0,
      });
      const worker = startSupportCaseServiceWorker({ logger, workerId: "support-worker" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();

      expect(logger.error).toHaveBeenCalledWith(
        { err: expect.any(Error) },
        "Support service deadline cycle failed",
      );
      expect(sweepDeadlines).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops future sweeps after stop", async () => {
    vi.useFakeTimers();
    try {
      const worker = startSupportCaseServiceWorker({ logger, workerId: "support-worker" });
      await vi.advanceTimersByTimeAsync(0);
      worker.stop();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(sweepDeadlines).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a second sweep while the first sweep is still running", async () => {
    vi.useFakeTimers();
    try {
      let finish: ((value: unknown) => void) | undefined;
      sweepDeadlines.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
      const worker = startSupportCaseServiceWorker({ logger, workerId: "support-worker" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sweepDeadlines).toHaveBeenCalledOnce();
      finish?.({ acknowledgementBreaches: 0, escalations: 0, resolutionBreaches: 0 });
      await Promise.resolve();
      worker.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
