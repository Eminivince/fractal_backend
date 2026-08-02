/**
 * Issuer developer settings: API keys + outbound webhooks.
 * All endpoints are issuer-scoped to the caller's business.
 */
import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { ApiKeyModel, IssuerWebhookModel } from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { authorize, type Action } from "../../../utils/rbac.js";
import { serialize } from "../../../utils/serialize.js";
import { appendEvent } from "../../../utils/audit.js";

function requireIssuerBusiness(request: FastifyRequest, action: Action = "read"): string {
  // Route through the RBAC matrix (developer resource), then issuer-scope.
  authorize(request.authUser, action, "developer");
  if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
  const businessId = request.authUser.businessId;
  if (!businessId) throw new HttpError(422, "Complete business registration before using developer settings");
  return String(businessId);
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export async function developerRoutes(app: FastifyInstance) {
  // ── API keys ────────────────────────────────────────────────────────────────
  app.post(
    "/v1/issuer/api-keys",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const businessId = requireIssuerBusiness(request, "create");
      const { name } = z.object({ name: z.string().min(1).max(120) }).parse(request.body);

      // fk_live_<48 hex>. The raw key is returned ONCE; only its hash is stored.
      const raw = `fk_live_${randomBytes(24).toString("hex")}`;
      const prefix = raw.slice(0, 16);
      const created = await ApiKeyModel.create({
        businessId,
        name,
        prefix,
        keyHash: hashKey(raw),
        createdBy: request.authUser.userId,
      });

      await appendEvent(request.authUser, {
        entityType: "business",
        entityId: businessId,
        action: "ApiKeyCreated",
        notes: name,
      });

      return serialize({
        id: String(created._id),
        name,
        prefix,
        key: raw, // shown once
        createdAt: created.createdAt,
      });
    },
  );

  app.get(
    "/v1/issuer/api-keys",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const businessId = requireIssuerBusiness(request);
      const keys = await ApiKeyModel.find({ businessId })
        .select("name prefix lastUsedAt revokedAt createdAt")
        .sort({ createdAt: -1 })
        .lean();
      return serialize({ data: keys });
    },
  );

  app.delete(
    "/v1/issuer/api-keys/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const businessId = requireIssuerBusiness(request, "update");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const key = await ApiKeyModel.findOne({ _id: id, businessId });
      if (!key) throw new HttpError(404, "API key not found");
      key.revokedAt = new Date();
      await key.save();
      await appendEvent(request.authUser, {
        entityType: "business",
        entityId: businessId,
        action: "ApiKeyRevoked",
        notes: key.name,
      });
      return { ok: true };
    },
  );

  // ── Outbound webhooks ─────────────────────────────────────────────────────────
  app.post(
    "/v1/issuer/webhooks",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const businessId = requireIssuerBusiness(request, "create");
      const payload = z
        .object({
          url: z.string().url(),
          events: z.array(z.string().min(1)).min(1).default(["*"]),
        })
        .parse(request.body);

      const secret = `whsec_${randomBytes(24).toString("hex")}`;
      const created = await IssuerWebhookModel.create({
        businessId,
        url: payload.url,
        secret,
        events: payload.events,
        createdBy: request.authUser.userId,
      });

      await appendEvent(request.authUser, {
        entityType: "business",
        entityId: businessId,
        action: "WebhookRegistered",
        notes: payload.url,
      });

      return serialize({
        id: String(created._id),
        url: created.url,
        events: created.events,
        secret, // shown once for signature verification
        active: created.active,
      });
    },
  );

  app.get(
    "/v1/issuer/webhooks",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const businessId = requireIssuerBusiness(request);
      const hooks = await IssuerWebhookModel.find({ businessId })
        .select("url events active lastDeliveryAt lastDeliveryStatus failureCount createdAt")
        .sort({ createdAt: -1 })
        .lean();
      return serialize({ data: hooks });
    },
  );

  app.delete(
    "/v1/issuer/webhooks/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const businessId = requireIssuerBusiness(request, "update");
      const { id } = z.object({ id: z.string() }).parse(request.params);
      const deleted = await IssuerWebhookModel.findOneAndDelete({ _id: id, businessId });
      if (!deleted) throw new HttpError(404, "Webhook not found");
      await appendEvent(request.authUser, {
        entityType: "business",
        entityId: businessId,
        action: "WebhookDeleted",
        notes: deleted.url,
      });
      return { ok: true };
    },
  );
}
