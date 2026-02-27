import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import mongoose from "mongoose";
import {
  ApplicationModel,
  AssetModel,
  DossierModel,
  ProfessionalModel,
  TaskModel,
  TemplateModel,
} from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError, assert } from "../../utils/errors.js";
import { assertTransition } from "../../utils/state-machine.js";
import { runInTransaction } from "../../utils/tx.js";
import { serialize } from "../../utils/serialize.js";
import { readCommandId, runIdempotentCommand } from "../../utils/idempotency.js";

const createAssetSchema = z.object({
  name: z.string().min(2),
  country: z.string().default("Nigeria"),
  state: z.string().min(2),
  city: z.string().min(2),
  addressLine: z.string().optional(),
  summary: z.string().min(2),
});

const createApplicationSchema = z.object({
  templateCode: z.enum(["A", "B"]),
  assetId: z.string().optional(),
  asset: createAssetSchema.optional(),
  checklistState: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        stage: z.enum(["Intake", "Diligence", "Structuring", "Compliance"]),
        required: z.boolean().default(true),
        status: z.enum(["missing", "provided", "verified"]).default("missing"),
      }),
    )
    .optional(),
  milestones: z
    .array(
      z.object({
        name: z.string(),
        percent: z.number().positive(),
        targetDate: z.string(),
      }),
    )
    .optional(),
});

const requestServiceSchema = z.object({
  professionalId: z.string(),
  stage: z.enum(["Diligence", "Structuring"]).default("Diligence"),
});

function mapProfessionalCategory(category: string): "inspection" | "valuation" | "legal" | "servicing" {
  if (category === "inspector") return "inspection";
  if (category === "valuer") return "valuation";
  if (category === "lawyer" || category === "trustee") return "legal";
  return "servicing";
}

