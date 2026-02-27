import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AnchorModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";

const listQuerySchema = z.object({
  entityType: z
    .enum([
      "application",
      "offering",
      "subscription",
      "distribution",
      "milestone",
      "tranche",
      "anchor",
      "ledger_entry",
      "escrow_receipt",
      "reconciliation_run",
      "business",
      "user",
      "platform_config",
      "template",
      "task",
    ])
    .optional(),
  entityId: z.string().optional(),
  eventType: z.string().optional(),
  anchorStatus: z.enum(["pending", "processing", "anchored", "failed"]).optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export async function anchorRoutes(app: FastifyInstance) {
  app.get(
    "/v1/anchors",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "anchor");
      const query = listQuerySchema.parse(request.query);

      const filter: Record<string, unknown> = {};
      if (query.entityType) filter.entityType = query.entityType;
      if (query.entityId) filter.entityId = query.entityId;
      if (query.eventType) filter.eventType = query.eventType;
      if (query.anchorStatus) filter.anchorStatus = query.anchorStatus;

      const rows = await AnchorModel.find(filter).sort({ createdAt: -1 }).limit(query.limit).lean();
      return serialize(rows);
    },
  );

  app.post(
    "/v1/anchors/:id/retry",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "anchor");
      const params = z.object({ id: z.string() }).parse(request.params);

      const anchor = await AnchorModel.findById(params.id);
      if (!anchor) throw new HttpError(404, "Anchor not found");

      if (anchor.anchorStatus === "anchored") {
        throw new HttpError(422, "Anchor is already anchored");
      }

      anchor.anchorStatus = "pending";
      anchor.lastError = undefined;
      await anchor.save();

      await appendEvent(request.authUser, {
        entityType: "anchor",
        entityId: String(anchor._id),
        action: "AnchorRetryQueued",
      });

      return serialize(anchor.toObject());
    },
  );
}
