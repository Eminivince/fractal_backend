import type { FastifyRequest } from "fastify";
import { readCommandId, runIdempotentCommand } from "../../../utils/idempotency.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import {
  acceptWorkOrderSchema,
  assignTaskWorkOrderSchema,
  bulkAssignTasksSchema,
  declineWorkOrderSchema,
  escalateOverdueWorkOrdersSchema,
  listWorkOrdersQuerySchema,
  requestWorkOrderInfoSchema,
  reviewWorkOrderSchema,
  scoreWorkOrderSchema,
  submitWorkOrderOutcomeSchema,
  taskIdParamsSchema,
  uploadDeliverableSchema,
  withdrawWorkOrderSchema,
  workOrderIdParamsSchema,
} from "../schemas/work-orders.schemas.js";
import {
  acceptWorkOrder,
  assignTaskWorkOrder,
  bulkAssignTasks,
  declineWorkOrder,
  escalateOverdueWorkOrders,
  getWorkOrder,
  getWorkOrderInvoice,
  listWorkOrderEvents,
  listWorkOrders,
  requestWorkOrderInfo,
  reviewWorkOrder,
  scoreWorkOrder,
  startWorkOrder,
  startWorkOrderReview,
  submitWorkOrderOutcome,
  uploadWorkOrderDeliverable,
  withdrawWorkOrder,
} from "../services/work-orders.service.js";
import { retrieveFile } from "../../../services/storage.js";

export function createWorkOrderController() {
  return {
    assignTask: async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "work_order");
      const params = taskIdParamsSchema.parse(request.params);
      const payload = assignTaskWorkOrderSchema.parse(request.body);
      const commandId = readCommandId(request.headers);

      const workOrder = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/tasks/:id/assign",
        payload: { id: params.id, ...payload },
        execute: () => assignTaskWorkOrder(request.authUser, params.id, payload),
      });

      return serialize(workOrder);
    },

    list: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "work_order");
      const query = listWorkOrdersQuerySchema.parse(request.query);
      const rows = await listWorkOrders(request.authUser, query);
      return serialize(rows);
    },

    escalateOverdue: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "work_order");
      const payload = escalateOverdueWorkOrdersSchema.parse(request.body ?? {});
      const result = await escalateOverdueWorkOrders(request.authUser, payload);
      return serialize(result);
    },

    getById: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const details = await getWorkOrder(request.authUser, params.id);
      return serialize(details);
    },

    accept: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      // PR-03: parse optional COI body — may be empty if client sends no body
      const payload = request.body && typeof request.body === "object" && Object.keys(request.body).length > 0
        ? acceptWorkOrderSchema.parse(request.body)
        : undefined;
      const workOrder = await acceptWorkOrder(request.authUser, params.id, payload);
      return serialize(workOrder);
    },

    decline: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = declineWorkOrderSchema.parse(request.body);
      const workOrder = await declineWorkOrder(request.authUser, params.id, payload);
      return serialize(workOrder);
    },

    start: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const workOrder = await startWorkOrder(request.authUser, params.id);
      return serialize(workOrder);
    },

    requestInfo: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = requestWorkOrderInfoSchema.parse(request.body);
      const commandId = readCommandId(request.headers);

      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/work-orders/:id/request-info",
        payload: { id: params.id, ...payload },
        execute: () => requestWorkOrderInfo(request.authUser, params.id, payload),
      });

      return serialize(response);
    },

    submitOutcome: async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = submitWorkOrderOutcomeSchema.parse(request.body);
      const commandId = readCommandId(request.headers);

      const workOrder = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/work-orders/:id/submit-outcome",
        payload: { id: params.id, ...payload },
        execute: () => submitWorkOrderOutcome(request.authUser, params.id, payload),
      });

      return serialize(workOrder);
    },

    startReview: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const workOrder = await startWorkOrderReview(request.authUser, params.id);
      return serialize(workOrder);
    },

    review: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = reviewWorkOrderSchema.parse(request.body);
      const commandId = readCommandId(request.headers);

      const workOrder = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/work-orders/:id/review",
        payload: { id: params.id, ...payload },
        execute: () => reviewWorkOrder(request.authUser, params.id, payload),
      });

      return serialize(workOrder);
    },

    events: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const events = await listWorkOrderEvents(request.authUser, params.id);
      return serialize(events);
    },

    score: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = scoreWorkOrderSchema.parse(request.body);
      const workOrder = await scoreWorkOrder(request.authUser, params.id, payload);
      return serialize(workOrder);
    },

    getInvoice: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const invoice = await getWorkOrderInvoice(request.authUser, params.id);
      return serialize(invoice);
    },

    // PR-09: Withdraw mid-work
    withdraw: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = withdrawWorkOrderSchema.parse(request.body);
      const workOrder = await withdrawWorkOrder(request.authUser, params.id, payload);
      return serialize(workOrder);
    },

    // PR-47: Bulk task assignment
    bulkAssign: async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "work_order");
      const payload = bulkAssignTasksSchema.parse(request.body);
      const result = await bulkAssignTasks(request.authUser, payload);
      return serialize(result);
    },

    // PR-15: Upload a deliverable file before outcome submission
    uploadDeliverable: async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "work_order");
      const params = workOrderIdParamsSchema.parse(request.params);
      const payload = uploadDeliverableSchema.parse(request.body);
      const result = await uploadWorkOrderDeliverable(request.authUser, params.id, payload);
      return serialize(result);
    },

    // PR-16: Download / stream a deliverable by index
    downloadDeliverable: async (request: FastifyRequest, reply: any) => {
      authorize(request.authUser, "read", "work_order");
      const params = (request.params as any);
      const workOrderId: string = params.id;
      const deliverableIndex = Number(params.deliverableIndex);

      const details = await getWorkOrder(request.authUser, workOrderId);
      const deliverables = details.workOrder.outcome?.deliverables;
      if (!Array.isArray(deliverables) || !deliverables[deliverableIndex]) {
        return reply.status(404).send({ error: "Deliverable not found" });
      }
      const deliverable = deliverables[deliverableIndex] as any;
      if (!deliverable.storageKey) {
        return reply.status(404).send({ error: "No storage key for deliverable" });
      }

      const file = await retrieveFile(deliverable.storageKey);
      if (file.redirectUrl) {
        return reply.redirect(302, file.redirectUrl);
      }

      const mimeType = (deliverable.mimeType as string | undefined) ?? "application/octet-stream";
      const filename = (deliverable.filename as string | undefined) ?? "deliverable";
      reply.header("Content-Type", mimeType);
      reply.header("Content-Disposition", `attachment; filename="${filename.replace(/"/g, "")}"`);
      return reply.send(file.buffer);
    },
  };
}
