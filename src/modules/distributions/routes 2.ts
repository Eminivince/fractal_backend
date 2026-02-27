import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DistributionModel, OfferingModel, SubscriptionModel } from "../../db/models.js";
import { toDecimal } from "../../utils/decimal.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { assertTransition } from "../../utils/state-machine.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";
import { runInTransaction } from "../../utils/tx.js";
import { serialize } from "../../utils/serialize.js";

const createDistributionSchema = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/),
  amount: z.number().positive(),
});

export async function distributionRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings/:id/distributions",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "distribution");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = createDistributionSchema.parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        if (offering.templateCode !== "A") {
          throw new HttpError(422, "Distributions endpoint is only valid for Template A offerings");
        }

        const [distribution] = await DistributionModel.create(
          [
            {
              offeringId: offering._id,
              period: payload.period,
              amount: toDecimal(payload.amount),
              status: "draft",
              createdBy: request.authUser.userId,
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "distribution",
            entityId: String(distribution._id),
            action: "Distribution draft created",
            notes: payload.period,
          },
          session,
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "Distribution created",
            notes: payload.period,
          },
          session,
        );

        return serialize(distribution.toObject());
      });
    },
  );

  app.post(
    "/v1/distributions/:id/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "distribution");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
      const params = z.object({ id: z.string() }).parse(request.params);

      const distribution = await DistributionModel.findById(params.id);
      if (!distribution) throw new HttpError(404, "Distribution not found");

      const offering = await OfferingModel.findById(distribution.offeringId).lean();
      if (!offering) throw new HttpError(404, "Offering not found");
      assertIssuerBusinessScope(request.authUser, String(offering.businessId));

      assertTransition("distribution", distribution.status as any, "pending_approval");
      distribution.status = "pending_approval";
      await distribution.save();

      await appendEvent(request.authUser, {
        entityType: "distribution",
        entityId: String(distribution._id),
        action: "Distribution submitted",
      });

      return serialize(distribution.toObject());
    },
  );

  app.post(
    "/v1/distributions/:id/approve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "approve", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const distribution = await DistributionModel.findById(params.id).session(session);
        if (!distribution) throw new HttpError(404, "Distribution not found");

        assertTransition("distribution", distribution.status as any, "scheduled");
        distribution.status = "scheduled";
        distribution.approvedBy = request.authUser.userId as any;
        await distribution.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "distribution",
            entityId: String(distribution._id),
            action: "Distribution approved",
          },
          session,
        );

        return serialize(distribution.toObject());
      });
    },
  );

  app.post(
    "/v1/distributions/:id/mark-paid",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const distribution = await DistributionModel.findById(params.id).session(session);
        if (!distribution) throw new HttpError(404, "Distribution not found");

        assertTransition("distribution", distribution.status as any, "paid");
        distribution.status = "paid";
        distribution.paidAt = new Date();
        await distribution.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "distribution",
            entityId: String(distribution._id),
            action: "Distribution marked paid",
          },
          session,
        );

        return serialize(distribution.toObject());
      });
    },
  );

  app.get(
    "/v1/offerings/:id/distributions",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "distribution");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      if (request.authUser.role === "investor") {
        const hasSubscription = await SubscriptionModel.exists({
          offeringId: offering._id,
          investorUserId: request.authUser.userId,
        });
        if (!hasSubscription) throw new HttpError(403, "Investor has no access to this offering distributions");
      }

      const rows = await DistributionModel.find({ offeringId: offering._id }).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );
}
