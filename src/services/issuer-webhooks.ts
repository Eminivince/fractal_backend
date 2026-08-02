/**
 * Outbound issuer webhooks: deliver platform events to issuer-registered URLs,
 * signed with HMAC-SHA256 (X-Fractal-Signature). Best-effort with a short timeout;
 * failures increment a counter and are logged (a sweep/retry worker can be added).
 */
import { createHmac } from "node:crypto";
import { IssuerWebhookModel } from "../db/models.js";

export interface WebhookEvent {
  type: string;
  businessId: string;
  data: Record<string, unknown>;
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

/**
 * Dispatch an event to all active issuer webhooks for a business that subscribe to
 * the event type (or "*"). Fire-and-forget — never throws into the caller.
 */
export async function dispatchIssuerWebhook(event: WebhookEvent): Promise<void> {
  try {
    const hooks = await IssuerWebhookModel.find({
      businessId: event.businessId,
      active: true,
    }).lean();
    if (!hooks.length) return;

    const body = JSON.stringify({
      type: event.type,
      businessId: event.businessId,
      data: event.data,
      sentAt: new Date().toISOString(),
    });

    await Promise.all(
      hooks
        .filter((h: any) => h.events?.includes("*") || h.events?.includes(event.type))
        .map(async (hook: any) => {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          try {
            const res = await fetch(hook.url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Fractal-Event": event.type,
                "X-Fractal-Signature": sign(hook.secret, body),
              },
              body,
              signal: controller.signal,
            });
            await IssuerWebhookModel.updateOne(
              { _id: hook._id },
              res.ok
                ? { $set: { lastDeliveryAt: new Date(), lastDeliveryStatus: `${res.status}`, failureCount: 0 } }
                : { $set: { lastDeliveryAt: new Date(), lastDeliveryStatus: `${res.status}` }, $inc: { failureCount: 1 } },
            );
          } catch (err) {
            await IssuerWebhookModel.updateOne(
              { _id: hook._id },
              { $set: { lastDeliveryAt: new Date(), lastDeliveryStatus: "error" }, $inc: { failureCount: 1 } },
            ).catch(() => {});
          } finally {
            clearTimeout(timeout);
          }
        }),
    );
  } catch {
    // never propagate webhook failures into business logic
  }
}
