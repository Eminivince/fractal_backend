import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { decideOrganizationOwnershipTransfer, OrganizationOwnershipTransferError, proposeOrganizationOwnershipTransfer } from "../../../platform/postgres-organization-ownership.js";
import {
  createIssuerOrganization,
  decideOrganizationVerification,
  getOrganizationAuthorityWorkspace,
  getOrganizationVerificationEvidence,
  getOrganizationVerificationReview,
  listOrganizationVerificationReviewQueue,
  OrganizationAuthorityError,
  organizationEntityTypes,
  organizationVerificationEvidenceTypes,
  recordOrganizationVerificationEvidence,
  submitOrganizationVerification,
} from "../../../platform/postgres-organization-authority.js";
import { PostgresIdentityUnavailableError, requirePostgresIdentityForSubject } from "../../../platform/postgres-identities.js";
import {
  acceptOrganizationInvitation,
  changeOrganizationMembershipRole,
  changeOrganizationMembershipStatus,
  inspectOrganizationInvitation,
  issueOrganizationInvitation,
  OrganizationInvitationError,
  resolveOrganizationInvitation,
  resendOrganizationInvitation,
  revokeOrganizationInvitation,
} from "../../../platform/tenant-invitations.js";
import { organizationMembershipRoles, requireOrganizationAccess, TenantAccessError, type OrganizationMembershipRole } from "../../../platform/tenant-access.js";
import { persistOrganizationVerificationEvidenceBinary, retrieveFile } from "../../../services/storage.js";
import { recordStoredDocument } from "../../../services/storage-metadata-guard.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";
import { authorize } from "../../../utils/rbac.js";

const addressSchema = z.object({
  line1: z.string().trim().min(2).max(240),
  line2: z.string().trim().min(1).max(240).optional(),
  city: z.string().trim().min(2).max(120),
  stateOrProvince: z.string().trim().min(1).max(120).optional(),
  postalCode: z.string().trim().min(1).max(32).optional(),
  countryCode: z.string().regex(/^[a-zA-Z]{2}$/),
}).strict();

const organizationProfileSchema = z.object({
  legalName: z.string().trim().min(2).max(240),
  registrationNumber: z.string().trim().min(2).max(120),
  jurisdictionCode: z.string().regex(/^[a-zA-Z]{2}$/),
  entityType: z.enum(organizationEntityTypes),
  primaryActivity: z.string().trim().min(2).max(500),
  registeredAddress: addressSchema,
}).strict();

