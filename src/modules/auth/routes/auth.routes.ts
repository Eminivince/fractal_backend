import type { FastifyInstance } from "fastify";
import { createAuthController } from "../controllers/auth.controller.js";

export async function authRoutes(app: FastifyInstance) {
  const controller = createAuthController(app);

  app.post("/v1/auth/login", controller.login);
  app.post("/v1/auth/register", controller.register);
  app.post("/v1/auth/sync", controller.sync);
  app.post("/v1/auth/logout", controller.logout);
  app.get("/v1/auth/me", { preHandler: [app.authenticate] }, controller.me);
}
