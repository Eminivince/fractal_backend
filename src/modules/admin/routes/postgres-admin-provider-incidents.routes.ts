import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../../middleware/role-guard.js";
import { AdministratorCapabilityError } from "../../../platform/postgres-administrator-capabilities.js";
import {
  AdministratorProviderIncidentError,
  createAdministratorProviderIncident,
  getAdministratorProviderIncident,
  listAdministratorProviderIncidents,
  transitionAdministratorProviderIncident,
} from "../../../platform/postgres-administrator-provider-incidents.js";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";

const severity = z.enum(["sev1", "sev2", "sev3", "sev4"]);
const status = z.enum(["open", "acknowledged", "contained", "resolved"]);
const incidentListQuery = z.object({
  status: status.optional(), severity: severity.optional(),
  providerKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/).optional(),
});
const incidentCreateBody = z.object({
  providerKey: z.string().trim().regex(/^[a-z][a-z0-9_]{1,79}$/),
  source: z.enum(["manual", "system_health", "provider_webhook", "queue_monitor", "external_alert"]),
  externalReference: z.string().trim().min(3).max(200).optional(), severity,
  summary: z.string().trim().min(10).max(300), userImpact: z.string().trim().min(10).max(2000),
  detectionEvidence: z.record(z.string(), z.unknown()).default({}), detectedAt: z.coerce.date(),
  ownerIdentityId: z.string().uuid().optional(), reason: z.string().trim().min(10).max(2000),
});
const incidentTransitionBody = z.object({
  action: z.enum(["acknowledge", "assign", "contain", "escalate", "resolve", "reopen"]),
  expectedVersion: z.number().int().positive(), reason: z.string().trim().min(10).max(2000),
  evidence: z.record(z.string(), z.unknown()).default({}), ownerIdentityId: z.string().uuid().optional(),
  severity: severity.optional(),
}).superRefine((value, context) => {
  if (value.action === "assign" && !value.ownerIdentityId) context.addIssue({ code: "custom", path: ["ownerIdentityId"], message: "ownerIdentityId is required for assignment" });
  if (value.action === "escalate" && !value.severity) context.addIssue({ code: "custom", path: ["severity"], message: "severity is required for escalation" });
  if (value.action !== "assign" && value.ownerIdentityId) context.addIssue({ code: "custom", path: ["ownerIdentityId"], message: "ownerIdentityId is valid only for assignment" });
  if (value.action !== "escalate" && value.severity) context.addIssue({ code: "custom", path: ["severity"], message: "severity is valid only for escalation" });
});

const identitySchema = { type: "object", additionalProperties: false, required: ["id", "legalName", "email"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" }, email: { type: "string", format: "email" } } } as const;
const incidentSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "providerKey", "source", "externalReference", "severity", "status", "summary", "userImpact", "detectedAt", "acknowledgementDueAt", "resolutionDueAt", "acknowledgementSlaState", "resolutionSlaState", "owner", "createdBy", "acknowledgedAt", "containedAt", "resolvedAt", "version", "createdAt", "updatedAt"],
  properties: {
    id: { type: "string", format: "uuid" }, providerKey: { type: "string" }, source: { type: "string" },
    externalReference: { anyOf: [{ type: "string" }, { type: "null" }] }, severity: { type: "string", enum: severity.options },
    status: { type: "string", enum: status.options }, summary: { type: "string" }, userImpact: { type: "string" },
    detectedAt: { type: "string", format: "date-time" }, acknowledgementDueAt: { type: "string", format: "date-time" }, resolutionDueAt: { type: "string", format: "date-time" },
    acknowledgementSlaState: { type: "string", enum: ["met", "open", "breached"] }, resolutionSlaState: { type: "string", enum: ["met", "open", "breached"] },
    owner: { anyOf: [identitySchema, { type: "null" }] }, createdBy: identitySchema,
    acknowledgedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    containedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    resolvedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    version: { type: "integer" }, createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  },
} as const;
const incidentDetailSchema = {
  ...incidentSchema,
  required: [...incidentSchema.required, "detectionEvidence"],
  properties: { ...incidentSchema.properties, detectionEvidence: { type: "object", additionalProperties: true } },
} as const;
const incidentEventSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "sequence", "eventType", "fromStatus", "toStatus", "fromSeverity", "severity", "fromOwnerIdentityId", "owner", "actor", "acknowledgementDueAt", "resolutionDueAt", "acknowledgedAt", "containedAt", "resolvedAt", "reason", "evidence", "occurredAt"],
  properties: {
    id: { type: "string", format: "uuid" }, sequence: { type: "integer" }, eventType: { type: "string" },
    fromStatus: { anyOf: [{ type: "string", enum: status.options }, { type: "null" }] }, toStatus: { type: "string", enum: status.options },
    fromSeverity: { anyOf: [{ type: "string", enum: severity.options }, { type: "null" }] }, severity: { type: "string", enum: severity.options },
    fromOwnerIdentityId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] },
    owner: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "legalName"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" } } }, { type: "null" }] },
    actor: identitySchema, acknowledgementDueAt: { type: "string", format: "date-time" }, resolutionDueAt: { type: "string", format: "date-time" },
    acknowledgedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    containedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    resolvedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
    reason: { type: "string" }, evidence: { type: "object", additionalProperties: true }, occurredAt: { type: "string", format: "date-time" },
  },
} as const;

