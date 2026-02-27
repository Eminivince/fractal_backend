import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApplicationModel,
  DistributionModel,
  EventLogModel,
  MilestoneModel,
  OfferingModel,
  SubscriptionModel,
  TrancheModel,
} from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { serialize } from "../../utils/serialize.js";

const querySchema = z.object({
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
      "dispute",
    ])
    .optional(),
  entityId: z.string().optional(),
  actor: z.string().optional(),
  q: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).default(100),
});

export async function eventRoutes(app: FastifyInstance) {
  app.get(
    "/v1/events",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "event");
      const query = querySchema.parse(request.query);

      const filter: Record<string, unknown> = {};
      if (query.entityType) filter.entityType = query.entityType;
      if (query.entityId) filter.entityId = query.entityId;
      if (query.actor) filter.actorUserId = query.actor;
      if (query.from || query.to) {
        filter.timestamp = {
          ...(query.from ? { $gte: new Date(query.from) } : {}),
          ...(query.to ? { $lte: new Date(query.to) } : {}),
        };
      }

      if (query.q && query.q.trim()) {
        const pattern = new RegExp(query.q.trim(), "i");
        filter.$or = [{ action: { $regex: pattern } }, { notes: { $regex: pattern } }];
      }

      if (request.authUser.role === "issuer") {
        const businessId = request.authUser.businessId;
        const applications = await ApplicationModel.find({ businessId }).select("_id").lean();
        const applicationIds = applications.map((item: any) => String(item._id));

        const offerings = await OfferingModel.find({ businessId }).select("_id").lean();
        const offeringIds = offerings.map((item: any) => String(item._id));

        const subscriptions = await SubscriptionModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const subscriptionIds = subscriptions.map((item: any) => String(item._id));

        const distributions = await DistributionModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const distributionIds = distributions.map((item: any) => String(item._id));

        const milestones = await MilestoneModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const milestoneIds = milestones.map((item: any) => String(item._id));

        const tranches = await TrancheModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const trancheIds = tranches.map((item: any) => String(item._id));

        const allowedEntityIds = new Set<string>([
          ...applicationIds,
          ...offeringIds,
          ...subscriptionIds,
          ...distributionIds,
          ...milestoneIds,
          ...trancheIds,
          String(businessId),
          request.authUser.userId,
        ]);

        const existingEntityIdFilter = filter.entityId as string | undefined;
        if (existingEntityIdFilter) {
          if (!allowedEntityIds.has(existingEntityIdFilter)) {
            return [];
          }
        } else {
          filter.entityId = { $in: [...allowedEntityIds] };
        }
      }

      if (request.authUser.role === "investor") {
        const subscriptions = await SubscriptionModel.find({ investorUserId: request.authUser.userId })
          .select("_id offeringId")
          .lean();

        const subscriptionIds = subscriptions.map((item: any) => String(item._id));
        const offeringIds = [...new Set(subscriptions.map((item: any) => String(item.offeringId)))];

        const distributions = await DistributionModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const distributionIds = distributions.map((item: any) => String(item._id));

        const milestones = await MilestoneModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const milestoneIds = milestones.map((item: any) => String(item._id));

        const tranches = await TrancheModel.find({ offeringId: { $in: offeringIds } }).select("_id").lean();
        const trancheIds = tranches.map((item: any) => String(item._id));

        const allowedEntityIds = new Set<string>([
          ...subscriptionIds,
          ...offeringIds,
          ...distributionIds,
          ...milestoneIds,
          ...trancheIds,
          request.authUser.userId,
        ]);

        const existingEntityIdFilter = filter.entityId as string | undefined;
        if (existingEntityIdFilter) {
          if (!allowedEntityIds.has(existingEntityIdFilter)) {
            return [];
          }
        } else {
          filter.entityId = { $in: [...allowedEntityIds] };
        }
      }

      const rows = await EventLogModel.find(filter).sort({ timestamp: -1 }).limit(query.limit).lean();
      return serialize(rows);
    },
  );
}
