import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ReconciliationIssueModel, ReconciliationRunModel } from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { runReconciliation } from "../../services/reconciliation.js";

export async function reconciliationRoutes(app: FastifyInstance) {
  app.post(
    "/v1/reconciliation/run",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "reconciliation");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }

      const payload = z
        .object({
          source: z.enum(["manual", "bank", "onchain", "provider"]).default("manual"),
        })
        .parse(request.body ?? {});

      const result = await runReconciliation(payload.source);

      await appendEvent(request.authUser, {
        entityType: "reconciliation_run",
        entityId: result.runId,
        action: "ReconciliationRunTriggered",
        notes: `status:${result.status}`,
      });

      return result;
    },
  );

  app.get(
    "/v1/reconciliation/runs",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "reconciliation");
      const query = z
        .object({
          status: z.enum(["ok", "mismatch", "failed"]).optional(),
          limit: z.coerce.number().int().positive().max(200).default(100),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {};
      if (query.status) filter.status = query.status;

      const rows = await ReconciliationRunModel.find(filter).sort({ checkedAt: -1 }).limit(query.limit).lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/reconciliation/runs/:id/issues",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "reconciliation");
      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          status: z.enum(["open", "resolved"]).optional(),
          limit: z.coerce.number().int().positive().max(500).default(200),
        })
        .parse(request.query);

      const run = await ReconciliationRunModel.findById(params.id).lean();
      if (!run) throw new HttpError(404, "Reconciliation run not found");

      const filter: Record<string, unknown> = { runId: params.id };
      if (query.status) filter.status = query.status;

      const rows = await ReconciliationIssueModel.find(filter).sort({ createdAt: -1 }).limit(query.limit).lean();
      return serialize(rows);
    },
  );

  app.post(
    "/v1/reconciliation/issues/:id/resolve",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "reconciliation");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ note: z.string().min(3) }).parse(request.body);

      const issue = await ReconciliationIssueModel.findById(params.id);
      if (!issue) throw new HttpError(404, "Reconciliation issue not found");

      issue.status = "resolved";
      issue.resolvedBy = request.authUser.userId as any;
      issue.resolvedAt = new Date();
      issue.resolutionNote = payload.note;
      await issue.save();

      await appendEvent(request.authUser, {
        entityType: "reconciliation_run",
        entityId: String(issue.runId),
        action: "ReconciliationIssueResolved",
        notes: `issue:${String(issue._id)} ${payload.note}`,
      });

      return serialize(issue.toObject());
    },
  );
}
