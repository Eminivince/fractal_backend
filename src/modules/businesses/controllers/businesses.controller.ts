import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

const listBusinessesQuerySchema = z.object({
  name: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});
import { requireRole } from "../../../middleware/role-guard.js";
import { authorize } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import {
  businessDocumentUploadSchema,
  businessIdParamsSchema,
  businessIssuerUpdateSchema,
  businessKybReviewSchema,
  businessRegistrationSchema,
  businessUpdateSchema,
  payoutBankAccountSchema,
} from "../schemas/businesses.schemas.js";
import {
  getIssuerBusiness,
  listBusinessesForUser,
  listBusinessDocuments,
  listBusinessUsers,
  registerIssuerBusiness,
  retrieveBusinessDocument,
  reviewBusinessKybStatus,
  submitIssuerBusinessKyb,
  updateBusinessProfile,
  updatePayoutBankAccount,
  uploadBusinessDocument,
} from "../services/businesses.service.js";

export function createBusinessController(app: FastifyInstance) {
  return {
    listBusinesses: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const query = listBusinessesQuerySchema.parse(request.query);
      const result = await listBusinessesForUser(request.authUser, query);
      return serialize(result);
    },

    getMyBusiness: async (request: FastifyRequest) => {
      requireRole(request.authUser, "issuer");
      const business = await getIssuerBusiness(request.authUser);
      return serialize(business);
    },

    registerBusiness: async (request: FastifyRequest) => {
      requireRole(request.authUser, "issuer");
      const payload = businessRegistrationSchema.parse(request.body);
      const created = await registerIssuerBusiness(app, request.authUser, payload);
      return {
        token: created.token,
        business: serialize(created.business),
        user: serialize(created.user),
      };
    },

    submitMyKyb: async (request: FastifyRequest) => {
      requireRole(request.authUser, "issuer");
      const business = await submitIssuerBusinessKyb(request.authUser);
      return serialize(business);
    },

    listDocuments: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = businessIdParamsSchema.parse(request.params);
      const documents = await listBusinessDocuments(request.authUser, params.id);
      return serialize(documents);
    },

    uploadDocument: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = businessIdParamsSchema.parse(request.params);
      const payload = businessDocumentUploadSchema.parse(request.body);
      const document = await uploadBusinessDocument(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(document);
    },

    retrieveDocument: async (request: FastifyRequest, reply: FastifyReply) => {
      authorize(request.authUser, "read", "business");
      const { z } = await import("zod");
      const params = z.object({ id: z.string(), docId: z.string() }).parse(request.params);
      const { doc, buffer, redirectUrl } = await retrieveBusinessDocument(
        request.authUser,
        params.id,
        params.docId,
      );
      if (redirectUrl) {
        return reply.redirect(redirectUrl, 302);
      }
      const mimeType = (doc as any).mimeType ?? "application/octet-stream";
      reply.header("Content-Type", mimeType);
      reply.header("Content-Disposition", `attachment; filename="${(doc as any).filename}"`);
      reply.header("Content-Length", buffer.length);
      return reply.send(buffer);
    },

    reviewKybStatus: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      requireRole(request.authUser, "admin");
      const params = businessIdParamsSchema.parse(request.params);
      const payload = businessKybReviewSchema.parse(request.body);
      const business = await reviewBusinessKybStatus(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(business);
    },

    updateBusiness: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = businessIdParamsSchema.parse(request.params);
      // A-77: Apply role-appropriate schema — issuers may only update
      // non-governance fields; admin/operator may update all fields.
      const role = request.authUser.role;
      const payload =
        role === "issuer"
          ? businessIssuerUpdateSchema.parse(request.body)
          : businessUpdateSchema.parse(request.body);
      const business = await updateBusinessProfile(
        request.authUser,
        params.id,
        payload,
      );
      return serialize(business);
    },

    listUsers: async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = businessIdParamsSchema.parse(request.params);
      const users = await listBusinessUsers(request.authUser, params.id);
      return serialize(users);
    },

    updatePayoutBankAccount: async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = businessIdParamsSchema.parse(request.params);
      const payload = payoutBankAccountSchema.parse(request.body);
      const business = await updatePayoutBankAccount(request.authUser, params.id, payload);
      return serialize(business);
    },
  };
}
