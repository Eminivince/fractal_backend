import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requirePostgres } from "../../../db/postgres.js";
import { requirePostgresIdentityForSubject, PostgresIdentityUnavailableError } from "../../../platform/postgres-identities.js";
import { requireFreshTotpStepUp, StepUpRequiredError } from "../../../platform/auth-step-up.js";
import { listAccessibleOrganizations, requireOrganizationAccess, TenantAccessError } from "../../../platform/tenant-access.js";
import { getIssuerOverview, organizationVerificationStatuses } from "../../../platform/postgres-issuer-overview.js";
import { addOrganizationDocumentVersion, archiveOrganizationDocument, createOrganizationDocument, getOrganizationDocumentRetentionOptions, getOrganizationDocumentVersion, listOrganizationDocumentAccessEvents, listOrganizationDocuments, OrganizationDocumentError, organizationDocumentCategories, organizationDocumentRetentionBases, recordOrganizationDocumentDownload } from "../../../platform/postgres-organization-documents.js";
import {
  decideInvestorComplianceReview,
  decideOfferingPublicationRequest,
  getInvestorComplianceReviewRequest,
  getOfferingPublicationRequest,
  listInvestorComplianceReviewRequests,
  listOfferingPublicationRequests,
  OfferingGovernanceError,
  submitInvestorComplianceReview,
  submitOfferingPublicationRequest,
} from "../../../platform/postgres-offering-governance.js";
import { getOfferingPublicationEvidence, listOfferingPublicationEvidence, OfferingPublicationEvidenceError, recordOfferingPublicationEvidence } from "../../../platform/postgres-offering-publication-evidence.js";
import { AssetApplicationError, createAssetApplicationReviewItem, decideAssetApplicationRequest, decideAssetApplicationReviewItem, getAssetApplicationEvidence, getAssetApplicationRequest, listApprovedAssetApplicationVersions, listAssetApplicationRequests, listAssetApplicationReviewItems, recordAssetApplicationEvidence, respondToAssetApplicationReviewItem, submitAssetApplicationRequest } from "../../../platform/postgres-asset-applications.js";
import {
  decideOfferingChainDeploymentRequest,
  getOfferingChainDeploymentRequest,
  listOfferingChainDeploymentRequests,
  listOfferingChainOperations,
  OfferingChainDeploymentError,
  submitOfferingChainDeploymentRequest,
} from "../../../platform/postgres-offering-chain-deployments.js";
import {
  decideOfferingIssuanceTerms,
  getOfferingIssuanceTerms,
  listOfferingIssuanceTerms,
  OfferingIssuanceTermsError,
  submitOfferingIssuanceTerms,
} from "../../../platform/postgres-offering-issuance-terms.js";
import {
  decideInvestmentAllocation,
  getInvestmentAllocation,
  InvestmentAllocationError,
  listInvestmentAllocations,
  submitInvestmentAllocation,
} from "../../../platform/postgres-investment-allocations.js";
import { listAllocationChainOperations } from "../../../platform/postgres-allocation-chain-operations.js";
import { listInvestorPortfolioPositions } from "../../../platform/postgres-investor-portfolio.js";
import { getInvestorAgreementDocument, listInvestorAgreementDocuments } from "../../../platform/postgres-investor-documents.js";
import { listOrganizationIssuableOfferings } from "../../../platform/postgres-investment-offerings.js";
import { getGovernanceEvidenceDocument, GovernanceEvidenceError, listAllocationPolicyEvidence, recordAllocationPolicyEvidence } from "../../../platform/postgres-governance-evidence.js";
import { listIdentityVerificationEvidenceForReviewer } from "../../../platform/postgres-provider-identity-verification.js";
import {
  getIdentityVerificationApplication,
  IdentityVerificationApplicationError,
  recordIdentityVerificationAccessTokenIssued,
  requestIdentityVerificationApplication,
} from "../../../platform/postgres-identity-verification-applications.js";
import { persistGovernanceEvidenceBinary, persistOfferingPublicationEvidenceBinary, persistOrganizationDocumentBinary, retrieveFile } from "../../../services/storage.js";
import { recordStoredDocument } from "../../../services/storage-metadata-guard.js";
import { generateAccessToken, SumsubRequestError } from "../../../services/sumsub.js";
import { env } from "../../../config/env.js";
import { HttpError } from "../../../utils/errors.js";
import { readCommandId } from "../../../utils/idempotency.js";
import { PostgresIdempotencyConflictError } from "../../../platform/postgres-idempotency.js";
import { authorize } from "../../../utils/rbac.js";

