import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireRole } from "../../../middleware/role-guard.js";
import { AdministratorCapabilityError } from "../../../platform/postgres-administrator-capabilities.js";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import {
  SupportCaseError, addRequesterSupportMessage, createSupportCase, getAdministratorSupportCase, getOwnSupportCase,
  listAdministratorSupportCases, listOwnSupportCases, transitionAdministratorSupportCase,
} from "../../../platform/postgres-support-cases.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import { authorizeSupportCaseAttachmentUpload, getSupportCaseAttachmentForDownload, recordSupportCaseAttachment, recordSupportCaseAttachmentDownload, SupportAttachmentError, SupportAttachmentReplayError } from "../../../platform/postgres-support-attachments.js";
import { persistSupportAttachmentBinary, retrieveFile } from "../../../services/storage.js";
import { recordStoredDocument } from "../../../services/storage-metadata-guard.js";
import { supportAttachmentClassifications } from "../domain/support-data-policy.js";
import { decideLegalHoldChange, decideSupportAttachmentDisposition, proposeLegalHoldChange, proposeSupportAttachmentDisposition, readSupportAttachmentLifecycle, resolveSupportEvidenceHoldTarget, SupportEvidenceLifecycleError } from "../../../platform/postgres-support-evidence-lifecycle.js";

const status = z.enum(["new", "triaged", "in_progress", "waiting_requester", "resolved", "closed"]);
const category = z.enum(["account_access", "identity_verification", "investment_record", "payment_status", "organization", "professional_work", "security_concern", "privacy_request", "formal_complaint", "other"]);
const impact = z.enum(["question", "blocked", "financial_or_legal_risk", "security_or_privacy_concern"]);
const requesterRole = z.enum(["investor", "issuer", "professional", "operator", "admin"]);
const createBody = z.object({ category, reportedImpact: impact, subject: z.string().trim().min(10).max(200), description: z.string().trim().min(20).max(5000), relatedReference: z.string().trim().min(3).max(200).optional(), occurredAt: z.coerce.date() });
const messageBody = z.object({ message: z.string().trim().min(2).max(5000), expectedVersion: z.number().int().positive() });
const transitionBody = z.object({ action: z.enum(["triage", "assign", "start", "wait_requester", "reply", "note", "resolve", "close", "reopen"]), expectedVersion: z.number().int().positive(), message: z.string().trim().min(2).max(5000), assigneeIdentityId: z.string().uuid().optional() });
const attachmentMetadata = z.object({ classification: z.enum(supportAttachmentClassifications), filename: z.string().trim().min(1).max(240), mimeType: z.string().trim().min(3).max(120), visibility: z.enum(["requester", "internal"]).optional() });
const legalHoldBody = z.object({ action: z.enum(["impose", "release"]), scope: z.enum(["attachment", "case", "requester_identity"]), reasonCategory: z.enum(["litigation", "regulatory_request", "audit", "investigation", "complaint", "security_incident"]), reason: z.string().trim().min(20).max(2000) });
const dispositionBody = z.object({ reason: z.string().trim().min(20).max(2000) });
const lifecycleDecisionBody = z.object({ decision: z.enum(["approve", "reject"]), decisionReason: z.string().trim().min(20).max(2000) });
const supportAttachmentBodyLimit = 15 * 1024 * 1024;
type AuthorizedAttachmentRequest = { actorIdentityId: string; caseId: string; payload: z.infer<typeof attachmentMetadata>; visibility: "requester" | "internal" };
const attachmentAuthorizations = new WeakMap<FastifyRequest, AuthorizedAttachmentRequest>();

