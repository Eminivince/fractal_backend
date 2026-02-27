import type { FastifyRequest } from "fastify";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import { readCommandId, runIdempotentCommand } from "../../../utils/idempotency.js";
import {
  applicationIdParamsSchema,
  closeReviewRoundSchema,
  createApplicationSchema,
  createAndSubmitApplicationSchema,
  createReviewRoundSchema,
  decisionPayloadSchema,
  listApplicationsQuerySchema,
  listReviewItemsQuerySchema,
  requestServiceSchema,
  respondReviewItemSchema,
  reviewItemIdParamsSchema,
  reviewRoundIdParamsSchema,
  taskIdParamsSchema,
  taskStatusSchema,
  verifyReviewItemSchema,
  withdrawApplicationSchema,
} from "../schemas/applications.schemas.js";
import {
  approveApplication,
  closeApplicationReviewRound,
  createApplication,
  createAndSubmitApplication,
  createApplicationReviewRound,
  getApplication,
  listApplicationReviewItems,
  listApplicationReviewRounds,
  listApplications,
  listApplicationTasks,
  markApplicationNeedsInfo,
  rejectApplication,
  requestApplicationService,
  respondToReviewItem,
  resubmitApplication,
  reviewApplicationItemResponse,
  startApplicationReview,
  submitApplication,
  updateTaskStatus,
  withdrawApplication,
} from "../services/applications.service.js";

export function createApplicationController() {
  return {
    create: async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "application");
      const payload = createApplicationSchema.parse(request.body);
      const created = await createApplication(request.authUser, payload);
      return serialize(created);
    },

    createAndSubmit: async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "application");
      const payload = createAndSubmitApplicationSchema.parse(request.body);
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/create-and-submit",
        payload,
        execute: () => createAndSubmitApplication(request.authUser, payload),
      });
      return serialize(response);
    },

    list: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const query = listApplicationsQuerySchema.parse(request.query);
      const rows = await listApplications(request.authUser, query);
      return serialize(rows);
    },

    getById: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const application = await getApplication(request.authUser, params.id);
      return serialize(application);
    },

    listTasks: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "task");
      const params = applicationIdParamsSchema.parse(request.params);
      const tasks = await listApplicationTasks(request.authUser, params.id);
      return serialize(tasks);
    },

    submit: async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/submit",
        payload: { id: params.id },
        execute: () => submitApplication(request.authUser, params.id),
      });
      return serialize(response);
    },

    requestService: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const payload = requestServiceSchema.parse(request.body);
      const task = await requestApplicationService(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(task);
    },

    updateTaskStatus: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "task");
      const params = taskIdParamsSchema.parse(request.params);
      const payload = taskStatusSchema.parse(request.body);
      const task = await updateTaskStatus(request.authUser, params.id, payload);
      return serialize(task);
    },

    startReview: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/start-review",
        payload: { id: params.id },
        execute: () => startApplicationReview(request.authUser, params.id),
      });
      return serialize(response);
    },

    needsInfo: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/needs-info",
        payload: { id: params.id },
        execute: () => markApplicationNeedsInfo(request.authUser, params.id),
      });
      return serialize(response);
    },

    resubmit: async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/resubmit",
        payload: { id: params.id },
        execute: () => resubmitApplication(request.authUser, params.id),
      });
      return serialize(response);
    },

    approve: async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const payload = decisionPayloadSchema.parse(request.body ?? {});
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/approve",
        payload: { id: params.id, ...payload },
        execute: () => approveApplication(request.authUser, params.id, payload),
      });
      return serialize(response);
    },

    reject: async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const payload = decisionPayloadSchema.parse(request.body ?? {});
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/reject",
        payload: { id: params.id, ...payload },
        execute: () => rejectApplication(request.authUser, params.id, payload),
      });
      return serialize(response);
    },

    withdraw: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const payload = withdrawApplicationSchema.parse(request.body ?? {});
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/withdraw",
        payload: { id: params.id, reason: payload.reason ?? null },
        execute: () =>
          withdrawApplication(request.authUser, params.id, payload.reason),
      });
      return serialize(response);
    },

    listReviewRounds: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const rows = await listApplicationReviewRounds(request.authUser, params.id);
      return serialize(rows);
    },

    listReviewItems: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const query = listReviewItemsQuerySchema.parse(request.query);
      const rows = await listApplicationReviewItems(
        request.authUser,
        params.id,
        query,
      );
      return serialize(rows);
    },

    openReviewRound: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      const params = applicationIdParamsSchema.parse(request.params);
      const payload = createReviewRoundSchema.parse(request.body);
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/review-rounds",
        payload: { id: params.id, ...payload },
        execute: () =>
          createApplicationReviewRound(request.authUser, params.id, payload),
      });
      return serialize(response);
    },

    respondReviewItem: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "application");
      const params = reviewItemIdParamsSchema.parse(request.params);
      const payload = respondReviewItemSchema.parse(request.body);
      const item = await respondToReviewItem(request.authUser, params.id, payload);
      return serialize(item);
    },

    verifyReviewItem: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      const params = reviewItemIdParamsSchema.parse(request.params);
      const payload = verifyReviewItemSchema.parse(request.body);
      const item = await reviewApplicationItemResponse(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(item);
    },

    closeReviewRound: async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      const params = reviewRoundIdParamsSchema.parse(request.params);
      closeReviewRoundSchema.parse(request.body ?? {});
      const commandId = readCommandId(request.headers);
      const response = await runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/review-rounds/:id/close",
        payload: { id: params.id },
        execute: () => closeApplicationReviewRound(request.authUser, params.id),
      });
      return serialize(response);
    },
  };
}
