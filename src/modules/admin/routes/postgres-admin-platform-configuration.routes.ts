import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../../middleware/role-guard.js";
import { AdministratorCapabilityError } from "../../../platform/postgres-administrator-capabilities.js";
import {
  decidePlatformConfigurationVersion,
  getPlatformConfigurationVersion,
  listPlatformConfigurations,
  PlatformConfigurationError,
  proposePlatformConfigurationRollback,
  proposePlatformConfigurationVersion,
} from "../../../platform/postgres-platform-configuration.js";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";

const configurationKey = z.string().trim().regex(/^[a-z][a-z0-9_.]{2,119}$/);
const versionParams = z.object({ versionId: z.string().uuid() });
const definitionParams = z.object({ configurationKey });
const proposalBody = z.object({
  proposedValue: z.unknown(),
  expectedProjectionVersion: z.number().int().positive().nullable(),
  effectiveAt: z.coerce.date(),
  reason: z.string().trim().min(10).max(2000),
});
const decisionBody = z.object({
  action: z.enum(["approve", "reject"]),
  expectedStateVersion: z.number().int().positive(),
  decisionReason: z.string().trim().min(10).max(2000),
});
const rollbackBody = z.object({
  targetVersionId: z.string().uuid(),
  expectedProjectionVersion: z.number().int().positive(),
  effectiveAt: z.coerce.date(),
  reason: z.string().trim().min(10).max(2000),
});

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

function configurationError(error: unknown): never {
  if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
  if (error instanceof AdministratorCapabilityError) throw new HttpError(error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 409, error.message);
  if (error instanceof PlatformConfigurationError) {
    const status = error.code === "forbidden" ? 403 : error.code === "not_found" ? 404
      : error.code === "invalid_input" ? 400 : error.code === "invalid_state" ? 422 : 409;
    throw new HttpError(status, error.message);
  }
  throw error;
}

const identitySchema = { type: "object", additionalProperties: false, required: ["id", "legalName", "email"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" }, email: { type: "string", format: "email" } } } as const;
const nullableIdentitySchema = { anyOf: [identitySchema, { type: "null" }] } as const;
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const nullableDate = { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] } as const;
const jsonValueSchema = { anyOf: [{ type: "boolean" }, { type: "number" }, { type: "string" }, { type: "object", additionalProperties: true }, { type: "array", items: {} }, { type: "null" }] } as const;
const versionStatus = ["validation_failed", "pending", "rejected", "scheduled", "active", "superseded", "failed"] as const;
const versionSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "configurationKey", "versionNumber", "stateVersion", "status", "proposedValue", "valueSha256", "validationOutput", "impactPreview", "reason", "proposedBy", "reviewedBy", "decisionReason", "effectiveAt", "proposedAt", "reviewedAt", "activatedAt", "supersededAt", "supersedesVersionId", "rollbackOfVersionId", "failureCode", "failureDetail"],
  properties: {
    id: { type: "string", format: "uuid" }, configurationKey: { type: "string" },
    versionNumber: { type: "integer" }, stateVersion: { type: "integer" }, status: { type: "string", enum: versionStatus },
    proposedValue: jsonValueSchema, valueSha256: { type: "string" }, validationOutput: { type: "object", additionalProperties: true },
    impactPreview: { type: "object", additionalProperties: true }, reason: { type: "string" }, proposedBy: identitySchema,
    reviewedBy: nullableIdentitySchema, decisionReason: nullableString, effectiveAt: { type: "string", format: "date-time" },
    proposedAt: { type: "string", format: "date-time" }, reviewedAt: nullableDate, activatedAt: nullableDate, supersededAt: nullableDate,
    supersedesVersionId: nullableString, rollbackOfVersionId: nullableString, failureCode: nullableString, failureDetail: nullableString,
  },
} as const;
const eventSchema = {
  type: "object", additionalProperties: false,
  required: ["id", "configurationVersionId", "sequence", "eventType", "fromStatus", "toStatus", "actorType", "actor", "reason", "evidence", "occurredAt"],
  properties: {
    id: { type: "string", format: "uuid" }, configurationVersionId: { type: "string", format: "uuid" }, sequence: { type: "integer" },
    eventType: { type: "string" }, fromStatus: nullableString, toStatus: { type: "string" }, actorType: { type: "string", enum: ["user", "system"] },
    actor: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "legalName"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" } } }, { type: "null" }] },
    reason: { type: "string" }, evidence: { type: "object", additionalProperties: true }, occurredAt: { type: "string", format: "date-time" },
  },
} as const;
const commandHeaders = { type: "object", required: ["x-command-id"], properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } } } as const;
const commandResponse = { type: "object", additionalProperties: false, required: ["version", "replayed"], properties: { version: versionSchema, replayed: { type: "boolean" } } } as const;