const date = z.string().datetime({ offset: true }).transform((value) => new Date(value));
const offeringRequestSchema = z.object({
  publicReference: z.string().trim().min(1).max(200),
  currency: z.string().regex(/^[a-zA-Z]{3}$/),
  capacityMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  opensAt: date,
  closesAt: date,
  terms: z.object({
    name: z.string().trim().min(2).max(200),
    publicSlug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120),
    minimumTicketMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    assetClass: z.enum(["logistics_industrial", "mixed_use_real_estate", "renewable_energy", "infrastructure", "healthcare", "education", "agribusiness", "other"]),
    summary: z.string().trim().min(20).max(500),
    thesis: z.string().trim().min(20).max(2_000),
    targetReturnBps: z.number().int().positive().max(10_000),
    termMonths: z.number().int().positive().max(600),
    riskSummary: z.string().trim().min(20).max(2_000),
    incomeSource: z.string().trim().min(10).max(1_000),
    structure: z.string().trim().min(10).max(1_000),
    security: z.string().trim().min(10).max(1_000),
    feeSummary: z.string().trim().min(10).max(1_000),
    nextMilestone: z.string().trim().min(10).max(1_000),
  }).strict(),
  eligibilityPolicy: z.object({
    allowedInvestorClasses: z.array(z.enum(["retail", "sophisticated", "institutional"])).min(1),
    allowedJurisdictions: z.array(z.string().regex(/^[a-zA-Z]{2,3}$/)).optional(),
    requiresAccreditation: z.boolean().optional(),
  }),
  agreementEvidenceDocumentId: z.string().uuid(),
  disclosureEvidenceDocumentId: z.string().uuid(),
  approvedAssetApplicationVersionId: z.string().uuid(),
});
const complianceRequestSchema = z.object({
  investorIdentityId: z.string().uuid(),
  kycStatus: z.enum(["pending", "approved", "rejected", "expired"]),
  investorClass: z.enum(["retail", "sophisticated", "institutional"]),
  accreditationStatus: z.enum(["not_required", "pending", "verified", "expired"]),
  jurisdictionCode: z.string().regex(/^[a-zA-Z]{2,3}$/),
  reviewedAt: date,
  expiresAt: date.optional(),
  evidence: z.object({ providerIdentityVerificationEventId: z.string().uuid().optional() }).catchall(z.unknown()).optional(),
});
const decisionSchema = z.object({ approve: z.boolean(), reason: z.string().trim().min(1).max(2_000).optional() });
const requestListQuery = z.object({ status: z.enum(["submitted", "approved", "rejected"]).optional() });
const chainDeploymentSchema = z.object({
  offeringName: z.string().trim().min(2).max(200),
  tokenName: z.string().trim().min(2).max(120),
  tokenSymbol: z.string().trim().regex(/^[A-Za-z0-9-]{2,12}$/),
  issuanceTermsRequestId: z.string().uuid(),
  maxBalancePerHolder: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  retailCap: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});
const issuanceTermsSchema = z.object({
  tokenUnitPriceMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  maxTotalSupply: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  allocationPolicyEvidenceDocumentId: z.string().uuid(),
});
const allocationPolicyEvidenceSchema = z.object({
  filename: z.string().trim().min(1).max(240),
  contentBase64: z.string().min(1),
  mimeType: z.literal("application/pdf"),
});
const publicationEvidenceSchema = z.object({
  evidenceKind: z.enum(["agreement", "disclosure_bundle"]),
  filename: z.string().trim().min(1).max(240),
  contentBase64: z.string().min(1),
  mimeType: z.literal("application/pdf"),
});
const assetApplicationEvidenceSchema = z.object({ filename: z.string().trim().min(1).max(240), contentBase64: z.string().min(1), mimeType: z.literal("application/pdf") });
const assetApplicationRequestSchema = z.object({ applicationReference: z.string().trim().min(1).max(200), applicationVersion: z.number().int().positive(), assetName: z.string().trim().min(2).max(200), assetType: z.string().trim().min(2).max(120), countryCode: z.string().regex(/^[a-zA-Z]{2}$/), state: z.string().trim().min(2).max(120), city: z.string().trim().min(2).max(120), summary: z.string().trim().min(20).max(5000), materialChangeSummary: z.string().trim().min(20).max(2000).optional(), requestedCapacityMinor: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), currency: z.string().regex(/^[a-zA-Z]{3}$/), dossierEvidenceDocumentId: z.string().uuid() });
const assetApplicationReviewItemSchema = z.object({ category: z.string().trim().min(2).max(80), title: z.string().trim().min(2).max(200), requestMessage: z.string().trim().min(2).max(2000), required: z.boolean().optional() });
const assetApplicationResponseSchema = z.object({ responseMessage: z.string().trim().min(2).max(2000), responseEvidenceDocumentId: z.string().uuid() });
const assetApplicationReviewDecisionSchema = z.object({ verify: z.boolean(), notes: z.string().trim().min(1).max(2000).optional() });
const organizationDocumentUploadSchema = z.object({
  title: z.string().trim().min(2).max(240), category: z.enum(organizationDocumentCategories),
  reference: z.string().trim().min(1).max(120).optional(), retentionBasis: z.enum(organizationDocumentRetentionBases),
  filename: z.string().trim().min(1).max(240), contentBase64: z.string().min(1), mimeType: z.literal("application/pdf"),
});
const organizationDocumentVersionSchema = organizationDocumentUploadSchema.pick({ filename: true, contentBase64: true, mimeType: true }).extend({ reason: z.string().trim().min(10).max(1000) });
const organizationDocumentArchiveSchema = z.object({ reason: z.string().trim().min(10).max(1000) });
const allocationSchema = z.object({
  issuanceTermsRequestId: z.string().uuid(),
  reservationId: z.string().uuid(),
  walletId: z.string().uuid(),
  chainId: z.number().int().positive(),
});

