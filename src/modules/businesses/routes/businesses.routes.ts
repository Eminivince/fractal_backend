import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createBusinessController } from "../controllers/businesses.controller.js";
import { businessTeamRoutes } from "./team.routes.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import { HttpError } from "../../../utils/errors.js";
import {
  addDirector,
  addShareholder,
  addUbo,
  removeDirector,
  removeShareholder,
  removeUbo,
  suspendBusiness,
  unsuspendBusiness,
} from "../services/businesses.service.js";
import { suspensionReasons } from "../../../utils/constants.js";
import { directorSchema, shareholderSchema, uboSchema } from "../schemas/businesses.schemas.js";

export async function businessRoutes(app: FastifyInstance) {
  const controller = createBusinessController(app);
  await businessTeamRoutes(app);

  app.get("/v1/businesses", { preHandler: [app.authenticate] }, controller.listBusinesses);
  app.get("/v1/businesses/me", { preHandler: [app.authenticate] }, controller.getMyBusiness);
  app.post(
    "/v1/businesses/register",
    { preHandler: [app.authenticate] },
    controller.registerBusiness,
  );
  app.post(
    "/v1/businesses/me/submit-kyb",
    { preHandler: [app.authenticate] },
    controller.submitMyKyb,
  );
  app.get(
    "/v1/businesses/:id/documents",
    { preHandler: [app.authenticate] },
    controller.listDocuments,
  );
  app.post(
    "/v1/businesses/:id/documents",
    { preHandler: [app.authenticate] },
    controller.uploadDocument,
  );
  app.get(
    "/v1/businesses/:id/documents/:docId",
    { preHandler: [app.authenticate] },
    controller.retrieveDocument,
  );
  app.patch(
    "/v1/businesses/:id/kyb-status",
    { preHandler: [app.authenticate] },
    controller.reviewKybStatus,
  );
  app.patch("/v1/businesses/:id", { preHandler: [app.authenticate] }, controller.updateBusiness);
  app.get("/v1/businesses/:id/users", { preHandler: [app.authenticate] }, controller.listUsers);
  app.patch(
    "/v1/businesses/:id/payout-account",
    { preHandler: [app.authenticate] },
    controller.updatePayoutBankAccount,
  );

  // I-01: UBO endpoints
  app.post(
    "/v1/businesses/:id/ubos",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = uboSchema.parse(request.body);
      const ubo = await addUbo(request.authUser, id, payload);
      return serialize(ubo);
    },
  );

  app.delete(
    "/v1/businesses/:id/ubos/:uboId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const { id, uboId } = z.object({ id: z.string(), uboId: z.string() }).parse(request.params);
      return removeUbo(request.authUser, id, uboId);
    },
  );

  // I-02: Director endpoints
  app.post(
    "/v1/businesses/:id/directors",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = directorSchema.parse(request.body);
      const director = await addDirector(request.authUser, id, payload);
      return serialize(director);
    },
  );

  app.delete(
    "/v1/businesses/:id/directors/:directorId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const { id, directorId } = z
        .object({ id: z.string(), directorId: z.string() })
        .parse(request.params);
      return removeDirector(request.authUser, id, directorId);
    },
  );

  // I-03: Shareholder endpoints
  app.post(
    "/v1/businesses/:id/shareholders",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = shareholderSchema.parse(request.body);
      const shareholder = await addShareholder(request.authUser, id, payload);
      return serialize(shareholder);
    },
  );

  app.delete(
    "/v1/businesses/:id/shareholders/:shareholderId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const { id, shareholderId } = z
        .object({ id: z.string(), shareholderId: z.string() })
        .parse(request.params);
      return removeShareholder(request.authUser, id, shareholderId);
    },
  );

  // A-19: Formal suspension endpoint (admin-only)
  app.post(
    "/v1/businesses/:id/suspend",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      if (request.authUser.role !== "admin") throw new HttpError(403, "Admin role required to suspend businesses");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({
        reason: z.enum(suspensionReasons),
        notes: z.string().max(1000).optional(),
      }).parse(request.body);
      const business = await suspendBusiness(request.authUser, id, payload);
      return serialize(business);
    },
  );

  app.post(
    "/v1/businesses/:id/unsuspend",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      if (request.authUser.role !== "admin") throw new HttpError(403, "Admin role required to unsuspend businesses");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const business = await unsuspendBusiness(request.authUser, id);
      return serialize(business);
    },
  );
}
