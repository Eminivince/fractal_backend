import { env } from "../config/env.js";
import { hasAnyEmailTransportConfigured } from "./email.js";
import { processPendingNotificationEmails } from "./notifications.js";

interface LoggerLike {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface NotificationWorkerHandle {
  stop: () => void;
  triggerNow: () => Promise<void>;
}

export function startNotificationWorker(log: LoggerLike): NotificationWorkerHandle {
  if (!env.NOTIFICATION_EMAIL_ENABLED) {
    log.info("Notification email worker disabled (NOTIFICATION_EMAIL_ENABLED=false)");
    return {
      stop: () => undefined,
      triggerNow: async () => undefined,
    };
  }

  if (!hasAnyEmailTransportConfigured()) {
    log.warn("Notification email worker inactive: no SendGrid or SMTP transport configured");
    return {
      stop: () => undefined,
      triggerNow: async () => undefined,
    };
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const result = await processPendingNotificationEmails();
      if (result.sent > 0 || result.failed > 0) {
        log.info(
          `Notification email batch: attempted=${result.attempted} sent=${result.sent} failed=${result.failed}`,
        );
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, env.NOTIFICATION_EMAIL_POLL_INTERVAL_MS);

  log.info(`Notification worker started (interval=${env.NOTIFICATION_EMAIL_POLL_INTERVAL_MS}ms)`);

  return {
    stop: () => clearInterval(timer),
    triggerNow: tick,
  };
}
