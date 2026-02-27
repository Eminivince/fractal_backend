/**
 * 5.3: Offering document management routes.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { OfferingModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";

export async function offeringDocumentRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings/:id/documents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({
        docType: z.enum(["prospectus", "risk_disclosure", "legal", "supplemental"]),
        label: z.string().min(1).max(200),
        storageKey: z.string().min(1),
      }).parse(request.body);

      const offering = await OfferingModel.findById(id);
      if (!offering) throw new HttpError(404, "Offering not found");

      // Scope check for issuers
      if (request.authUser.role === "issuer" && String(offering.businessId) !== request.authUser.businessId) {
        throw new HttpError(403, "Not your offering");
      }

      if (!offering.documents) offering.documents = [];
      offering.documents.push({
        docType: payload.docType,
        label: payload.label,
        storageKey: payload.storageKey,
        uploadedAt: new Date(),
        version: 1,
      } as any);

      await offering.save();
      return serialize(offering.documents[offering.documents.length - 1]);
    },
  );

  app.get(
    "/v1/offerings/:id/documents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const { id } = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(id).select("documents").lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      return serialize(offering.documents ?? []);
    },
  );

  app.delete(
    "/v1/offerings/:id/documents/:docId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      const { id, docId } = z.object({ id: z.string(), docId: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(id);
      if (!offering) throw new HttpError(404, "Offering not found");

      if (offering.status !== "draft") {
        throw new HttpError(422, "Documents can only be removed from draft offerings");
      }

      if (request.authUser.role === "issuer" && String(offering.businessId) !== request.authUser.businessId) {
        throw new HttpError(403, "Not your offering");
      }

      const idx = (offering.documents ?? []).findIndex((d: any) => String(d._id) === docId);
      if (idx === -1) throw new HttpError(404, "Document not found");

      offering.documents.splice(idx, 1);
      await offering.save();

      return { ok: true };
    },
  );
}