const invitationIssueSchema = z.object({
  email: z.string().email().max(320),
  role: z.enum(["administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"]),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict();
const invitationTokenSchema = z.object({ token: z.string().min(32).max(256) }).strict();
const invitationRevokeSchema = z.object({ reason: z.string().trim().min(5).max(1000) }).strict();
const membershipRoleSchema = z.object({
  role: z.enum(["administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"]),
  reason: z.string().trim().min(5).max(1000),
}).strict();
const membershipStatusSchema = z.object({
  action: z.enum(["suspend", "restore", "revoke"]),
  reason: z.string().trim().min(5).max(1000),
}).strict();
const ownershipTransferProposalSchema = z.object({
  targetMembershipId: z.string().uuid(), reason: z.string().trim().min(10).max(2000),
  expiresAt: z.string().datetime({ offset: true }).transform((value) => new Date(value)),
}).strict();
const ownershipTransferDecisionSchema = z.object({
  action: z.enum(["accept", "reject", "cancel"]), reason: z.string().trim().min(5).max(2000),
}).strict();
const evidenceUploadSchema = z.object({
  evidenceType: z.enum(organizationVerificationEvidenceTypes),
  filename: z.string().trim().min(1).max(240),
  mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
  contentBase64: z.string().min(1),
}).strict();
const beneficialOwnerSchema = z.object({
  ownerType: z.enum(["natural_person", "legal_entity"]),
  legalName: z.string().trim().min(2).max(240),
  ownershipBps: z.number().int().min(0).max(10000),
  isControlPerson: z.boolean(),
  nationalityOrJurisdictionCode: z.string().regex(/^[a-zA-Z]{2}$/),
  countryOfResidenceCode: z.string().regex(/^[a-zA-Z]{2}$/).optional(),
  identityLink: z.literal("self").optional(),
}).strict();
const verificationSubmissionSchema = organizationProfileSchema.extend({
  representativeAuthorityBasis: z.string().trim().min(10).max(2000),
  beneficialOwners: z.array(beneficialOwnerSchema).min(1).max(50),
  evidenceDocumentIds: z.array(z.string().uuid()).min(3).max(30),
}).strict();
const verificationDecisionSchema = z.object({
  approve: z.boolean(),
  reason: z.string().trim().min(10).max(2000),
  validityDays: z.number().int().min(1).max(730).optional(),
}).strict();

const uuidJson = { type: "string", format: "uuid" } as const;
const commandHeadersJson = {
  type: "object", required: ["x-command-id"],
  properties: { "x-command-id": { type: "string", minLength: 1, maxLength: 200 } },
} as const;
const invitationTokenJson = {
  type: "object", additionalProperties: false, required: ["token"],
  properties: { token: { type: "string", minLength: 32, maxLength: 256 } },
} as const;
const addressJson = {
  type: "object", additionalProperties: false, required: ["line1", "city", "countryCode"],
  properties: {
    line1: { type: "string", minLength: 2, maxLength: 240 }, line2: { type: "string", minLength: 1, maxLength: 240 },
    city: { type: "string", minLength: 2, maxLength: 120 }, stateOrProvince: { type: "string", minLength: 1, maxLength: 120 },
    postalCode: { type: "string", minLength: 1, maxLength: 32 }, countryCode: { type: "string", pattern: "^[a-zA-Z]{2}$" },
  },
} as const;
const organizationProfileProperties = {
  legalName: { type: "string", minLength: 2, maxLength: 240 }, registrationNumber: { type: "string", minLength: 2, maxLength: 120 },
  jurisdictionCode: { type: "string", pattern: "^[a-zA-Z]{2}$" }, entityType: { type: "string", enum: organizationEntityTypes },
  primaryActivity: { type: "string", minLength: 2, maxLength: 500 }, registeredAddress: addressJson,
} as const;
const organizationProfileJson = {
  type: "object", additionalProperties: false,
  required: ["legalName", "registrationNumber", "jurisdictionCode", "entityType", "primaryActivity", "registeredAddress"],
  properties: organizationProfileProperties,
} as const;
const beneficialOwnerJson = {
  type: "object", additionalProperties: false,
  required: ["ownerType", "legalName", "ownershipBps", "isControlPerson", "nationalityOrJurisdictionCode"],
  properties: {
    ownerType: { type: "string", enum: ["natural_person", "legal_entity"] }, legalName: { type: "string", minLength: 2, maxLength: 240 },
    ownershipBps: { type: "integer", minimum: 0, maximum: 10000 }, isControlPerson: { type: "boolean" },
    nationalityOrJurisdictionCode: { type: "string", pattern: "^[a-zA-Z]{2}$" }, countryOfResidenceCode: { type: "string", pattern: "^[a-zA-Z]{2}$" },
    identityLink: { type: "string", enum: ["self"] },
  },
} as const;
const objectResponseJson = { type: "object", additionalProperties: true } as const;
const binaryResponseJson = { type: "string", format: "binary" } as const;

function organizationParamsJson(include: "organization" | "invitation" | "membership" | "evidence" = "organization") {
  const properties: Record<string, typeof uuidJson> = { organizationId: uuidJson };
  if (include === "invitation") properties.invitationId = uuidJson;
  if (include === "membership") properties.membershipId = uuidJson;
  if (include === "evidence") properties.evidenceDocumentId = uuidJson;
  return { type: "object", additionalProperties: false, required: Object.keys(properties), properties } as const;
}

async function currentIdentity(request: FastifyRequest): Promise<string> {
  try { return await requirePostgresIdentityForSubject(request.authUser.userId); }
  catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Your account migration is not ready for organization authority");
    throw error;
  }
}

async function organizationScope(identityId: string, organizationId: string, roles: readonly OrganizationMembershipRole[] = ["owner", "administrator"]) {
  try { return await requireOrganizationAccess({ identityId, organizationId, allowedRoles: roles }); }
  catch (error) {
    if (error instanceof TenantAccessError) throw new HttpError(403, "You do not have the required organization role");
    throw error;
  }
}

function domain<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error: unknown) => {
    if (error instanceof OrganizationAuthorityError || error instanceof OrganizationInvitationError || error instanceof OrganizationOwnershipTransferError) throw new HttpError(422, error.message);
    if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
    if (typeof error === "object" && error !== null && "code" in error && error.code === "23505") {
      throw new HttpError(409, "This organization or invitation conflicts with an existing authoritative record");
    }
    throw error;
  });
}