export async function postgresAdminPlatformConfigurationRoutes(app: FastifyInstance) {
  app.get("/v1/admin/platform-configuration", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "List capability-protected versioned platform configuration",
    response: { 200: { type: "object", additionalProperties: false, required: ["definitions"], properties: { definitions: { type: "array", items: {
      type: "object", additionalProperties: false,
      required: ["key", "label", "description", "valueType", "validationSchema", "consumerBinding", "status", "projectionVersion", "activeVersionId", "versions"],
      properties: {
        key: { type: "string" }, label: { type: "string" }, description: { type: "string" },
        valueType: { type: "string", enum: ["boolean", "integer", "decimal", "string", "json"] },
        validationSchema: { type: "object", additionalProperties: true }, consumerBinding: { type: "string" },
        status: { type: "string", enum: ["active", "retired"] },
        projectionVersion: { anyOf: [{ type: "integer" }, { type: "null" }] }, activeVersionId: nullableString,
        versions: { type: "array", items: versionSchema },
      },
    } } } } },
  } }, async (request) => {
    try { return await listPlatformConfigurations({ actorIdentityId: await administratorIdentity(request) }); }
    catch (error) { configurationError(error); }
  });

  app.get("/v1/admin/platform-configuration/versions/:versionId", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Read immutable platform configuration version evidence",
    params: { type: "object", additionalProperties: false, required: ["versionId"], properties: { versionId: { type: "string", format: "uuid" } } },
    response: { 200: { type: "object", additionalProperties: false, required: ["version", "events", "activationAttempts"], properties: {
      version: versionSchema, events: { type: "array", items: eventSchema }, activationAttempts: { type: "array", items: {
        type: "object", additionalProperties: false, required: ["id", "outcome", "dueAt", "attemptedAt", "latenessMs", "failureCode", "failureDetail"],
        properties: { id: { type: "string", format: "uuid" }, outcome: { type: "string", enum: ["activated", "failed", "already_terminal"] }, dueAt: { type: "string", format: "date-time" }, attemptedAt: { type: "string", format: "date-time" }, latenessMs: { type: "integer" }, failureCode: nullableString, failureDetail: nullableString },
      } },
    } } },
  } }, async (request) => {
    try { return await getPlatformConfigurationVersion({ actorIdentityId: await administratorIdentity(request), versionId: versionParams.parse(request.params).versionId }); }
    catch (error) { configurationError(error); }
  });

  app.post("/v1/admin/platform-configuration/:configurationKey/versions", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Propose and validate an immutable platform configuration version", headers: commandHeaders,
    params: { type: "object", additionalProperties: false, required: ["configurationKey"], properties: { configurationKey: { type: "string", pattern: "^[a-z][a-z0-9_.]{2,119}$" } } },
    body: { type: "object", additionalProperties: false, required: ["proposedValue", "expectedProjectionVersion", "effectiveAt", "reason"], properties: { proposedValue: jsonValueSchema, expectedProjectionVersion: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, effectiveAt: { type: "string", format: "date-time" }, reason: { type: "string", minLength: 10, maxLength: 2000 } } },
    response: { 200: commandResponse, 201: commandResponse },
  } }, async (request, reply) => {
    try {
      const params = definitionParams.parse(request.params); const body = proposalBody.parse(request.body);
      const result = await proposePlatformConfigurationVersion({ actorIdentityId: await administratorIdentity(request), configurationKey: params.configurationKey, ...body, commandKey: commandId(request) });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) { configurationError(error); }
  });

  app.post("/v1/admin/platform-configuration/versions/:versionId/decision", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Independently approve or reject a platform configuration version", headers: commandHeaders,
    params: { type: "object", additionalProperties: false, required: ["versionId"], properties: { versionId: { type: "string", format: "uuid" } } },
    body: { type: "object", additionalProperties: false, required: ["action", "expectedStateVersion", "decisionReason"], properties: { action: { type: "string", enum: ["approve", "reject"] }, expectedStateVersion: { type: "integer", minimum: 1 }, decisionReason: { type: "string", minLength: 10, maxLength: 2000 } } },
    response: { 200: commandResponse },
  } }, async (request) => {
    try { return await decidePlatformConfigurationVersion({ actorIdentityId: await administratorIdentity(request), versionId: versionParams.parse(request.params).versionId, ...decisionBody.parse(request.body), commandKey: commandId(request) }); }
    catch (error) { configurationError(error); }
  });

  app.post("/v1/admin/platform-configuration/:configurationKey/rollbacks", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Propose a new version that rolls back to immutable prior configuration bytes", headers: commandHeaders,
    params: { type: "object", additionalProperties: false, required: ["configurationKey"], properties: { configurationKey: { type: "string", pattern: "^[a-z][a-z0-9_.]{2,119}$" } } },
    body: { type: "object", additionalProperties: false, required: ["targetVersionId", "expectedProjectionVersion", "effectiveAt", "reason"], properties: { targetVersionId: { type: "string", format: "uuid" }, expectedProjectionVersion: { type: "integer", minimum: 1 }, effectiveAt: { type: "string", format: "date-time" }, reason: { type: "string", minLength: 10, maxLength: 2000 } } },
    response: { 200: commandResponse, 201: commandResponse },
  } }, async (request, reply) => {
    try {
      const params = definitionParams.parse(request.params); const body = rollbackBody.parse(request.body);
      const result = await proposePlatformConfigurationRollback({ actorIdentityId: await administratorIdentity(request), configurationKey: params.configurationKey, ...body, commandKey: commandId(request) });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) { configurationError(error); }
  });
}