const countJson = { type: "integer", minimum: 0 } as const;
const issuerOverviewResponseJson = {
  type: "object", additionalProperties: false,
  required: ["generatedAt", "summary", "organizations"],
  properties: {
    generatedAt: { type: "string", format: "date-time" },
    summary: {
      type: "object", additionalProperties: false,
      required: ["organizationCount", "actionRequiredCount", "submittedApplications", "publishedOfferings"],
      properties: {
        organizationCount: countJson, actionRequiredCount: countJson,
        submittedApplications: countJson, publishedOfferings: countJson,
      },
    },
    organizations: {
      type: "array",
      items: {
        type: "object", additionalProperties: false,
        required: ["id", "legalName", "role", "verification", "team", "applications", "offerings", "actionRequiredCount"],
        properties: {
          id: { type: "string", format: "uuid" },
          legalName: { type: "string" },
          role: { type: "string", enum: ["owner", "administrator", "offering_manager", "finance_operator", "compliance_reviewer", "viewer"] },
          verification: {
            type: "object", additionalProperties: false,
            required: ["status", "updatedAt", "expiresAt"],
            properties: {
              status: { type: "string", enum: organizationVerificationStatuses },
              updatedAt: { type: "string", format: "date-time" },
              expiresAt: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
            },
          },
          team: {
            type: "object", additionalProperties: false,
            required: ["activeMembers", "pendingInvitations"],
            properties: { activeMembers: countJson, pendingInvitations: countJson },
          },
          applications: {
            type: "object", additionalProperties: false,
            required: ["submitted", "approved", "rejected", "unresolvedDiligenceItems"],
            properties: { submitted: countJson, approved: countJson, rejected: countJson, unresolvedDiligenceItems: countJson },
          },
          offerings: {
            type: "object", additionalProperties: false,
            required: ["pendingPublicationRequests", "published", "paused", "closed"],
            properties: { pendingPublicationRequests: countJson, published: countJson, paused: countJson, closed: countJson },
          },
          actionRequiredCount: countJson,
        },
      },
    },
  },
} as const;

function requireGovernanceActor(request: FastifyRequest): void {
  if (!["issuer", "operator", "admin"].includes(request.authUser.role)) {
    throw new HttpError(403, "Issuer, operator, or admin role required");
  }
}

async function currentIdentity(request: FastifyRequest): Promise<string> {
  // This module deliberately contains both investor-owned reads and issuer
  // governance. Apply the actor restriction centrally only to the latter so
  // adding a new governed route cannot accidentally omit it.
  if (request.routeOptions.url?.startsWith("/v1/governance/")) {
    requireGovernanceActor(request);
  }
  try {
    return await requirePostgresIdentityForSubject(request.authUser.userId);
  } catch (error) {
    if (error instanceof PostgresIdentityUnavailableError) throw new HttpError(409, "Your account migration is not ready for the governed workflow");
    throw error;
  }
}

async function requireHighRiskStepUp(request: FastifyRequest, identityId: string): Promise<void> {
  try {
    await requireFreshTotpStepUp({ sessionId: request.authUser.sessionId, identityId });
  } catch (error) {
    if (error instanceof StepUpRequiredError) {
      throw new HttpError(403, error.message);
    }
    throw error;
  }
}

async function scope(identityId: string, organizationId: string, roles: readonly ("owner" | "administrator" | "offering_manager" | "finance_operator" | "compliance_reviewer" | "viewer")[]) {
  try {
    await requireOrganizationAccess({ identityId, organizationId, allowedRoles: roles });
  } catch (error) {
    if (error instanceof TenantAccessError) throw new HttpError(403, "You do not have the required organization role");
    throw error;
  }
}

function governed<T>(operation: () => Promise<T>): Promise<T> {
  return operation().catch((error) => {
    if (error instanceof OrganizationDocumentError) throw new HttpError(error.code === "not_found" ? 404 : error.code === "invalid_state" || error.code === "policy_unavailable" ? 409 : 422, error.message);
    if (error instanceof OfferingGovernanceError || error instanceof OfferingChainDeploymentError || error instanceof OfferingIssuanceTermsError || error instanceof InvestmentAllocationError || error instanceof GovernanceEvidenceError || error instanceof OfferingPublicationEvidenceError || error instanceof AssetApplicationError) throw new HttpError(422, error.message);
    throw error;
  });
}

function configuredChainDeploymentTarget() {
  if (!env.TOKEN_FACTORY_ADDRESS) throw new HttpError(409, "A token factory is not configured for this environment");
  return { chainId: env.CHAIN_ID, tokenFactoryAddress: env.TOKEN_FACTORY_ADDRESS };
}

function routeUuid(value: string, label: string): string {
  if (!z.string().uuid().safeParse(value).success) throw new HttpError(400, `${label} is invalid`);
  return value;
}

/**
 * Deliberately narrow operational APIs for the PostgreSQL checkout path.
 * The global RBAC policy controls platform role, and PG membership controls
 * tenant role. An individual cannot submit and decide the same request.
 */
