import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { env } from "../../../config/env.js";
import { getPostgres, requirePostgres } from "../../../db/postgres.js";
import { getRedis } from "../../../db/redis.js";
import { requireRole } from "../../../middleware/role-guard.js";
import {
  createIdentityAccessChangeRequest,
  decodeIdentityAccessRequestCursor,
  decideIdentityAccessChangeRequest,
  IdentityAccessGovernanceError,
  listIdentityAccessChangeRequests,
} from "../../../platform/postgres-identity-access-governance.js";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import {
  decodeAdminAccessCursor,
  listAdminAccessIdentities,
  listAdminAuditEvents,
} from "../../../platform/postgres-admin-read-models.js";
import {
  AdministratorCapabilityError,
  createAdministratorCapabilityChangeRequest,
  decideAdministratorCapabilityChangeRequest,
  listAdministratorCapabilityRegister,
} from "../../../platform/postgres-administrator-capabilities.js";
import {
  AdministratorAuditExportError,
  createAdministratorAuditExport,
  listAdministratorAuditExports,
  retrieveAdministratorAuditExport,
} from "../../../platform/postgres-administrator-audit-exports.js";
import { hasAnyEmailTransportConfigured, isResendConfigured } from "../../../services/email.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";
import { roles } from "../../../utils/constants.js";

const accessQuery = z.object({
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const auditQuery = z.object({
  query: z.string().trim().max(200).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  scopeKey: z.string().trim().min(1).max(300).optional(),
  actorId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: "from must be earlier than or equal to to",
  path: ["from"],
});

const accessChangeQuery = z.object({
  status: z.enum(["pending", "applied", "rejected", "cancelled"]).optional(),
  query: z.string().trim().max(200).optional(),
  cursor: z.string().min(1).max(1000).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const accessChangeRequestBody = z.object({
  targetIdentityId: z.string().uuid(),
  changeType: z.enum(["change_role", "suspend", "restore"]),
  proposedRole: z.enum(roles).optional(),
  reason: z.string().trim().min(10).max(2000),
}).superRefine((value, context) => {
  if (value.changeType === "change_role" && !value.proposedRole) {
    context.addIssue({ code: "custom", path: ["proposedRole"], message: "proposedRole is required for a role change" });
  }
  if (value.changeType !== "change_role" && value.proposedRole) {
    context.addIssue({ code: "custom", path: ["proposedRole"], message: "proposedRole is valid only for a role change" });
  }
});

const accessChangeDecisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(10).max(2000),
});

const capabilityRegisterQuery = z.object({
  status: z.enum(["pending", "applied", "rejected", "cancelled"]).optional(),
  query: z.string().trim().max(200).optional(),
});

const capabilityChangeRequestBody = z.object({
  targetIdentityId: z.string().uuid(),
  capabilityKey: z.string().trim().min(1).max(120),
  changeType: z.enum(["grant", "revoke"]),
  reason: z.string().trim().min(10).max(2000),
});

const capabilityChangeDecisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(10).max(2000),
});

const auditExportBody = z.object({
  query: z.string().trim().max(200).optional(),
  action: z.string().trim().min(1).max(200).optional(),
  scopeKey: z.string().trim().min(1).max(300).optional(),
  actorId: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  maxRecords: z.coerce.number().int().min(1).max(5000).default(1000),
}).refine((value) => !value.from || !value.to || value.from <= value.to, {
  message: "from must be earlier than or equal to to",
  path: ["from"],
});

const identityReferenceJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "email", "legalName"],
  properties: {
    id: { type: "string", format: "uuid" },
    email: { type: "string", format: "email" },
    legalName: { type: "string" },
  },
} as const;

const accessChangeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "targetIdentity", "changeType", "priorRole", "proposedRole", "priorStatus", "reason", "status", "requestedBy", "reviewedBy", "decisionReason", "requestedAt", "reviewedAt", "appliedAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    targetIdentity: identityReferenceJsonSchema,
    changeType: { type: "string", enum: ["change_role", "suspend", "restore"] },
    priorRole: { anyOf: [{ type: "string", enum: roles }, { type: "null" }] },
    proposedRole: { anyOf: [{ type: "string", enum: roles }, { type: "null" }] },
    priorStatus: { type: "string", enum: ["active", "disabled"] },
    reason: { type: "string" },
    status: { type: "string", enum: ["pending", "applied", "rejected", "cancelled"] },
    requestedBy: identityReferenceJsonSchema,
    reviewedBy: { anyOf: [identityReferenceJsonSchema, { type: "null" }] },
    decisionReason: { anyOf: [{ type: "string" }, { type: "null" }] },
    requestedAt: { type: "string", format: "date-time" },
    reviewedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    appliedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
} as const;

const accessChangeCommandResponseJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["request", "replayed"],
  properties: { request: accessChangeJsonSchema, replayed: { type: "boolean" } },
} as const;

const commandHeadersJsonSchema = {
  type: "object",
  required: ["x-command-id"],
  properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } },
} as const;

const capabilityChangeJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "targetIdentity", "capabilityKey", "capabilityLabel", "changeType", "priorEnabled", "reason", "status", "requestedBy", "reviewedBy", "decisionReason", "requestedAt", "reviewedAt", "appliedAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    targetIdentity: identityReferenceJsonSchema,
    capabilityKey: { type: "string" },
    capabilityLabel: { type: "string" },
    changeType: { type: "string", enum: ["grant", "revoke"] },
    priorEnabled: { type: "boolean" },
    reason: { type: "string" },
    status: { type: "string", enum: ["pending", "applied", "rejected", "cancelled"] },
    requestedBy: identityReferenceJsonSchema,
    reviewedBy: { anyOf: [identityReferenceJsonSchema, { type: "null" }] },
    decisionReason: { anyOf: [{ type: "string" }, { type: "null" }] },
    requestedAt: { type: "string", format: "date-time" },
    reviewedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    appliedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  },
} as const;

const nullableFilterJsonSchema = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const auditExportMetadataJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id", "requestedByIdentityId", "requestedByLegalName", "filters", "sequenceHighWatermark", "firstSequence", "lastSequence", "recordCount", "contentSha256", "createdAt"],
  properties: {
    id: { type: "string", format: "uuid" },
    requestedByIdentityId: { type: "string", format: "uuid" },
    requestedByLegalName: { type: "string" },
    filters: {
      type: "object",
      additionalProperties: false,
      required: ["query", "action", "scopeKey", "actorId", "from", "to"],
      properties: {
        query: nullableFilterJsonSchema,
        action: nullableFilterJsonSchema,
        scopeKey: nullableFilterJsonSchema,
        actorId: nullableFilterJsonSchema,
        from: nullableFilterJsonSchema,
        to: nullableFilterJsonSchema,
      },
    },
    sequenceHighWatermark: { type: "string", pattern: "^[0-9]+$" },
    firstSequence: { anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] },
    lastSequence: { anyOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] },
    recordCount: { type: "integer", minimum: 0, maximum: 5000 },
    contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    createdAt: { type: "string", format: "date-time" },
  },
} as const;

function requireAdministrator(request: FastifyRequest) {
  requireRole(request.authUser, "admin");
}

async function administratorIdentity(request: FastifyRequest): Promise<string> {
  requireAdministrator(request);
  try {
    return await requirePostgresIdentityForSubject(request.authUser.userId);
  } catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Administrator identity is not available in PostgreSQL.");
    throw error;
  }
}

function requiredCommandId(request: FastifyRequest): string {
  const commandId = readCommandId(request.headers);
  if (!commandId || commandId.length > 200) throw new HttpError(400, "A valid X-Command-Id is required.");
  return commandId;
}

function accessGovernanceError(error: unknown): never {
  if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
  if (error instanceof IdentityAccessGovernanceError) {
    const status = error.code === "not_found" ? 404
      : error.code === "forbidden" ? 403
        : error.code === "invalid_state" ? 422
          : 409;
    throw new HttpError(status, error.message);
  }
  throw error;
}

