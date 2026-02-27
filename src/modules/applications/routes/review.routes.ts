/**
 * 5.1: Application review workflow routes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApplicationModel,
  ApplicationReviewRoundModel,
  ApplicationReviewItemModel,
} from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";
import { appendEvent } from "../../../utils/audit.js";

export async function applicationReviewRoutes(app: FastifyInstance) {
  // Create review round (operator)
  app.post(
    "/v1/applications/:id/review-rounds",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) throw new HttpError(403, "Operator role required");
      authorize(request.authUser, "update", "application");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({
        title: z.string().min(1).max(200),
        notes: z.string().max(2000).optional(),
      }).parse(request.body);

      const application = await ApplicationModel.findById(id);
      if (!application) throw new HttpError(404, "Application not found");

      const round = await ApplicationReviewRoundModel.create({
        applicationId: id,
        title: payload.title,
        notes: payload.notes,
        openedBy: request.authUser.userId,
        status: "open",
      });

      // Transition application to needs_info
      if (application.status === "in_review") {
        application.status = "needs_info";
        await application.save();
      }

      await appendEvent(request.authUser, {
        entityType: "application",
        entityId: id,
        action: "ReviewRoundCreated",
        notes: payload.title,
      });

      return serialize(round.toObject());
    },
  );

  // Add review item to round
  app.post(
    "/v1/applications/:id/review-rounds/:roundId/items",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) throw new HttpError(403, "Operator role required");
      const { id, roundId } = z.object({ id: z.string(), roundId: z.string() }).parse(request.params);
      const payload = z.object({
        question: z.string().min(1).max(2000),
        category: z.string().max(100).optional(),
      }).parse(request.body);

      const round = await ApplicationReviewRoundModel.findOne({ _id: roundId, applicationId: id });
      if (!round) throw new HttpError(404, "Review round not found");
      if ((round as any).status !== "open") throw new HttpError(422, "Review round is closed");

      const item = await ApplicationReviewItemModel.create({
        reviewRoundId: roundId,
        applicationId: id,
        question: payload.question,
        category: payload.category,
        askedBy: request.authUser.userId,
        status: "pending",
      });

      return serialize(item.toObject());
    },
  );

  // Issuer responds to review item
  app.post(
    "/v1/applications/:id/review-rounds/:roundId/items/:itemId/respond",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["issuer", "operator", "admin"].includes(request.authUser.role)) throw new HttpError(403, "Forbidden");
      const { id, roundId, itemId } = z.object({
        id: z.string(), roundId: z.string(), itemId: z.string(),
      }).parse(request.params);
      const payload = z.object({
        response: z.string().min(1).max(5000),
      }).parse(request.body);

      const item = await ApplicationReviewItemModel.findOne({
        _id: itemId, reviewRoundId: roundId, applicationId: id,
      });
      if (!item) throw new HttpError(404, "Review item not found");

      (item as any).response = payload.response;
      (item as any).respondedBy = request.authUser.userId;
      (item as any).respondedAt = new Date();
      (item as any).status = "resolved";
      await item.save();

      return serialize(item.toObject());
    },
  );

  // Close review round
  app.post(
    "/v1/applications/:id/review-rounds/:roundId/close",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) throw new HttpError(403, "Operator role required");
      const { id, roundId } = z.object({ id: z.string(), roundId: z.string() }).parse(request.params);

      const round = await ApplicationReviewRoundModel.findOne({ _id: roundId, applicationId: id });
      if (!round) throw new HttpError(404, "Review round not found");

      (round as any).status = "closed";
      (round as any).closedAt = new Date();
      (round as any).closedBy = request.authUser.userId;
      await round.save();

      // Check if all items are resolved — if so, transition back to in_review
      const pendingItems = await ApplicationReviewItemModel.countDocuments({
        reviewRoundId: roundId,
        status: "pending",
      });

      if (pendingItems === 0) {
        const application = await ApplicationModel.findById(id);
        if (application && application.status === "needs_info") {
          application.status = "in_review";
          await application.save();
        }
      }

      await appendEvent(request.authUser, {
        entityType: "application",
        entityId: id,
        action: "ReviewRoundClosed",
      });

      return serialize(round.toObject());
    },
  );

  // List review rounds for an application
  app.get(
    "/v1/applications/:id/review-rounds",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const rounds = await ApplicationReviewRoundModel.find({ applicationId: id })
        .sort({ createdAt: -1 }).lean();

      // Attach items to each round
      const result = await Promise.all(
        rounds.map(async (round: any) => {
          const items = await ApplicationReviewItemModel.find({ reviewRoundId: round._id }).lean();
          return { ...round, items };
        }),
      );

      return serialize(result);
    },
  );
}
