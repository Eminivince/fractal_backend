import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../../middleware/role-guard.js";
import { AdministratorCapabilityError } from "../../../platform/postgres-administrator-capabilities.js";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import {
  decidePlatformContentVersion, getLegalConsentStatus, getPlatformContentVersion, listPlatformContent,
  listPublishedLegalDocumentHistory, listPublishedLegalDocuments, PlatformContentError, proposePlatformContentVersion,
  readPublishedLegalDocument, readPublishedLegalDocumentBytes, recordLegalReacceptance,
} from "../../../platform/postgres-platform-content.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";

const uuid = z.string().uuid();
const contentKey = z.string().regex(/^[a-z][a-z0-9_]{2,79}$/);
const acceptanceReference = z.object({ documentKey: contentKey, versionId: uuid, contentSha256: z.string().regex(/^[0-9a-f]{64}$/) });
async function postgresIdentity(request: FastifyRequest) { try { return await requirePostgresIdentityForSubject(request.authUser.userId); } catch (error) { if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Account identity is not available in PostgreSQL."); throw error; } }
async function adminIdentity(request: FastifyRequest) { requireRole(request.authUser, "admin"); return postgresIdentity(request); }
function commandId(request: FastifyRequest) { const id = readCommandId(request.headers); if (!id || id.length > 200) throw new HttpError(400, "A valid X-Command-Id is required."); return id; }
function handle(error: unknown): never {
  if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
  if (error instanceof AdministratorCapabilityError) throw new HttpError(error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 409, error.message);
  if (error instanceof PlatformContentError) throw new HttpError(error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : error.code === "unavailable" ? 503 : error.code === "invalid_input" ? 400 : error.code === "invalid_state" ? 422 : 409, error.message);
  throw error;
}
const commandHeaders = { type: "object", required: ["x-command-id"], properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } } } as const;
const jsonObject = { type: "object", additionalProperties: true } as const;
const slugParamsSchema = { type: "object", additionalProperties: false, required: ["slug"], properties: { slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } } } as const;
const versionParamsSchema = { type: "object", additionalProperties: false, required: ["versionId"], properties: { versionId: { type: "string", format: "uuid" } } } as const;
const downloadParamsSchema = { type: "object", additionalProperties: false, required: ["slug", "versionId"], properties: { slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }, versionId: { type: "string", format: "uuid" } } } as const;
const documentParamsSchema = { type: "object", additionalProperties: false, required: ["documentKey"], properties: { documentKey: { type: "string", pattern: "^[a-z][a-z0-9_]{2,79}$" } } } as const;
const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] } as const;
const nullableDate = { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] } as const;
const identitySchema = { type: "object", additionalProperties: false, required: ["id", "legalName", "email"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" }, email: { type: "string", format: "email" } } } as const;
const nullableIdentitySchema = { anyOf: [identitySchema, { type: "null" }] } as const;
const legalContentSchema = { type: "object", additionalProperties: false, required: ["title", "eyebrow", "lead", "keyPoints", "sections"], properties: {
  title: { type: "string" }, eyebrow: { type: "string" }, lead: { type: "string" }, readingTime: { type: "string" },
  keyPoints: { type: "array", items: { type: "string" } }, sections: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "title", "paragraphs"], properties: { id: { type: "string" }, title: { type: "string" }, paragraphs: { type: "array", items: { type: "string" } }, bullets: { type: "array", items: { type: "string" } } } } },
} } as const;
const publishedMetadataSchema = { type: "object", additionalProperties: false, required: ["documentKey", "slug", "title", "documentType", "jurisdictionCode", "audience", "requiredAtRegistration", "projectionVersion", "versionId", "semanticVersion", "contentSha256", "effectiveAt", "publishedAt", "reacceptanceRequired"], properties: {
  documentKey: { type: "string" }, slug: { type: "string" }, title: { type: "string" }, documentType: { type: "string" }, jurisdictionCode: { type: "string" }, audience: { type: "string" }, requiredAtRegistration: { type: "boolean" }, projectionVersion: { type: "integer" }, versionId: { type: "string", format: "uuid" }, semanticVersion: { type: "string" }, contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, effectiveAt: { type: "string", format: "date-time" }, publishedAt: { type: "string", format: "date-time" }, reacceptanceRequired: { type: "boolean" },
} } as const;
const publishedDocumentSchema = { ...publishedMetadataSchema, required: [...publishedMetadataSchema.required, "content"], properties: { ...publishedMetadataSchema.properties, content: legalContentSchema } } as const;
const versionStatuses = ["validation_failed", "pending", "rejected", "scheduled", "published", "superseded", "failed"] as const;
const contentVersionSchema = { type: "object", additionalProperties: false, required: ["id", "documentKey", "semanticVersion", "stateVersion", "status", "contentSha256", "validationOutput", "changeSummary", "reacceptanceRequired", "proposedBy", "reviewedBy", "decisionReason", "effectiveAt", "proposedAt", "reviewedAt", "publishedAt", "supersededAt", "supersedesVersionId", "failureCode", "failureDetail"], properties: {
  id: { type: "string", format: "uuid" }, documentKey: { type: "string" }, semanticVersion: { type: "string" }, stateVersion: { type: "integer" }, status: { type: "string", enum: versionStatuses }, contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, validationOutput: jsonObject, changeSummary: { type: "string" }, reacceptanceRequired: { type: "boolean" }, proposedBy: identitySchema, reviewedBy: nullableIdentitySchema, decisionReason: nullableString, effectiveAt: { type: "string", format: "date-time" }, proposedAt: { type: "string", format: "date-time" }, reviewedAt: nullableDate, publishedAt: nullableDate, supersededAt: nullableDate, supersedesVersionId: nullableString, failureCode: nullableString, failureDetail: nullableString,
} } as const;
const commandResponseSchema = { type: "object", additionalProperties: false, required: ["version", "replayed"], properties: { version: contentVersionSchema, replayed: { type: "boolean" } } } as const;
const acceptanceReferenceSchema = { type: "object", additionalProperties: false, required: ["documentKey", "versionId", "contentSha256"], properties: { documentKey: { type: "string" }, versionId: { type: "string", format: "uuid" }, contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" } } } as const;

export async function postgresAdminPlatformContentRoutes(app: FastifyInstance) {
  app.get("/v1/public/legal-documents", { schema: { tags: ["Public"], summary: "List exact currently published legal-document versions", response: { 200: { type: "object", additionalProperties: false, required: ["documents", "registrationDocumentsAvailable"], properties: { documents: { type: "array", items: publishedMetadataSchema }, registrationDocumentsAvailable: { type: "boolean" } } } } } }, async () => listPublishedLegalDocuments());
  app.get("/v1/public/legal-documents/:slug", { schema: { tags: ["Public"], summary: "Read one exact approved published legal document", params: slugParamsSchema, response: { 200: publishedDocumentSchema } } }, async (request, reply) => {
    try { reply.header("Cache-Control", "no-store"); return await readPublishedLegalDocument(z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).parse(request.params).slug); } catch (error) { handle(error); }
  });
  app.get("/v1/public/legal-documents/:slug/history", { schema: { tags: ["Public"], summary: "List immutable published and superseded legal-document versions", params: slugParamsSchema, response: { 200: { type: "object", additionalProperties: false, required: ["documents"], properties: { documents: { type: "array", items: publishedMetadataSchema } } } } } }, async (request, reply) => {
    try { reply.header("Cache-Control", "no-store"); return await listPublishedLegalDocumentHistory(z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).parse(request.params).slug); } catch (error) { handle(error); }
  });
  app.get("/v1/public/legal-documents/:slug/versions/:versionId/download", { schema: { tags: ["Public"], summary: "Download canonical immutable published legal-document bytes", params: downloadParamsSchema } }, async (request, reply) => {
    try {
      const params = z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/), versionId: uuid }).parse(request.params);
      const evidence = await readPublishedLegalDocumentBytes(params.slug, params.versionId);
      const digest = Buffer.from(evidence.contentSha256, "hex").toString("base64");
      return reply.header("Content-Type", "application/json; charset=utf-8").header("Content-Disposition", `attachment; filename="${evidence.filename}"`).header("Digest", `sha-256=${digest}`).header("ETag", `"sha256-${evidence.contentSha256}"`).header("X-Fractal-Content-SHA256", evidence.contentSha256).header("X-Content-Type-Options", "nosniff").header("Cache-Control", "no-store").send(evidence.bytes);
    } catch (error) { handle(error); }
  });

  app.get("/v1/legal-consents/status", { preHandler: [app.authenticate], schema: { tags: ["Identity"], summary: "Read exact current legal acceptance and re-acceptance state", response: { 200: { type: "object", additionalProperties: false, required: ["available", "required", "accepted"], properties: { available: { type: "boolean" }, required: { type: "array", items: publishedMetadataSchema }, accepted: { type: "array", items: { type: "object", additionalProperties: false, required: ["documentKey", "versionId", "contentSha256", "acceptedAt"], properties: { documentKey: { type: "string" }, versionId: { type: "string", format: "uuid" }, contentSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, acceptedAt: { type: "string", format: "date-time" } } } } } } } } }, async (request) => getLegalConsentStatus(await postgresIdentity(request)));
  app.post("/v1/legal-consents/accept", { preHandler: [app.authenticate], schema: { tags: ["Identity"], summary: "Accept exact current legal versions that require re-acceptance", body: { type: "object", additionalProperties: false, required: ["references"], properties: { references: { type: "array", minItems: 1, maxItems: 5, items: acceptanceReferenceSchema } } }, response: { 200: { type: "object", additionalProperties: false, required: ["accepted"], properties: { accepted: { type: "boolean" } } } } } }, async (request) => {
    const body = z.object({ references: z.array(acceptanceReference).min(1).max(5) }).parse(request.body);
    try { await recordLegalReacceptance({ identityId: await postgresIdentity(request), references: body.references, ip: request.ip, userAgent: request.headers["user-agent"] }); return { accepted: true }; } catch (error) { handle(error); }
  });

  app.get("/v1/admin/platform-content", { preHandler: [app.authenticate], schema: { tags: ["Administration"], summary: "List governed legal-content definitions and immutable versions", response: { 200: { type: "object", additionalProperties: false, required: ["definitions"], properties: { definitions: { type: "array", items: { type: "object", additionalProperties: false, required: ["key", "slug", "title", "documentType", "jurisdictionCode", "audience", "requiredAtRegistration", "status", "projectionVersion", "publishedVersionId", "versions"], properties: { key: { type: "string" }, slug: { type: "string" }, title: { type: "string" }, documentType: { type: "string" }, jurisdictionCode: { type: "string" }, audience: { type: "string" }, requiredAtRegistration: { type: "boolean" }, status: { type: "string", enum: ["active", "retired"] }, projectionVersion: { anyOf: [{ type: "integer" }, { type: "null" }] }, publishedVersionId: nullableString, versions: { type: "array", items: contentVersionSchema } } } } } } } } }, async (request) => { try { return await listPlatformContent({ actorIdentityId: await adminIdentity(request) }); } catch (error) { handle(error); } });
  app.get("/v1/admin/platform-content/versions/:versionId", { preHandler: [app.authenticate], schema: { tags: ["Administration"], summary: "Read immutable legal-content version and event evidence", params: versionParamsSchema, response: { 200: { type: "object", additionalProperties: false, required: ["version", "events"], properties: { version: { ...contentVersionSchema, required: [...contentVersionSchema.required, "content"], properties: { ...contentVersionSchema.properties, content: jsonObject } }, events: { type: "array", items: { type: "object", additionalProperties: false, required: ["id", "sequence", "eventType", "fromStatus", "toStatus", "actorType", "actor", "reason", "evidence", "occurredAt"], properties: { id: { type: "string", format: "uuid" }, sequence: { type: "integer" }, eventType: { type: "string" }, fromStatus: nullableString, toStatus: { type: "string" }, actorType: { type: "string", enum: ["user", "system"] }, actor: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "legalName"], properties: { id: { type: "string", format: "uuid" }, legalName: { anyOf: [{ type: "string" }, { type: "null" }] } } }, { type: "null" }] }, reason: { type: "string" }, evidence: jsonObject, occurredAt: { type: "string", format: "date-time" } } } } } } } } }, async (request) => { try { return await getPlatformContentVersion({ actorIdentityId: await adminIdentity(request), versionId: z.object({ versionId: uuid }).parse(request.params).versionId }); } catch (error) { handle(error); } });
  app.post("/v1/admin/platform-content/:documentKey/versions", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Propose immutable validated legal content", headers: commandHeaders, params: documentParamsSchema,
    body: { type: "object", additionalProperties: false, required: ["semanticVersion", "content", "reacceptanceRequired", "expectedProjectionVersion", "effectiveAt", "changeSummary"], properties: { semanticVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+$" }, content: jsonObject, reacceptanceRequired: { type: "boolean" }, expectedProjectionVersion: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }, effectiveAt: { type: "string", format: "date-time" }, changeSummary: { type: "string", minLength: 10, maxLength: 2000 } } }, response: { 200: commandResponseSchema, 201: commandResponseSchema },
  } }, async (request, reply) => {
    try {
      const params = z.object({ documentKey: contentKey }).parse(request.params);
      const body = z.object({ semanticVersion: z.string(), content: z.unknown(), reacceptanceRequired: z.boolean(), expectedProjectionVersion: z.number().int().positive().nullable(), effectiveAt: z.coerce.date(), changeSummary: z.string() }).parse(request.body);
      const result = await proposePlatformContentVersion({ actorIdentityId: await adminIdentity(request), documentKey: params.documentKey, ...body, commandKey: commandId(request) });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) { handle(error); }
  });
  app.post("/v1/admin/platform-content/versions/:versionId/decision", { preHandler: [app.authenticate], schema: {
    tags: ["Administration"], summary: "Independently approve or reject a legal-content version", headers: commandHeaders, params: versionParamsSchema,
    body: { type: "object", additionalProperties: false, required: ["action", "expectedStateVersion", "decisionReason"], properties: { action: { type: "string", enum: ["approve", "reject"] }, expectedStateVersion: { type: "integer", minimum: 1 }, decisionReason: { type: "string", minLength: 10, maxLength: 2000 } } }, response: { 200: commandResponseSchema },
  } }, async (request) => {
    try { const versionId = z.object({ versionId: uuid }).parse(request.params).versionId; const body = z.object({ action: z.enum(["approve", "reject"]), expectedStateVersion: z.number().int().positive(), decisionReason: z.string() }).parse(request.body); return await decidePlatformContentVersion({ actorIdentityId: await adminIdentity(request), versionId, ...body, commandKey: commandId(request) }); } catch (error) { handle(error); }
  });
}
