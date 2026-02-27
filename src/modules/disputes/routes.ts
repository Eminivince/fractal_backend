import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApplicationModel,
  DisputeModel,
  DistributionModel,
  MilestoneModel,
  OfferingModel,
  SubscriptionModel,
  TrancheModel,
} from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";
import { serialize } from "../../utils/serialize.js";

const disputeEntityTypes = [
  "application",
  "offering",
  "subscription",
  "distribution",
  "milestone",
  "tranche",
] as const;

const createDisputeSchema = z.object({
  entityType: z.enum(disputeEntityTypes),
  entityId: z.string().min(3),
  reason: z.string().min(3),
  details: z.string().max(2000).optional(),
});

async function resolveEntityContext(entityType: (typeof disputeEntityTypes)[number], entityId: string): Promise<{
  businessId?: string;
  offeringId?: string;
  investorUserId?: string;
}> {
  if (entityType === "application") {
    const application = await ApplicationModel.findById(entityId).lean();
    if (!application) throw new HttpError(404, "Application not found");
    return { businessId: String(application.businessId) };
  }

  if (entityType === "offering") {
    const offering = await OfferingModel.findById(entityId).lean();
    if (!offering) throw new HttpError(404, "Offering not found");
    return {
      businessId: String(offering.businessId),
      offeringId: String(offering._id),
    };
  }

  if (entityType === "subscription") {
    const subscription = await SubscriptionModel.findById(entityId).lean();
    if (!subscription) throw new HttpError(404, "Subscription not found");
    const offering = await OfferingModel.findById(subscription.offeringId).lean();
    if (!offering) throw new HttpError(404, "Offering not found");
    return {
      businessId: String(offering.businessId),
      offeringId: String(offering._id),
      investorUserId: String(subscription.investorUserId),
    };
  }

  if (entityType === "distribution") {
    const distribution = await DistributionModel.findById(entityId).lean();
    if (!distribution) throw new HttpError(404, "Distribution not found");
    const offering = await OfferingModel.findById(distribution.offeringId).lean();
    if (!offering) throw new HttpError(404, "Offering not found");
    return {
      businessId: String(offering.businessId),
      offeringId: String(offering._id),
    };
  }

  if (entityType === "milestone") {
    const milestone = await MilestoneModel.findById(entityId).lean();
    if (!milestone) throw new HttpError(404, "Milestone not found");
    const offering = await OfferingModel.findById(milestone.offeringId).lean();
    if (!offering) throw new HttpError(404, "Offering not found");
    return {
      businessId: String(offering.businessId),
      offeringId: String(offering._id),
    };
  }

  const tranche = await TrancheModel.findById(entityId).lean();
  if (!tranche) throw new HttpError(404, "Tranche not found");
  const offering = await OfferingModel.findById(tranche.offeringId).lean();
  if (!offering) throw new HttpError(404, "Offering not found");
  return {
    businessId: String(offering.businessId),
    offeringId: String(offering._id),
  };
}

async function assertInvestorDisputeAccess(userId: string, context: {
  offeringId?: string;
  investorUserId?: string;
}) {
  if (context.investorUserId && context.investorUserId === userId) return;
  if (!context.offeringId) throw new HttpError(403, "Investor is not allowed for this dispute entity");

  const hasSubscription = await SubscriptionModel.exists({
    offeringId: context.offeringId,
    investorUserId: userId,
  });
  if (!hasSubscription) {
    throw new HttpError(403, "Investor is not allowed for this dispute entity");
  }
}

