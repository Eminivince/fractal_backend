import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { WorkOrderTemplateModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import { createWorkOrderController } from "../controllers/work-orders.controller.js";

export async function workOrderRoutes(app: FastifyInstance) {
  const controller = createWorkOrderController();

  app.post(
    "/v1/tasks/:id/assign",
    { preHandler: [app.authenticate] },
    controller.assignTask,
  );

  app.get(
    "/v1/work-orders",
    { preHandler: [app.authenticate] },
    controller.list,
  );

  app.post(
    "/v1/work-orders/escalate-overdue",
    { preHandler: [app.authenticate] },
    controller.escalateOverdue,
  );

  app.get(
    "/v1/work-orders/:id",
    { preHandler: [app.authenticate] },
    controller.getById,
  );

  app.get(
    "/v1/work-orders/:id/events",
    { preHandler: [app.authenticate] },
    controller.events,
  );

  app.post(
    "/v1/work-orders/:id/accept",
    { preHandler: [app.authenticate] },
    controller.accept,
  );

  app.post(
    "/v1/work-orders/:id/decline",
    { preHandler: [app.authenticate] },
    controller.decline,
  );

  app.post(
    "/v1/work-orders/:id/start",
    { preHandler: [app.authenticate] },
    controller.start,
  );

  app.post(
    "/v1/work-orders/:id/request-info",
    { preHandler: [app.authenticate] },
    controller.requestInfo,
  );

  app.post(
    "/v1/work-orders/:id/submit-outcome",
    { preHandler: [app.authenticate] },
    controller.submitOutcome,
  );

  app.post(
    "/v1/work-orders/:id/start-review",
    { preHandler: [app.authenticate] },
    controller.startReview,
  );

  app.post(
    "/v1/work-orders/:id/review",
    { preHandler: [app.authenticate] },
    controller.review,
  );

  app.post(
    "/v1/work-orders/:id/score",
    { preHandler: [app.authenticate] },
    controller.score,
  );

  app.get(
    "/v1/work-orders/:id/invoice",
    { preHandler: [app.authenticate] },
    controller.getInvoice,
  );

  // PR-09: Professional withdrawal after starting work
  app.post(
    "/v1/work-orders/:id/withdraw",
    { preHandler: [app.authenticate] },
    controller.withdraw,
  );

  // PR-47: Bulk assignment of tasks
  app.post(
    "/v1/tasks/bulk-assign",
    { preHandler: [app.authenticate] },
    controller.bulkAssign,
  );

  // PR-15: Dedicated deliverable upload (before outcome submission)
  app.post(
    "/v1/work-orders/:id/upload-deliverable",
    { preHandler: [app.authenticate] },
    controller.uploadDeliverable,
  );

  // PR-16: Download a deliverable by index
  app.get(
    "/v1/work-orders/:id/deliverables/:deliverableIndex",
    { preHandler: [app.authenticate] },
    controller.downloadDeliverable,
  );

  // PR-14: Work order templates CRUD
  const templateSchema = z.object({
    name: z.string().trim().min(2).max(200),
    category: z.enum(["legal", "valuation", "inspection", "trustee", "servicing"]),
    instructions: z.string().trim().min(10).max(5000),
    requiredDeliverableTypes: z.array(z.string().trim().min(1).max(120)).max(20).optional(),
    standardSlaDays: z.number().int().positive().optional(),
    priority: z.enum(["low", "normal", "high"]).default("normal"),
  });

  app.get(
    "/v1/work-order-templates",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "work_order");
      const query = z.object({
        category: z.enum(["legal", "valuation", "inspection", "trustee", "servicing"]).optional(),
      }).parse(request.query);
      const filter: Record<string, unknown> = { isActive: true };
      if (query.category) filter.category = query.category;
      const templates = await WorkOrderTemplateModel.find(filter).sort({ name: 1 }).lean();
      return serialize(templates);
    },
  );

  app.post(
    "/v1/work-order-templates",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "work_order");
      const payload = templateSchema.parse(request.body);
      const template = await WorkOrderTemplateModel.create({
        ...payload,
        createdBy: request.authUser.userId,
      });
      return serialize(template.toObject());
    },
  );

  app.put(
    "/v1/work-order-templates/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = templateSchema.partial().parse(request.body);
      const updated = await WorkOrderTemplateModel.findByIdAndUpdate(params.id, { $set: payload }, { new: true }).lean();
      if (!updated) throw { statusCode: 404, message: "Template not found" };
      return serialize(updated);
    },
  );

  app.delete(
    "/v1/work-order-templates/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = z.object({ id: z.string() }).parse(request.params);
      await WorkOrderTemplateModel.findByIdAndUpdate(params.id, { $set: { isActive: false } });
      return serialize({ ok: true });
    },
  );
}
