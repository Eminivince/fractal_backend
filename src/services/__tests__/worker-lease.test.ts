import { describe, expect, it, vi } from "vitest";
import { acquireWorkerLease } from "../worker-lease.js";

function redisMock(setResult: "OK" | null = "OK") {
  return {
    set: vi.fn().mockResolvedValue(setResult),
    eval: vi.fn().mockResolvedValue(1),
  };
}

describe("acquireWorkerLease", () => {
  it("releases only through the owner-checked Lua command", async () => {
    const redis = redisMock();
    const onLost = vi.fn();
    const lease = await acquireWorkerLease({
      redis: redis as never,
      key: "test:worker",
      ttlMs: 10_000,
      onLost,
    });

    expect(redis.set).toHaveBeenCalledWith("test:worker", expect.any(String), "PX", 10_000, "NX");
    await lease.release();

    expect(redis.eval).toHaveBeenCalledWith(expect.stringContaining("del"), 1, "test:worker", expect.any(String));
    expect(onLost).not.toHaveBeenCalled();
    await lease.release();
    expect(redis.eval).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when another runtime owns the lease", async () => {
    const redis = redisMock(null);

    await expect(
      acquireWorkerLease({
        redis: redis as never,
        key: "test:worker",
        ttlMs: 10_000,
        onLost: vi.fn(),
      }),
    ).rejects.toThrow("Another worker runtime already holds lease test:worker");
  });

  it("reports a lost lease once when renewal no longer confirms ownership", async () => {
    vi.useFakeTimers();
    try {
      const redis = redisMock();
      redis.eval.mockResolvedValueOnce(0);
      const onLost = vi.fn();
      const lease = await acquireWorkerLease({
        redis: redis as never,
        key: "test:worker",
        ttlMs: 1_000,
        onLost,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(onLost).toHaveBeenCalledOnce();
      await lease.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a lost lease once when Redis renewal fails", async () => {
    vi.useFakeTimers();
    try {
      const redis = redisMock();
      redis.eval.mockRejectedValueOnce(new Error("Redis unavailable"));
      const onLost = vi.fn();
      const lease = await acquireWorkerLease({
        redis: redis as never,
        key: "test:worker",
        ttlMs: 1_000,
        onLost,
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(onLost).toHaveBeenCalledOnce();
      await lease.release();
    } finally {
      vi.useRealTimers();
    }
  });
});