const identitySchema = { type: "object", additionalProperties: false, required: ["id", "email", "legalName"], properties: { id: { type: "string", format: "uuid" }, email: { type: "string", format: "email" }, legalName: { type: "string" } } } as const;
const requesterSchema = { ...identitySchema, required: [...identitySchema.required, "role"], properties: { ...identitySchema.properties, role: { type: "string", enum: requesterRole.options } } } as const;
const serviceLevelSchema = { type: "object", additionalProperties: false, required: ["obligationId", "cycleNumber", "priority", "policy", "acknowledgementDueAt", "escalationDueAt", "resolutionDueAt", "acknowledgedAt", "escalatedAt", "resolutionMetAt", "acknowledgementBreachedAt", "resolutionBreachedAt"], properties: {
  obligationId: { type: "string", format: "uuid" }, cycleNumber: { type: "integer", minimum: 1 }, priority: { type: "string", enum: ["p1", "p2", "p3", "p4"] },
  policy: { type: "object", additionalProperties: false, required: ["versionId", "versionNumber", "projectionVersion", "valueSha256", "reference", "name"], properties: {
    versionId: { type: "string", format: "uuid" }, versionNumber: { type: "integer", minimum: 1 }, projectionVersion: { type: "integer", minimum: 1 },
    valueSha256: { type: "string", pattern: "^[0-9a-f]{64}$" }, reference: { type: "string" }, name: { type: "string" },
  } },
  acknowledgementDueAt: { type: "string", format: "date-time" }, escalationDueAt: { type: "string", format: "date-time" }, resolutionDueAt: { type: "string", format: "date-time" },
  acknowledgedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, escalatedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  resolutionMetAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, acknowledgementBreachedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  resolutionBreachedAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
} } as const;
const caseSchema = { type: "object", additionalProperties: false, required: ["id", "reference", "requester", "category", "reportedImpact", "subject", "description", "relatedReference", "occurredAt", "status", "assignee", "resolutionSummary", "version", "createdAt", "lastActivityAt", "serviceLevel"], properties: {
  id: { type: "string", format: "uuid" }, reference: { type: "string" }, requester: requesterSchema,
  category: { type: "string", enum: category.options }, reportedImpact: { type: "string", enum: impact.options }, subject: { type: "string" }, description: { type: "string" },
  relatedReference: { anyOf: [{ type: "string" }, { type: "null" }] }, occurredAt: { type: "string", format: "date-time" }, status: { type: "string", enum: status.options },
  assignee: { anyOf: [identitySchema, { type: "null" }] }, resolutionSummary: { anyOf: [{ type: "string" }, { type: "null" }] }, version: { type: "integer" }, createdAt: { type: "string", format: "date-time" }, lastActivityAt: { type: "string", format: "date-time" },
  serviceLevel: { anyOf: [serviceLevelSchema, { type: "null" }] },
} } as const;
const eventSchema = { type: "object", additionalProperties: false, required: ["id", "sequence", "eventType", "fromStatus", "toStatus", "fromAssigneeIdentityId", "assignee", "actor", "visibility", "message", "occurredAt"], properties: {
  id: { type: "string", format: "uuid" }, sequence: { type: "integer" }, eventType: { type: "string" }, fromStatus: { anyOf: [{ type: "string", enum: status.options }, { type: "null" }] }, toStatus: { type: "string", enum: status.options },
  fromAssigneeIdentityId: { anyOf: [{ type: "string", format: "uuid" }, { type: "null" }] }, assignee: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "legalName"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" } } }, { type: "null" }] },
  actor: identitySchema, visibility: { type: "string", enum: ["requester", "internal"] }, message: { type: "string" }, occurredAt: { type: "string", format: "date-time" },
} } as const;
const serviceEventSchema = { type: "object", additionalProperties: false, required: ["id", "obligationId", "cycleNumber", "eventType", "actorType", "actor", "dueAt", "occurredAt", "latenessMs"], properties: {
  id: { type: "string", format: "uuid" }, obligationId: { type: "string", format: "uuid" }, cycleNumber: { type: "integer", minimum: 1 },
  eventType: { type: "string", enum: ["acknowledgement_met", "acknowledgement_breached", "escalated", "resolution_met", "resolution_breached"] },
  actorType: { type: "string", enum: ["user", "system"] },
  actor: { anyOf: [{ type: "object", additionalProperties: false, required: ["id", "legalName"], properties: { id: { type: "string", format: "uuid" }, legalName: { type: "string" } } }, { type: "null" }] },
  dueAt: { type: "string", format: "date-time" }, occurredAt: { type: "string", format: "date-time" }, latenessMs: { type: "integer", minimum: 0 },
} } as const;
const notificationDeliverySchema = { type: "object", additionalProperties: false, required: ["id", "caseEventSequence", "notificationType", "channel", "status", "attempts", "provider", "requestedAt", "sentAt", "terminalAt"], properties: {
  id: { type: "string", format: "uuid" }, caseEventSequence: { type: "integer", minimum: 1 }, notificationType: { type: "string", enum: ["opened", "staff_reply", "waiting_requester", "resolved", "closed", "reopened"] },
  channel: { type: "string", enum: ["email"] }, status: { type: "string", enum: ["requested", "failed", "sent", "terminal", "cancelled"] }, attempts: { type: "integer", minimum: 0 },
  provider: { anyOf: [{ type: "string", enum: ["resend", "nodemailer"] }, { type: "null" }] }, requestedAt: { type: "string", format: "date-time" }, sentAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] }, terminalAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
} } as const;
const attachmentSchema = { type: "object", additionalProperties: false, required: ["id","caseId","uploadedBy","visibility","classification","filename","mimeType","bytes","contentSha256","scan","policy","retentionDays","uploadedAt","retentionDueAt"], properties: {
  id:{type:"string",format:"uuid"}, caseId:{type:"string",format:"uuid"}, uploadedBy:{type:"object",additionalProperties:false,required:["id","legalName"],properties:{id:{type:"string",format:"uuid"},legalName:{type:"string"}}},
  visibility:{type:"string",enum:["requester","internal"]}, classification:{type:"string",enum:supportAttachmentClassifications}, filename:{type:"string"}, mimeType:{type:"string"}, bytes:{type:"integer",minimum:1}, contentSha256:{type:"string",pattern:"^[0-9a-f]{64}$"},
  scan:{type:"object",additionalProperties:false,required:["status","scanner","scannedAt"],properties:{status:{type:"string",enum:["clean"]},scanner:{type:"string",enum:["clamav_instream"]},scannedAt:{type:"string",format:"date-time"}}},
  policy:{type:"object",additionalProperties:false,required:["versionId","versionNumber","projectionVersion","valueSha256","reference","name"],properties:{versionId:{type:"string",format:"uuid"},versionNumber:{type:"integer"},projectionVersion:{type:"integer"},valueSha256:{type:"string",pattern:"^[0-9a-f]{64}$"},reference:{type:"string"},name:{type:"string"}}},
  retentionDays:{type:"integer",minimum:1}, uploadedAt:{type:"string",format:"date-time"}, retentionDueAt:{type:"string",format:"date-time"},
} } as const;
const commandHeaders = { type: "object", required: ["x-command-id"], properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } } } as const;
const requesterAttachmentHeaders = { type: "object", required: ["x-command-id", "x-fractal-attachment-classification", "x-fractal-attachment-filename", "x-fractal-attachment-mime-type"], properties: { ...commandHeaders.properties,
  "x-fractal-attachment-classification": { type: "string", enum: supportAttachmentClassifications }, "x-fractal-attachment-filename": { type: "string", minLength: 1, maxLength: 3000 }, "x-fractal-attachment-mime-type": { type: "string", minLength: 3, maxLength: 120 },
} } as const;
const staffAttachmentHeaders = { ...requesterAttachmentHeaders, required: [...requesterAttachmentHeaders.required, "x-fractal-attachment-visibility"], properties: { ...requesterAttachmentHeaders.properties, "x-fractal-attachment-visibility": { type: "string", enum: ["requester", "internal"] } } } as const;
const commandResponse = { type: "object", additionalProperties: false, required: ["case", "replayed"], properties: { case: caseSchema, replayed: { type: "boolean" } } } as const;
const lifecycleActorSchema = { type:"object",additionalProperties:false,required:["id","legalName"],properties:{id:{type:"string",format:"uuid"},legalName:{type:"string"}} } as const;
const holdChangeSchema = { type:"object",additionalProperties:false,required:["id","reference","targetType","targetId","changeType","reasonCategory","reason","status","requestedBy","reviewedBy","decisionReason","requestedAt","reviewedAt","appliedAt"],properties:{
  id:{type:"string",format:"uuid"},reference:{type:"string"},targetType:{type:"string",enum:["identity","support_case","support_attachment"]},targetId:{type:"string",format:"uuid"},changeType:{type:"string",enum:["impose","release"]},reasonCategory:{type:"string",enum:legalHoldBody.shape.reasonCategory.options},reason:{type:"string"},status:{type:"string",enum:["pending","applied","rejected"]},requestedBy:lifecycleActorSchema,reviewedBy:{anyOf:[lifecycleActorSchema,{type:"null"}]},decisionReason:{anyOf:[{type:"string"},{type:"null"}]},requestedAt:{type:"string",format:"date-time"},reviewedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},appliedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},
} } as const;
const holdSchema = { type:"object",additionalProperties:false,required:["id","reference","targetType","targetId","reasonCategory","reason","imposedBy","imposedAt","releasedAt"],properties:{id:{type:"string",format:"uuid"},reference:{type:"string"},targetType:{type:"string",enum:["identity","support_case","support_attachment"]},targetId:{type:"string",format:"uuid"},reasonCategory:{type:"string",enum:legalHoldBody.shape.reasonCategory.options},reason:{type:"string"},imposedBy:lifecycleActorSchema,imposedAt:{type:"string",format:"date-time"},releasedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]}} } as const;
const dispositionRequestSchema = { type:"object",additionalProperties:false,required:["id","reference","attachmentId","action","reason","retentionDueAt","status","requestedBy","reviewedBy","decisionReason","requestedAt","reviewedAt","appliedAt"],properties:{id:{type:"string",format:"uuid"},reference:{type:"string"},attachmentId:{type:"string",format:"uuid"},action:{type:"string",enum:["delete_object"]},reason:{type:"string"},retentionDueAt:{type:"string",format:"date-time"},status:{type:"string",enum:["pending","applied","rejected"]},requestedBy:lifecycleActorSchema,reviewedBy:{anyOf:[lifecycleActorSchema,{type:"null"}]},decisionReason:{anyOf:[{type:"string"},{type:"null"}]},requestedAt:{type:"string",format:"date-time"},reviewedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},appliedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]}} } as const;
const lifecycleSchema = { type:"object",additionalProperties:false,required:["attachmentId","retentionDueAt","retentionElapsed","activeHolds","pendingHoldChanges","pendingDispositionRequest","disposition"],properties:{attachmentId:{type:"string",format:"uuid"},retentionDueAt:{type:"string",format:"date-time"},retentionElapsed:{type:"boolean"},activeHolds:{type:"array",items:holdSchema},pendingHoldChanges:{type:"array",items:holdChangeSchema},pendingDispositionRequest:{anyOf:[dispositionRequestSchema,{type:"null"}]},disposition:{anyOf:[{type:"object",additionalProperties:false,required:["id","status","approvedAt","completedAt","failedAt"],properties:{id:{type:"string",format:"uuid"},status:{type:"string",enum:["cleanup_requested","completed","failed"]},approvedAt:{type:"string",format:"date-time"},completedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]},failedAt:{anyOf:[{type:"string",format:"date-time"},{type:"null"}]} }},{type:"null"}]}} } as const;

