/**
 * 5.5: Offering closure enforcement worker.
 * Runs hourly, closes offerings past their close date.
 */

import type { FastifyBaseLogger } from "fastify";
import { OfferingModel } from "../db/models.js";
import { createNotificationsFromEvent } from "../services/notifications.js";
import { appendEvent } from "../utils/audit.js";

const POLL_INTERVAL_MS = 60 * 60 * 1000; // hourly

const SYSTEM_ACTOR = {
  userId: "system",
  role: "admin" as const,
  email: "system@fractal",
  businessId: undefined,
};

export function startOfferingClosureWorker(log: FastifyBaseLogger) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();

      // Find open offerings past their close date
      const expiredOfferings = await OfferingModel.find({
        status: "open",
        closesAt: { $lt: now },
      });

      for (const offering of expiredOfferings) {
        offering.status = "closed";
        await offering.save();

        await appendEvent(SYSTEM_ACTOR as any, {
          entityType: "offering",
          entityId: String(offering._id),
          action: "OfferingClosed",
          notes: "Offering automatically closed - close date reached.",
        });

        await createNotificationsFromEvent(SYSTEM_ACTOR as any, {
          entityType: "offering",
          entityId: String(offering._id),
          action: "OfferingClosed",
          notes: `Offering "${offering.name}" has been closed as the subscription period has ended.`,
        });

        log.info({ offeringId: String(offering._id) }, "Offering auto-closed");
      }

      if (expiredOfferings.length > 0) {
        log.info(`[offering-closure] Closed ${expiredOfferings.length} offerings`);
      }
    } catch (err) {
      log.error(err, "[offering-closure-worker] error");
    } finally {
      running = false;
    }
  }

  timer = setInterval(tick, POLL_INTERVAL_MS);

  return {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    triggerNow: tick,
  };
}
