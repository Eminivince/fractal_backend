import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotificationModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";
import { eventBus } from "../../../services/event-bus.js";

const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(30),
  unreadOnly: z.coerce.boolean().default(false),
});

export async function notificationRoutes(app: FastifyInstance) {
  app.get(
    "/v1/notifications",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "notification");
      const query = listNotificationsQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = {
        recipientUserId: request.authUser.userId,
      };
      if (query.unreadOnly) filter.readAt = { $exists: false };

      const rows = await NotificationModel.find(filter)
        .sort({ createdAt: -1 })
        .limit(query.limit)
        .lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/notifications/unread-count",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "notification");
      const count = await NotificationModel.countDocuments({
        recipientUserId: request.authUser.userId,
        readAt: { $exists: false },
      });
      return { count };
    },
  );

  app.post(
    "/v1/notifications/:id/read",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "notification");
      const params = z.object({ id: z.string() }).parse(request.params);

      const updated = await NotificationModel.findOneAndUpdate(
        {
          _id: params.id,
          recipientUserId: request.authUser.userId,
        },
        {
          $set: { readAt: new Date() },
        },
        { new: true },
      ).lean();

      if (!updated) throw new HttpError(404, "Notification not found");
      return serialize(updated);
    },
  );

  /**
   * P4-01 — Server-Sent Events stream for real-time notifications.
   *
   * Auth: pass JWT as ?token= query param (EventSource cannot set headers).
   * The endpoint keeps the connection open and pushes events as:
   *   data: {"type":"notification", ...}\n\n
   * A heartbeat comment is sent every 25 seconds to prevent proxy timeouts.
   *
   * Usage:
   *   const es = new EventSource('/v1/notifications/stream?token=<jwt>');
   *   es.onmessage = (e) => console.log(JSON.parse(e.data));
   */
  app.get(
    "/v1/notifications/stream",
    async (request: FastifyRequest, reply) => {
      // Manual JWT verification from query param (EventSource can't set headers)
      const query = z.object({ token: z.string().min(1) }).parse(request.query);
      let authUser: import("../../../types.js").AuthUser;
      try {
        authUser = (await (request.server as any).jwt.verify(query.token)) as import("../../../types.js").AuthUser;
      } catch {
        throw new HttpError(401, "Invalid or expired token");
      }

      const userId = authUser.userId;
      const eventKey = `user:${userId}`;

      const origin = request.headers.origin ?? "*";
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      });

      // Send initial connection confirmation
      reply.raw.write(": connected\n\n");

      // Push events to this client
      const onEvent = (payload: Record<string, unknown>) => {
        try {
          reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
        } catch {
          // Client disconnected — cleanup will happen below
        }
      };

      eventBus.on(eventKey, onEvent);

      // Heartbeat every 25s to keep connection alive through proxies
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": heartbeat\n\n");
        } catch {
          clearInterval(heartbeat);
        }
      }, 25000);

      // Cleanup when client disconnects
      request.raw.on("close", () => {
        clearInterval(heartbeat);
        eventBus.off(eventKey, onEvent);
      });

      // Keep the handler pending — Fastify must not send a normal reply
      await new Promise<void>((resolve) => {
        request.raw.on("close", resolve);
      });
    },
  );

  app.post(
    "/v1/notifications/read-all",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "notification");
      const result = await NotificationModel.updateMany(
        {
          recipientUserId: request.authUser.userId,
          readAt: { $exists: false },
        },
        {
          $set: { readAt: new Date() },
        },
      );

      return {
        matched: result.matchedCount,
        modified: result.modifiedCount,
      };
    },
  );
}
