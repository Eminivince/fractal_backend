/**
 * 2.5: Document expiration enforcement worker.
 * Runs daily, flags businesses with expired critical documents,
 * and sends notifications 30 days before expiry.
 */

import type { FastifyBaseLogger } from "fastify";
import { BusinessModel } from "../db/models.js";
import { createNotificationsFromEvent } from "../services/notifications.js";
import type { AuthUser } from "../types.js";

const SYSTEM_ACTOR: AuthUser = { userId: "system", role: "admin" };

const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const EXPIRY_WARNING_DAYS = 30;

export function startDocumentExpiryWorker(log: FastifyBaseLogger) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const warningDate = new Date(now.getTime() + EXPIRY_WARNING_DAYS * 24 * 60 * 60 * 1000);

      // Find businesses with documents that have expired or are about to expire
      const businesses = await BusinessModel.find({
        status: "active",
        "documents.validUntil": { $exists: true },
      }).lean();

      for (const biz of businesses) {
        const docs = (biz as any).documents ?? [];
        let hasExpired = false;

        for (const doc of docs) {
          if (!doc.validUntil) continue;
          const validUntil = new Date(doc.validUntil);

          if (validUntil < now) {
            // Document has expired
            hasExpired = true;
            log.info({ businessId: String(biz._id), docType: doc.type, validUntil }, "Document expired");
          } else if (validUntil < warningDate) {
            // Document expiring soon — send warning notification
            await createNotificationsFromEvent(SYSTEM_ACTOR, {
              entityType: "business",
              entityId: String(biz._id),
              action: "DocumentExpiringSoon",
              notes: `Document "${doc.filename || doc.type}" expires on ${validUntil.toISOString().slice(0, 10)}. Please upload a renewed version.`,
            });
          }
        }

        // Flag business KYB status if critical docs expired
        if (hasExpired && (biz as any).kybStatus === "approved") {
          await BusinessModel.findByIdAndUpdate(biz._id, {
            kybStatus: "needs_renewal",
          });

          await createNotificationsFromEvent(SYSTEM_ACTOR, {
            entityType: "business",
            entityId: String(biz._id),
            action: "DocumentsExpired",
            notes: "One or more critical documents have expired. Your KYB status has been set to needs_renewal. Please upload renewed documents.",
          });

          log.warn({ businessId: String(biz._id) }, "Business KYB set to needs_renewal due to expired documents");
        }
      }
    } catch (err) {
      log.error(err, "[document-expiry-worker] error");
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