async function administratorIdentity(request: FastifyRequest): Promise<string> {
  requireRole(request.authUser, "admin");
  try { return await requirePostgresIdentityForSubject(request.authUser.userId); }
  catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Administrator identity is not available in PostgreSQL.");
    throw error;
  }
}

function commandId(request: FastifyRequest): string {
  const value = readCommandId(request.headers);
  if (!value || value.length > 200) throw new HttpError(400, "A valid X-Command-Id is required.");
  return value;
}

function incidentError(error: unknown): never {
  if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
  if (error instanceof AdministratorCapabilityError) throw new HttpError(error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 409, error.message);
  if (error instanceof AdministratorProviderIncidentError) {
    const code = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : error.code === "invalid_input" || error.code === "invalid_state" ? 422 : 409;
    throw new HttpError(code, error.message);
  }
  throw error;
}

const commandHeaders = { type: "object", required: ["x-command-id"], properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } } } as const;
const commandResponse = { type: "object", additionalProperties: false, required: ["incident", "replayed"], properties: { incident: incidentSchema, replayed: { type: "boolean" } } } as const;

export async function postgresAdminProviderIncidentRoutes(app: FastifyInstance) {
  app.get("/v1/admin/provider-incidents", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "List capability-protected provider incidents",
    querystring: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: status.options }, severity: { type: "string", enum: severity.options }, providerKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,79}$" } } },
    response: { 200: { type: "object", additionalProperties: false, required: ["incidents"], properties: { incidents: { type: "array", items: incidentSchema } } } },
  } }, async (request) => {
    const actorIdentityId = await administratorIdentity(request);
    try { return await listAdministratorProviderIncidents({ actorIdentityId, ...incidentListQuery.parse(request.query) }); }
    catch (error) { return incidentError(error); }
  });

  app.post("/v1/admin/provider-incidents", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Create a durable provider incident", headers: commandHeaders,
    body: { type: "object", additionalProperties: false, required: ["providerKey", "source", "severity", "summary", "userImpact", "detectionEvidence", "detectedAt", "reason"], properties: {
      providerKey: { type: "string", pattern: "^[a-z][a-z0-9_]{1,79}$" }, source: { type: "string", enum: ["manual", "system_health", "provider_webhook", "queue_monitor", "external_alert"] },
      externalReference: { type: "string", minLength: 3, maxLength: 200 }, severity: { type: "string", enum: severity.options }, summary: { type: "string", minLength: 10, maxLength: 300 },
      userImpact: { type: "string", minLength: 10, maxLength: 2000 }, detectionEvidence: { type: "object", additionalProperties: true }, detectedAt: { type: "string", format: "date-time" },
      ownerIdentityId: { type: "string", format: "uuid" }, reason: { type: "string", minLength: 10, maxLength: 2000 },
    } }, response: { 200: commandResponse, 201: commandResponse },
  } }, async (request, reply) => {
    const actorIdentityId = await administratorIdentity(request);
    try {
      const result = await createAdministratorProviderIncident({ actorIdentityId, ...incidentCreateBody.parse(request.body), commandKey: commandId(request) });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) { return incidentError(error); }
  });

  app.get("/v1/admin/provider-incidents/:incidentId", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Read provider incident evidence and immutable timeline",
    params: { type: "object", additionalProperties: false, required: ["incidentId"], properties: { incidentId: { type: "string", format: "uuid" } } },
    response: { 200: { type: "object", additionalProperties: false, required: ["incident", "events"], properties: { incident: incidentDetailSchema, events: { type: "array", items: incidentEventSchema } } } },
  } }, async (request) => {
    const actorIdentityId = await administratorIdentity(request);
    const incidentId = z.object({ incidentId: z.string().uuid() }).parse(request.params).incidentId;
    try { return await getAdministratorProviderIncident({ actorIdentityId, incidentId }); }
    catch (error) { return incidentError(error); }
  });

  app.post("/v1/admin/provider-incidents/:incidentId/transitions", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Apply an attributable provider-incident transition", headers: commandHeaders,
    params: { type: "object", additionalProperties: false, required: ["incidentId"], properties: { incidentId: { type: "string", format: "uuid" } } },
    body: { type: "object", additionalProperties: false, required: ["action", "expectedVersion", "reason", "evidence"], properties: {
      action: { type: "string", enum: ["acknowledge", "assign", "contain", "escalate", "resolve", "reopen"] }, expectedVersion: { type: "integer", minimum: 1 },
      reason: { type: "string", minLength: 10, maxLength: 2000 }, evidence: { type: "object", additionalProperties: true }, ownerIdentityId: { type: "string", format: "uuid" }, severity: { type: "string", enum: severity.options },
    } }, response: { 200: commandResponse },
  } }, async (request) => {
    const actorIdentityId = await administratorIdentity(request);
    const incidentId = z.object({ incidentId: z.string().uuid() }).parse(request.params).incidentId;
    try { return await transitionAdministratorProviderIncident({ actorIdentityId, incidentId, ...incidentTransitionBody.parse(request.body), commandKey: commandId(request) }); }
    catch (error) { return incidentError(error); }
  });
}