export async function applicationRoutes(app: FastifyInstance) {
  app.post(
    "/v1/applications",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "application");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const payload = createApplicationSchema.parse(request.body);
      const template = await TemplateModel.findOne({ code: payload.templateCode, enabled: true }).lean();
      if (!template) throw new HttpError(404, "Template not found or disabled");

      return runInTransaction(async (session) => {
        let assetId = payload.assetId;
        if (!assetId) {
          assert(payload.asset, 422, "Asset details required when assetId is not supplied");
          const [asset] = await AssetModel.create(
            [
              {
                businessId: request.authUser.businessId,
                type: "real_estate",
                name: payload.asset.name,
                location: {
                  country: payload.asset.country,
                  state: payload.asset.state,
                  city: payload.asset.city,
                  addressLine: payload.asset.addressLine,
                },
                summary: payload.asset.summary,
              },
            ],
            { session },
          );
          assetId = String(asset._id);
        }

        const checklistState =
          payload.checklistState ??
          template.checklistItems.map((item: any) => ({
            key: item.key,
            label: item.label,
            stage: item.requiredStage,
            required: true,
            status: "missing" as const,
          }));

        const [application] = await ApplicationModel.create(
          [
            {
              businessId: request.authUser.businessId,
              templateCode: payload.templateCode,
              assetId,
              stage: "Intake",
              status: "draft",
              checklistState,
              milestones: payload.milestones?.map((milestone) => ({
                ...milestone,
                targetDate: new Date(milestone.targetDate),
              })),
              createdBy: request.authUser.userId,
            },
          ],
          { session },
        );

        await DossierModel.create(
          [
            {
              applicationId: application._id,
              structuredData: {},
              documents: [],
              hashes: [],
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "application",
            entityId: String(application._id),
            action: "ApplicationCreated",
          },
          session,
        );

        return serialize(application.toObject());
      });
    },
  );

  app.get(
    "/v1/applications",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const query = z
        .object({
          status: z
            .enum(["draft", "submitted", "in_review", "needs_info", "approved", "rejected", "withdrawn"])
            .optional(),
          templateCode: z.enum(["A", "B"]).optional(),
          stage: z
            .enum(["Intake", "Diligence", "Structuring", "Compliance", "Issuance", "Servicing", "Exit"])
            .optional(),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {};
      if (request.authUser.role === "issuer") filter.businessId = request.authUser.businessId;
      if (query.status) filter.status = query.status;
      if (query.templateCode) filter.templateCode = query.templateCode;
      if (query.stage) filter.stage = query.stage;

      const rows = await ApplicationModel.find(filter).sort({ createdAt: -1 }).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/applications/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const application = await ApplicationModel.findById(params.id).lean();
      if (!application) throw new HttpError(404, "Application not found");
      assertIssuerBusinessScope(request.authUser, application.businessId ? String(application.businessId) : undefined);
      return serialize(application);
    },
  );

  app.get(
    "/v1/applications/:id/tasks",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "task");
      const params = z.object({ id: z.string() }).parse(request.params);

      const application = await ApplicationModel.findById(params.id).lean();
      if (!application) throw new HttpError(404, "Application not found");
      assertIssuerBusinessScope(request.authUser, application.businessId ? String(application.businessId) : undefined);

      const tasks = await TaskModel.find({ applicationId: application._id }).sort({ createdAt: 1 }).lean();
      return serialize(tasks);
    },
  );

  app.post(
    "/v1/applications/:id/submit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/submit",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const application = await ApplicationModel.findById(params.id).session(session);
            if (!application) throw new HttpError(404, "Application not found");
            assertIssuerBusinessScope(request.authUser, application.businessId ? String(application.businessId) : undefined);

            const minimumDocsSatisfied = application.checklistState
              .filter((item: any) => item.stage === "Intake" && item.required)
              .every((item: any) => item.status !== "missing");

            assertTransition("application", application.status as any, "submitted", {
              minimumDocsSatisfied,
            });

            application.status = "submitted";
            application.submittedAt = new Date();
            application.stage = "Diligence";
            await application.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "application",
                entityId: String(application._id),
                action: "ApplicationSubmitted",
              },
              session,
            );

            return serialize(application.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/applications/:id/request-service",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = requestServiceSchema.parse(request.body);

      return runInTransaction(async (session) => {
        const application = await ApplicationModel.findById(params.id).session(session);
        if (!application) throw new HttpError(404, "Application not found");
        assertIssuerBusinessScope(request.authUser, application.businessId ? String(application.businessId) : undefined);

        const professional = await ProfessionalModel.findById(payload.professionalId).session(session);
        if (!professional || professional.status !== "active") {
          throw new HttpError(404, "Professional not available");
        }

        const category = mapProfessionalCategory(professional.category);

        const [task] = await TaskModel.create(
          [
            {
              applicationId: application._id,
              stage: payload.stage,
              category,
              assignedProfessionalId: professional._id,
              assignedAt: new Date(),
              status: "open",
              slaDays: professional.slaDays,
              evidenceDocs: [],
            },
          ],
          { session },
        );

        if (application.stage === "Intake") application.stage = payload.stage;
        await application.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "task",
            entityId: String(task._id),
            action: "ApplicationTaskRequested",
            notes: `${professional.name} (${professional.category})`,
          },
          session,
        );

        return serialize(task.toObject());
      });
    },
  );

  app.patch(
    "/v1/tasks/:id/status",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "task");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ status: z.enum(["open", "in_progress", "completed", "rejected"]) }).parse(request.body);

      const task = await TaskModel.findById(params.id);
      if (!task) throw new HttpError(404, "Task not found");

      if (request.authUser.role === "issuer") {
        const appRecord = await ApplicationModel.findById(task.applicationId).lean();
        assertIssuerBusinessScope(request.authUser, appRecord?.businessId ? String(appRecord.businessId) : undefined);
      }

      task.status = payload.status;
      if (payload.status === "completed") task.completedAt = new Date();
      await task.save();

      await appendEvent(request.authUser, {
        entityType: "task",
        entityId: String(task._id),
        action: "ApplicationTaskStatusUpdated",
        notes: payload.status,
      });

      return serialize(task.toObject());
    },
  );

  app.post(
    "/v1/applications/:id/start-review",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/start-review",
        payload: { id: params.id },
        execute: async () => {
          const application = await ApplicationModel.findById(params.id);
          if (!application) throw new HttpError(404, "Application not found");

          assertTransition("application", application.status as any, "in_review");
          application.status = "in_review";
          if (application.stage === "Intake") application.stage = "Diligence";
          await application.save();

          await appendEvent(request.authUser, {
            entityType: "application",
            entityId: String(application._id),
            action: "ApplicationReviewStarted",
          });

          return serialize(application.toObject());
        },
      });
    },
  );

  app.post(
    "/v1/applications/:id/needs-info",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/needs-info",
        payload: { id: params.id },
        execute: async () => {
          const application = await ApplicationModel.findById(params.id);
          if (!application) throw new HttpError(404, "Application not found");

          assertTransition("application", application.status as any, "needs_info");
          application.status = "needs_info";
          await application.save();

          await appendEvent(request.authUser, {
            entityType: "application",
            entityId: String(application._id),
            action: "ApplicationNeedsInfo",
          });

          return serialize(application.toObject());
        },
      });
    },
  );

  app.post(
    "/v1/applications/:id/resubmit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "application");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/resubmit",
        payload: { id: params.id },
        execute: async () => {
          const application = await ApplicationModel.findById(params.id);
          if (!application) throw new HttpError(404, "Application not found");
          assertIssuerBusinessScope(request.authUser, application.businessId ? String(application.businessId) : undefined);

          assertTransition("application", application.status as any, "submitted");
          application.status = "submitted";
          await application.save();

          await appendEvent(request.authUser, {
            entityType: "application",
            entityId: String(application._id),
            action: "ApplicationSubmitted",
            notes: "resubmission",
          });

          return serialize(application.toObject());
        },
      });
    },
  );

  app.post(
    "/v1/applications/:id/approve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/approve",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const application = await ApplicationModel.findById(params.id).session(session);
            if (!application) throw new HttpError(404, "Application not found");

            const tasks = await TaskModel.find({ applicationId: application._id }).session(session);
            const requiredCategories = new Set(["inspection", "valuation", "legal"]);
            const completedCategories = new Set(
              tasks.filter((task: any) => task.status === "completed").map((task: any) => task.category),
            );

            const tasksComplete = tasks.length > 0 && tasks.every((task: any) => task.status === "completed");
            const evidenceVerified = tasks.every(
              (task: any) => task.status !== "completed" || (Array.isArray(task.evidenceDocs) && task.evidenceDocs.length > 0),
            );
            const legalChecklistSatisfied = [...requiredCategories].every((category) => completedCategories.has(category));

            assertTransition("application", application.status as any, "approved", {
              tasksComplete,
              evidenceVerified,
              legalChecklistSatisfied,
            });

            application.status = "approved";
            application.stage = "Compliance";
            application.approvedAt = new Date();
            await application.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "application",
                entityId: String(application._id),
                action: "ApplicationApproved",
              },
              session,
            );

            return serialize(application.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/applications/:id/reject",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/reject",
        payload: { id: params.id },
        execute: async () => {
          const application = await ApplicationModel.findById(params.id);
          if (!application) throw new HttpError(404, "Application not found");

          assertTransition("application", application.status as any, "rejected");
          application.status = "rejected";
          application.rejectedAt = new Date();
          await application.save();

          await appendEvent(request.authUser, {
            entityType: "application",
            entityId: String(application._id),
            action: "ApplicationRejected",
          });

          return serialize(application.toObject());
        },
      });
    },
  );

  app.post(
    "/v1/applications/:id/withdraw",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "application");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3).optional() }).parse(request.body ?? {});
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/applications/:id/withdraw",
        payload: { id: params.id, reason: payload.reason ?? null },
        execute: async () => {
          const application = await ApplicationModel.findById(params.id);
          if (!application) throw new HttpError(404, "Application not found");
          assertIssuerBusinessScope(request.authUser, application.businessId ? String(application.businessId) : undefined);

          assertTransition("application", application.status as any, "withdrawn");
          application.status = "withdrawn";
          application.withdrawnAt = new Date();
          await application.save();

          await appendEvent(request.authUser, {
            entityType: "application",
            entityId: String(application._id),
            action: "ApplicationWithdrawn",
            notes: payload.reason,
          });

          return serialize(application.toObject());
        },
      });
    },
  );
}