export async function postgresOfferingGovernanceRoutes(app: FastifyInstance) {
  app.get("/v1/investor/identity-verification/application", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
    authorize(request.authUser, "read", "investor_profile");
    return { application: await getIdentityVerificationApplication(await currentIdentity(request)) };
  });

  app.post("/v1/investor/identity-verification/applications", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
    authorize(request.authUser, "submit", "investor_profile");
    if (!env.SUMSUB_ENABLED) throw new HttpError(422, "Identity-verification provider is not configured");
    const commandKey = readCommandId(request.headers);
    if (!commandKey) throw new HttpError(400, "X-Command-Id is required for identity-verification setup");
    try {
      const result = await requestIdentityVerificationApplication({ identityId: await currentIdentity(request), commandKey });
      return { application: result.application, replayed: result.replayed };
    } catch (error) {
      if (error instanceof PostgresIdempotencyConflictError) throw new HttpError(409, error.message);
      if (error instanceof IdentityVerificationApplicationError) throw new HttpError(422, error.message);
      throw error;
    }
  });

  app.post("/v1/investor/identity-verification/access-token", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
    authorize(request.authUser, "submit", "investor_profile");
    if (!env.SUMSUB_ENABLED) throw new HttpError(422, "Identity-verification provider is not configured");
    const identityId = await currentIdentity(request);
    const application = await getIdentityVerificationApplication(identityId);
    if (!application || application.status !== "ready") throw new HttpError(409, "Identity-verification setup is not ready");
    try {
      const accessToken = await generateAccessToken(application.externalUserId);
      if (!accessToken.token.trim() || accessToken.userId !== application.externalUserId) {
        throw new HttpError(502, "Identity-verification provider returned an invalid access token");
      }
      const expiresAt = new Date(Date.now() + env.SUMSUB_SDK_TOKEN_TTL_SECONDS * 1_000);
      await recordIdentityVerificationAccessTokenIssued({ applicationId: application.id, identityId, expiresAt });
      reply.header("Cache-Control", "no-store, private");
      reply.header("Pragma", "no-cache");
      return { token: accessToken.token, expiresAt: expiresAt.toISOString() };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      if (error instanceof SumsubRequestError) throw new HttpError(error.retryable ? 503 : 422, "Identity-verification token is temporarily unavailable");
      if (error instanceof IdentityVerificationApplicationError) throw new HttpError(409, "Identity-verification setup is not ready");
      throw error;
    }
  });

  app.get("/v1/investor/portfolio", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
    authorize(request.authUser, "read", "investor_profile");
    return { positions: await listInvestorPortfolioPositions(await currentIdentity(request)) };
  });

  app.get("/v1/investor/documents", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
    authorize(request.authUser, "read", "investor_profile");
    return { documents: await listInvestorAgreementDocuments(await currentIdentity(request)) };
  });

  app.get("/v1/investor/documents/:agreementAcceptanceId/download", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.authUser.role !== "investor") throw new HttpError(403, "Investor role required");
    authorize(request.authUser, "read", "investor_profile");
    const agreementAcceptanceId = (request.params as { agreementAcceptanceId: string }).agreementAcceptanceId;
    const document = await getInvestorAgreementDocument({ identityId: await currentIdentity(request), agreementAcceptanceId });
    if (!document) throw new HttpError(404, "Agreement document not found");
    const file = await retrieveFile(document.storageKey);
    if (file.redirectUrl) throw new HttpError(409, "This agreement storage provider cannot be integrity-validated for download");
    if (createHash("sha256").update(file.buffer).digest("hex") !== document.contentSha256) {
      throw new HttpError(409, "Agreement document failed integrity validation");
    }
    reply.header("Cache-Control", "private, no-store");
    reply.header("Content-Type", document.mimeType);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(file.buffer);
  });

  // Organization selection is derived from the caller's active memberships;
  // clients must never manufacture an organization identifier to enter a
  // governed workspace.
  app.get("/v1/governance/organizations", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const identityId = await currentIdentity(request);
    return { organizations: await listAccessibleOrganizations(identityId) };
  });

  app.get("/v1/issuer/overview", {
    preHandler: [app.authenticate],
    schema: {
      tags: ["Issuer operations"],
      summary: "Read the authenticated issuer's tenant-scoped operational overview",
      response: { 200: issuerOverviewResponseJson },
    },
  }, async (request: FastifyRequest) => {
    if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
    authorize(request.authUser, "read", "offering");
    return getIssuerOverview(await currentIdentity(request));
  });

  app.get("/v1/governance/organizations/:organizationId/documents", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId=routeUuid((request.params as {organizationId:string}).organizationId,"Organization"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator","offering_manager","finance_operator","compliance_reviewer","viewer"]);
    return {documents:await listOrganizationDocuments(organizationId)};
  });
  app.get("/v1/governance/organizations/:organizationId/document-retention-options", { preHandler: [app.authenticate], schema: {
    tags: ["Issuer operations"], summary: "Read the exact active organization-document retention rules for one authorized tenant",
    params: { type: "object", additionalProperties: false, required: ["organizationId"], properties: { organizationId: { type: "string", format: "uuid" } } },
    response: { 200: { type: "object", additionalProperties: false, required: ["policy", "rules"], properties: {
      policy: { type: "object", additionalProperties: false, required: ["versionId","versionNumber","reference","name","schemaVersion","jurisdictionCode","legalBasisReference"], properties: {
        versionId: { type: "string", format: "uuid" }, versionNumber: { type: "integer", minimum: 1 }, reference: { type: "string" }, name: { type: "string" },
        schemaVersion: { type: "string", enum: ["organization-document-retention-v1"] }, jurisdictionCode: { type: "string", pattern: "^[A-Z]{2}$" }, legalBasisReference: { type: "string" },
      } },
      rules: { type: "array", minItems: 24, maxItems: 24, items: { type: "object", additionalProperties: false, required: ["category","retentionBasis","retentionDays"], properties: {
        category: { type: "string", enum: organizationDocumentCategories }, retentionBasis: { type: "string", enum: organizationDocumentRetentionBases }, retentionDays: { type: "integer", minimum: 1, maximum: 9131 },
      } } },
    } } },
  } }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId=routeUuid((request.params as {organizationId:string}).organizationId,"Organization"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator","offering_manager"]);
    return governed(()=>getOrganizationDocumentRetentionOptions(organizationId));
  });
  app.post("/v1/governance/organizations/:organizationId/documents", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser,"create","offering"); const organizationId=routeUuid((request.params as {organizationId:string}).organizationId,"Organization"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator","offering_manager"]); const payload=organizationDocumentUploadSchema.parse(request.body);
    const documentId=randomUUID(); const stored=await persistOrganizationDocumentBinary({organizationId,documentId,filename:payload.filename,contentBase64:payload.contentBase64,mimeType:payload.mimeType});
    return recordStoredDocument({storageKey:stored.storageKey,source:"organization-document",logger:request.log,record:()=>governed(()=>createOrganizationDocument({documentId,organizationId,actorIdentityId:identityId,...payload,storageKey:stored.storageKey,contentSha256:stored.sha256,bytes:stored.bytes}))});
  });
  app.post("/v1/governance/organizations/:organizationId/documents/:documentId/versions", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser,"create","offering"); const params=request.params as {organizationId:string;documentId:string}; const organizationId=routeUuid(params.organizationId,"Organization"); const documentId=routeUuid(params.documentId,"Document"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator","offering_manager"]); const payload=organizationDocumentVersionSchema.parse(request.body);
    const stored=await persistOrganizationDocumentBinary({organizationId,documentId,filename:payload.filename,contentBase64:payload.contentBase64,mimeType:payload.mimeType});
    return recordStoredDocument({storageKey:stored.storageKey,source:"organization-document-version",logger:request.log,record:()=>governed(()=>addOrganizationDocumentVersion({organizationId,documentId,actorIdentityId:identityId,...payload,storageKey:stored.storageKey,contentSha256:stored.sha256,bytes:stored.bytes}))});
  });
  app.post("/v1/governance/organizations/:organizationId/documents/:documentId/archive", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser,"update","offering"); const params=request.params as {organizationId:string;documentId:string}; const organizationId=routeUuid(params.organizationId,"Organization"); const documentId=routeUuid(params.documentId,"Document"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator"]); await requireHighRiskStepUp(request,identityId); const payload=organizationDocumentArchiveSchema.parse(request.body);
    return governed(()=>archiveOrganizationDocument({organizationId,documentId,actorIdentityId:identityId,reason:payload.reason}));
  });
  app.get("/v1/governance/organizations/:organizationId/documents/:documentId/versions/:versionId/download", { preHandler: [app.authenticate] }, async (request: FastifyRequest,reply:FastifyReply) => {
    authorize(request.authUser,"read","offering"); const params=request.params as {organizationId:string;documentId:string;versionId:string}; const organizationId=routeUuid(params.organizationId,"Organization"); const documentId=routeUuid(params.documentId,"Document"); const versionId=routeUuid(params.versionId,"Document version"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator","offering_manager","finance_operator","compliance_reviewer","viewer"]);
    const document=await getOrganizationDocumentVersion({organizationId,documentId,versionId}); if(!document) throw new HttpError(404,"Organization document version not found");
    const file=await retrieveFile(document.storageKey); if(file.redirectUrl) throw new HttpError(409,"This document storage provider cannot be integrity-validated for download");
    if(createHash("sha256").update(file.buffer).digest("hex")!==document.contentSha256) throw new HttpError(409,"Organization document failed integrity validation");
    await governed(()=>recordOrganizationDocumentDownload({organizationId,documentId,versionId,actorIdentityId:identityId,contentSha256:document.contentSha256}));
    reply.header("Cache-Control","private, no-store"); reply.header("Content-Type",document.mimeType); reply.header("Content-Disposition",`attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`); reply.header("X-Content-Type-Options","nosniff"); return reply.send(file.buffer);
  });
  app.get("/v1/governance/organizations/:organizationId/documents/:documentId/access-events", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser,"read","offering"); const params=request.params as {organizationId:string;documentId:string}; const organizationId=routeUuid(params.organizationId,"Organization"); const documentId=routeUuid(params.documentId,"Document"); const identityId=await currentIdentity(request);
    await scope(identityId,organizationId,["owner","administrator"]); return {events:await listOrganizationDocumentAccessEvents({organizationId,documentId})};
  });

  app.get("/v1/governance/organizations/:organizationId/offering-publication-requests", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    return { requests: await listOfferingPublicationRequests({ organizationId, ...requestListQuery.parse(request.query) }) };
  });

  app.get("/v1/governance/organizations/:organizationId/investor-compliance/:investorIdentityId/provider-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const { organizationId, investorIdentityId } = request.params as { organizationId: string; investorIdentityId: string };
    if (!z.string().uuid().safeParse(investorIdentityId).success) throw new HttpError(400, "Investor identity is invalid");
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    // Provider identity evidence is platform-level PII. Organization membership
    // alone is not a licence to enumerate arbitrary investor identities: the
    // investor must already be part of this organization's governed compliance
    // review trail before any evidence can be returned.
    const association = await requirePostgres().query(
      `SELECT 1 FROM fractal.investor_compliance_review_requests
        WHERE organization_id = $1 AND investor_identity_id = $2
        LIMIT 1`,
      [organizationId, investorIdentityId],
    );
    if (!association.rows[0]) throw new HttpError(404, "Provider evidence is not available for this organization's investor review");
    return { evidence: await listIdentityVerificationEvidenceForReviewer({ identityId: investorIdentityId, accessedByIdentityId: identityId }) };
  });

  app.get("/v1/governance/organizations/:organizationId/asset-application-requests", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering"); const organizationId = (request.params as { organizationId: string }).organizationId; const identityId = await currentIdentity(request); await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]); return { requests: await listAssetApplicationRequests(organizationId), approvedVersions: await listApprovedAssetApplicationVersions(organizationId) };
  });
  app.post("/v1/governance/organizations/:organizationId/asset-application-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "create", "offering"); const organizationId = (request.params as { organizationId: string }).organizationId; const identityId = await currentIdentity(request); await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]); const payload = assetApplicationEvidenceSchema.parse(request.body); const stored = await persistOfferingPublicationEvidenceBinary({ organizationId, evidenceKind: "asset_dossier", filename: payload.filename, contentBase64: payload.contentBase64, mimeType: payload.mimeType }); return recordStoredDocument({ storageKey: stored.storageKey, source: "asset-application-evidence", logger: request.log, record: () => governed(() => recordAssetApplicationEvidence({ organizationId, uploadedByIdentityId: identityId, filename: payload.filename, mimeType: payload.mimeType, storageKey: stored.storageKey, contentSha256: stored.sha256, bytes: stored.bytes })) });
  });
  app.get("/v1/governance/organizations/:organizationId/asset-application-evidence/:evidenceDocumentId/download", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    authorize(request.authUser, "read", "offering"); const { organizationId, evidenceDocumentId } = request.params as { organizationId: string; evidenceDocumentId: string }; const identityId = await currentIdentity(request); await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]); const evidence = await getAssetApplicationEvidence(evidenceDocumentId); if (!evidence || evidence.organizationId !== organizationId) throw new HttpError(404, "Asset application evidence not found"); const file = await retrieveFile(evidence.storageKey); if (createHash("sha256").update(file.buffer).digest("hex") !== evidence.contentSha256) throw new HttpError(409, "Asset application evidence failed integrity validation"); reply.header("Content-Type", evidence.mimeType); reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(evidence.filename)}`); reply.header("X-Content-Type-Options", "nosniff"); return reply.send(file.buffer);
  });
  app.post("/v1/governance/organizations/:organizationId/asset-application-requests", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "create", "offering"); const organizationId = (request.params as { organizationId: string }).organizationId; const identityId = await currentIdentity(request); await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]); const payload = assetApplicationRequestSchema.parse(request.body); return governed(() => submitAssetApplicationRequest({ organizationId, submittedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/governance/asset-application-requests/:requestId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering"); const requestId = (request.params as { requestId: string }).requestId; const existing = await getAssetApplicationRequest(requestId); if (!existing) throw new HttpError(404, "Asset application request not found"); const identityId = await currentIdentity(request); await scope(identityId, existing.organizationId, ["owner", "administrator", "compliance_reviewer"]); await requireHighRiskStepUp(request, identityId); const payload = decisionSchema.parse(request.body); return governed(() => decideAssetApplicationRequest({ requestId, decidedByIdentityId: identityId, ...payload }));
  });
  app.get("/v1/governance/organizations/:organizationId/asset-application-requests/:applicationRequestId/review-items", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering"); const { organizationId, applicationRequestId } = request.params as { organizationId: string; applicationRequestId: string }; const identityId = await currentIdentity(request); await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]); return { items: await listAssetApplicationReviewItems({ organizationId, applicationRequestId }) };
  });
  app.post("/v1/governance/organizations/:organizationId/asset-application-requests/:applicationRequestId/review-items", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering"); const { organizationId, applicationRequestId } = request.params as { organizationId: string; applicationRequestId: string }; const identityId = await currentIdentity(request); await scope(identityId, organizationId, ["owner", "administrator", "compliance_reviewer"]); const payload = assetApplicationReviewItemSchema.parse(request.body); return governed(() => createAssetApplicationReviewItem({ organizationId, applicationRequestId, openedByIdentityId: identityId, ...payload }));
  });
  app.post("/v1/governance/asset-application-review-items/:reviewItemId/response", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "submit", "offering"); const reviewItemId = (request.params as { reviewItemId: string }).reviewItemId; const payload = assetApplicationResponseSchema.parse(request.body); const identityId = await currentIdentity(request); return governed(async () => { const items = await requirePostgres().query<{ organization_id: string }>("SELECT organization_id FROM fractal.asset_application_review_items WHERE id = $1", [reviewItemId]); const organizationId = items.rows[0]?.organization_id; if (!organizationId) throw new AssetApplicationError("Asset application review item not found"); await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]); await respondToAssetApplicationReviewItem({ reviewItemId, respondedByIdentityId: identityId, ...payload }); return { reviewItemId, status: "responded" }; });
  });
  app.post("/v1/governance/asset-application-review-items/:reviewItemId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering"); const reviewItemId = (request.params as { reviewItemId: string }).reviewItemId; const payload = assetApplicationReviewDecisionSchema.parse(request.body); const identityId = await currentIdentity(request); return governed(async () => { const items = await requirePostgres().query<{ organization_id: string }>("SELECT organization_id FROM fractal.asset_application_review_items WHERE id = $1", [reviewItemId]); const organizationId = items.rows[0]?.organization_id; if (!organizationId) throw new AssetApplicationError("Asset application review item not found"); await scope(identityId, organizationId, ["owner", "administrator", "compliance_reviewer"]); await requireHighRiskStepUp(request, identityId); await decideAssetApplicationReviewItem({ reviewItemId, reviewedByIdentityId: identityId, ...payload }); return { reviewItemId, status: payload.verify ? "verified" : "rejected" }; });
  });

  app.get("/v1/governance/organizations/:organizationId/offering-publication-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    const query = z.object({ evidenceKind: z.enum(["agreement", "disclosure_bundle"]).optional() }).parse(request.query);
    return { evidence: await listOfferingPublicationEvidence({ organizationId, evidenceKind: query.evidenceKind }) };
  });

  app.post("/v1/governance/organizations/:organizationId/offering-publication-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "create", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]);
    const payload = publicationEvidenceSchema.parse(request.body);
    const stored = await persistOfferingPublicationEvidenceBinary({ organizationId, evidenceKind: payload.evidenceKind, filename: payload.filename, contentBase64: payload.contentBase64, mimeType: payload.mimeType });
    return recordStoredDocument({ storageKey: stored.storageKey, source: "offering-publication-evidence", logger: request.log, record: () => governed(() => recordOfferingPublicationEvidence({ organizationId, evidenceKind: payload.evidenceKind, uploadedByIdentityId: identityId, filename: payload.filename, mimeType: payload.mimeType, storageKey: stored.storageKey, contentSha256: stored.sha256, bytes: stored.bytes })) });
  });

  app.get("/v1/governance/organizations/:organizationId/offering-publication-evidence/:evidenceDocumentId/download", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    authorize(request.authUser, "read", "offering");
    const { organizationId, evidenceDocumentId } = request.params as { organizationId: string; evidenceDocumentId: string };
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    const evidence = await getOfferingPublicationEvidence(evidenceDocumentId);
    if (!evidence || evidence.organizationId !== organizationId) throw new HttpError(404, "Offering publication evidence not found");
    const file = await retrieveFile(evidence.storageKey);
    if (createHash("sha256").update(file.buffer).digest("hex") !== evidence.contentSha256) throw new HttpError(409, "Offering publication evidence failed integrity validation");
    reply.header("Content-Type", evidence.mimeType);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(evidence.filename)}`);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(file.buffer);
  });

  app.get("/v1/governance/organizations/:organizationId/issuable-offerings", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    return { offerings: await listOrganizationIssuableOfferings(organizationId) };
  });

  app.get("/v1/governance/organizations/:organizationId/allocation-policy-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    const query = z.object({ offeringId: z.string().uuid().optional() }).parse(request.query);
    return { evidence: await listAllocationPolicyEvidence({ organizationId, offeringId: query.offeringId }) };
  });

  app.post("/v1/governance/organizations/:organizationId/offerings/:offeringId/allocation-policy-evidence", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "submit", "offering");
    const { organizationId, offeringId } = request.params as { organizationId: string; offeringId: string };
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]);
    const payload = allocationPolicyEvidenceSchema.parse(request.body);
    const stored = await persistGovernanceEvidenceBinary({ organizationId, offeringId, ...payload });
    return recordStoredDocument({ storageKey: stored.storageKey, source: "allocation-policy-evidence", logger: request.log, record: () => governed(() => recordAllocationPolicyEvidence({ organizationId, offeringId, uploadedByIdentityId: identityId, filename: payload.filename, mimeType: payload.mimeType, storageKey: stored.storageKey, contentSha256: stored.sha256, bytes: stored.bytes })) });
  });

  app.get("/v1/governance/organizations/:organizationId/allocation-policy-evidence/:evidenceDocumentId/download", { preHandler: [app.authenticate] }, async (request: FastifyRequest, reply: FastifyReply) => {
    authorize(request.authUser, "read", "offering");
    const { organizationId, evidenceDocumentId } = request.params as { organizationId: string; evidenceDocumentId: string };
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    const evidence = await getGovernanceEvidenceDocument(evidenceDocumentId);
    if (!evidence || evidence.organizationId !== organizationId) throw new HttpError(404, "Allocation policy evidence not found");
    const file = await retrieveFile(evidence.storageKey);
    const actualHash = createHash("sha256").update(file.buffer).digest("hex");
    if (actualHash !== evidence.contentSha256) throw new HttpError(409, "Allocation policy evidence failed integrity validation");
    reply.header("Content-Type", evidence.mimeType);
    reply.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(evidence.filename)}`);
    reply.header("X-Content-Type-Options", "nosniff");
    return reply.send(file.buffer);
  });

  app.post("/v1/governance/organizations/:organizationId/offering-publication-requests", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "create", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]);
    const payload = offeringRequestSchema.parse(request.body);
    return governed(() => submitOfferingPublicationRequest({ organizationId, submittedByIdentityId: identityId, ...payload }));
  });

  app.post("/v1/governance/offering-publication-requests/:requestId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering");
    const requestId = (request.params as { requestId: string }).requestId;
    const existing = await getOfferingPublicationRequest(requestId);
    if (!existing) throw new HttpError(404, "Offering publication request not found");
    const identityId = await currentIdentity(request);
    await scope(identityId, existing.organization_id, ["owner", "administrator", "compliance_reviewer"]);
    await requireHighRiskStepUp(request, identityId);
    const payload = decisionSchema.parse(request.body);
    return governed(() => decideOfferingPublicationRequest({ requestId, decidedByIdentityId: identityId, ...payload }));
  });

  app.post("/v1/governance/organizations/:organizationId/investor-compliance-reviews", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "investor_profile");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "compliance_reviewer"]);
    const payload = complianceRequestSchema.parse(request.body);
    return governed(() => submitInvestorComplianceReview({ organizationId, submittedByIdentityId: identityId, identityId: payload.investorIdentityId, kycStatus: payload.kycStatus, investorClass: payload.investorClass, accreditationStatus: payload.accreditationStatus, jurisdictionCode: payload.jurisdictionCode, reviewedAt: payload.reviewedAt, expiresAt: payload.expiresAt, evidence: payload.evidence }));
  });

  app.get("/v1/governance/organizations/:organizationId/investor-compliance-reviews", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "investor_profile");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "compliance_reviewer"]);
    return { requests: await listInvestorComplianceReviewRequests({ organizationId, ...requestListQuery.parse(request.query) }) };
  });

  app.post("/v1/governance/investor-compliance-reviews/:requestId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "investor_profile");
    const requestId = (request.params as { requestId: string }).requestId;
    const existing = await getInvestorComplianceReviewRequest(requestId);
    if (!existing) throw new HttpError(404, "Compliance review request not found");
    const identityId = await currentIdentity(request);
    await scope(identityId, existing.organization_id, ["owner", "administrator", "compliance_reviewer"]);
    await requireHighRiskStepUp(request, identityId);
    const payload = decisionSchema.parse(request.body);
    return governed(() => decideInvestorComplianceReview({ requestId, decidedByIdentityId: identityId, ...payload }));
  });

  // Contract deployment is a separate maker-checker action. The API binds it
  // to the configured factory and records a dispatchable operation, but does
  // not send a transaction from an HTTP handler.
  app.get("/v1/governance/organizations/:organizationId/chain-deployment-requests", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    return { requests: await listOfferingChainDeploymentRequests({ organizationId, ...requestListQuery.parse(request.query) }) };
  });

  app.get("/v1/governance/organizations/:organizationId/chain-operations", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    return { operations: await listOfferingChainOperations({ organizationId }) };
  });

  app.post("/v1/governance/organizations/:organizationId/offerings/:offeringId/chain-deployment-requests", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "submit", "offering");
    const { organizationId, offeringId } = request.params as { organizationId: string; offeringId: string };
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]);
    const payload = chainDeploymentSchema.parse(request.body);
    return governed(() => submitOfferingChainDeploymentRequest({ organizationId, offeringId, submittedByIdentityId: identityId, ...configuredChainDeploymentTarget(), ...payload }));
  });

  app.post("/v1/governance/chain-deployment-requests/:requestId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering");
    const requestId = (request.params as { requestId: string }).requestId;
    const existing = await getOfferingChainDeploymentRequest(requestId);
    if (!existing) throw new HttpError(404, "Offering chain deployment request not found");
    const identityId = await currentIdentity(request);
    await scope(identityId, existing.organizationId, ["owner", "administrator", "compliance_reviewer"]);
    await requireHighRiskStepUp(request, identityId);
    const payload = decisionSchema.parse(request.body);
    return governed(() => decideOfferingChainDeploymentRequest({ requestId, decidedByIdentityId: identityId, ...payload }));
  });

  app.get("/v1/governance/organizations/:organizationId/issuance-terms", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    return { requests: await listOfferingIssuanceTerms({ organizationId, ...requestListQuery.parse(request.query) }) };
  });

  app.post("/v1/governance/organizations/:organizationId/offerings/:offeringId/issuance-terms", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "submit", "offering");
    const { organizationId, offeringId } = request.params as { organizationId: string; offeringId: string };
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]);
    return governed(() => submitOfferingIssuanceTerms({ organizationId, offeringId, submittedByIdentityId: identityId, ...issuanceTermsSchema.parse(request.body) }));
  });

  app.post("/v1/governance/issuance-terms/:requestId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering");
    const requestId = (request.params as { requestId: string }).requestId;
    const existing = await getOfferingIssuanceTerms(requestId);
    if (!existing) throw new HttpError(404, "Offering issuance terms request not found");
    const identityId = await currentIdentity(request);
    await scope(identityId, existing.organizationId, ["owner", "administrator", "compliance_reviewer"]);
    await requireHighRiskStepUp(request, identityId);
    return governed(() => decideOfferingIssuanceTerms({ requestId, decidedByIdentityId: identityId, ...decisionSchema.parse(request.body) }));
  });

  app.get("/v1/governance/organizations/:organizationId/investment-allocations", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    return { requests: await listInvestmentAllocations({ organizationId, ...requestListQuery.parse(request.query) }) };
  });

  app.get("/v1/governance/organizations/:organizationId/allocation-chain-operations", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const organizationId = (request.params as { organizationId: string }).organizationId;
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager", "compliance_reviewer"]);
    const query = z.object({ allocationRequestId: z.string().uuid().optional() }).parse(request.query);
    return { operations: await listAllocationChainOperations({ organizationId, allocationRequestId: query.allocationRequestId }) };
  });

  app.post("/v1/governance/organizations/:organizationId/offerings/:offeringId/investment-allocations", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "submit", "offering");
    const { organizationId, offeringId } = request.params as { organizationId: string; offeringId: string };
    const identityId = await currentIdentity(request);
    await scope(identityId, organizationId, ["owner", "administrator", "offering_manager"]);
    return governed(() => submitInvestmentAllocation({ organizationId, offeringId, submittedByIdentityId: identityId, ...allocationSchema.parse(request.body) }));
  });

  app.post("/v1/governance/investment-allocations/:requestId/decision", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "approve", "offering");
    const requestId = (request.params as { requestId: string }).requestId;
    const existing = await getInvestmentAllocation(requestId);
    if (!existing) throw new HttpError(404, "Investment allocation request not found");
    const identityId = await currentIdentity(request);
    await scope(identityId, existing.organizationId, ["owner", "administrator", "compliance_reviewer"]);
    await requireHighRiskStepUp(request, identityId);
    return governed(() => decideInvestmentAllocation({ requestId, decidedByIdentityId: identityId, ...decisionSchema.parse(request.body) }));
  });
}