function commandId(request: FastifyRequest, capability: string) {
  const value = readCommandId(request.headers);
  if (!value) throw new HttpError(400, `X-Command-Id is required for ${capability}`);
  return value;
}

async function sendVerifiedDocument(reply: FastifyReply, document: { filename: string; mimeType: string; storageKey: string; contentSha256: string }) {
  const file = await retrieveFile(document.storageKey);
  if (file.redirectUrl) throw new HttpError(409, "This evidence storage provider cannot be integrity-validated for download");
  if (createHash("sha256").update(file.buffer).digest("hex") !== document.contentSha256) throw new HttpError(409, "Organization evidence failed integrity validation");
  reply.header("Cache-Control", "private, no-store");
  reply.header("Content-Type", document.mimeType);
  reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
  reply.header("X-Content-Type-Options", "nosniff");
  return reply.send(file.buffer);
}

export async function postgresOrganizationAuthorityRoutes(app: FastifyInstance) {
  app.post("/v1/organization-invitations/resolve", {
    config: { rateLimit: { max: 20, timeWindow: "10 minutes" } },
    schema: { tags: ["Organization authority"], summary: "Resolve a confidential single-use organization invitation", body: invitationTokenJson, response: { 200: objectResponseJson } },
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store, private");
    return resolveOrganizationInvitation(invitationTokenSchema.parse(request.body).token);
  });

  app.post("/v1/organization-invitations/inspect", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Inspect an invitation after matching account proof", body: invitationTokenJson, response: { 200: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    reply.header("Cache-Control", "no-store, private");
    const token = invitationTokenSchema.parse(request.body).token;
    const identityId = await currentIdentity(request);
    return domain(() => inspectOrganizationInvitation({ token, identityId }));
  });

  app.post("/v1/organization-invitations/accept", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Accept an email-bound invitation exactly once", body: invitationTokenJson, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    const token = invitationTokenSchema.parse(request.body).token;
    const identityId = await currentIdentity(request);
    return domain(() => acceptOrganizationInvitation({ token, identityId }));
  });

  app.post("/v1/governance/organizations", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Create an issuer organization and its first owner atomically", headers: commandHeadersJson, body: organizationProfileJson, response: { 200: objectResponseJson, 201: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const payload = organizationProfileSchema.parse(request.body);
    const identityId = await currentIdentity(request);
    const result = await domain(() => createIssuerOrganization({ ...payload, identityId, commandKey: commandId(request, "organization creation") }));
    return reply.code(result.status).send({ ...result.body, replayed: result.replayed });
  });

  app.get("/v1/governance/organizations/:organizationId/authority", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Read the role-redacted organization authority workspace", params: organizationParamsJson(), response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "read", "business");
    const organizationId = z.string().uuid().parse((request.params as { organizationId: string }).organizationId);
    const currentIdentityId = await currentIdentity(request);
    const access = await organizationScope(currentIdentityId, organizationId, organizationMembershipRoles);
    return { ...await domain(() => getOrganizationAuthorityWorkspace({ organizationId, viewerRole: access.role, currentIdentityId })), currentIdentityId };
  });

  app.post("/v1/governance/organizations/:organizationId/invitations", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Issue a time-limited organization invitation", headers: commandHeadersJson, params: organizationParamsJson(), body: { type: "object", additionalProperties: false, required: ["email", "role", "expiresAt"], properties: { email: { type: "string", format: "email", maxLength: 320 }, role: { type: "string", enum: ["administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"] }, expiresAt: { type: "string", format: "date-time" } } }, response: { 200: objectResponseJson, 201: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const organizationId = z.string().uuid().parse((request.params as { organizationId: string }).organizationId);
    const identityId = await currentIdentity(request);
    await organizationScope(identityId, organizationId);
    const payload = invitationIssueSchema.parse(request.body);
    const result = await domain(() => issueOrganizationInvitation({ organizationId, invitedByIdentityId: identityId, ...payload, commandKey: commandId(request, "organization invitation") }));
    return reply.code(result.status).send({ ...result.body, replayed: result.replayed });
  });

  app.post("/v1/governance/organizations/:organizationId/invitations/:invitationId/revoke", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Revoke an unaccepted organization invitation", params: organizationParamsJson("invitation"), body: { type: "object", additionalProperties: false, required: ["reason"], properties: { reason: { type: "string", minLength: 5, maxLength: 1000 } } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const params = z.object({ organizationId: z.string().uuid(), invitationId: z.string().uuid() }).parse(request.params);
    const identityId = await currentIdentity(request);
    await organizationScope(identityId, params.organizationId);
    return domain(() => revokeOrganizationInvitation({ ...params, revokedByIdentityId: identityId, ...invitationRevokeSchema.parse(request.body) }));
  });

  app.post("/v1/governance/organizations/:organizationId/invitations/:invitationId/resend", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Rotate and redeliver an active organization invitation", headers: commandHeadersJson, params: organizationParamsJson("invitation"), response: { 200: objectResponseJson, 202: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const params = z.object({ organizationId: z.string().uuid(), invitationId: z.string().uuid() }).parse(request.params);
    const requestedByIdentityId = await currentIdentity(request);
    await organizationScope(requestedByIdentityId, params.organizationId);
    const result = await domain(() => resendOrganizationInvitation({
      ...params, requestedByIdentityId, commandKey: commandId(request, "organization invitation resend"),
    }));
    return reply.code(result.status).send({ ...result.body, replayed: result.replayed });
  });

  app.post("/v1/governance/organizations/:organizationId/memberships/:membershipId/role", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Change a non-owner organization membership role", params: organizationParamsJson("membership"), body: { type: "object", additionalProperties: false, required: ["role", "reason"], properties: { role: { type: "string", enum: ["administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"] }, reason: { type: "string", minLength: 5, maxLength: 1000 } } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const params = z.object({ organizationId: z.string().uuid(), membershipId: z.string().uuid() }).parse(request.params);
    const changedByIdentityId = await currentIdentity(request);
    await organizationScope(changedByIdentityId, params.organizationId);
    return domain(() => changeOrganizationMembershipRole({ ...params, changedByIdentityId, ...membershipRoleSchema.parse(request.body) }));
  });

  app.post("/v1/governance/organizations/:organizationId/memberships/:membershipId/status", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Suspend, restore, or revoke a non-owner membership", params: organizationParamsJson("membership"), body: { type: "object", additionalProperties: false, required: ["action", "reason"], properties: { action: { type: "string", enum: ["suspend", "restore", "revoke"] }, reason: { type: "string", minLength: 5, maxLength: 1000 } } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const params = z.object({ organizationId: z.string().uuid(), membershipId: z.string().uuid() }).parse(request.params);
    const changedByIdentityId = await currentIdentity(request);
    await organizationScope(changedByIdentityId, params.organizationId);
    return domain(() => changeOrganizationMembershipStatus({ ...params, changedByIdentityId, ...membershipStatusSchema.parse(request.body) }));
  });

  app.post("/v1/governance/organizations/:organizationId/ownership-transfers", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Propose a two-party organization ownership transfer", headers: commandHeadersJson, params: organizationParamsJson(), body: { type: "object", additionalProperties: false, required: ["targetMembershipId", "reason", "expiresAt"], properties: { targetMembershipId: uuidJson, reason: { type: "string", minLength: 10, maxLength: 2000 }, expiresAt: { type: "string", format: "date-time" } } }, response: { 200: objectResponseJson, 201: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    const organizationId = z.string().uuid().parse((request.params as { organizationId: string }).organizationId);
    const requestedByIdentityId = await currentIdentity(request);
    await organizationScope(requestedByIdentityId, organizationId);
    const result = await domain(() => proposeOrganizationOwnershipTransfer({
      organizationId, requestedByIdentityId, commandKey: commandId(request, "organization ownership transfer"),
      ...ownershipTransferProposalSchema.parse(request.body),
    }));
    return reply.code(result.status).send({ ...result.body, replayed: result.replayed });
  });

  app.post("/v1/governance/organizations/:organizationId/ownership-transfers/:transferId/decision", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Accept, reject, or cancel a two-party ownership transfer", headers: commandHeadersJson, params: { type: "object", additionalProperties: false, required: ["organizationId", "transferId"], properties: { organizationId: uuidJson, transferId: uuidJson } }, body: { type: "object", additionalProperties: false, required: ["action", "reason"], properties: { action: { type: "string", enum: ["accept", "reject", "cancel"] }, reason: { type: "string", minLength: 5, maxLength: 2000 } } }, response: { 200: objectResponseJson, 410: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    const params = z.object({ organizationId: z.string().uuid(), transferId: z.string().uuid() }).parse(request.params);
    const actorIdentityId = await currentIdentity(request);
    await organizationScope(actorIdentityId, params.organizationId, organizationMembershipRoles);
    const result = await domain(() => decideOrganizationOwnershipTransfer({
      ...params, actorIdentityId, commandKey: commandId(request, "organization ownership transfer decision"),
      ...ownershipTransferDecisionSchema.parse(request.body),
    }));
    return reply.code(result.status).send({ ...result.body, replayed: result.replayed });
  });

  app.post("/v1/governance/organizations/:organizationId/verification-evidence", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Scan and persist immutable organization verification evidence", params: organizationParamsJson(), body: { type: "object", additionalProperties: false, required: ["evidenceType", "filename", "mimeType", "contentBase64"], properties: { evidenceType: { type: "string", enum: organizationVerificationEvidenceTypes }, filename: { type: "string", minLength: 1, maxLength: 240 }, mimeType: { type: "string", enum: ["application/pdf", "image/jpeg", "image/png"] }, contentBase64: { type: "string", minLength: 1 } } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const organizationId = z.string().uuid().parse((request.params as { organizationId: string }).organizationId);
    const identityId = await currentIdentity(request);
    await organizationScope(identityId, organizationId);
    const payload = evidenceUploadSchema.parse(request.body);
    const stored = await persistOrganizationVerificationEvidenceBinary({ organizationId, ...payload });
    return recordStoredDocument({
      storageKey: stored.storageKey,
      source: "organization-verification-evidence",
      logger: request.log,
      record: () => domain(() => recordOrganizationVerificationEvidence({
        organizationId, uploadedByIdentityId: identityId, evidenceType: payload.evidenceType,
        filename: payload.filename, mimeType: payload.mimeType, storageKey: stored.storageKey,
        contentSha256: stored.sha256, bytes: stored.bytes,
      })),
    });
  });

  app.get("/v1/governance/organizations/:organizationId/verification-evidence/:evidenceDocumentId/download", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Download integrity-checked organization evidence", params: organizationParamsJson("evidence"), response: { 200: binaryResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    const params = z.object({ organizationId: z.string().uuid(), evidenceDocumentId: z.string().uuid() }).parse(request.params);
    await organizationScope(await currentIdentity(request), params.organizationId);
    const document = await getOrganizationVerificationEvidence(params);
    if (!document) throw new HttpError(404, "Organization verification evidence not found");
    return sendVerifiedDocument(reply, document);
  });

  app.post("/v1/governance/organizations/:organizationId/verification-requests", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Submit an immutable organization verification snapshot", headers: commandHeadersJson, params: organizationParamsJson(), body: { type: "object", additionalProperties: false, required: [...organizationProfileJson.required, "representativeAuthorityBasis", "beneficialOwners", "evidenceDocumentIds"], properties: { ...organizationProfileProperties, representativeAuthorityBasis: { type: "string", minLength: 10, maxLength: 2000 }, beneficialOwners: { type: "array", minItems: 1, maxItems: 50, items: beneficialOwnerJson }, evidenceDocumentIds: { type: "array", minItems: 3, maxItems: 30, items: uuidJson } } }, response: { 200: objectResponseJson, 201: objectResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "update", "business");
    const organizationId = z.string().uuid().parse((request.params as { organizationId: string }).organizationId);
    const submittedByIdentityId = await currentIdentity(request);
    await organizationScope(submittedByIdentityId, organizationId);
    const result = await domain(() => submitOrganizationVerification({
      organizationId, submittedByIdentityId, commandKey: commandId(request, "organization verification submission"),
      ...verificationSubmissionSchema.parse(request.body),
    }));
    return reply.code(result.status).send({ ...result.body, replayed: result.replayed });
  });

  app.get("/v1/control/organization-verifications", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "List independent organization-verification review work", querystring: { type: "object", additionalProperties: false, properties: { status: { type: "string", enum: ["submitted", "under_review", "approved", "rejected"] } } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or administrator role required");
    authorize(request.authUser, "review", "application");
    const query = z.object({ status: z.enum(["submitted", "under_review", "approved", "rejected"]).optional() }).parse(request.query);
    return { requests: await listOrganizationVerificationReviewQueue(query.status) };
  });

  app.get("/v1/control/organization-verifications/:requestId", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Read an immutable organization-verification review package", params: { type: "object", additionalProperties: false, required: ["requestId"], properties: { requestId: uuidJson } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or administrator role required");
    authorize(request.authUser, "review", "application");
    return domain(() => getOrganizationVerificationReview(z.string().uuid().parse((request.params as { requestId: string }).requestId)));
  });

  app.get("/v1/control/organization-verifications/:requestId/evidence/:evidenceDocumentId/download", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Download evidence bound to an independent review", params: { type: "object", additionalProperties: false, required: ["requestId", "evidenceDocumentId"], properties: { requestId: uuidJson, evidenceDocumentId: uuidJson } }, response: { 200: binaryResponseJson } } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or administrator role required");
    authorize(request.authUser, "review", "application");
    const params = z.object({ requestId: z.string().uuid(), evidenceDocumentId: z.string().uuid() }).parse(request.params);
    const review = await domain(() => getOrganizationVerificationReview(params.requestId));
    if (!review.evidenceDocuments.some((document) => document.id === params.evidenceDocumentId)) throw new HttpError(404, "Organization verification evidence not found");
    const document = await getOrganizationVerificationEvidence({ organizationId: review.request.organizationId, evidenceDocumentId: params.evidenceDocumentId });
    if (!document) throw new HttpError(404, "Organization verification evidence not found");
    return sendVerifiedDocument(reply, document);
  });

  app.post("/v1/control/organization-verifications/:requestId/decision", { preHandler: [app.authenticate], schema: { tags: ["Organization authority"], summary: "Independently approve or reject an organization verification", params: { type: "object", additionalProperties: false, required: ["requestId"], properties: { requestId: uuidJson } }, body: { type: "object", additionalProperties: false, required: ["approve", "reason"], properties: { approve: { type: "boolean" }, reason: { type: "string", minLength: 10, maxLength: 2000 }, validityDays: { type: "integer", minimum: 1, maximum: 730 } } }, response: { 200: objectResponseJson } } }, async (request: FastifyRequest) => {
    if (!['operator', 'admin'].includes(request.authUser.role)) throw new HttpError(403, "Operator or administrator role required");
    authorize(request.authUser, "approve", "application");
    const requestId = z.string().uuid().parse((request.params as { requestId: string }).requestId);
    const decidedByIdentityId = await currentIdentity(request);
    return domain(() => decideOrganizationVerification({ requestId, decidedByIdentityId, ...verificationDecisionSchema.parse(request.body) }));
  });
}
