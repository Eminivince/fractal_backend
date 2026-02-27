import type { FastifyInstance } from "fastify";
import { createProfessionalController } from "../controllers/professionals.controller.js";

export async function professionalRoutes(app: FastifyInstance) {
  const controller = createProfessionalController(app);

  app.get("/v1/professionals", { preHandler: [app.authenticate] }, controller.list);
  app.post("/v1/professionals", { preHandler: [app.authenticate] }, controller.create);
  app.put("/v1/professionals/:id", { preHandler: [app.authenticate] }, controller.update);
  app.patch(
    "/v1/professionals/:id/status",
    { preHandler: [app.authenticate] },
    controller.updateStatus,
  );

  app.post(
    "/v1/professionals/register",
    { preHandler: [app.authenticate] },
    controller.register,
  );
  app.post(
    "/v1/professionals/me/submit-onboarding",
    { preHandler: [app.authenticate] },
    controller.submitOnboarding,
  );
  app.patch(
    "/v1/professionals/:id/onboarding-status",
    { preHandler: [app.authenticate] },
    controller.reviewOnboarding,
  );
}