function administratorEvidenceError(error: unknown): never {
  if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
  if (error instanceof AdministratorCapabilityError) {
    const status = error.code === "not_found" ? 404
      : error.code === "forbidden" ? 403
        : error.code === "invalid_state" ? 422
          : 409;
    throw new HttpError(status, error.message);
  }
  if (error instanceof AdministratorAuditExportError) {
    const status = error.code === "not_found" ? 404
      : error.code === "too_broad" || error.code === "invalid_input" ? 422
        : 409;
    throw new HttpError(status, error.message);
  }
  throw error;
}

export async function postgresAdminReadRoutes(app: FastifyInstance) {
  app.get("/v1/admin/access-identities", { preHandler: [app.authenticate] }, async (request) => {
    requireAdministrator(request);
    const parsed = accessQuery.parse(request.query);
    let cursor;
    try {
      cursor = parsed.cursor ? decodeAdminAccessCursor(parsed.cursor) : undefined;
    } catch {
      throw new HttpError(400, "The access-register cursor is invalid.");
    }
    return listAdminAccessIdentities({ query: parsed.query, cursor, limit: parsed.limit });
  });

  app.get("/v1/admin/audit-events", { preHandler: [app.authenticate] }, async (request) => {
    requireAdministrator(request);
    const parsed = auditQuery.parse(request.query);
    return listAdminAuditEvents({
      query: parsed.query,
      action: parsed.action,
      scopeKey: parsed.scopeKey,
      actorId: parsed.actorId,
      from: parsed.from,
      to: parsed.to,
      beforeSequence: parsed.cursor,
      limit: parsed.limit,
    });
  });

  app.get("/v1/admin/access-change-requests", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "List governed identity access-change requests",
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["pending", "applied", "rejected", "cancelled"] },
          query: { type: "string", maxLength: 200 },
          cursor: { type: "string", minLength: 1, maxLength: 1000 },
          limit: { type: "integer", minimum: 1, maximum: 100, default: 50 },
        },
      },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["requests", "nextCursor"],
          properties: {
            requests: { type: "array", items: accessChangeJsonSchema },
            nextCursor: { anyOf: [{ type: "string" }, { type: "null" }] },
          },
        },
      },
    },
  }, async (request) => {
    requireAdministrator(request);
    const parsed = accessChangeQuery.parse(request.query);
    try {
      return await listIdentityAccessChangeRequests({
        status: parsed.status,
        query: parsed.query,
        cursor: parsed.cursor ? decodeIdentityAccessRequestCursor(parsed.cursor) : undefined,
        limit: parsed.limit,
      });
    } catch (error) {
      return accessGovernanceError(error);
    }
  });

  app.post("/v1/admin/access-change-requests", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "Propose a maker-checker identity access change",
      headers: commandHeadersJsonSchema,
      body: {
        type: "object",
        additionalProperties: false,
        required: ["targetIdentityId", "changeType", "reason"],
        properties: {
          targetIdentityId: { type: "string", format: "uuid" },
          changeType: { type: "string", enum: ["change_role", "suspend", "restore"] },
          proposedRole: { type: "string", enum: roles },
          reason: { type: "string", minLength: 10, maxLength: 2000 },
        },
      },
      response: { 200: accessChangeCommandResponseJsonSchema, 201: accessChangeCommandResponseJsonSchema },
    },
  }, async (request, reply) => {
    const actorIdentityId = await administratorIdentity(request);
    const payload = accessChangeRequestBody.parse(request.body);
    try {
      const result = await createIdentityAccessChangeRequest({
        actorIdentityId,
        targetIdentityId: payload.targetIdentityId,
        changeType: payload.changeType,
        proposedRole: payload.proposedRole,
        reason: payload.reason,
        commandKey: requiredCommandId(request),
      });
      reply.code(result.replayed ? 200 : 201);
      return result;
    } catch (error) {
      return accessGovernanceError(error);
    }
  });

  app.post("/v1/admin/access-change-requests/:requestId/decision", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "Independently approve or reject an identity access change",
      headers: commandHeadersJsonSchema,
      params: {
        type: "object",
        additionalProperties: false,
        required: ["requestId"],
        properties: { requestId: { type: "string", format: "uuid" } },
      },
      body: {
        type: "object",
        additionalProperties: false,
        required: ["decision", "reason"],
        properties: {
          decision: { type: "string", enum: ["approve", "reject"] },
          reason: { type: "string", minLength: 10, maxLength: 2000 },
        },
      },
      response: { 200: accessChangeCommandResponseJsonSchema },
    },
  }, async (request) => {
    const actorIdentityId = await administratorIdentity(request);
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    const payload = accessChangeDecisionBody.parse(request.body);
    try {
      return await decideIdentityAccessChangeRequest({
        actorIdentityId,
        requestId,
        decision: payload.decision,
        reason: payload.reason,
        commandKey: requiredCommandId(request),
      });
    } catch (error) {
      return accessGovernanceError(error);
    }
  });

  app.get("/v1/admin/capabilities", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "Read administrator capability assignments and maker-checker queue",
      querystring: {
        type: "object",
        additionalProperties: false,
        properties: {
          status: { type: "string", enum: ["pending", "applied", "rejected", "cancelled"] },
          query: { type: "string", maxLength: 200 },
        },
      },
      response: {
        200: {
          type: "object",
          additionalProperties: false,
          required: ["capabilities", "assignments", "requests"],
          properties: {
            capabilities: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["key", "label", "description", "status"],
                properties: {
                  key: { type: "string" },
                  label: { type: "string" },
                  description: { type: "string" },
                  status: { type: "string", enum: ["active", "retired"] },
                },
              },
            },
            assignments: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["identityId", "email", "legalName", "capabilityKey", "grantedAt"],
                properties: {
                  identityId: { type: "string", format: "uuid" },
                  email: { type: "string", format: "email" },
                  legalName: { type: "string" },
                  capabilityKey: { type: "string" },
                  grantedAt: { type: "string", format: "date-time" },
                },
              },
            },
            requests: { type: "array", items: capabilityChangeJsonSchema },
          },
        },
      },
    },
  }, async (request) => {
    requireAdministrator(request);
    const parsed = capabilityRegisterQuery.parse(request.query);
    return listAdministratorCapabilityRegister(parsed);
  });

  app.post("/v1/admin/capability-change-requests", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "Propose a maker-checker administrator capability change",
      headers: commandHeadersJsonSchema,
      body: { type: "object", additionalProperties: false, required: ["targetIdentityId", "capabilityKey", "changeType", "reason"], properties: { targetIdentityId: { type: "string", format: "uuid" }, capabilityKey: { type: "string", minLength: 1, maxLength: 120 }, changeType: { type: "string", enum: ["grant", "revoke"] }, reason: { type: "string", minLength: 10, maxLength: 2000 } } },
      response: { 200: { type: "object", additionalProperties: false, required: ["request", "replayed"], properties: { request: capabilityChangeJsonSchema, replayed: { type: "boolean" } } }, 201: { type: "object", additionalProperties: false, required: ["request", "replayed"], properties: { request: capabilityChangeJsonSchema, replayed: { type: "boolean" } } } },
    },
  }, async (request, reply) => {
    const actorIdentityId = await administratorIdentity(request);
    const payload = capabilityChangeRequestBody.parse(request.body);
    try {
      const result = await createAdministratorCapabilityChangeRequest({ actorIdentityId, ...payload, commandKey: requiredCommandId(request) });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      return administratorEvidenceError(error);
    }
  });

  app.post("/v1/admin/capability-change-requests/:requestId/decision", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "Independently decide an administrator capability change",
      headers: commandHeadersJsonSchema,
      params: { type: "object", additionalProperties: false, required: ["requestId"], properties: { requestId: { type: "string", format: "uuid" } } },
      body: { type: "object", additionalProperties: false, required: ["decision", "reason"], properties: { decision: { type: "string", enum: ["approve", "reject"] }, reason: { type: "string", minLength: 10, maxLength: 2000 } } },
      response: { 200: { type: "object", additionalProperties: false, required: ["request", "replayed"], properties: { request: capabilityChangeJsonSchema, replayed: { type: "boolean" } } } },
    },
  }, async (request) => {
    const actorIdentityId = await administratorIdentity(request);
    const { requestId } = z.object({ requestId: z.string().uuid() }).parse(request.params);
    try {
      return await decideAdministratorCapabilityChangeRequest({ actorIdentityId, requestId, ...capabilityChangeDecisionBody.parse(request.body), commandKey: requiredCommandId(request) });
    } catch (error) {
      return administratorEvidenceError(error);
    }
  });

  app.get("/v1/admin/audit-exports", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration"], summary: "List immutable administrator audit exports", response: { 200: { type: "object", additionalProperties: false, required: ["exports"], properties: { exports: { type: "array", items: auditExportMetadataJsonSchema } } } } },
  }, async (request) => {
    const requestedByIdentityId = await administratorIdentity(request);
    try {
      return await listAdministratorAuditExports({ requestedByIdentityId });
    } catch (error) {
      return administratorEvidenceError(error);
    }
  });

  app.post("/v1/admin/audit-exports", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Administration"],
      summary: "Create a bounded immutable administrator audit export",
      headers: commandHeadersJsonSchema,
      body: { type: "object", additionalProperties: false, properties: { query: { type: "string", maxLength: 200 }, action: { type: "string", minLength: 1, maxLength: 200 }, scopeKey: { type: "string", minLength: 1, maxLength: 300 }, actorId: { type: "string", format: "uuid" }, from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" }, maxRecords: { type: "integer", minimum: 1, maximum: 5000, default: 1000 } } },
      response: { 200: { type: "object", additionalProperties: false, required: ["export", "replayed"], properties: { export: auditExportMetadataJsonSchema, replayed: { type: "boolean" } } }, 201: { type: "object", additionalProperties: false, required: ["export", "replayed"], properties: { export: auditExportMetadataJsonSchema, replayed: { type: "boolean" } } } },
    },
  }, async (request, reply) => {
    const requestedByIdentityId = await administratorIdentity(request);
    const payload = auditExportBody.parse(request.body);
    try {
      const result = await createAdministratorAuditExport({
        requestedByIdentityId,
        filters: { query: payload.query, action: payload.action, scopeKey: payload.scopeKey, actorId: payload.actorId, from: payload.from, to: payload.to },
        maxRecords: payload.maxRecords,
        commandKey: requiredCommandId(request),
      });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) {
      return administratorEvidenceError(error);
    }
  });

  app.get("/v1/admin/audit-exports/:exportId/download", {
    preHandler: [app.authenticate],
    schema: { tags: ["Administration"], summary: "Retrieve and verify an immutable administrator audit export", params: { type: "object", additionalProperties: false, required: ["exportId"], properties: { exportId: { type: "string", format: "uuid" } } } },
  }, async (request, reply) => {
    const requestedByIdentityId = await administratorIdentity(request);
    const { exportId } = z.object({ exportId: z.string().uuid() }).parse(request.params);
    try {
      const result = await retrieveAdministratorAuditExport({ requestedByIdentityId, exportId });
      const digest = Buffer.from(result.metadata.contentSha256, "hex").toString("base64");
      reply.header("Cache-Control", "private, no-store");
      reply.header("Content-Type", "application/json; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="fractal-audit-${exportId}.json"`);
      reply.header("Digest", `sha-256=${digest}`);
      reply.header("ETag", `\"sha256-${result.metadata.contentSha256}\"`);
      reply.header("X-Fractal-Content-SHA256", result.metadata.contentSha256);
      reply.header("X-Content-Type-Options", "nosniff");
      return reply.send(result.canonicalContent);
    } catch (error) {
      return administratorEvidenceError(error);
    }
  });

  app.get("/v1/admin/system-health", { preHandler: [app.authenticate] }, async (request) => {
    requireAdministrator(request);
    const postgres = getPostgres();
    if (!postgres) throw new HttpError(503, "PostgreSQL health authority is unavailable.");
    const [outbox, inbox, email, storage, payments] = await Promise.all([
      requirePostgres().query<{ pending: string; failed: string; oldest: Date | null }>(
        `SELECT count(*) FILTER (WHERE published_at IS NULL)::text AS pending,
                count(*) FILTER (WHERE published_at IS NULL AND last_error IS NOT NULL)::text AS failed,
                min(occurred_at) FILTER (WHERE published_at IS NULL) AS oldest
           FROM fractal.outbox_events`,
      ),
      requirePostgres().query<{ pending: string; failed: string; oldest: Date | null }>(
        `SELECT count(*) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL)::text AS pending,
                count(*) FILTER (WHERE failed_at IS NOT NULL)::text AS failed,
                min(received_at) FILTER (WHERE processed_at IS NULL AND failed_at IS NULL) AS oldest
           FROM fractal.inbox_events`,
      ),
      requirePostgres().query<{ pending: string; failed: string; oldest: Date | null }>(
        `SELECT count(*) FILTER (WHERE status IN ('requested', 'failed'))::text AS pending,
                count(*) FILTER (WHERE status = 'terminal')::text AS failed,
                min(requested_at) FILTER (WHERE status IN ('requested', 'failed')) AS oldest
           FROM fractal.auth_email_deliveries`,
      ),
      requirePostgres().query<{ pending: string; failed: string; oldest: Date | null }>(
        `SELECT count(*) FILTER (WHERE completed_at IS NULL AND failed_at IS NULL)::text AS pending,
                count(*) FILTER (WHERE failed_at IS NOT NULL)::text AS failed,
                min(created_at) FILTER (WHERE completed_at IS NULL AND failed_at IS NULL) AS oldest
           FROM fractal.storage_cleanup_tasks`,
      ),
      requirePostgres().query<{ pending: string; failed: string; oldest: Date | null }>(
        `SELECT count(*) FILTER (WHERE status = 'pending')::text AS pending,
                count(*) FILTER (WHERE status = 'failed')::text AS failed,
                min(created_at) FILTER (WHERE status IN ('pending', 'failed')) AS oldest
           FROM fractal.payment_provider_instructions`,
      ),
    ]);
    const queue = (key: string, name: string, row: { pending: string; failed: string; oldest: Date | null } | undefined) => ({
      key,
      name,
      pending: Number(row?.pending ?? 0),
      failed: Number(row?.failed ?? 0),
      oldestPendingAt: row?.oldest?.toISOString() ?? null,
    });
    return {
      checkedAt: new Date().toISOString(),
      components: [
        { key: "postgres", name: "PostgreSQL", state: "available", detail: "Authoritative transactional database responded" },
        { key: "mongodb", name: "MongoDB", state: mongoose.connection.readyState === 1 ? "available" : "unavailable", detail: "Migration and retained legacy store" },
        { key: "redis", name: "Redis", state: getRedis()?.status === "ready" ? "available" : "unavailable", detail: "Distributed limits and worker coordination" },
        { key: "resend", name: "Resend", state: isResendConfigured() ? "configured" : "not_configured", detail: "Configuration state only; no credential material is returned" },
        { key: "email", name: "Email delivery", state: env.AUTH_EMAIL_DELIVERY_ENABLED && hasAnyEmailTransportConfigured() ? "configured" : "not_configured", detail: "Durable authentication delivery pipeline" },
        { key: "paystack", name: "Paystack", state: env.PAYSTACK_ENABLED ? "configured" : "disabled", detail: "Runtime enablement state; provider reachability requires an owned smoke check" },
        { key: "sumsub", name: "Sumsub", state: env.SUMSUB_ENABLED ? "configured" : "disabled", detail: "Runtime enablement state; provider reachability requires an owned smoke check" },
      ],
      queues: [
        queue("outbox", "Domain outbox", outbox.rows[0]),
        queue("inbox", "Provider inbox", inbox.rows[0]),
        queue("auth_email", "Authentication email", email.rows[0]),
        queue("storage_cleanup", "Storage cleanup", storage.rows[0]),
        queue("payment_provider", "Payment provider instructions", payments.rows[0]),
      ],
    };
  });
}
