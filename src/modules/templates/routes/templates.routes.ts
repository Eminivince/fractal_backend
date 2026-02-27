import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { TemplateModel } from "../../../db/models.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";

const templateUpdateSchema = z.object({
  name: z.string().optional(),
  checklistItems: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        requiredStage: z.enum(["Intake", "Diligence", "Structuring", "Compliance"]),
      }),
    )
    .optional(),
  termSchema: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        type: z.enum(["number", "string", "enum", "array", "date"]),
        required: z.boolean().optional(),
        options: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  enabled: z.boolean().optional(),
});

export async function templateRoutes(app: FastifyInstance) {
  app.get(
    "/v1/templates",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "template");
      const templates = await TemplateModel.find().lean();
      return serialize(templates);
    },
  );

  app.put(
    "/v1/templates/:code",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "template");
      const params = z.object({ code: z.enum(["A", "B"]) }).parse(request.params);
      const payload = templateUpdateSchema.parse(request.body);

      const template = await TemplateModel.findOne({ code: params.code });
      if (!template) throw new HttpError(404, "Template not found");

      if (payload.name !== undefined) template.name = payload.name;
      if (payload.checklistItems !== undefined) template.checklistItems = payload.checklistItems as any;
      if (payload.termSchema !== undefined) template.termSchema = payload.termSchema as any;
      if (payload.enabled !== undefined) template.enabled = payload.enabled;

      template.updatedBy = request.authUser.userId as any;
      template.updatedAt = new Date();
      await template.save();

      await appendEvent(request.authUser, {
        entityType: "template",
        entityId: String(template._id),
        action: `Template ${params.code} updated`,
      });

      return serialize(template.toObject());
    },
  );
}