async function identity(request: FastifyRequest) {
  if (!request.authUser?.userId) throw new HttpError(401, "Authentication is required.");
  try { return await requirePostgresIdentityForSubject(request.authUser.userId); }
  catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Your account is not ready for authenticated support.");
    throw error;
  }
}

function commandId(request: FastifyRequest) {
  const value = readCommandId(request.headers);
  if (!value || value.length > 200) throw new HttpError(400, "A valid X-Command-Id is required.");
  return value;
}

function supportError(error: unknown): never {
  if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
  if (error instanceof AdministratorCapabilityError) throw new HttpError(error.code === "forbidden" ? 403 : error.code === "not_found" ? 404 : 409, error.message);
  if (error instanceof SupportCaseError) throw new HttpError(error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 422, error.message);
  if (error instanceof SupportAttachmentError) throw new HttpError(error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : error.code === "policy_unavailable" ? 503 : 422, error.message);
  if (error instanceof SupportEvidenceLifecycleError) throw new HttpError(error.code === "not_found" ? 404 : error.code === "forbidden" ? 403 : error.code === "conflict" ? 409 : 422, error.message);
  throw error;
}

async function requireSupportStepUp(request: FastifyRequest, identityId: string) {
  try { await requireFreshTotpStepUp({ sessionId: request.authUser?.sessionId, identityId }); }
  catch (error) { if (error instanceof StepUpRequiredError) throw new HttpError(403, error.message); throw error; }
}

