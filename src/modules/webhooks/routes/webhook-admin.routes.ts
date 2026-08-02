/**
 * B13: Webhook admin routes for listing and replaying stored webhook events.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WebhookEventModel } from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";

export async function webhookAdminRoutes(app: FastifyInstance) {
  // List webhook events with filtering
  app.get(
    "/v1/admin/webhooks",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }

      const query = z.object({
        provider: z.enum(["paystack", "sumsub"]).optional(),
        status: z.enum(["received", "processed", "failed"]).optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }).parse(request.query);

      const filter: Record<string, unknown> = {};
      if (query.provider) filter.provider = query.provider;
      if (query.status) filter.status = query.status;

      const [events, total] = await Promise.all([
        WebhookEventModel.find(filter)
          .sort({ receivedAt: -1 })
          .skip(query.offset)
          .limit(query.limit)
          .select("-rawPayload")
          .lean(),
        WebhookEventModel.countDocuments(filter),
      ]);

      return serialize({ events, total, limit: query.limit, offset: query.offset });
    },
  );

  // Get single webhook event (includes raw payload)
  app.get(
    "/v1/admin/webhooks/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["admin", "operator"].includes(request.authUser.role)) {
        throw new HttpError(403, "Admin or operator role required");
      }
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const event = await WebhookEventModel.findById(id).lean();
      if (!event) throw new HttpError(404, "Webhook event not found");
      return serialize(event);
    },
  );

  // Replay a stored webhook event
  app.post(
    "/v1/admin/webhooks/:id/replay",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "admin") {
        throw new HttpError(403, "Admin role required");
      }
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const event = await WebhookEventModel.findById(id);
      if (!event) throw new HttpError(404, "Webhook event not found");

      await WebhookEventModel.updateOne(
        { _id: event._id },
        { $set: { status: "received" }, $inc: { replayCount: 1 } },
      );

      return serialize({
        message: `Webhook event ${id} marked for replay. The next webhook processing cycle will re-process it.`,
        replayCount: (event.replayCount ?? 0) + 1,
      });
    },
  );
}
