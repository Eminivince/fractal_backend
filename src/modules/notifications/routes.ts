import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { NotificationModel } from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";

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