function readAttachmentRequestMetadata(request: FastifyRequest, staff: boolean) {
  const { caseId } = z.object({ caseId: z.string().uuid() }).parse(request.params);
  const encodedFilename = z.string().parse(request.headers["x-fractal-attachment-filename"]);
  let decodedFilename: string;
  try { decodedFilename = decodeURIComponent(encodedFilename); }
  catch { throw new HttpError(400, "Attachment filename encoding is invalid."); }
  const payload = attachmentMetadata.parse({
    classification: request.headers["x-fractal-attachment-classification"], filename: decodedFilename,
    mimeType: request.headers["x-fractal-attachment-mime-type"], visibility: request.headers["x-fractal-attachment-visibility"],
  });
  return { caseId, payload, visibility: staff ? payload.visibility ?? "internal" : "requester" as const };
}

async function authorizeAttachmentRequest(request: FastifyRequest, staff: boolean) {
  if (staff) requireRole(request.authUser, "admin");
  const actorIdentityId = await identity(request);
  if (staff) await requireSupportStepUp(request, actorIdentityId);
  const { caseId, payload, visibility } = readAttachmentRequestMetadata(request, staff);
  await authorizeSupportCaseAttachmentUpload({ caseId, actorIdentityId, staff, visibility, mimeType: payload.mimeType });
  return { actorIdentityId, caseId, payload, visibility };
}

