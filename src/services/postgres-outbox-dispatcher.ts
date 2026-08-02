import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { withPostgresTransaction } from "../db/postgres.js";
import {
  claimOutboxEvents,
  markOutboxEventForRetry,
  markOutboxEventPublished,
  type ClaimedOutboxEvent,
} from "../platform/postgres-outbox.js";

export interface OutboxDispatcherLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface OutboxDispatcherOptions {
  workerId?: string;
  eventTypes: readonly string[];
  project: (client: PoolClient, event: ClaimedOutboxEvent) => Promise<void>;
  logger: OutboxDispatcherLogger;
}

export async function dispatchPendingOutboxEvents(options: OutboxDispatcherOptions): Promise<number> {
  const workerId = options.workerId ?? randomUUID();
  const events = await claimOutboxEvents({
    workerId,
    eventTypes: options.eventTypes,
    limit: env.OUTBOX_DISPATCH_BATCH_SIZE,
    claimTimeoutSeconds: env.OUTBOX_CLAIM_TIMEOUT_SECONDS,
  });

  for (const event of events) {
    try {
      await withPostgresTransaction(async (client) => {
        await options.project(client, event);
        await markOutboxEventPublished(client, event.id, workerId);
      });
      options.logger.info({ eventId: event.id, eventType: event.eventType }, "Postgres outbox event dispatched");
    } catch (error) {
      const delaySeconds = Math.min(60 * 60, env.OUTBOX_RETRY_BASE_SECONDS * 2 ** Math.max(0, event.attempts - 1));
      await markOutboxEventForRetry({
        eventId: event.id,
        workerId,
        retryAt: new Date(Date.now() + delaySeconds * 1_000),
        error,
      });
      options.logger.error({ err: error, eventId: event.id, eventType: event.eventType, delaySeconds }, "Postgres outbox dispatch failed");
    }
  }
  return events.length;
}

export function startPostgresOutboxDispatcher(options: OutboxDispatcherOptions): { stop: () => void } {
  const workerId = options.workerId ?? randomUUID();
  let running = false;
  let stopped = false;
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchPendingOutboxEvents({ ...options, workerId });
    } catch (error) {
      options.logger.error({ err: error }, "Postgres outbox polling failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void dispatch(), env.OUTBOX_DISPATCH_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
