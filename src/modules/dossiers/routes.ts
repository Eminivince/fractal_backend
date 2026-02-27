import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApplicationModel, DossierModel } from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";
import { runInTransaction } from "../../utils/tx.js";
import { serialize } from "../../utils/serialize.js";
import { persistDossierBinary } from "../../services/storage.js";

const uploadDocSchema = z.object({
  type: z.string().min(2),
  filename: z.string().min(2),
  storageKey: z.string().optional(),
  contentBase64: z.string().min(8).optional(),
  mimeType: z.string().optional(),
  stageTag: z.enum(["Intake", "Diligence", "Structuring", "Compliance", "Issuance", "Servicing", "Exit"]),
});

export async function dossierRoutes(app: FastifyInstance) {
  app.get(
    "/v1/applications/:id/dossier",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "dossier");
      const params = z.object({ id: z.string() }).parse(request.params);

      const application = await ApplicationModel.findById(params.id).lean();
      if (!application) throw new HttpError(404, "Application not found");
      assertIssuerBusinessScope(request.authUser, String(application.businessId));

      const dossier = await DossierModel.findOne({ applicationId: application._id }).lean();
      if (!dossier) throw new HttpError(404, "Dossier not found");

      return serialize(dossier);
    },
  );

  app.post(
    "/v1/applications/:id/dossier/documents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "dossier");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = uploadDocSchema.parse(request.body);

      return runInTransaction(async (session) => {
        const application = await ApplicationModel.findById(params.id).session(session);
        if (!application) throw new HttpError(404, "Application not found");
        assertIssuerBusinessScope(request.authUser, String(application.businessId));

        const dossier = await DossierModel.findOne({ applicationId: application._id }).session(session);
        if (!dossier) throw new HttpError(404, "Dossier not found");

        let storageKey =
          payload.storageKey ??
          `manual://dossiers/${application._id.toString()}/${Date.now()}-${payload.filename.replace(/[^a-z0-9.\-_]+/gi, "-").toLowerCase()}`;

        if (payload.contentBase64) {
          const persisted = await persistDossierBinary({
            applicationId: String(application._id),
            filename: payload.filename,
            contentBase64: payload.contentBase64,
            mimeType: payload.mimeType,
          });
          storageKey = persisted.storageKey;
          dossier.hashes.push({
            algo: "sha256",
            hash: persisted.sha256,
            createdAt: new Date(),
          });
        }

        dossier.documents.push({
          type: payload.type,
          filename: payload.filename,
          mimeType: payload.mimeType,
          storageKey,
          uploadedBy: request.authUser.userId as any,
          uploadedAt: new Date(),
          stageTag: payload.stageTag,
        });

        // Keep checklist state aligned with uploaded dossier docs.
        application.checklistState = application.checklistState.map((item: any) => {
          const labelMatch = item.label.toLowerCase() === payload.type.toLowerCase();
          const keyMatch = item.key.toLowerCase() === payload.type.toLowerCase();
          if ((labelMatch || keyMatch) && item.status === "missing") {
            return { ...item, status: "provided" as const };
          }
          return item;
        }) as any;

        await application.save({ session });
        await dossier.save({ session });

        const createdDoc = dossier.documents[dossier.documents.length - 1];

        await appendEvent(
          request.authUser,
          {
            entityType: "application",
            entityId: String(application._id),
            action: "Dossier document uploaded",
            notes: `${payload.type}: ${payload.filename}`,
          },
          session,
        );

        return serialize(createdDoc?.toObject ? createdDoc.toObject() : createdDoc);
      });
    },
  );

  app.patch(
    "/v1/applications/:id/dossier/structuredData",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "dossier");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ structuredData: z.record(z.string(), z.unknown()) }).parse(request.body);

      const application = await ApplicationModel.findById(params.id).lean();
      if (!application) throw new HttpError(404, "Application not found");
      assertIssuerBusinessScope(request.authUser, String(application.businessId));

      const dossier = await DossierModel.findOneAndUpdate(
        { applicationId: application._id },
        { structuredData: payload.structuredData },
        { new: true },
      ).lean();

      if (!dossier) throw new HttpError(404, "Dossier not found");

      await appendEvent(request.authUser, {
        entityType: "application",
        entityId: String(application._id),
        action: "Dossier structured data updated",
      });

      return serialize(dossier);
    },
  );
}
