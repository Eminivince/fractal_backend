/**
 * B2: BullMQ-based notification worker.
 * Replaces the polling-based notification-worker when Redis is available.
 */

import { createQueue } from "../../services/queue.js";
import { processPendingNotificationEmails } from "../../services/notifications.js";
import { env } from "../../config/env.js";
import type { NotificationWorkerHandle } from "../../services/notification-worker.js";

interface LoggerLike {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export function startNotificationQueue(log: LoggerLike): NotificationWorkerHandle {
  const result = createQueue(
    "notifications",
    async () => {
      const batch = await processPendingNotificationEmails();
      if (batch.sent > 0 || batch.failed > 0) {
        log.info(`[queue:notifications] sent=${batch.sent} failed=${batch.failed}`);
      }
    },
    { repeatEveryMs: env.NOTIFICATION_EMAIL_POLL_INTERVAL_MS },
  );

  if (!result) {
    log.warn("[queue:notifications] Redis not available, cannot start BullMQ notification worker");
    return { stop: () => {}, triggerNow: async () => {} };
  }

  log.info("[queue:notifications] BullMQ notification worker started");

  return {
    stop: () => {
      result.worker.close().catch(() => {});
      result.queue.close().catch(() => {});
    },
    triggerNow: async () => {
      await result.queue.add("manual-trigger", {}, { priority: 1 });
    },
  };
}
