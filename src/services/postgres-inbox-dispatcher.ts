import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { withPostgresTransaction } from "../db/postgres.js";
import {
  claimInboxEvents,
  markInboxEventForRetry,
  markInboxEventProcessed,
  type ClaimedInboxEvent,
} from "../platform/postgres-inbox.js";

export interface InboxDispatcherLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export interface InboxDispatcherOptions {
  workerId?: string;
  providers: readonly string[];
  process: (event: ClaimedInboxEvent) => Promise<void>;
  isTerminalError?: (error: unknown) => boolean;
  logger: InboxDispatcherLogger;
}

/**
 * The only code that executes provider-event business effects. HTTP handlers
 * merely authenticate and durably accept events, keeping acknowledgement and
 * retry semantics independent from provider/network timing.
 */
export async function dispatchPendingInboxEvents(options: InboxDispatcherOptions): Promise<number> {
  const workerId = options.workerId ?? randomUUID();
  const events = await claimInboxEvents({
    workerId,
    providers: options.providers,
    limit: env.INBOX_DISPATCH_BATCH_SIZE,
    claimTimeoutSeconds: env.INBOX_CLAIM_TIMEOUT_SECONDS,
  });
  for (const event of events) {
    try {
      await options.process(event);
      await withPostgresTransaction((client: PoolClient) => markInboxEventProcessed(client, event.id, workerId));
      options.logger.info({ eventId: event.id, provider: event.provider }, "Postgres inbox event processed");
    } catch (error) {
      const terminal = options.isTerminalError?.(error) ?? false;
      const exhausted = event.attempts >= env.INBOX_MAX_ATTEMPTS;
      const delaySeconds = Math.min(60 * 60, env.INBOX_RETRY_BASE_SECONDS * 2 ** Math.max(0, event.attempts - 1));
      await markInboxEventForRetry({
        eventId: event.id,
        workerId,
        retryAt: new Date(Date.now() + delaySeconds * 1_000),
        error,
        terminal: terminal || exhausted,
      });
      options.logger.error(
        { err: error, eventId: event.id, provider: event.provider, terminal: terminal || exhausted, delaySeconds },
        "Postgres inbox event processing failed",
      );
    }
  }
  return events.length;
}

export function startPostgresInboxDispatcher(options: InboxDispatcherOptions): { stop: () => void } {
  const workerId = options.workerId ?? randomUUID();
  let running = false;
  let stopped = false;
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchPendingInboxEvents({ ...options, workerId });
    } catch (error) {
      options.logger.error({ err: error }, "Postgres inbox polling failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void dispatch(), env.INBOX_DISPATCH_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
