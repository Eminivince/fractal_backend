/**
 * B2: BullMQ job queue manager.
 * Provides a centralized queue factory backed by Redis.
 */

import { Queue, Worker, type Processor, type WorkerOptions, type QueueOptions } from "bullmq";
import { getRedis } from "../db/redis.js";

interface ManagedQueue {
  queue: Queue;
  worker: Worker;
}

const queues = new Map<string, ManagedQueue>();

const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: { age: 86400 },
  removeOnFail: { age: 604800 },
};

export function createQueue(
  name: string,
  processor: Processor,
  opts?: { concurrency?: number; repeatEveryMs?: number },
): { queue: Queue; worker: Worker } | null {
  const redis = getRedis();
  if (!redis) return null;

  const connection = { host: redis.options.host!, port: redis.options.port! };
  if (redis.options.password) (connection as any).password = redis.options.password;

  const queue = new Queue(name, {
    connection,
    defaultJobOptions: DEFAULT_JOB_OPTIONS,
  });

  const workerOpts: WorkerOptions = {
    connection,
    concurrency: opts?.concurrency ?? 1,
  };

  const worker = new Worker(name, processor, workerOpts);

  worker.on("failed", (job, err) => {
    console.error(`[queue:${name}] Job ${job?.id} failed: ${err.message}`);
  });

  worker.on("completed", (job) => {
    console.debug(`[queue:${name}] Job ${job.id} completed`);
  });

  // Set up repeatable job if interval specified
  if (opts?.repeatEveryMs) {
    queue.upsertJobScheduler(
      `${name}-repeatable`,
      { every: opts.repeatEveryMs },
      { name: `${name}-tick` },
    ).catch((err) => {
      console.warn(`[queue:${name}] Failed to set repeatable job: ${err.message}`);
    });
  }

  queues.set(name, { queue, worker });
  return { queue, worker };
}

export async function closeAllQueues(): Promise<void> {
  for (const [name, { queue, worker }] of queues) {
    try {
      await worker.close();
      await queue.close();
    } catch (err) {
      console.warn(`[queue:${name}] Error closing: ${(err as Error).message}`);
    }
  }
  queues.clear();
}