async function uploadAttachment(request: FastifyRequest, staff: boolean) {
  const authorization = attachmentAuthorizations.get(request) ?? await authorizeAttachmentRequest(request, staff);
  attachmentAuthorizations.delete(request);
  const { actorIdentityId, caseId, payload, visibility } = authorization;
  if (!Buffer.isBuffer(request.body) || request.body.length < 1) throw new HttpError(422, "A non-empty attachment binary is required.");
  const stored = await persistSupportAttachmentBinary({ caseId, filename: payload.filename, mimeType: payload.mimeType, content: request.body });
  try {
    const result = await recordStoredDocument({ storageKey: stored.storageKey, source: "support-case-attachment", logger: request.log,
      record: () => recordSupportCaseAttachment({ caseId, actorIdentityId, staff, commandKey: commandId(request), visibility, classification: payload.classification,
        filename: payload.filename, mimeType: payload.mimeType, bytes: stored.bytes, contentSha256: stored.sha256, storageKey: stored.storageKey, scanner: stored.scanner, scannedAt: stored.scannedAt }) });
    return { ...result, replayed: false };
  } catch (error) {
    if (error instanceof SupportAttachmentReplayError) return { attachment: error.attachment, replayed: true };
    throw error;
  }
}

async function downloadAttachment(request: FastifyRequest, staff: boolean) {
  const actorIdentityId = await identity(request);
  const { attachmentId } = z.object({ attachmentId: z.string().uuid() }).parse(request.params);
  const attachment = await getSupportCaseAttachmentForDownload({ attachmentId, actorIdentityId, staff });
  if (staff || attachment.classification === "identity_document" || attachment.classification === "security_sensitive") await requireSupportStepUp(request, actorIdentityId);
  const file = await retrieveFile(attachment.storageKey);
  if (file.redirectUrl) throw new HttpError(409, "This storage provider cannot support integrity-verified attachment download.");
  const sha256 = createHash("sha256").update(file.buffer).digest("hex");
  if (sha256 !== attachment.contentSha256) throw new HttpError(409, "Support attachment failed integrity validation.");
  await recordSupportCaseAttachmentDownload({ attachmentId, actorIdentityId, staff, verifiedSha256: sha256 });
  return { attachment, buffer: file.buffer };
}