export async function disputeRoutes(app: FastifyInstance) {
  app.get(
    "/v1/disputes",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "dispute");

      const query = z
        .object({
          status: z.enum(["open", "investigating", "resolved", "dismissed"]).optional(),
          entityType: z.enum(disputeEntityTypes).optional(),
          entityId: z.string().optional(),
          limit: z.coerce.number().int().positive().max(200).default(100),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {};
      if (query.status) filter.status = query.status;
      if (query.entityType) filter.entityType = query.entityType;
      if (query.entityId) filter.entityId = query.entityId;

      if (request.authUser.role === "investor") {
        filter.raisedBy = request.authUser.userId;
      }

      if (request.authUser.role === "issuer") {
        const offerings = await OfferingModel.find({
          businessId: request.authUser.businessId,
        })
          .select("_id")
          .lean();
        const offeringIds = offerings.map((item: any) => String(item._id));

        const relatedSubscriptions = await SubscriptionModel.find({
          offeringId: { $in: offeringIds },
        })
          .select("_id")
          .lean();
        const relatedSubscriptionIds = relatedSubscriptions.map((item: any) => String(item._id));

        const relatedDistributions = await DistributionModel.find({
          offeringId: { $in: offeringIds },
        })
          .select("_id")
          .lean();
        const relatedDistributionIds = relatedDistributions.map((item: any) => String(item._id));

        const relatedMilestones = await MilestoneModel.find({
          offeringId: { $in: offeringIds },
        })
          .select("_id")
          .lean();
        const relatedMilestoneIds = relatedMilestones.map((item: any) => String(item._id));

        const relatedTranches = await TrancheModel.find({
          offeringId: { $in: offeringIds },
        })
          .select("_id")
          .lean();
        const relatedTrancheIds = relatedTranches.map((item: any) => String(item._id));

        const relatedApplications = await ApplicationModel.find({
          businessId: request.authUser.businessId,
        })
          .select("_id")
          .lean();
        const relatedApplicationIds = relatedApplications.map((item: any) => String(item._id));

        const allowedByType: Record<string, string[]> = {
          application: relatedApplicationIds,
          offering: offeringIds,
          subscription: relatedSubscriptionIds,
          distribution: relatedDistributionIds,
          milestone: relatedMilestoneIds,
          tranche: relatedTrancheIds,
        };

        if (query.entityType) {
          filter.entityId = { $in: allowedByType[query.entityType] ?? [] };
        } else {
          filter.$or = Object.entries(allowedByType).map(([type, ids]) => ({
            entityType: type,
            entityId: { $in: ids },
          }));
        }
      }

      const disputes = await DisputeModel.find(filter).sort({ createdAt: -1 }).limit(query.limit).lean();
      return serialize(disputes);
    },
  );

  app.post(
    "/v1/disputes",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "dispute");
      const payload = createDisputeSchema.parse(request.body);

      const context = await resolveEntityContext(payload.entityType, payload.entityId);

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, context.businessId);
      }

      if (request.authUser.role === "investor") {
        await assertInvestorDisputeAccess(request.authUser.userId, context);
      }

      const dispute = await DisputeModel.create({
        entityType: payload.entityType,
        entityId: payload.entityId,
        reason: payload.reason,
        details: payload.details,
        status: "open",
        raisedBy: request.authUser.userId,
      });

      await appendEvent(request.authUser, {
        entityType: "dispute",
        entityId: String(dispute._id),
        action: "DisputeOpened",
        notes: `${payload.entityType}:${payload.entityId}`,
      });

      return serialize(dispute.toObject());
    },
  );

  app.patch(
    "/v1/disputes/:id/status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "dispute");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          status: z.enum(["open", "investigating", "resolved", "dismissed"]),
          resolutionNote: z.string().max(2000).optional(),
          assignedTo: z.string().optional(),
        })
        .parse(request.body);

      const dispute = await DisputeModel.findById(params.id);
      if (!dispute) throw new HttpError(404, "Dispute not found");

      dispute.status = payload.status;
      dispute.assignedTo = payload.assignedTo as any;
      if (payload.resolutionNote !== undefined) {
        dispute.resolutionNote = payload.resolutionNote;
      }
      dispute.resolvedAt =
        payload.status === "resolved" || payload.status === "dismissed"
          ? new Date()
          : undefined;
      await dispute.save();

      await appendEvent(request.authUser, {
        entityType: "dispute",
        entityId: String(dispute._id),
        action: "DisputeStatusUpdated",
        notes: payload.status,
      });

      return serialize(dispute.toObject());
    },
  );
}
