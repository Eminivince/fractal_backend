import type { FastifyInstance } from "fastify";
import { createApplicationController } from "../controllers/applications.controller.js";

export async function applicationRoutes(app: FastifyInstance) {
  const controller = createApplicationController();

  // Register literal path BEFORE parameterized :id routes so create-and-submit isn't captured as :id
  app.post(
    "/v1/applications/create-and-submit",
    { preHandler: [app.authenticate] },
    controller.createAndSubmit,
  );
  app.post("/v1/applications", { preHandler: [app.authenticate] }, controller.create);
  app.get("/v1/applications", { preHandler: [app.authenticate] }, controller.list);
  app.get("/v1/applications/:id", { preHandler: [app.authenticate] }, controller.getById);
  app.get(
    "/v1/applications/:id/tasks",
    { preHandler: [app.authenticate] },
    controller.listTasks,
  );
  app.post(
    "/v1/applications/:id/submit",
    { preHandler: [app.authenticate] },
    controller.submit,
  );
  app.post(
    "/v1/applications/:id/request-service",
    { preHandler: [app.authenticate] },
    controller.requestService,
  );
  app.patch("/v1/tasks/:id/status", { preHandler: [app.authenticate] }, controller.updateTaskStatus);
  app.post(
    "/v1/applications/:id/start-review",
    { preHandler: [app.authenticate] },
    controller.startReview,
  );
  app.post(
    "/v1/applications/:id/needs-info",
    { preHandler: [app.authenticate] },
    controller.needsInfo,
  );
  app.post(
    "/v1/applications/:id/resubmit",
    { preHandler: [app.authenticate] },
    controller.resubmit,
  );
  app.post(
    "/v1/applications/:id/approve",
    { preHandler: [app.authenticate] },
    controller.approve,
  );
  app.post(
    "/v1/applications/:id/reject",
    { preHandler: [app.authenticate] },
    controller.reject,
  );
  app.post(
    "/v1/applications/:id/withdraw",
    { preHandler: [app.authenticate] },
    controller.withdraw,
  );
  // Review round routes are in review.routes.ts to avoid FST_ERR_DUPLICATED_ROUTE
  app.get(
    "/v1/applications/:id/review-items",
    { preHandler: [app.authenticate] },
    controller.listReviewItems,
  );
  app.post(
    "/v1/review-items/:id/respond",
    { preHandler: [app.authenticate] },
    controller.respondReviewItem,
  );
  app.post(
    "/v1/review-items/:id/verify",
    { preHandler: [app.authenticate] },
    controller.verifyReviewItem,
  );
  app.post(
    "/v1/review-rounds/:id/close",
    { preHandler: [app.authenticate] },
    controller.closeReviewRound,
  );
}