export async function postgresSupportCaseRoutes(app: FastifyInstance) {
  if (!app.hasContentTypeParser("application/octet-stream")) {
    app.addContentTypeParser("application/octet-stream", { parseAs: "buffer", bodyLimit: supportAttachmentBodyLimit }, (_request, body, done) => done(null, body));
  }
  app.get("/v1/support/cases", { preHandler: [app.authenticate], schema: { tags: ["Support"], summary: "List the authenticated requester's support cases", querystring: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: status.options } } }, response: { 200: { type: "object", additionalProperties: false, required: ["cases"], properties: { cases: { type: "array", items: caseSchema } } } } } }, async (request) => {
    try { return await listOwnSupportCases({ actorIdentityId: await identity(request), ...z.object({ status: status.optional() }).parse(request.query) }); } catch (error) { return supportError(error); }
  });
  app.post("/v1/support/cases", { preHandler: [app.authenticate], schema: { tags: ["Support"], summary: "Open an authenticated durable support case", headers: commandHeaders, body: { type: "object", additionalProperties: false, required: ["category", "reportedImpact", "subject", "description", "occurredAt"], properties: { category: { type: "string", enum: category.options }, reportedImpact: { type: "string", enum: impact.options }, subject: { type: "string", minLength: 10, maxLength: 200 }, description: { type: "string", minLength: 20, maxLength: 5000 }, relatedReference: { type: "string", minLength: 3, maxLength: 200 }, occurredAt: { type: "string", format: "date-time" } } }, response: { 200: commandResponse, 201: commandResponse } } }, async (request, reply) => {
    try {
      const actorRole = requesterRole.parse(request.authUser?.role);
      const result = await createSupportCase({ actorIdentityId: await identity(request), actorRole, ...createBody.parse(request.body), commandKey: commandId(request) });
      return reply.code(result.replayed ? 200 : 201).send(result);
    } catch (error) { return supportError(error); }
  });
  app.get("/v1/support/cases/:caseId", { preHandler: [app.authenticate], schema: { tags: ["Support"], summary: "Read an owned support case and requester-visible timeline", params: { type: "object", additionalProperties: false, required: ["caseId"], properties: { caseId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", additionalProperties: false, required: ["case", "events", "serviceEvents", "notificationDeliveries", "attachments"], properties: { case: caseSchema, events: { type: "array", items: eventSchema }, serviceEvents: { type: "array", items: serviceEventSchema }, notificationDeliveries: { type: "array", items: notificationDeliverySchema }, attachments: {type:"array",items:attachmentSchema} } } } } }, async (request) => {
    try { return await getOwnSupportCase({ actorIdentityId: await identity(request), caseId: z.object({ caseId: z.string().uuid() }).parse(request.params).caseId }); } catch (error) { return supportError(error); }
  });
  app.post("/v1/support/cases/:caseId/messages", { preHandler: [app.authenticate], schema: { tags: ["Support"], summary: "Append requester information to an owned support case", headers: commandHeaders, params: { type: "object", additionalProperties: false, required: ["caseId"], properties: { caseId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["message", "expectedVersion"], properties: { message: { type: "string", minLength: 2, maxLength: 5000 }, expectedVersion: { type: "integer", minimum: 1 } } }, response: { 200: commandResponse } } }, async (request) => {
    try { return await addRequesterSupportMessage({ actorIdentityId: await identity(request), caseId: z.object({ caseId: z.string().uuid() }).parse(request.params).caseId, ...messageBody.parse(request.body), commandKey: commandId(request) }); } catch (error) { return supportError(error); }
  });
  app.post("/v1/support/cases/:caseId/attachments", { bodyLimit:supportAttachmentBodyLimit, onRequest:[app.authenticate, async(request)=>{ try { attachmentAuthorizations.set(request,await authorizeAttachmentRequest(request,false)); } catch(error){ return supportError(error); } }], schema:{tags:["Support"],summary:"Upload a policy-bound malware-screened attachment to an owned case",consumes:["application/octet-stream"],headers:requesterAttachmentHeaders,params:{type:"object",additionalProperties:false,required:["caseId"],properties:{caseId:{type:"string",format:"uuid"}}},response:{200:{type:"object",additionalProperties:false,required:["attachment","replayed"],properties:{attachment:attachmentSchema,replayed:{type:"boolean"}}},201:{type:"object",additionalProperties:false,required:["attachment","replayed"],properties:{attachment:attachmentSchema,replayed:{type:"boolean"}}}}}}, async(request,reply)=>{ try { const result=await uploadAttachment(request,false); return reply.code(result.replayed?200:201).send({attachment:result.attachment,replayed:Boolean(result.replayed)}); } catch(error){ return supportError(error); } });
  app.get("/v1/support/attachments/:attachmentId/download", { preHandler:[app.authenticate], schema:{tags:["Support"],summary:"Download an owned requester-visible attachment after integrity validation",params:{type:"object",additionalProperties:false,required:["attachmentId"],properties:{attachmentId:{type:"string",format:"uuid"}}}}}, async(request,reply)=>{ try { const result=await downloadAttachment(request,false); reply.header("Content-Type",result.attachment.mimeType).header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.filename)}`).header("X-Content-Type-Options","nosniff").header("X-Fractal-Content-Sha256",result.attachment.contentSha256).header("Cache-Control","private, no-store"); return reply.send(result.buffer); } catch(error){ return supportError(error); } });

  app.get("/v1/admin/support-cases", { preHandler: [app.authenticate], schema: { tags: ["Administration"], summary: "List capability-protected support cases", querystring: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: status.options }, category: { type: "string", enum: category.options } } }, response: { 200: { type: "object", additionalProperties: false, required: ["cases"], properties: { cases: { type: "array", items: caseSchema } } } } } }, async (request) => {
    requireRole(request.authUser, "admin");
    try { return await listAdministratorSupportCases({ actorIdentityId: await identity(request), ...z.object({ status: status.optional(), category: category.optional() }).parse(request.query) }); } catch (error) { return supportError(error); }
  });
  app.get("/v1/admin/support-cases/:caseId", { preHandler: [app.authenticate], schema: { tags: ["Administration"], summary: "Read a capability-protected support case and full timeline", params: { type: "object", additionalProperties: false, required: ["caseId"], properties: { caseId: { type: "string", format: "uuid" } } }, response: { 200: { type: "object", additionalProperties: false, required: ["case", "events", "serviceEvents", "notificationDeliveries", "attachments"], properties: { case: caseSchema, events: { type: "array", items: eventSchema }, serviceEvents: { type: "array", items: serviceEventSchema }, notificationDeliveries: { type: "array", items: notificationDeliverySchema }, attachments:{type:"array",items:attachmentSchema} } } } } }, async (request) => {
    requireRole(request.authUser, "admin");
    try { return await getAdministratorSupportCase({ actorIdentityId: await identity(request), caseId: z.object({ caseId: z.string().uuid() }).parse(request.params).caseId }); } catch (error) { return supportError(error); }
  });
  app.post("/v1/admin/support-cases/:caseId/transitions", { preHandler: [app.authenticate], schema: { tags: ["Administration"], summary: "Apply an attributable support-case transition or message", headers: commandHeaders, params: { type: "object", additionalProperties: false, required: ["caseId"], properties: { caseId: { type: "string", format: "uuid" } } }, body: { type: "object", additionalProperties: false, required: ["action", "expectedVersion", "message"], properties: { action: { type: "string", enum: transitionBody.shape.action.options }, expectedVersion: { type: "integer", minimum: 1 }, message: { type: "string", minLength: 2, maxLength: 5000 }, assigneeIdentityId: { type: "string", format: "uuid" } } }, response: { 200: commandResponse } } }, async (request) => {
    requireRole(request.authUser, "admin");
    try { const actorIdentityId=await identity(request); await requireSupportStepUp(request,actorIdentityId); return await transitionAdministratorSupportCase({ actorIdentityId, caseId: z.object({ caseId: z.string().uuid() }).parse(request.params).caseId, ...transitionBody.parse(request.body), commandKey: commandId(request) }); } catch (error) { return supportError(error); }
  });
  app.post("/v1/admin/support-cases/:caseId/attachments", { bodyLimit:supportAttachmentBodyLimit, onRequest:[app.authenticate, async(request)=>{ try { attachmentAuthorizations.set(request,await authorizeAttachmentRequest(request,true)); } catch(error){ return supportError(error); } }], schema:{tags:["Administration"],summary:"Upload a classified policy-bound support attachment",consumes:["application/octet-stream"],headers:staffAttachmentHeaders,params:{type:"object",additionalProperties:false,required:["caseId"],properties:{caseId:{type:"string",format:"uuid"}}},response:{200:{type:"object",additionalProperties:false,required:["attachment","replayed"],properties:{attachment:attachmentSchema,replayed:{type:"boolean"}}},201:{type:"object",additionalProperties:false,required:["attachment","replayed"],properties:{attachment:attachmentSchema,replayed:{type:"boolean"}}}}}}, async(request,reply)=>{ try { const result=await uploadAttachment(request,true); return reply.code(result.replayed?200:201).send({attachment:result.attachment,replayed:Boolean(result.replayed)}); } catch(error){ return supportError(error); } });
  app.get("/v1/admin/support-attachments/:attachmentId/download", { preHandler:[app.authenticate], schema:{tags:["Administration"],summary:"Download a capability-protected attachment after step-up and integrity validation",params:{type:"object",additionalProperties:false,required:["attachmentId"],properties:{attachmentId:{type:"string",format:"uuid"}}}}}, async(request,reply)=>{ requireRole(request.authUser,"admin"); try { const result=await downloadAttachment(request,true); reply.header("Content-Type",result.attachment.mimeType).header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(result.attachment.filename)}`).header("X-Content-Type-Options","nosniff").header("X-Fractal-Content-Sha256",result.attachment.contentSha256).header("Cache-Control","private, no-store"); return reply.send(result.buffer); } catch(error){ return supportError(error); } });
  app.get("/v1/admin/support-attachments/:attachmentId/lifecycle", { preHandler:[app.authenticate], schema:{tags:["Administration"],summary:"Read applicable legal holds and governed disposition evidence",params:{type:"object",additionalProperties:false,required:["attachmentId"],properties:{attachmentId:{type:"string",format:"uuid"}}},response:{200:lifecycleSchema}}}, async(request)=>{ requireRole(request.authUser,"admin"); try { const {attachmentId}=z.object({attachmentId:z.string().uuid()}).parse(request.params); return await readSupportAttachmentLifecycle({actorIdentityId:await identity(request),attachmentId}); } catch(error){ return supportError(error); } });
  app.post("/v1/admin/support-attachments/:attachmentId/legal-hold-requests", { preHandler:[app.authenticate], schema:{tags:["Administration"],summary:"Propose a scoped maker-checker legal hold change for support evidence",headers:commandHeaders,params:{type:"object",additionalProperties:false,required:["attachmentId"],properties:{attachmentId:{type:"string",format:"uuid"}}},body:{type:"object",additionalProperties:false,required:["action","scope","reasonCategory","reason"],properties:{action:{type:"string",enum:legalHoldBody.shape.action.options},scope:{type:"string",enum:legalHoldBody.shape.scope.options},reasonCategory:{type:"string",enum:legalHoldBody.shape.reasonCategory.options},reason:{type:"string",minLength:20,maxLength:2000}}},response:{200:{type:"object",additionalProperties:false,required:["request","replayed"],properties:{request:holdChangeSchema,replayed:{type:"boolean"}}},201:{type:"object",additionalProperties:false,required:["request","replayed"],properties:{request:holdChangeSchema,replayed:{type:"boolean"}}}}}}, async(request,reply)=>{ requireRole(request.authUser,"admin"); try { const actorIdentityId=await identity(request); const {attachmentId}=z.object({attachmentId:z.string().uuid()}).parse(request.params); const body=legalHoldBody.parse(request.body); const target=await resolveSupportEvidenceHoldTarget({actorIdentityId,attachmentId,scope:body.scope}); const result=await proposeLegalHoldChange({actorIdentityId,...target,changeType:body.action,reasonCategory:body.reasonCategory,reason:body.reason,commandKey:commandId(request)}); return reply.code(result.replayed?200:201).send(result); } catch(error){ return supportError(error); } });
  app.post("/v1/admin/support-attachment-hold-requests/:requestId/decision", { preHandler:[app.authenticate], schema:{tags:["Administration"],summary:"Independently decide a support evidence legal hold change",params:{type:"object",additionalProperties:false,required:["requestId"],properties:{requestId:{type:"string",format:"uuid"}}},body:{type:"object",additionalProperties:false,required:["decision","decisionReason"],properties:{decision:{type:"string",enum:lifecycleDecisionBody.shape.decision.options},decisionReason:{type:"string",minLength:20,maxLength:2000}}},response:{200:{type:"object",additionalProperties:false,required:["request","replayed"],properties:{request:holdChangeSchema,replayed:{type:"boolean"}}}}}}, async(request)=>{ requireRole(request.authUser,"admin"); try { const {requestId}=z.object({requestId:z.string().uuid()}).parse(request.params); return await decideLegalHoldChange({actorIdentityId:await identity(request),requestId,...lifecycleDecisionBody.parse(request.body)}); } catch(error){ return supportError(error); } });
  app.post("/v1/admin/support-attachments/:attachmentId/disposition-requests", { preHandler:[app.authenticate], schema:{tags:["Administration"],summary:"Propose retention-gated support evidence disposition",headers:commandHeaders,params:{type:"object",additionalProperties:false,required:["attachmentId"],properties:{attachmentId:{type:"string",format:"uuid"}}},body:{type:"object",additionalProperties:false,required:["reason"],properties:{reason:{type:"string",minLength:20,maxLength:2000}}},response:{200:{type:"object",additionalProperties:false,required:["request","replayed"],properties:{request:dispositionRequestSchema,replayed:{type:"boolean"}}},201:{type:"object",additionalProperties:false,required:["request","replayed"],properties:{request:dispositionRequestSchema,replayed:{type:"boolean"}}}}}}, async(request,reply)=>{ requireRole(request.authUser,"admin"); try { const {attachmentId}=z.object({attachmentId:z.string().uuid()}).parse(request.params); const result=await proposeSupportAttachmentDisposition({actorIdentityId:await identity(request),attachmentId,...dispositionBody.parse(request.body),commandKey:commandId(request)}); return reply.code(result.replayed?200:201).send(result); } catch(error){ return supportError(error); } });
  app.post("/v1/admin/support-attachment-disposition-requests/:requestId/decision", { preHandler:[app.authenticate], schema:{tags:["Administration"],summary:"Independently decide retention-gated support evidence disposition",params:{type:"object",additionalProperties:false,required:["requestId"],properties:{requestId:{type:"string",format:"uuid"}}},body:{type:"object",additionalProperties:false,required:["decision","decisionReason"],properties:{decision:{type:"string",enum:lifecycleDecisionBody.shape.decision.options},decisionReason:{type:"string",minLength:20,maxLength:2000}}},response:{200:{type:"object",additionalProperties:false,required:["request","replayed"],properties:{request:dispositionRequestSchema,replayed:{type:"boolean"}}}}}}, async(request)=>{ requireRole(request.authUser,"admin"); try { const {requestId}=z.object({requestId:z.string().uuid()}).parse(request.params); return await decideSupportAttachmentDisposition({actorIdentityId:await identity(request),requestId,...lifecycleDecisionBody.parse(request.body)}); } catch(error){ return supportError(error); } });
}
