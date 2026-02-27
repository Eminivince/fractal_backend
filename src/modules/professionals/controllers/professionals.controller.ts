import type { FastifyInstance, FastifyRequest } from "fastify";
import { requireRole } from "../../../middleware/role-guard.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import {
  createProfessionalSchema,
  professionalIdParamsSchema,
  professionalListQuerySchema,
  professionalOnboardingReviewSchema,
  professionalRegisterSchema,
  professionalStatusUpdateSchema,
  updateProfessionalSchema,
} from "../schemas/professionals.schemas.js";
import {
  createProfessional,
  listProfessionals,
  registerProfessionalProfile,
  reviewProfessionalOnboarding,
  submitProfessionalOnboarding,
  updateProfessional,
  updateProfessionalStatus,
} from "../services/professionals.service.js";

export function createProfessionalController(app: FastifyInstance) {
  return {
    list: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "professional");
      const query = professionalListQuerySchema.parse(request.query);
      const rows = await listProfessionals(query);
      return serialize(rows);
    },

    create: async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "professional");
      const payload = createProfessionalSchema.parse(request.body);
      const created = await createProfessional(request.authUser, payload);
      return serialize(created);
    },

    update: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "professional");
      const params = professionalIdParamsSchema.parse(request.params);
      const payload = updateProfessionalSchema.parse(request.body);
      const updated = await updateProfessional(request.authUser, params.id, payload);
      return serialize(updated);
    },

    updateStatus: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "professional");
      const params = professionalIdParamsSchema.parse(request.params);
      const payload = professionalStatusUpdateSchema.parse(request.body);
      const updated = await updateProfessionalStatus(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(updated);
    },

    register: async (request: FastifyRequest) => {
      requireRole(request.authUser, "professional");
      authorize(request.authUser, "update", "professional");
      const payload = professionalRegisterSchema.parse(request.body);
      const response = await registerProfessionalProfile(app, request.authUser, payload);
      return {
        token: response.token,
        professional: serialize(response.professional),
        user: serialize(response.user),
      };
    },

    submitOnboarding: async (request: FastifyRequest) => {
      requireRole(request.authUser, "professional");
      authorize(request.authUser, "update", "professional");
      const professional = await submitProfessionalOnboarding(request.authUser);
      return serialize(professional);
    },

    reviewOnboarding: async (request: FastifyRequest) => {
      requireRole(request.authUser, "admin");
      authorize(request.authUser, "update", "professional");
      const params = professionalIdParamsSchema.parse(request.params);
      const payload = professionalOnboardingReviewSchema.parse(request.body);
      const professional = await reviewProfessionalOnboarding(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(professional);
    },
  };
}
