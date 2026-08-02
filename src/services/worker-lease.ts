import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

const RENEW_IF_OWNER = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
  end
  return 0
`;

const RELEASE_IF_OWNER = `
  if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
  end
  return 0
`;

export interface WorkerLease {
  release: () => Promise<void>;
}

/**
 * A process-wide lease for the legacy polling workers. Queue consumers can be
 * scaled deliberately later; scheduled polling must have exactly one leader
 * until each job has its own durable scheduler and idempotency proof.
 */
export async function acquireWorkerLease({
  redis,
  key,
  ttlMs,
  onLost,
}: {
  redis: Redis;
  key: string;
  ttlMs: number;
  onLost: () => void;
}): Promise<WorkerLease> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") {
    throw new Error(`Another worker runtime already holds lease ${key}`);
  }

  let released = false;
  let lossReported = false;
  const renewEveryMs = Math.max(1_000, Math.floor(ttlMs / 3));
  const timer = setInterval(() => {
    void redis
      .eval(RENEW_IF_OWNER, 1, key, token, String(ttlMs))
      .then((result) => {
        if (result === 1 || result === "1") return;
        if (!released && !lossReported) {
          lossReported = true;
          onLost();
        }
      })
      .catch(() => {
        if (!released && !lossReported) {
          lossReported = true;
          onLost();
        }
      });
  }, renewEveryMs);
  timer.unref();

  return {
    async release() {
      if (released) return;
      released = true;
      clearInterval(timer);
      await redis.eval(RELEASE_IF_OWNER, 1, key, token);
    },
  };
}
