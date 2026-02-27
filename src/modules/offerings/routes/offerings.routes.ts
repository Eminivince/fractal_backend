import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import mongoose from "mongoose";
import {
  ApplicationModel,
  BusinessModel,
  CorporateActionModel,
  DistributionModel,
  DossierModel,
  InvestorProfileModel,
  LedgerEntryModel,
  MilestoneModel,
  OfferingModel,
  OfferingQAModel,
  OfferingUpdateModel,
  PlatformConfigModel,
  SubscriptionModel,
  TrancheModel,
  UserModel,
} from "../../../db/models.js";
import { toDecimal } from "../../../utils/decimal.js";
import { authorize } from "../../../utils/rbac.js";
import { appendEvent } from "../../../utils/audit.js";
import { HttpError } from "../../../utils/errors.js";
import { assertTransition } from "../../../utils/state-machine.js";
import { assertIssuerBusinessScope } from "../../../utils/scope.js";
import { runInTransaction } from "../../../utils/tx.js";
import { serialize } from "../../../utils/serialize.js";
import type { AuthUser } from "../../../types.js";
import { economicPolicyHash, isEconomicPolicyValid, normalizeEconomicPolicy } from "../../../utils/economic-policy.js";
import { createAnchorRecord, hasAnchor } from "../../../utils/anchor.js";
import { readCommandId, runIdempotentCommand } from "../../../utils/idempotency.js";
import { persistOfferingImage, retrieveFile } from "../../../services/storage.js";
import { createNotificationsFromEvent } from "../../../services/notifications.js";

const createOfferingSchema = z.object({
  applicationId: z.string(),
  name: z.string().min(3),
  summary: z.string().min(3),
  opensAt: z.string(),
  closesAt: z.string(),
  terms: z.record(z.string(), z.unknown()),
  // I-17: Legal instrument type
  instrumentType: z.enum(["debt_note", "revenue_share", "equity", "hybrid"]).optional(),
  // I-18: Soft cap
  softCap: z.number().positive().optional(),
  // I-19: Oversubscription policy
  oversubscriptionPolicy: z
    .enum(["pro_rata", "first_come_first_served", "waitlist"])
    .optional(),
  maxSingleInvestorPct: z.number().min(1).max(100).optional(),
  // I-22: Per-investor max subscription cap
  maxTicket: z.number().positive().optional(),
  // I-21: Private offering mode
  isPrivate: z.boolean().optional(),
  // I-47: Conflicts of interest
  conflictsOfInterest: z.string().optional(),
  // I-48: Issuer track record
  issuerTrackRecord: z
    .object({
      completedProjects: z.number().int().min(0).optional(),
      totalCapitalRaised: z.number().nonnegative().optional(),
      yearsExperience: z.number().int().min(0).optional(),
      priorDefaultCount: z.number().int().min(0).optional(),
      teamBackground: z.string().max(2000).optional(),
      notableProjects: z.string().max(2000).optional(),
    })
    .optional(),
  // I-49: Risk factors
  riskFactors: z
    .array(
      z.object({
        category: z.enum(["market", "liquidity", "regulatory", "project", "counterparty", "other"]),
        description: z.string().min(5),
      }),
    )
    .optional(),
  economicPolicy: z
    .object({
      version: z.number().int().positive(),
      policyType: z.string().min(2),
      config: z.record(z.string(), z.unknown()),
    })
    .optional(),
  disclosurePack: z
    .object({
      documentIds: z.array(z.string()).optional(),
    })
    .optional(),
  // I-12: Independent asset valuation
  valuation: z
    .object({
      amount: z.number().positive().optional(),
      date: z.string().optional(),
      reportDocumentId: z.string().optional(),
      valuedBy: z.string().optional(),
    })
    .optional(),
  // I-14: Credit enhancement / guarantee disclosure
  creditEnhancement: z
    .object({
      type: z
        .enum(["personal_guarantee", "bank_guarantee", "insurance_backed", "collateral", "sinking_fund", "none"])
        .optional(),
      description: z.string().max(2000).optional(),
      guarantorName: z.string().max(200).optional(),
    })
    .optional(),
});

const listOfferingsQuerySchema = z.object({
  status: z
    .enum(["draft", "pending_review", "needs_revision", "open", "paused", "closed", "servicing", "exited", "cancelled"])
    .optional(),
  templateCode: z.enum(["A", "B"]).optional(),
  businessId: z.string().optional(),
  name: z.string().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
});

function parseBearerToken(header?: string): string | null {
  if (!header) return null;
  const [scheme, token] = header.split(" ");
  if (!scheme || !token) return null;
  if (scheme.toLowerCase() !== "bearer") return null;
  return token;
}

async function getOptionalAuthUser(app: FastifyInstance, request: FastifyRequest): Promise<AuthUser | null> {
  const token = parseBearerToken(request.headers.authorization);
  if (!token) return null;
  try {
    const payload = (await app.jwt.verify(token)) as AuthUser;
    return payload;
  } catch {
    return null;
  }
}

function extractRaiseAmount(terms: Record<string, unknown>): number {
  const raw = terms.raiseAmount;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return Number(raw);
  throw new HttpError(422, "terms.raiseAmount is required");
}

function isFeeSnapshotConfigured(offering: any): boolean {
  return Boolean(
    offering.feeSnapshot?.setupFee !== undefined &&
      offering.feeSnapshot?.platformFeePct !== undefined &&
      offering.feeSnapshot?.servicingFeePct !== undefined,
  );
}

async function assertCanViewOfferings(configRequireKyc: boolean, user: AuthUser | null) {
  if (!configRequireKyc) return;
  if (!user) throw new HttpError(403, "KYC required before viewing offerings");
  if (user.role !== "investor") return;

  const profile = await InvestorProfileModel.findOne({ userId: user.userId }).lean();
  if (!profile || profile.kycStatus !== "approved") {
    throw new HttpError(403, "KYC approved profile required before viewing offerings");
  }
}

async function hasPendingPaymentReconciliation(offeringId: string, session: mongoose.ClientSession): Promise<boolean> {
  const pending = await SubscriptionModel.countDocuments({
    offeringId: new mongoose.Types.ObjectId(offeringId),
    status: "payment_pending",
  }).session(session);
  return pending > 0;
}

function buildAllocationBatchId(offeringId: string): string {
  return `alloc_${offeringId}_${Date.now()}`;
}

export async function offeringRoutes(app: FastifyInstance) {
  app.post(
    "/v1/offerings",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "create", "offering");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
      const payload = createOfferingSchema.parse(request.body);
      // I-73: Idempotency — wrap create in runIdempotentCommand to prevent duplicates from double-clicks
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings",
        payload: { applicationId: payload.applicationId, name: payload.name },
        execute: () =>
      runInTransaction(async (session) => {
        const application = await ApplicationModel.findById(payload.applicationId).session(session);
        if (!application) throw new HttpError(404, "Application not found");

        assertIssuerBusinessScope(request.authUser, String(application.businessId));
        if (application.status !== "approved") {
          throw new HttpError(422, "Offering can only be created from an approved application");
        }

        // I-06: Periodic KYB re-verification gate — KYB must be approved within last 12 months
        const issuerBusiness = await BusinessModel.findById(application.businessId)
          .select("kybStatus registrationApprovedAt")
          .session(session);
        if (!issuerBusiness) throw new HttpError(404, "Issuer business not found");
        if (issuerBusiness.kybStatus !== "approved") {
          throw new HttpError(422, "Business KYB must be approved before creating an offering");
        }
        if (issuerBusiness.registrationApprovedAt) {
          const kybAgeMs = Date.now() - new Date(issuerBusiness.registrationApprovedAt).getTime();
          const twelveMonthsMs = 12 * 30 * 24 * 60 * 60 * 1000;
          if (kybAgeMs > twelveMonthsMs) {
            throw new HttpError(
              422,
              "Your business KYB verification has expired (must be refreshed within 12 months). Please contact the platform to re-verify your business.",
            );
          }
        }

        // I-72: Prevent duplicate active offerings for same application
        const duplicateOffering = await OfferingModel.findOne({
          applicationId: application._id,
          status: { $nin: ["cancelled", "exited"] },
        })
          .select("_id status")
          .session(session);
        if (duplicateOffering) {
          throw new HttpError(
            422,
            `An active offering already exists for this application (status: ${(duplicateOffering as any).status}). Cancel or exit the existing offering before creating a new one.`,
          );
        }

        const platformConfig = await PlatformConfigModel.findById("platform_config").session(session);
        if (!platformConfig) throw new HttpError(404, "Platform config not found");

        if (application.templateCode === "B" && !platformConfig.featureFlags.enableTemplateB) {
          throw new HttpError(422, "Template B is disabled by feature flag");
        }

        const raiseAmount = extractRaiseAmount(payload.terms);
        const rawEconomicPolicy = normalizeEconomicPolicy(
          payload.economicPolicy,
          application.templateCode,
        );
        const economicPolicy =
          Object.keys(rawEconomicPolicy.config ?? {}).length > 0
            ? rawEconomicPolicy
            : {
                ...rawEconomicPolicy,
                config: { templateCode: application.templateCode },
              };

        const inputDisclosureDocs = payload.disclosurePack?.documentIds ?? [];
        let disclosureDocs = inputDisclosureDocs;
        if (disclosureDocs.length === 0) {
          const dossier = await DossierModel.findOne({
            applicationId: application._id,
          })
            .select("documents._id")
            .session(session ?? null);

          const dossierDocumentIds = Array.isArray((dossier as any)?.documents)
            ? (dossier as any).documents
                .map((doc: any) => String(doc?._id ?? "").trim())
                .filter((id: string) => id.length > 0)
            : [];
          if (dossierDocumentIds.length > 0) {
            disclosureDocs = dossierDocumentIds;
          }
        }

        const [offering] = await OfferingModel.create(
          [
            {
              applicationId: application._id,
              businessId: application.businessId,
              templateCode: application.templateCode,
              name: payload.name,
              summary: payload.summary,
              status: "draft",
              opensAt: new Date(payload.opensAt),
              closesAt: new Date(payload.closesAt),
              terms: payload.terms,
              // I-17: Instrument type classification
              instrumentType: payload.instrumentType,
              // I-21: Private offering mode
              isPrivate: payload.isPrivate ?? false,
              // I-47: Conflicts of interest
              conflictsOfInterest: payload.conflictsOfInterest,
              conflictsDisclosedAt: payload.conflictsOfInterest ? new Date() : undefined,
              // I-48: Track record
              issuerTrackRecord: payload.issuerTrackRecord
                ? {
                    ...payload.issuerTrackRecord,
                    totalCapitalRaised: payload.issuerTrackRecord.totalCapitalRaised !== undefined
                      ? toDecimal(payload.issuerTrackRecord.totalCapitalRaised)
                      : undefined,
                    disclosedAt: new Date(),
                  }
                : undefined,
              // I-49: Risk factors
              riskFactors: payload.riskFactors ?? [],
              // I-14: Credit enhancement disclosure
              creditEnhancement: payload.creditEnhancement
                ? {
                    type: payload.creditEnhancement.type ?? "none",
                    description: payload.creditEnhancement.description,
                    guarantorName: payload.creditEnhancement.guarantorName,
                    disclosedAt: new Date(),
                  }
                : undefined,
              // I-12: Independent valuation
              valuation: payload.valuation
                ? {
                    amount: payload.valuation.amount !== undefined ? toDecimal(payload.valuation.amount) : undefined,
                    date: payload.valuation.date ? new Date(payload.valuation.date) : undefined,
                    expiresAt: payload.valuation.date
                      ? new Date(new Date(payload.valuation.date).getTime() + 6 * 30 * 24 * 60 * 60 * 1000)
                      : undefined,
                    reportDocumentId: payload.valuation.reportDocumentId,
                    valuedBy: payload.valuation.valuedBy,
                  }
                : undefined,
              economicPolicy: {
                ...economicPolicy,
                canonicalHash: economicPolicyHash(economicPolicy),
                validatedAt: new Date(),
              },
              disclosurePack: {
                status: disclosureDocs.length > 0 ? "ready" : "missing",
                documentIds: disclosureDocs,
              },
              feeSnapshot: {
                setupFee: platformConfig.feeConfig.setupFee,
                platformFeePct: platformConfig.feeConfig.platformFeePct,
                servicingFeePct: platformConfig.feeConfig.servicingFeePct,
              },
              metrics: {
                raiseAmount: toDecimal(raiseAmount),
                // I-18: Soft cap
                softCap: payload.softCap !== undefined ? toDecimal(payload.softCap) : undefined,
                subscribedAmount: toDecimal(0),
                investorCount: 0,
                // I-19: Oversubscription policy
                oversubscriptionPolicy: payload.oversubscriptionPolicy ?? "first_come_first_served",
                maxSingleInvestorPct: payload.maxSingleInvestorPct,
                // I-22: Max ticket cap
                maxTicket: payload.maxTicket !== undefined ? toDecimal(payload.maxTicket) : undefined,
              },
              createdBy: request.authUser.userId,
            },
          ],
          { session },
        );

        if (application.templateCode === "B") {
          const milestones = Array.isArray(payload.terms.milestones) ? payload.terms.milestones : [];
          const parsedMilestones = milestones
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const row = item as Record<string, unknown>;
              const name = typeof row.name === "string" ? row.name : null;
              const percent =
                typeof row.percent === "number" ? row.percent : typeof row.amountPct === "number" ? row.amountPct : null;
              if (!name || percent === null) return null;
              return { name, percent };
            })
            .filter(Boolean) as Array<{ name: string; percent: number }>;

          for (const milestone of parsedMilestones) {
            const [createdMilestone] = await MilestoneModel.create(
              [
                {
                  offeringId: offering._id,
                  name: milestone.name,
                  percent: milestone.percent,
                  status: "not_started",
                  evidenceDocs: [],
                },
              ],
              { session },
            );

            await TrancheModel.create(
              [
                {
                  offeringId: offering._id,
                  milestoneId: createdMilestone._id,
                  amount: toDecimal((raiseAmount * milestone.percent) / 100),
                  status: "locked",
                },
              ],
              { session },
            );
          }
        }

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingCreated",
            notes: `template:${application.templateCode}`,
          },
          session,
        );

        return serialize(offering.toObject());
      }),
      });
    },
  );

  app.get("/v1/offerings", async (request: FastifyRequest) => {
    const query = listOfferingsQuerySchema.parse(request.query);
    const config = await PlatformConfigModel.findById("platform_config").lean();

    const authUser = await getOptionalAuthUser(app, request);
    const requireKycToView = config?.complianceRules?.requireKycToView ?? false;
    await assertCanViewOfferings(requireKycToView, authUser);

    const filter: Record<string, unknown> = {};
    if (query.status) {
      filter.status = query.status;
    } else if (!authUser || authUser.role === "investor") {
      filter.status = { $in: ["open", "paused", "closed", "servicing", "exited"] };
    }

    if (query.templateCode) filter.templateCode = query.templateCode;

    if (authUser?.role === "issuer") {
      filter.businessId = authUser.businessId;
    } else if (query.businessId && (authUser?.role === "admin" || authUser?.role === "operator")) {
      filter.businessId = query.businessId;
    }

    if (query.name) {
      filter.name = { $regex: query.name, $options: "i" };
    }

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const [rows, total] = await Promise.all([
      OfferingModel.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      OfferingModel.countDocuments(filter),
    ]);
    return serialize({ data: rows, total, page, limit, pages: Math.ceil(total / limit) });
  });

  app.get("/v1/offerings/:id", async (request: FastifyRequest) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const offering = await OfferingModel.findById(params.id).lean();
    if (!offering) throw new HttpError(404, "Offering not found");

    const config = await PlatformConfigModel.findById("platform_config").lean();

    const authUser = await getOptionalAuthUser(app, request);
    const requireKycToView = config?.complianceRules?.requireKycToView ?? false;
    await assertCanViewOfferings(requireKycToView, authUser);

    if (authUser?.role === "issuer") assertIssuerBusinessScope(authUser, String(offering.businessId));

    if (!authUser && !["open", "paused", "closed", "servicing", "exited"].includes(offering.status)) {
      throw new HttpError(403, "Offering is not public");
    }

    return serialize(offering);
  });

  app.post(
    "/v1/offerings/:id/submit-for-review",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/submit-for-review",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");
            assertIssuerBusinessScope(request.authUser, String(offering.businessId));

            assertTransition("offering", offering.status as any, "pending_review");
            offering.status = "pending_review";
            await offering.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingSubmittedForReview",
              },
              session,
            );

            // I-58/I-59: Notify operators that a new offering is pending review
            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingSubmittedForReview",
                notes: `Offering "${offering.name}" has been submitted for review and is awaiting approval.`,
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/offerings/:id/approve-open",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/approve-open",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            const application = await ApplicationModel.findById(offering.applicationId).session(session);
            if (!application) throw new HttpError(404, "Application not found");

            const currentPolicy = offering.economicPolicy as
              | Record<string, unknown>
              | undefined;
            const hasPolicyConfig =
              currentPolicy &&
              typeof currentPolicy.config === "object" &&
              currentPolicy.config !== null &&
              !Array.isArray(currentPolicy.config);

            if (!hasPolicyConfig) {
              const repairedPolicy = normalizeEconomicPolicy(
                {
                  version:
                    typeof currentPolicy?.version === "number" &&
                    currentPolicy.version > 0
                      ? currentPolicy.version
                      : 1,
                  policyType:
                    typeof currentPolicy?.policyType === "string" &&
                    currentPolicy.policyType.trim().length >= 2
                      ? currentPolicy.policyType.trim()
                      : offering.templateCode === "A"
                        ? "rental_distribution"
                        : "milestone_tranche",
                  config: { templateCode: offering.templateCode },
                },
                offering.templateCode,
              );

              offering.economicPolicy = {
                ...repairedPolicy,
                canonicalHash: economicPolicyHash(repairedPolicy),
                validatedAt: new Date(),
              } as any;
            }

            let disclosurePackPresent = offering.disclosurePack?.status === "ready";
            if (!disclosurePackPresent) {
              const configuredDocIds = Array.isArray(offering.disclosurePack?.documentIds)
                ? offering.disclosurePack.documentIds
                    .map((id: any) => String(id ?? "").trim())
                    .filter((id: string) => id.length > 0)
                : [];

              if (configuredDocIds.length > 0) {
                offering.disclosurePack = {
                  status: "ready",
                  documentIds: configuredDocIds,
                } as any;
                disclosurePackPresent = true;
              } else {
                const dossier = await DossierModel.findOne({
                  applicationId: offering.applicationId,
                })
                  .select("documents._id")
                  .session(session ?? null);

                const fallbackDocIds = Array.isArray((dossier as any)?.documents)
                  ? (dossier as any).documents
                      .map((doc: any) => String(doc?._id ?? "").trim())
                      .filter((id: string) => id.length > 0)
                  : [];

                if (fallbackDocIds.length > 0) {
                  offering.disclosurePack = {
                    status: "ready",
                    documentIds: fallbackDocIds,
                  } as any;
                  disclosurePackPresent = true;
                }
              }
            }

            // I-12: Enforce independent valuation requirement before opening
            const valuation = (offering as any).valuation;
            if (!valuation?.reportDocumentId) {
              throw new HttpError(
                422,
                "An independent asset valuation report is required before this offering can be opened. Upload a valuation report and provide the document ID.",
              );
            }
            if (valuation?.expiresAt && new Date(valuation.expiresAt) < new Date()) {
              throw new HttpError(
                422,
                "The asset valuation report has expired (must be within 6 months of the offering open date). A fresh independent valuation is required.",
              );
            }

            assertTransition("offering", offering.status as any, "open", {
              applicationApproved: application.status === "approved",
              economicPolicyValid: isEconomicPolicyValid(offering.economicPolicy),
              disclosurePackPresent,
              feesConfigured: isFeeSnapshotConfigured(offering),
            });

            offering.status = "open";
            if (offering.opensAt.getTime() > Date.now()) offering.opensAt = new Date();
            await offering.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingOpened",
              },
              session,
            );

            // I-58/I-59: Notify issuer that their offering is now live
            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingOpened",
                notes: `Your offering "${offering.name}" is now live and accepting subscriptions.`,
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  // I-53: Pause requires operator/admin — issuers cannot self-approve
  app.post(
    "/v1/offerings/:id/pause",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      // I-53: Only operators and admins may pause a live offering
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(
          403,
          "Pausing a live offering requires operator or admin approval. Submit a pause request to your platform operator.",
        );
      }
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          confirm: z.literal("PAUSE"),
          notes: z.string().min(3),
          // I-53: Operator must provide a regulatory reason
          regulatoryReason: z
            .enum(["investor_protection", "compliance_review", "operational", "other"])
            .optional(),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/pause",
        payload: { id: params.id, ...payload },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            assertTransition("offering", offering.status as any, "paused");
            offering.status = "paused";
            await offering.save({ session });

            await CorporateActionModel.create(
              [
                {
                  offeringId: offering._id,
                  type: "pause",
                  status: "executed",
                  payload: {
                    notes: payload.notes,
                    regulatoryReason: payload.regulatoryReason ?? "other",
                    approvedByRole: request.authUser.role,
                  },
                  requestedBy: request.authUser.userId,
                  approvedBy: request.authUser.userId,
                  executedAt: new Date(),
                },
              ],
              { session },
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingPaused",
                notes: payload.notes,
              },
              session,
            );

            // I-53: Notify issuers and investors of the pause
            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingPaused",
                notes: `The offering "${offering.name}" has been temporarily paused. Reason: ${payload.notes}`,
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  // I-53: Unpause also requires operator/admin
  app.post(
    "/v1/offerings/:id/unpause",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Resuming a paused offering requires operator or admin approval.");
      }
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ notes: z.string().min(3).optional() }).parse(request.body ?? {});
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/unpause",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            assertTransition("offering", offering.status as any, "open");
            offering.status = "open";
            await offering.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingResumed",
                notes: payload.notes,
              },
              session,
            );

            // I-53: Notify issuers and investors that offering is live again
            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingResumed",
                notes: `The offering "${offering.name}" has been resumed and is now accepting subscriptions.${payload.notes ? ` Note: ${payload.notes}` : ""}`,
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  // I-69: Issuer requests a close date extension (requires operator approval)
  app.post(
    "/v1/offerings/:id/request-extension",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          requestedClosesAt: z.string().min(10),
          reason: z.string().min(10),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        if (!["open", "paused"].includes(offering.status)) {
          throw new HttpError(422, "Close date extension can only be requested for open or paused offerings");
        }

        const requestedDate = new Date(payload.requestedClosesAt);
        if (isNaN(requestedDate.getTime())) {
          throw new HttpError(422, "Invalid requestedClosesAt date format");
        }
        if (requestedDate <= offering.closesAt) {
          throw new HttpError(422, "Requested close date must be later than the current close date");
        }
        const maxExtensionDays = 180;
        const maxAllowed = new Date(offering.closesAt);
        maxAllowed.setDate(maxAllowed.getDate() + maxExtensionDays);
        if (requestedDate > maxAllowed) {
          throw new HttpError(422, `Extension cannot exceed ${maxExtensionDays} days from current close date`);
        }

        // Create a corporate action record for operator review
        await CorporateActionModel.create(
          [
            {
              offeringId: offering._id,
              type: "extend_close_date",
              status: "pending",
              payload: {
                currentClosesAt: offering.closesAt,
                requestedClosesAt: requestedDate,
                reason: payload.reason,
              },
              requestedBy: request.authUser.userId,
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "CloseDateExtensionRequested",
            notes: `Requested new close date: ${payload.requestedClosesAt}. Reason: ${payload.reason}`,
          },
          session,
        );

        await createNotificationsFromEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "CloseDateExtensionRequested",
            notes: `Issuer requests close date extension for "${offering.name}" to ${payload.requestedClosesAt}. Reason: ${payload.reason}`,
          },
          session,
        );

        return serialize({
          message: "Close date extension request submitted for operator review",
          currentClosesAt: offering.closesAt,
          requestedClosesAt: requestedDate,
        });
      });
    },
  );

  // I-69: Operator approves a close date extension request
  app.post(
    "/v1/offerings/:id/approve-extension",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required to approve extension requests");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          corporateActionId: z.string(),
          approved: z.boolean(),
          notes: z.string().optional(),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        const action = await CorporateActionModel.findOne({
          _id: payload.corporateActionId,
          offeringId: offering._id,
          type: "extend_close_date",
          status: "pending",
        }).session(session);
        if (!action) throw new HttpError(404, "Extension request not found or already processed");

        if (payload.approved) {
          const newClosesAt = new Date((action as any).payload.requestedClosesAt);
          offering.closesAt = newClosesAt;
          await offering.save({ session });

          (action as any).status = "executed";
          (action as any).approvedBy = request.authUser.userId;
          (action as any).executedAt = new Date();
        } else {
          (action as any).status = "rejected";
          (action as any).approvedBy = request.authUser.userId;
        }
        await (action as any).save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: payload.approved ? "CloseDateExtensionApproved" : "CloseDateExtensionRejected",
            notes: payload.notes ?? (payload.approved ? `New close date: ${offering.closesAt.toISOString()}` : "Request rejected"),
          },
          session,
        );

        if (payload.approved) {
          await createNotificationsFromEvent(
            request.authUser,
            {
              entityType: "offering",
              entityId: String(offering._id),
              action: "CloseDateExtensionApproved",
              notes: `The close date for offering "${offering.name}" has been extended to ${offering.closesAt.toISOString().slice(0, 10)}.`,
            },
            session,
          );
        }

        return serialize({
          approved: payload.approved,
          newClosesAt: payload.approved ? offering.closesAt : null,
        });
      });
    },
  );

  app.post(
    "/v1/offerings/:id/close",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          override: z.boolean().optional(),
          overrideNotes: z.string().min(3).optional(),
        })
        .parse(request.body ?? {});
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/close",
        payload: { id: params.id, ...payload },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            const pendingRecon = await hasPendingPaymentReconciliation(String(offering._id), session);
            if (payload.override && !payload.overrideNotes) {
              throw new HttpError(422, "overrideNotes required when override is true");
            }

            assertTransition("offering", offering.status as any, "closed", {
              hasPendingReconciliation: pendingRecon,
              overrideRequested: Boolean(payload.override),
            });

            offering.status = "closed";
            await offering.save({ session });

            await CorporateActionModel.create(
              [
                {
                  offeringId: offering._id,
                  type: "close",
                  status: "executed",
                  payload: {
                    override: Boolean(payload.override),
                    overrideNotes: payload.overrideNotes,
                  },
                  requestedBy: request.authUser.userId,
                  approvedBy: request.authUser.userId,
                  executedAt: new Date(),
                },
              ],
              { session },
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingClosed",
                notes: payload.override ? `OVERRIDE: ${payload.overrideNotes}` : undefined,
              },
              session,
            );

            // I-30: Generate setup fee invoice ledger entry at offering close
            const setupFeeAmount = Number(offering.feeSnapshot?.setupFee?.toString() ?? "0");
            if (setupFeeAmount > 0) {
              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "fee",
                    accountRef: "platform:fees",
                    direction: "credit",
                    amount: toDecimal(setupFeeAmount),
                    currency: "NGN",
                    entityType: "offering",
                    entityId: String(offering._id),
                    idempotencyKey: `fee:setup:${commandId}`,
                    postedAt: new Date(),
                    metadata: {
                      feeType: "setup",
                      businessId: String(offering.businessId),
                      offeringName: offering.name,
                    },
                  },
                ],
                { session },
              );
            }

            return serialize(offering.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/offerings/:id/finalize-allocation",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/finalize-allocation",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");
            if (offering.status !== "closed") throw new HttpError(422, "Offering must be closed first");

            const paidSubscriptions = await SubscriptionModel.find({
              offeringId: offering._id,
              status: "paid",
            }).session(session);

            if (paidSubscriptions.length === 0) {
              throw new HttpError(422, "No paid subscriptions available for allocation");
            }

            const allocationBatchId = buildAllocationBatchId(String(offering._id));

            for (const subscription of paidSubscriptions) {
              assertTransition("subscription", subscription.status as any, "allocation_confirmed");
              subscription.status = "allocation_confirmed";
              subscription.allocationBatchId = allocationBatchId;
              await subscription.save({ session });

              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "ownership",
                    accountRef: `investor:${String(subscription.investorUserId)}`,
                    direction: "credit",
                    amount: subscription.amount,
                    currency: "NGN",
                    entityType: "offering",
                    entityId: String(offering._id),
                    externalRef: allocationBatchId,
                    idempotencyKey: `allocation:${allocationBatchId}:${String(subscription._id)}`,
                    postedAt: new Date(),
                    metadata: {
                      subscriptionId: String(subscription._id),
                      investorUserId: String(subscription.investorUserId),
                    },
                  },
                ],
                { session },
              );
            }

            // Fee collection: setup fee + platform fee on total raise
            const totalRaised = paidSubscriptions.reduce(
              (sum: number, sub: any) => sum + Number(sub.amount.toString()),
              0,
            );
            const setupFee = Number(offering.feeSnapshot?.setupFee?.toString() ?? "0");
            const platformFeePct = Number(offering.feeSnapshot?.platformFeePct?.toString() ?? "0");
            const platformFeeAmount = (totalRaised * platformFeePct) / 100;
            const totalFee = setupFee + platformFeeAmount;

            if (totalFee > 0) {
              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "fee",
                    accountRef: "platform:fees",
                    direction: "credit",
                    amount: toDecimal(totalFee),
                    currency: "NGN",
                    entityType: "offering",
                    entityId: String(offering._id),
                    idempotencyKey: `fee:allocation:${allocationBatchId}`,
                    postedAt: new Date(),
                    metadata: {
                      feeType: "allocation",
                      setupFee,
                      platformFeePct,
                      platformFeeAmount,
                      totalRaised,
                      allocationBatchId,
                    },
                  },
                ],
                { session },
              );
            }

            const anchor = await createAnchorRecord(
              {
                entityType: "offering",
                entityId: String(offering._id),
                eventType: "AllocationFinalized",
                payload: {
                  allocationBatchId,
                  totalRaised: totalRaised.toFixed(2),
                  setupFee: setupFee.toFixed(2),
                  platformFeeAmount: platformFeeAmount.toFixed(2),
                  subscriptions: paidSubscriptions.map((item: any) => ({
                    subscriptionId: String(item._id),
                    investorUserId: String(item.investorUserId),
                    amount: item.amount.toString(),
                  })),
                },
              },
              session,
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "AllocationFinalized",
                notes: `anchor:${anchor.id}`,
              },
              session,
            );

            return {
              offeringId: String(offering._id),
              allocationBatchId,
              anchorId: anchor.id,
              canonicalHash: anchor.canonicalHash,
              allocatedCount: paidSubscriptions.length,
            };
          }),
      });
    },
  );

  app.post(
    "/v1/offerings/:id/enter-servicing",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/enter-servicing",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            const allocationSnapshotAnchored = await hasAnchor("offering", String(offering._id), "AllocationFinalized");
            assertTransition("offering", offering.status as any, "servicing", { allocationSnapshotAnchored });
            offering.status = "servicing";
            await offering.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingServicingEntered",
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/offerings/:id/cancel",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3) }).parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/cancel",
        payload: { id: params.id, reason: payload.reason },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            assertTransition("offering", offering.status as any, "cancelled");
            offering.status = "cancelled";
            offering.cancelledAt = new Date();
            await offering.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingCancelled",
                notes: payload.reason,
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  // P2-05: Check exit readiness
  app.get(
    "/v1/offerings/:id/exit-readiness",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      const unpaidDistributions = await DistributionModel.countDocuments({
        offeringId: offering._id,
        status: { $in: ["draft", "pending_approval", "approved", "scheduled", "failed"] },
      });

      const unsettledSubscriptions = await SubscriptionModel.countDocuments({
        offeringId: offering._id,
        status: { $nin: ["allocation_confirmed", "cancelled", "refunded"] },
      });

      const exitWorkflow = (offering as any).exitWorkflow ?? {};
      const issuerAcknowledged = Boolean(exitWorkflow.issuerAcknowledgedAt);
      const investorsNotified = Boolean(exitWorkflow.investorsNotifiedAt);

      const checks = [
        { key: "all_distributions_settled", label: "All distributions have been paid or cancelled", passed: unpaidDistributions === 0 },
        { key: "all_subscriptions_settled", label: "All subscriptions are settled or cancelled", passed: unsettledSubscriptions === 0 },
        { key: "issuer_acknowledged", label: "Issuer has acknowledged all obligations", passed: issuerAcknowledged },
        { key: "investors_notified", label: "Investors have been notified of exit", passed: investorsNotified },
      ];

      const canExit = checks.every((check) => check.passed) && offering.status === "servicing";

      return {
        offeringId: String(offering._id),
        currentStatus: offering.status,
        canExit,
        checks,
        exitWorkflow: serialize(exitWorkflow),
      };
    },
  );

  // P2-05: Issuer acknowledges exit obligations
  app.post(
    "/v1/offerings/:id/exit/acknowledge",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({ notes: z.string().min(3).optional() })
        .parse(request.body ?? {});

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        if (offering.status !== "servicing") {
          throw new HttpError(422, "Offering must be in servicing status for exit acknowledgment");
        }

        if ((offering as any).exitWorkflow?.issuerAcknowledgedAt) {
          throw new HttpError(422, "Issuer has already acknowledged exit obligations");
        }

        (offering as any).exitWorkflow = {
          ...((offering as any).exitWorkflow ?? {}),
          issuerAcknowledgedAt: new Date(),
          issuerAcknowledgedBy: request.authUser.userId,
          acknowledgeNotes: payload.notes,
        };
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingExitAcknowledged",
            notes: payload.notes,
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  // P2-05: Operator notifies investors of exit
  app.post(
    "/v1/offerings/:id/exit/notify-investors",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({ message: z.string().min(10).optional() })
        .parse(request.body ?? {});

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (offering.status !== "servicing") {
          throw new HttpError(422, "Offering must be in servicing status to notify investors");
        }

        (offering as any).exitWorkflow = {
          ...((offering as any).exitWorkflow ?? {}),
          investorsNotifiedAt: new Date(),
          investorsNotifiedBy: request.authUser.userId,
        };
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingExitInvestorsNotified",
            notes: payload.message ?? "Investors notified of offering exit",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/exit",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/exit",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            // P2-05: Require issuer acknowledgment before exiting
            if (!(offering as any).exitWorkflow?.issuerAcknowledgedAt) {
              throw new HttpError(422, "Issuer must acknowledge exit obligations before the offering can be exited");
            }

            assertTransition("offering", offering.status as any, "exited");
            offering.status = "exited";
            (offering as any).exitWorkflow = {
              ...((offering as any).exitWorkflow ?? {}),
              finalReportGeneratedAt: new Date(),
            };
            await offering.save({ session });

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingExited",
              },
              session,
            );

            return serialize(offering.toObject());
          }),
      });
    },
  );

  // P2-02: Operator requests revision from issuer
  app.post(
    "/v1/offerings/:id/request-revision",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "review", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ reason: z.string().min(3) }).parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertTransition("offering", offering.status as any, "needs_revision");
        offering.status = "needs_revision";
        if (!Array.isArray((offering as any).revisionRequests)) {
          (offering as any).revisionRequests = [];
        }
        (offering as any).revisionRequests.push({
          reason: payload.reason,
          requestedBy: request.authUser.userId,
          requestedAt: new Date(),
        });
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingRevisionRequested",
            notes: payload.reason,
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  // P2-02: Issuer resubmits offering after revision
  app.post(
    "/v1/offerings/:id/resubmit-after-revision",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "submit", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        assertTransition("offering", offering.status as any, "pending_review");
        offering.status = "pending_review";
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingResubmittedAfterRevision",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  // P2-02: Issuer edits an offering in draft or needs_revision status
  app.patch(
    "/v1/offerings/:id",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          name: z.string().min(3).optional(),
          summary: z.string().min(3).optional(),
          opensAt: z.string().optional(),
          closesAt: z.string().optional(),
          terms: z.record(z.string(), z.unknown()).optional(),
          // I-17
          instrumentType: z.enum(["debt_note", "revenue_share", "equity", "hybrid"]).optional(),
          // I-18
          softCap: z.number().positive().optional(),
          // I-19
          oversubscriptionPolicy: z
            .enum(["pro_rata", "first_come_first_served", "waitlist"])
            .optional(),
          maxSingleInvestorPct: z.number().min(1).max(100).optional(),
          // I-22: Per-investor max ticket
          maxTicket: z.number().positive().optional(),
          // I-21: Private mode
          isPrivate: z.boolean().optional(),
          // I-47
          conflictsOfInterest: z.string().optional(),
          // I-48: Track record
          issuerTrackRecord: z
            .object({
              completedProjects: z.number().int().min(0).optional(),
              totalCapitalRaised: z.number().nonnegative().optional(),
              yearsExperience: z.number().int().min(0).optional(),
              priorDefaultCount: z.number().int().min(0).optional(),
              teamBackground: z.string().max(2000).optional(),
              notableProjects: z.string().max(2000).optional(),
            })
            .optional(),
          // I-49
          riskFactors: z
            .array(
              z.object({
                category: z.enum([
                  "market",
                  "liquidity",
                  "regulatory",
                  "project",
                  "counterparty",
                  "other",
                ]),
                description: z.string().min(5),
              }),
            )
            .optional(),
          disclosurePack: z
            .object({ documentIds: z.array(z.string()).optional() })
            .optional(),
          // I-12: Independent valuation update
          valuation: z
            .object({
              amount: z.number().positive().optional(),
              date: z.string().optional(),
              reportDocumentId: z.string().optional(),
              valuedBy: z.string().optional(),
            })
            .optional(),
          // I-14: Credit enhancement update
          creditEnhancement: z
            .object({
              type: z
                .enum(["personal_guarantee", "bank_guarantee", "insurance_backed", "collateral", "sinking_fund", "none"])
                .optional(),
              description: z.string().max(2000).optional(),
              guarantorName: z.string().max(200).optional(),
            })
            .optional(),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (!["draft", "needs_revision"].includes(offering.status)) {
          throw new HttpError(422, "Offering can only be edited when in draft or needs_revision status");
        }

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        if (payload.name !== undefined) offering.name = payload.name;
        if (payload.summary !== undefined) offering.summary = payload.summary;
        if (payload.opensAt !== undefined) offering.opensAt = new Date(payload.opensAt);
        if (payload.closesAt !== undefined) offering.closesAt = new Date(payload.closesAt);
        if (payload.terms !== undefined) offering.terms = payload.terms as any;
        if (payload.instrumentType !== undefined) (offering as any).instrumentType = payload.instrumentType;
        if (payload.softCap !== undefined) (offering as any).metrics = { ...(offering as any).metrics, softCap: toDecimal(payload.softCap) };
        if (payload.oversubscriptionPolicy !== undefined) (offering as any).metrics = { ...(offering as any).metrics, oversubscriptionPolicy: payload.oversubscriptionPolicy };
        if (payload.maxSingleInvestorPct !== undefined) (offering as any).metrics = { ...(offering as any).metrics, maxSingleInvestorPct: payload.maxSingleInvestorPct };
        if (payload.maxTicket !== undefined) (offering as any).metrics = { ...(offering as any).metrics, maxTicket: toDecimal(payload.maxTicket) };
        if (payload.isPrivate !== undefined) (offering as any).isPrivate = payload.isPrivate;
        if (payload.conflictsOfInterest !== undefined) {
          (offering as any).conflictsOfInterest = payload.conflictsOfInterest;
          (offering as any).conflictsDisclosedAt = new Date();
        }
        if (payload.riskFactors !== undefined) (offering as any).riskFactors = payload.riskFactors;
        if (payload.issuerTrackRecord !== undefined) {
          (offering as any).issuerTrackRecord = {
            ...(payload.issuerTrackRecord as object),
            totalCapitalRaised: (payload.issuerTrackRecord as any).totalCapitalRaised !== undefined
              ? toDecimal((payload.issuerTrackRecord as any).totalCapitalRaised)
              : undefined,
            disclosedAt: new Date(),
          };
        }
        if (payload.disclosurePack?.documentIds !== undefined) {
          offering.disclosurePack = {
            status: payload.disclosurePack.documentIds.length > 0 ? "ready" : "missing",
            documentIds: payload.disclosurePack.documentIds,
          } as any;
        }
        // I-14: Update credit enhancement fields
        if (payload.creditEnhancement !== undefined) {
          (offering as any).creditEnhancement = {
            ...(offering as any).creditEnhancement,
            ...payload.creditEnhancement,
            disclosedAt: new Date(),
          };
        }
        // I-12: Update valuation fields
        if (payload.valuation !== undefined) {
          const v = payload.valuation;
          (offering as any).valuation = {
            amount: v.amount !== undefined ? toDecimal(v.amount) : (offering as any).valuation?.amount,
            date: v.date ? new Date(v.date) : (offering as any).valuation?.date,
            expiresAt: v.date
              ? new Date(new Date(v.date).getTime() + 6 * 30 * 24 * 60 * 60 * 1000)
              : (offering as any).valuation?.expiresAt,
            reportDocumentId: v.reportDocumentId ?? (offering as any).valuation?.reportDocumentId,
            valuedBy: v.valuedBy ?? (offering as any).valuation?.valuedBy,
          };
        }

        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingUpdated",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/disburse-to-issuer",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          amount: z.number().positive(),
          externalRef: z.string().min(3),
          notes: z.string().optional(),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/disburse-to-issuer",
        payload: { id: params.id, amount: payload.amount, externalRef: payload.externalRef },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            if (offering.status !== "servicing") {
              throw new HttpError(422, "Offering must be in servicing status to disburse funds");
            }

            const business = await BusinessModel.findById(offering.businessId).session(session);
            if (!business) throw new HttpError(404, "Issuer business not found");

            const payoutAccount = (business as any).payoutBankAccount;
            if (!payoutAccount?.accountNumber) {
              throw new HttpError(422, "Issuer has not registered a payout bank account");
            }

            const disburseIdempotencyKey = commandId ?? `disburse:${String(offering._id)}:${payload.externalRef}:${Date.now()}`;

            // Debit escrow (money leaving the offering escrow)
            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "tranche",
                  accountRef: `escrow:offering:${String(offering._id)}`,
                  direction: "debit",
                  amount: toDecimal(payload.amount),
                  currency: payoutAccount.currency ?? "NGN",
                  entityType: "offering",
                  entityId: String(offering._id),
                  externalRef: payload.externalRef,
                  idempotencyKey: `${disburseIdempotencyKey}:debit`,
                  postedAt: new Date(),
                  metadata: {
                    disbursementType: "issuer_payout",
                    notes: payload.notes,
                  },
                },
              ],
              { session },
            );

            // Credit issuer (money arriving at issuer business account)
            await LedgerEntryModel.create(
              [
                {
                  ledgerType: "tranche",
                  accountRef: `issuer:business:${String(offering.businessId)}`,
                  direction: "credit",
                  amount: toDecimal(payload.amount),
                  currency: payoutAccount.currency ?? "NGN",
                  entityType: "offering",
                  entityId: String(offering._id),
                  externalRef: payload.externalRef,
                  idempotencyKey: `${disburseIdempotencyKey}:credit`,
                  postedAt: new Date(),
                  metadata: {
                    disbursementType: "issuer_payout",
                    bankName: payoutAccount.bankName,
                    accountNumber: payoutAccount.accountNumber,
                    accountName: payoutAccount.accountName,
                    notes: payload.notes,
                  },
                },
              ],
              { session },
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "IssuerDisbursed",
                notes: `ref:${payload.externalRef} amount:${payload.amount}`,
              },
              session,
            );

            return {
              offeringId: String(offering._id),
              businessId: String(offering.businessId),
              amount: payload.amount,
              externalRef: payload.externalRef,
              payoutAccount: {
                bankName: payoutAccount.bankName,
                accountNumber: payoutAccount.accountNumber,
                accountName: payoutAccount.accountName,
                currency: payoutAccount.currency ?? "NGN",
              },
            };
          }),
      });
    },
  );

  // I-27: Escrow balance visibility for issuers
  app.get(
    "/v1/offerings/:id/escrow-balance",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      const [credits, debits, pendingDistributions] = await Promise.all([
        LedgerEntryModel.find({
          ledgerType: { $in: ["escrow", "subscription"] },
          accountRef: `escrow:offering:${String(offering._id)}`,
          direction: "credit",
        }).lean(),
        LedgerEntryModel.find({
          ledgerType: { $in: ["escrow", "subscription", "distribution", "tranche"] },
          accountRef: `escrow:offering:${String(offering._id)}`,
          direction: "debit",
        }).lean(),
        DistributionModel.find({
          offeringId: offering._id,
          status: { $in: ["pending_approval", "approved", "scheduled"] },
        }).lean(),
      ]);

      const totalCredits = credits.reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );
      const totalDebits = debits.reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );
      const escrowBalance = totalCredits - totalDebits;

      const pendingDistributionAmount = pendingDistributions.reduce(
        (sum: number, d: any) => sum + Number(d.amount?.toString() ?? "0"),
        0,
      );
      const availableForDistribution = escrowBalance - pendingDistributionAmount;

      return serialize({
        offeringId: String(offering._id),
        currency: "NGN",
        escrowBalance: escrowBalance.toFixed(2),
        totalCredits: totalCredits.toFixed(2),
        totalDebits: totalDebits.toFixed(2),
        pendingDistributionAmount: pendingDistributionAmount.toFixed(2),
        availableForDistribution: availableForDistribution.toFixed(2),
      });
    },
  );

  app.get(
    "/v1/offerings/:id/disbursements",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      const entries = await LedgerEntryModel.find({
        ledgerType: "tranche",
        accountRef: `issuer:business:${String(offering.businessId)}`,
        entityType: "offering",
        entityId: String(offering._id),
        direction: "credit",
      })
        .sort({ postedAt: -1 })
        .lean();

      return serialize(entries);
    },
  );

  const MAX_OFFERING_IMAGES = 8;
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

  app.post(
    "/v1/offerings/:id/images",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({
        filename: z.string().min(1),
        contentBase64: z.string().min(1),
        mimeType: z.string().refine((v) => ALLOWED_IMAGE_TYPES.has(v.toLowerCase()), {
          message: "Only JPEG, PNG, WebP, and GIF images are allowed",
        }),
      }).parse(request.body);

      const offering = await OfferingModel.findById(params.id);
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      const currentImages = Array.isArray(offering.images) ? offering.images : [];
      if (currentImages.length >= MAX_OFFERING_IMAGES) {
        throw new HttpError(422, `Maximum ${MAX_OFFERING_IMAGES} images allowed per offering`);
      }

      const uploaded = await persistOfferingImage({
        offeringId: String(offering._id),
        filename: payload.filename,
        contentBase64: payload.contentBase64,
        mimeType: payload.mimeType,
      });

      const newImage = {
        storageKey: uploaded.storageKey,
        filename: payload.filename,
        mimeType: payload.mimeType.toLowerCase(),
        bytes: uploaded.bytes,
        order: currentImages.length,
        uploadedAt: new Date(),
      };

      offering.images.push(newImage);
      await offering.save();

      const saved = offering.images[offering.images.length - 1];
      return serialize({
        id: String(saved._id),
        filename: saved.filename,
        mimeType: saved.mimeType,
        bytes: saved.bytes,
        order: saved.order,
        uploadedAt: saved.uploadedAt,
      });
    },
  );

  app.delete(
    "/v1/offerings/:id/images/:imageId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string(), imageId: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id);
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      const idx = offering.images.findIndex(
        (img: any) => String(img._id) === params.imageId,
      );
      if (idx === -1) throw new HttpError(404, "Image not found");

      offering.images.splice(idx, 1);
      offering.images.forEach((img: any, i: number) => { img.order = i; });
      await offering.save();

      return { ok: true };
    },
  );

  app.get(
    "/v1/offerings/:id/images/:imageId/download",
    async (request: FastifyRequest, reply) => {
      const params = z.object({ id: z.string(), imageId: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      const images = Array.isArray(offering.images) ? offering.images : [];
      const img = images.find((item: any) => String(item._id) === params.imageId);
      if (!img) throw new HttpError(404, "Image not found");

      const { buffer, redirectUrl } = await retrieveFile((img as any).storageKey);

      if (redirectUrl) {
        return reply.redirect(redirectUrl, 302);
      }

      reply.header("Content-Type", (img as any).mimeType ?? "application/octet-stream");
      reply.header("Cache-Control", "public, max-age=86400");
      reply.header("Content-Length", buffer.length);
      return reply.send(buffer);
    },
  );

  // I-23: Extend close date — operator/admin only (governance gate)
  app.post(
    "/v1/offerings/:id/extend-close-date",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(
          403,
          "Extending a close date requires operator or admin approval. Contact your platform operator.",
        );
      }
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          newClosesAt: z.string().min(1),
          reason: z.string().min(5),
          // I-23: Limit extensions to prevent abuse
          notifyInvestors: z.boolean().default(true),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/extend-close-date",
        payload: { id: params.id, newClosesAt: payload.newClosesAt },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            if (!["open", "paused"].includes(offering.status)) {
              throw new HttpError(422, "Close date can only be extended for open or paused offerings");
            }

            const newDate = new Date(payload.newClosesAt);
            if (Number.isNaN(newDate.getTime())) {
              throw new HttpError(422, "newClosesAt must be a valid date");
            }
            if (newDate <= offering.closesAt) {
              throw new HttpError(422, "New close date must be later than the current close date");
            }

            const oldClosesAt = offering.closesAt;
            offering.closesAt = newDate;
            await offering.save({ session });

            await CorporateActionModel.create(
              [
                {
                  offeringId: offering._id,
                  type: "extend_close_date",
                  status: "executed",
                  payload: {
                    oldClosesAt,
                    newClosesAt: newDate,
                    reason: payload.reason,
                    approvedByRole: request.authUser.role,
                  },
                  requestedBy: request.authUser.userId,
                  approvedBy: request.authUser.userId,
                  executedAt: new Date(),
                },
              ],
              { session },
            );

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingCloseDateExtended",
                notes: `from:${oldClosesAt.toISOString()} to:${newDate.toISOString()} reason:${payload.reason}`,
              },
              session,
            );

            if (payload.notifyInvestors) {
              await createNotificationsFromEvent(
                request.authUser,
                {
                  entityType: "offering",
                  entityId: String(offering._id),
                  action: "OfferingCloseDateExtended",
                  notes: `The closing date for "${offering.name}" has been extended to ${newDate.toLocaleDateString()}. Reason: ${payload.reason}`,
                },
                session,
              );
            }

            return serialize(offering.toObject());
          }),
      });
    },
  );

  // I-35: Distribution health — check if Template A distributions are overdue
  app.get(
    "/v1/offerings/:id/distribution-health",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      if (offering.templateCode !== "A") {
        return { applicable: false, reason: "Distribution health only applies to Template A offerings" };
      }

      const lastPaid = await DistributionModel.findOne({
        offeringId: offering._id,
        status: "paid",
      })
        .sort({ paidAt: -1 })
        .lean();

      const pendingDistributions = await DistributionModel.find({
        offeringId: offering._id,
        status: { $in: ["draft", "pending_approval", "approved", "scheduled"] },
      }).lean();

      // Determine expected distribution frequency from economic policy
      const policy = (offering as any).economicPolicy?.config ?? {};
      const frequencyMonths: number = (() => {
        const freq = policy.distributionFrequency ?? policy.distribution_frequency ?? "monthly";
        if (freq === "quarterly") return 3;
        if (freq === "semi_annual" || freq === "semi-annual") return 6;
        if (freq === "annual") return 12;
        return 1; // monthly default
      })();

      const now = new Date();
      let overdueMonths = 0;
      let lastDistributionDate: Date | null = null;
      let nextExpectedDate: Date | null = null;
      let isInArrears = false;

      if (lastPaid?.paidAt) {
        lastDistributionDate = new Date(lastPaid.paidAt as any);
        nextExpectedDate = new Date(lastDistributionDate);
        nextExpectedDate.setMonth(nextExpectedDate.getMonth() + frequencyMonths);

        if (now > nextExpectedDate && offering.status === "servicing") {
          const msOverdue = now.getTime() - nextExpectedDate.getTime();
          overdueMonths = Math.floor(msOverdue / (30 * 24 * 60 * 60 * 1000));
          isInArrears = true;
        }
      } else if (offering.status === "servicing") {
        // No distribution ever paid — check if one is overdue from offering open date
        const openDate = new Date(offering.opensAt);
        const expectedFirst = new Date(openDate);
        expectedFirst.setMonth(expectedFirst.getMonth() + frequencyMonths);
        if (now > expectedFirst) {
          const msOverdue = now.getTime() - expectedFirst.getTime();
          overdueMonths = Math.floor(msOverdue / (30 * 24 * 60 * 60 * 1000));
          nextExpectedDate = expectedFirst;
          isInArrears = true;
        }
      }

      return serialize({
        offeringId: String(offering._id),
        templateCode: offering.templateCode,
        status: offering.status,
        applicable: true,
        isInArrears,
        overdueMonths,
        lastDistributionDate: lastDistributionDate?.toISOString() ?? null,
        nextExpectedDate: nextExpectedDate?.toISOString() ?? null,
        pendingDistributions: pendingDistributions.length,
        pendingDistributionIds: pendingDistributions.map((d: any) => String(d._id)),
        frequencyMonths,
      });
    },
  );

  // I-55: Servicing health — issuer default / missed distribution escalation
  app.post(
    "/v1/offerings/:id/flag-distribution-arrears",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({ notes: z.string().min(5).optional() })
        .parse(request.body ?? {});

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (offering.status !== "servicing") {
          throw new HttpError(422, "Offering must be in servicing status to flag arrears");
        }

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "DistributionArrearsFlag",
            notes: payload.notes ?? "Offering flagged as in distribution arrears by operator",
          },
          session,
        );

        await createNotificationsFromEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "DistributionArrearsFlag",
            notes: `ALERT: The issuer for offering "${offering.name}" has missed scheduled distributions. ${payload.notes ?? ""}`.trim(),
          },
          session,
        );

        return { ok: true, offeringId: String(offering._id) };
      });
    },
  );

  // I-54: Soft cap auto-cancel — trigger if offering closed below soft cap
  app.post(
    "/v1/offerings/:id/check-soft-cap",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/check-soft-cap",
        payload: { id: params.id },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            if (offering.status !== "closed") {
              throw new HttpError(422, "Soft cap check only applies to closed offerings");
            }

            const softCap = Number((offering as any).metrics?.softCap?.toString() ?? "0");
            if (softCap <= 0) {
              return { softCapConfigured: false, message: "No soft cap configured for this offering" };
            }

            const subscribedAmount = Number((offering as any).metrics?.subscribedAmount?.toString() ?? "0");
            if (subscribedAmount >= softCap) {
              return {
                softCapConfigured: true,
                softCapReached: true,
                softCap,
                subscribedAmount,
                message: "Soft cap reached — offering can proceed to allocation",
              };
            }

            // Soft cap NOT reached — auto-cancel and refund all paid subscriptions
            assertTransition("offering", offering.status as any, "cancelled");
            offering.status = "cancelled";
            offering.cancelledAt = new Date();
            await offering.save({ session });

            const paidSubs = await SubscriptionModel.find({
              offeringId: offering._id,
              status: { $in: ["paid", "committed", "payment_pending"] },
            }).session(session);

            let refundedCount = 0;
            for (const sub of paidSubs) {
              if (["paid", "committed", "payment_pending"].includes(sub.status as string)) {
                sub.status = "refunded";
                await sub.save({ session });
                refundedCount++;
              }
            }

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingAutoCancelledSoftCap",
                notes: `softCap:${softCap} subscribed:${subscribedAmount} refunded:${refundedCount}`,
              },
              session,
            );

            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "OfferingAutoCancelledSoftCap",
                notes: `Offering "${offering.name}" was cancelled because it did not reach its minimum raise target of ${softCap.toLocaleString()}. All subscriptions have been refunded.`,
              },
              session,
            );

            return {
              softCapConfigured: true,
              softCapReached: false,
              softCap,
              subscribedAmount,
              autoCancelled: true,
              refundedSubscriptions: refundedCount,
              message: `Offering auto-cancelled: raised ${subscribedAmount} but soft cap is ${softCap}. ${refundedCount} subscriptions refunded.`,
            };
          }),
      });
    },
  );

  // I-42: Issuer metrics — total AUM, total raised, distributed, pending payments
  app.get(
    "/v1/issuer/metrics",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "issuer") {
        throw new HttpError(403, "Issuer role required");
      }

      const businessId = request.authUser.businessId;
      if (!businessId) throw new HttpError(422, "Issuer has no associated business");

      const [offerings, distributions, subscriptions] = await Promise.all([
        OfferingModel.find({ businessId }).lean(),
        DistributionModel.find({
          offeringId: { $in: [] }, // placeholder; filled below
        }).lean(),
        SubscriptionModel.find({
          offeringId: { $in: [] },
          status: "payment_pending",
        }).lean(),
      ]);

      const offeringIds = offerings.map((o: any) => o._id);

      const [allDistributions, pendingPayments] = await Promise.all([
        DistributionModel.find({ offeringId: { $in: offeringIds } }).lean(),
        SubscriptionModel.find({
          offeringId: { $in: offeringIds },
          status: "payment_pending",
        }).lean(),
      ]);

      const totalAum = offerings
        .filter((o: any) => ["open", "closed", "servicing"].includes(o.status))
        .reduce((sum: number, o: any) => sum + Number(o.metrics?.subscribedAmount?.toString() ?? "0"), 0);

      const totalRaised = offerings
        .filter((o: any) => ["closed", "servicing", "exited"].includes(o.status))
        .reduce((sum: number, o: any) => sum + Number(o.metrics?.subscribedAmount?.toString() ?? "0"), 0);

      const totalDistributed = allDistributions
        .filter((d: any) => d.status === "paid")
        .reduce((sum: number, d: any) => sum + Number(d.amount?.toString() ?? "0"), 0);

      const pendingPaymentCount = pendingPayments.length;
      const pendingPaymentAmount = pendingPayments.reduce(
        (sum: number, s: any) => sum + Number(s.amount?.toString() ?? "0"),
        0,
      );

      // Nearest upcoming close date
      const openOfferings = offerings.filter((o: any) => o.status === "open");
      const nextClose = openOfferings.reduce(
        (nearest: Date | null, o: any) => {
          const d = new Date(o.closesAt);
          if (!nearest || d < nearest) return d;
          return nearest;
        },
        null as Date | null,
      );

      const daysUntilNextClose = nextClose
        ? Math.max(0, Math.ceil((nextClose.getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
        : null;

      const activeOfferingsCount = offerings.filter((o: any) =>
        ["open", "paused"].includes(o.status),
      ).length;

      return serialize({
        businessId,
        currency: "NGN",
        totalAum: totalAum.toFixed(2),
        totalRaised: totalRaised.toFixed(2),
        totalDistributed: totalDistributed.toFixed(2),
        pendingPaymentCount,
        pendingPaymentAmount: pendingPaymentAmount.toFixed(2),
        activeOfferingsCount,
        nextCloseDate: nextClose?.toISOString() ?? null,
        daysUntilNextClose,
        offeringCount: offerings.length,
      });
    },
  );

  // I-43: Cap table CSV export — full investor registry for an offering
  app.get(
    "/v1/offerings/:id/cap-table.csv",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Forbidden");
      }

      const subscriptions = await SubscriptionModel.find({
        offeringId: offering._id,
        status: { $nin: ["cancelled", "refunded"] },
      })
        .sort({ createdAt: 1 })
        .lean();

      const investorIds = subscriptions.map((s: any) => s.investorUserId);
      const users = await UserModel.find({ _id: { $in: investorIds } })
        .select("_id name email")
        .lean();
      const userMap = new Map(users.map((u: any) => [String(u._id), u]));

      const totalSubscribed = subscriptions.reduce(
        (sum: number, s: any) => sum + Number(s.amount?.toString() ?? "0"),
        0,
      );

      function csvSafeValue(value: string | number): string {
        const raw = String(value ?? "");
        if (raw.includes(",") || raw.includes('"') || raw.includes("\n")) {
          return `"${raw.replace(/"/g, '""')}"`;
        }
        return raw;
      }

      const headerRow = [
        "investorUserId",
        "investorName",
        "investorEmail",
        "subscriptionId",
        "amount",
        "sharePercent",
        "status",
        "subscribedAt",
        "allocationConfirmedAt",
      ];

      const dataRows = subscriptions.map((sub: any) => {
        const user = userMap.get(String(sub.investorUserId));
        const amount = Number(sub.amount?.toString() ?? "0");
        const sharePercent = totalSubscribed > 0 ? ((amount / totalSubscribed) * 100).toFixed(4) : "0";
        return [
          String(sub.investorUserId),
          (user as any)?.name ?? "",
          (user as any)?.email ?? "",
          String(sub._id),
          amount.toFixed(2),
          sharePercent,
          sub.status,
          sub.createdAt ? new Date(sub.createdAt).toISOString() : "",
          sub.allocationConfirmedAt ? new Date(sub.allocationConfirmedAt).toISOString() : "",
        ];
      });

      const allRows = [headerRow, ...dataRows];
      const csv = `${allRows.map((row) => row.map(csvSafeValue).join(",")).join("\n")}\n`;
      const fileName = `cap_table_${String(offering._id)}_${new Date().toISOString().slice(0, 10)}.csv`;

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csv);
    },
  );

  // I-46: Fee ledger — issuers can see fee entries for their offering
  app.get(
    "/v1/offerings/:id/fee-ledger",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Forbidden");
      }

      const feeEntries = await LedgerEntryModel.find({
        ledgerType: "fee",
        entityType: "offering",
        entityId: String(offering._id),
      })
        .sort({ postedAt: -1 })
        .lean();

      // Also fetch distribution-level fee entries
      const distributions = await DistributionModel.find({ offeringId: offering._id }).lean();
      const distributionIds = distributions.map((d: any) => String(d._id));

      const distributionFeeEntries = await LedgerEntryModel.find({
        ledgerType: "fee",
        entityType: "distribution",
        entityId: { $in: distributionIds },
      })
        .sort({ postedAt: -1 })
        .lean();

      const allFeeEntries = [...feeEntries, ...distributionFeeEntries].sort(
        (a: any, b: any) => new Date(b.postedAt).getTime() - new Date(a.postedAt).getTime(),
      );

      const totalFees = allFeeEntries.reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );

      const feeSnapshot = {
        setupFee: offering.feeSnapshot?.setupFee?.toString() ?? "0",
        platformFeePct: offering.feeSnapshot?.platformFeePct?.toString() ?? "0",
        servicingFeePct: offering.feeSnapshot?.servicingFeePct?.toString() ?? "0",
      };

      return serialize({
        offeringId: String(offering._id),
        currency: "NGN",
        feeSnapshot,
        totalFeesCharged: totalFees.toFixed(2),
        entries: allFeeEntries,
      });
    },
  );

  // I-39: Offering updates / investor announcements feed
  app.post(
    "/v1/offerings/:id/updates",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["issuer", "operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Issuer, operator or admin role required");
      }
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          title: z.string().min(3).max(200),
          body: z.string().min(5).max(5000),
          category: z
            .enum(["operational", "financial", "regulatory", "milestone", "general"])
            .default("general"),
          isPinned: z.boolean().default(false),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        const [update] = await OfferingUpdateModel.create(
          [
            {
              offeringId: offering._id,
              businessId: offering.businessId,
              title: payload.title,
              body: payload.body,
              category: payload.category,
              isPinned: payload.isPinned,
              createdBy: request.authUser.userId,
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingUpdatePosted",
            notes: payload.title,
          },
          session,
        );

        // Notify all investors in this offering
        await createNotificationsFromEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "OfferingUpdatePosted",
            notes: `${offering.name}: ${payload.title} — ${payload.body.slice(0, 200)}`,
          },
          session,
        );

        return serialize(update.toObject());
      });
    },
  );

  app.get(
    "/v1/offerings/:id/updates",
    async (request: FastifyRequest) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(50).default(20),
        })
        .parse(request.query);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      const skip = (query.page - 1) * query.limit;
      const [updates, total] = await Promise.all([
        OfferingUpdateModel.find({ offeringId: offering._id })
          .sort({ isPinned: -1, createdAt: -1 })
          .skip(skip)
          .limit(query.limit)
          .lean(),
        OfferingUpdateModel.countDocuments({ offeringId: offering._id }),
      ]);

      return serialize({ data: updates, total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) });
    },
  );

  // I-40: Offering Q&A
  app.post(
    "/v1/offerings/:id/qa",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({ question: z.string().min(10).max(2000) })
        .parse(request.body);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      const [qa] = await OfferingQAModel.create([
        {
          offeringId: offering._id,
          askedBy: request.authUser.userId,
          question: payload.question,
        },
      ]);

      // Notify issuers that a question has been asked
      await createNotificationsFromEvent(
        request.authUser,
        {
          entityType: "offering",
          entityId: String(offering._id),
          action: "OfferingQuestionAsked",
          notes: `New question on "${offering.name}": ${payload.question.slice(0, 150)}`,
        },
      );

      return serialize(qa.toObject());
    },
  );

  app.post(
    "/v1/offerings/:id/qa/:qaId/answer",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (!["issuer", "operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Issuer, operator or admin role required to answer");
      }
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string(), qaId: z.string() }).parse(request.params);
      const payload = z.object({ answer: z.string().min(5).max(5000) }).parse(request.body);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      }

      const qa = await OfferingQAModel.findOne({ _id: params.qaId, offeringId: offering._id });
      if (!qa) throw new HttpError(404, "Q&A entry not found");
      if (qa.answer) throw new HttpError(422, "This question has already been answered");

      qa.answer = payload.answer;
      qa.answeredBy = request.authUser.userId;
      qa.answeredAt = new Date();
      await qa.save();

      return serialize(qa.toObject());
    },
  );

  app.get(
    "/v1/offerings/:id/qa",
    async (request: FastifyRequest) => {
      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(50).default(20),
          answered: z.enum(["true", "false"]).optional(),
        })
        .parse(request.query);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      const filter: Record<string, unknown> = {
        offeringId: offering._id,
        isHidden: false,
        isPublic: true,
      };
      if (query.answered === "true") filter.answeredAt = { $exists: true };
      if (query.answered === "false") filter.answeredAt = { $exists: false };

      const skip = (query.page - 1) * query.limit;
      const [qaItems, total] = await Promise.all([
        OfferingQAModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(query.limit)
          .lean(),
        OfferingQAModel.countDocuments(filter),
      ]);

      return serialize({ data: qaItems, total, page: query.page, limit: query.limit, pages: Math.ceil(total / query.limit) });
    },
  );

  // I-65: Offering disclosure document upload for issuers
  app.post(
    "/v1/offerings/:id/disclosure-documents",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          filename: z.string().min(1),
          contentBase64: z.string().min(1),
          mimeType: z.string().min(3),
          documentType: z
            .enum([
              "offering_memorandum",
              "financial_projections",
              "valuation_report",
              "legal_opinion",
              "insurance_policy",
              "title_document",
              "other",
            ])
            .default("other"),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (!["draft", "needs_revision"].includes(offering.status)) {
          throw new HttpError(
            422,
            "Disclosure documents can only be uploaded when the offering is in draft or needs_revision status",
          );
        }

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        // Persist via dossier storage pattern
        const { persistOfferingImage } = await import("../../../services/storage.js");
        const contentBuffer = Buffer.from(payload.contentBase64, "base64");
        const storageKey = `offerings/${String(offering._id)}/disclosure/${Date.now()}_${payload.filename.replace(/[^a-z0-9._-]/gi, "_")}`;

        // Upload via the storage service
        const { persistDossierBinary } = await import("../../../services/storage.js");
        await persistDossierBinary({
          applicationId: String(offering.applicationId),
          filename: payload.filename,
          mimeType: payload.mimeType,
          contentBase64: payload.contentBase64,
        });

        // Generate a document ID for the disclosure pack reference
        const docId = new mongoose.Types.ObjectId().toString();
        const currentDocIds = Array.isArray(offering.disclosurePack?.documentIds)
          ? [...offering.disclosurePack.documentIds]
          : [];
        currentDocIds.push(docId);

        offering.disclosurePack = {
          status: "ready",
          documentIds: currentDocIds,
        } as any;
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "DisclosureDocumentUploaded",
            notes: `${payload.documentType}:${payload.filename}`,
          },
          session,
        );

        return serialize({
          documentId: docId,
          filename: payload.filename,
          documentType: payload.documentType,
          disclosurePack: offering.disclosurePack,
        });
      });
    },
  );

  // I-38: Investor roster — issuers can view their investor list (read-only, no PII beyond name/status)
  app.get(
    "/v1/offerings/:id/investors",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");

      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({
          page: z.coerce.number().int().positive().default(1),
          limit: z.coerce.number().int().positive().max(200).default(50),
          status: z
            .enum(["draft", "committed", "payment_pending", "paid", "allocation_confirmed", "refunded", "cancelled"])
            .optional(),
        })
        .parse(request.query);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Forbidden");
      }

      const filter: Record<string, unknown> = { offeringId: offering._id };
      if (query.status) filter.status = query.status;

      const skip = (query.page - 1) * query.limit;
      const [subscriptions, total] = await Promise.all([
        SubscriptionModel.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(query.limit)
          .lean(),
        SubscriptionModel.countDocuments(filter),
      ]);

      const investorIds = subscriptions.map((s: any) => s.investorUserId);
      const users = await UserModel.find({ _id: { $in: investorIds } })
        .select("_id name email")
        .lean();
      const userMap = new Map(users.map((u: any) => [String(u._id), u]));

      const roster = subscriptions.map((sub: any) => {
        const user = userMap.get(String(sub.investorUserId));
        return {
          subscriptionId: String(sub._id),
          investorUserId: String(sub.investorUserId),
          // Issuers can see name but not email (privacy)
          investorName: (user as any)?.name ?? "—",
          // Only operators/admins can see email
          investorEmail:
            ["operator", "admin"].includes(request.authUser.role)
              ? (user as any)?.email ?? null
              : undefined,
          amount: sub.amount?.toString() ?? "0",
          currency: "NGN",
          status: sub.status,
          subscribedAt: sub.createdAt,
          allocationConfirmedAt: sub.allocationConfirmedAt ?? null,
        };
      });

      return serialize({
        data: roster,
        total,
        page: query.page,
        limit: query.limit,
        pages: Math.ceil(total / query.limit),
      });
    },
  );

  // I-28: Issuer-initiated fund disbursement request (Template A)
  app.post(
    "/v1/offerings/:id/request-disbursement",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          amount: z.number().positive().optional(),
          notes: z.string().max(1000).optional(),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        if (offering.status !== "servicing") {
          throw new HttpError(422, "Disbursement requests can only be made when offering is in servicing status");
        }

        if (offering.templateCode !== "A") {
          throw new HttpError(422, "Disbursement requests apply to Template A offerings only. Template B uses milestone-based releases.");
        }

        // Check there is no pending disbursement request already
        const pendingRequest = await CorporateActionModel.findOne({
          offeringId: offering._id,
          type: "disbursement_request",
          status: "pending",
        })
          .select("_id createdAt")
          .session(session);

        if (pendingRequest) {
          throw new HttpError(409, "A disbursement request is already pending operator review. Please wait for a decision before submitting another.");
        }

        const action = await CorporateActionModel.create(
          [
            {
              offeringId: offering._id,
              businessId: offering.businessId,
              type: "disbursement_request",
              status: "pending",
              initiatedBy: request.authUser.userId,
              requestedAmount: payload.amount,
              notes: payload.notes ?? "",
              requestedAt: new Date(),
            },
          ],
          { session },
        );

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "DisbursementRequested",
            notes: payload.amount ? `Requested: ${payload.amount}${payload.notes ? ` — ${payload.notes}` : ""}` : (payload.notes ?? ""),
          },
          session,
        );

        await createNotificationsFromEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "DisbursementRequested",
            notes: `offeringName:${offering.name}${payload.amount ? ` amount:${payload.amount}` : ""}`,
          },
          session,
        );

        return serialize({ corporateActionId: String((action[0] as any)._id), status: "pending" });
      });
    },
  );

  // I-25: Issuer-initiated offering cancellation request
  app.post(
    "/v1/offerings/:id/request-cancellation",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          reason: z.string().min(10).max(2000),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        const cancellableStatuses = ["draft", "pending_review", "needs_revision", "open", "paused"];
        if (!cancellableStatuses.includes(offering.status)) {
          throw new HttpError(422, `Offering cannot be cancelled from status '${offering.status}'. Only draft, pending_review, needs_revision, open, and paused offerings can be cancelled.`);
        }

        // Draft offerings can be self-cancelled by the issuer immediately
        if (["draft", "needs_revision"].includes(offering.status)) {
          offering.status = "cancelled" as any;
          offering.cancellationReason = payload.reason as any;
          offering.cancelledAt = new Date() as any;
          await offering.save({ session });

          await appendEvent(
            request.authUser,
            {
              entityType: "offering",
              entityId: String(offering._id),
              action: "OfferingCancelled",
              notes: payload.reason,
            },
            session,
          );

          return serialize({ cancelled: true, requiresOperatorApproval: false });
        }

        // For open/paused offerings, create a cancellation request for operator review
        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "CancellationRequested",
            notes: payload.reason,
          },
          session,
        );

        await createNotificationsFromEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "CancellationRequested",
            notes: `offeringName:${offering.name} reason:${payload.reason.slice(0, 200)}`,
          },
          session,
        );

        return serialize({
          cancelled: false,
          requiresOperatorApproval: true,
          message: "Cancellation request submitted. An operator will review and process the cancellation, including any necessary investor refunds.",
        });
      });
    },
  );

  // I-21: Manage investor whitelist for private offerings
  app.post(
    "/v1/offerings/:id/whitelist",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          action: z.enum(["add", "remove"]),
          // Either userId or email can be used to identify the investor
          userId: z.string().optional(),
          email: z.string().email().optional(),
        })
        .refine((d) => d.userId || d.email, { message: "Provide either userId or email" })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        if (!(offering as any).isPrivate) {
          throw new HttpError(422, "Offering is not in private mode. Set isPrivate=true first to manage the whitelist.");
        }

        let targetUserId: string | undefined = payload.userId;
        if (!targetUserId && payload.email) {
          const user = await UserModel.findOne({ email: payload.email }).select("_id").session(session);
          if (!user) throw new HttpError(404, `No user found with email: ${payload.email}`);
          targetUserId = String(user._id);
        }

        const currentList: string[] = ((offering as any).investorWhitelistUserIds ?? []).map((id: any) => String(id));

        if (payload.action === "add") {
          if (!currentList.includes(targetUserId!)) {
            currentList.push(targetUserId!);
          }
        } else {
          const idx = currentList.indexOf(targetUserId!);
          if (idx >= 0) currentList.splice(idx, 1);
        }

        (offering as any).investorWhitelistUserIds = currentList;
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: payload.action === "add" ? "WhitelistInvestorAdded" : "WhitelistInvestorRemoved",
            notes: `userId:${targetUserId}`,
          },
          session,
        );

        return serialize({ whitelistCount: currentList.length, action: payload.action, userId: targetUserId });
      });
    },
  );

  // I-31: Issuer confirms receipt of disbursed capital from escrow to their bank account
  app.post(
    "/v1/offerings/:id/confirm-receipt",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          amountReceived: z.number().positive(),
          receivedAt: z.string().optional(),
          notes: z.string().max(1000).optional(),
          hasDiscrepancy: z.boolean().optional(),
          discrepancyDetails: z.string().max(2000).optional(),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        if (!["servicing", "exited"].includes(offering.status)) {
          throw new HttpError(422, "Receipts can only be confirmed for offerings in servicing or exited status");
        }

        const noteParts = [
          `amountReceived:${payload.amountReceived}`,
          payload.hasDiscrepancy ? `discrepancy:${(payload.discrepancyDetails ?? "").slice(0, 200)}` : null,
          payload.notes ? payload.notes.slice(0, 200) : null,
        ].filter(Boolean) as string[];

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: payload.hasDiscrepancy ? "ReceiptConfirmedWithDiscrepancy" : "ReceiptConfirmed",
            notes: noteParts.join(" | "),
          },
          session,
        );

        if (payload.hasDiscrepancy) {
          await createNotificationsFromEvent(
            request.authUser,
            {
              entityType: "offering",
              entityId: String(offering._id),
              action: "ReceiptDiscrepancyReported",
              notes: `offeringName:${offering.name} discrepancy:${(payload.discrepancyDetails ?? "").slice(0, 100)}`,
            },
            session,
          );
        }

        return serialize({
          confirmed: true,
          hasDiscrepancy: payload.hasDiscrepancy ?? false,
          amountReceived: payload.amountReceived,
          receivedAt: payload.receivedAt ?? new Date().toISOString(),
        });
      });
    },
  );

  // I-32: Investor concentration risk report
  app.get(
    "/v1/offerings/:id/concentration-report",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String((offering as any).businessId));
      }

      const subscriptions = await SubscriptionModel.find({
        offeringId: (offering as any)._id,
        status: { $in: ["committed", "payment_pending", "paid", "allocation_confirmed"] },
      })
        .select("investorUserId amount status")
        .lean();

      if (subscriptions.length === 0) {
        return serialize({ topInvestors: [], concentrationRisk: "low", herfindahlIndex: 0, totalCommitted: 0 });
      }

      const raiseAmount = Number((offering as any).terms?.raiseAmount?.toString() ?? "0");
      const totalCommitted = subscriptions.reduce((sum: number, s: any) => sum + Number((s as any).amount?.toString() ?? "0"), 0);

      // Aggregate by investor
      const byInvestor = new Map<string, number>();
      for (const sub of subscriptions) {
        const uid = String((sub as any).investorUserId);
        byInvestor.set(uid, (byInvestor.get(uid) ?? 0) + Number((sub as any).amount?.toString() ?? "0"));
      }

      // Sort by amount descending
      const sorted = [...byInvestor.entries()].sort((a, b) => b[1] - a[1]);

      const base = raiseAmount > 0 ? raiseAmount : totalCommitted;
      const topInvestors = sorted.slice(0, 10).map(([investorUserId, amount], idx) => ({
        rank: idx + 1,
        investorUserId,
        amount,
        pctOfRaise: base > 0 ? Number(((amount / base) * 100).toFixed(2)) : 0,
      }));

      // Herfindahl-Hirschman Index (sum of squared market shares)
      const hhi = sorted.reduce((sum, [, amount]) => {
        const share = base > 0 ? amount / base : 0;
        return sum + share * share;
      }, 0);

      const concentrationRisk = hhi > 0.25 ? "high" : hhi > 0.1 ? "medium" : "low";

      // Top 1/3/5 concentration
      const top1Pct = topInvestors[0]?.pctOfRaise ?? 0;
      const top3Pct = topInvestors.slice(0, 3).reduce((s, i) => s + i.pctOfRaise, 0);
      const top5Pct = topInvestors.slice(0, 5).reduce((s, i) => s + i.pctOfRaise, 0);

      return serialize({
        topInvestors,
        concentrationRisk,
        herfindahlIndex: Number(hhi.toFixed(4)),
        top1Pct,
        top3Pct,
        top5Pct,
        totalCommitted,
        investorCount: byInvestor.size,
        raiseAmount,
      });
    },
  );

  // I-56: Compute per-investor redemption amounts before executing
  app.get(
    "/v1/offerings/:id/compute-redemption",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required to view redemption computations");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z.object({ totalPayoutAmount: z.coerce.number().positive() }).parse(request.query);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (offering.status !== "servicing") {
        throw new HttpError(422, "Offering must be in servicing status to compute redemption");
      }

      const allocatedSubs = await SubscriptionModel.find({
        offeringId: offering._id,
        status: "allocation_confirmed",
      })
        .select("investorUserId amount")
        .lean();

      if (allocatedSubs.length === 0) {
        throw new HttpError(422, "No allocation-confirmed subscriptions found for this offering");
      }

      const totalAllocated = allocatedSubs.reduce(
        (sum: number, s: any) => sum + Number(s.amount?.toString() ?? "0"),
        0,
      );

      if (totalAllocated === 0) {
        throw new HttpError(422, "Total allocated amount is zero — cannot compute pro-rata redemption");
      }

      // Compute per-investor pro-rata share of the total payout
      const investorRedemptions = allocatedSubs.map((sub: any) => {
        const investedAmount = Number(sub.amount?.toString() ?? "0");
        const proRataShare = investedAmount / totalAllocated;
        const redemptionAmount = query.totalPayoutAmount * proRataShare;
        const capitalGain = redemptionAmount - investedAmount;

        return {
          subscriptionId: String(sub._id),
          investorUserId: String(sub.investorUserId),
          investedAmount: Number(investedAmount.toFixed(2)),
          proRataSharePct: Number((proRataShare * 100).toFixed(4)),
          redemptionAmount: Number(redemptionAmount.toFixed(2)),
          capitalGain: Number(capitalGain.toFixed(2)),
          capitalGainPct: investedAmount > 0 ? Number(((capitalGain / investedAmount) * 100).toFixed(2)) : 0,
        };
      });

      return serialize({
        offeringId: String(offering._id),
        offeringName: offering.name,
        totalAllocated: Number(totalAllocated.toFixed(2)),
        totalPayoutAmount: query.totalPayoutAmount,
        totalCapitalGain: Number((query.totalPayoutAmount - totalAllocated).toFixed(2)),
        investorCount: allocatedSubs.length,
        investorRedemptions,
      });
    },
  );

  // I-56: Execute full redemption — operator closes the offering and pays out investors
  app.post(
    "/v1/offerings/:id/execute-redemption",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Operator or admin role required");
      }
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          totalPayoutAmount: z.number().positive(),
          externalRef: z.string().min(3),
          saleDocumentId: z.string().optional(),
          notes: z.string().optional(),
        })
        .parse(request.body);
      const commandId = readCommandId(request.headers);

      return runIdempotentCommand({
        commandId,
        userId: request.authUser.userId,
        route: "POST:/v1/offerings/:id/execute-redemption",
        payload: { id: params.id, externalRef: payload.externalRef },
        execute: () =>
          runInTransaction(async (session) => {
            const offering = await OfferingModel.findById(params.id).session(session);
            if (!offering) throw new HttpError(404, "Offering not found");

            if (offering.status !== "servicing") {
              throw new HttpError(422, "Offering must be in servicing status to execute redemption");
            }

            const allocatedSubs = await SubscriptionModel.find({
              offeringId: offering._id,
              status: "allocation_confirmed",
            }).session(session);

            if (allocatedSubs.length === 0) {
              throw new HttpError(422, "No allocation-confirmed subscriptions to redeem");
            }

            const totalAllocated = allocatedSubs.reduce(
              (sum: number, s: any) => sum + Number(s.amount?.toString() ?? "0"),
              0,
            );

            if (totalAllocated === 0) {
              throw new HttpError(422, "Total allocated amount is zero");
            }

            const redemptionBatchId = `redemption_${String(offering._id)}_${Date.now()}`;

            for (const sub of allocatedSubs) {
              const investedAmount = Number((sub as any).amount?.toString() ?? "0");
              const proRataShare = investedAmount / totalAllocated;
              const redemptionAmount = payload.totalPayoutAmount * proRataShare;

              // Mark subscription as redeemed
              (sub as any).status = "redeemed";
              await (sub as any).save({ session });

              // Create redemption ledger entry for this investor
              await LedgerEntryModel.create(
                [
                  {
                    ledgerType: "ownership",
                    accountRef: `investor:${String((sub as any).investorUserId)}`,
                    direction: "debit",
                    amount: toDecimal(investedAmount),
                    currency: "NGN",
                    entityType: "offering",
                    entityId: String(offering._id),
                    externalRef: payload.externalRef,
                    idempotencyKey: `redemption:${redemptionBatchId}:${String((sub as any)._id)}`,
                    postedAt: new Date(),
                    metadata: {
                      redemptionType: "full_exit",
                      subscriptionId: String((sub as any)._id),
                      investedAmount,
                      redemptionAmount: Number(redemptionAmount.toFixed(2)),
                      capitalGain: Number((redemptionAmount - investedAmount).toFixed(2)),
                      redemptionBatchId,
                      saleDocumentId: payload.saleDocumentId,
                    },
                  },
                ],
                { session },
              );
            }

            await appendEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "RedemptionExecuted",
                notes: `batch:${redemptionBatchId} payout:${payload.totalPayoutAmount} investors:${allocatedSubs.length} ref:${payload.externalRef}`,
              },
              session,
            );

            await createNotificationsFromEvent(
              request.authUser,
              {
                entityType: "offering",
                entityId: String(offering._id),
                action: "RedemptionExecuted",
                notes: `The offering "${offering.name}" has been fully redeemed. Your pro-rata redemption payment will be processed to your registered bank account.`,
              },
              session,
            );

            return serialize({
              offeringId: String(offering._id),
              redemptionBatchId,
              totalPayoutAmount: payload.totalPayoutAmount,
              investorCount: allocatedSubs.length,
              externalRef: payload.externalRef,
            });
          }),
      });
    },
  );

  // I-36: Actual vs projected cash flow report (Template A)
  app.post(
    "/v1/offerings/:id/actual-vs-projected",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "offering");

      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          period: z.string().regex(/^\d{4}-\d{2}$/, "Period must be YYYY-MM format"),
          actualRentalIncome: z.number().nonnegative(),
          projectedRentalIncome: z.number().nonnegative(),
          actualExpenses: z.number().nonnegative().optional(),
          projectedExpenses: z.number().nonnegative().optional(),
          vacancyDays: z.number().int().min(0).max(31).optional(),
          notes: z.string().max(2000).optional(),
        })
        .parse(request.body);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        if (request.authUser.role === "issuer") {
          assertIssuerBusinessScope(request.authUser, String(offering.businessId));
        }

        if (offering.templateCode !== "A") {
          throw new HttpError(422, "Actual vs projected reporting applies to Template A offerings only");
        }

        const variance = payload.actualRentalIncome - payload.projectedRentalIncome;
        const variancePct = payload.projectedRentalIncome > 0
          ? Number(((variance / payload.projectedRentalIncome) * 100).toFixed(2))
          : 0;

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "ActualVsProjectedReported",
            notes: `period:${payload.period} actual:${payload.actualRentalIncome} projected:${payload.projectedRentalIncome} variance:${variancePct}%`,
          },
          session,
        );

        return serialize({
          period: payload.period,
          actualRentalIncome: payload.actualRentalIncome,
          projectedRentalIncome: payload.projectedRentalIncome,
          variance,
          variancePct,
          actualExpenses: payload.actualExpenses,
          projectedExpenses: payload.projectedExpenses,
          vacancyDays: payload.vacancyDays,
          notes: payload.notes,
        });
      });
    },
  );

  // I-44: Offering performance report — aggregated financials for an offering
  app.get(
    "/v1/offerings/:id/performance-report",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");

      if (request.authUser.role === "issuer") {
        assertIssuerBusinessScope(request.authUser, String(offering.businessId));
      } else if (!["operator", "admin"].includes(request.authUser.role)) {
        throw new HttpError(403, "Forbidden");
      }

      const [subscriptions, distributions, feeEntries, distributionLines] = await Promise.all([
        SubscriptionModel.find({
          offeringId: offering._id,
          status: { $nin: ["cancelled", "refunded"] },
        }).lean(),
        DistributionModel.find({ offeringId: offering._id }).sort({ periodStart: 1 }).lean(),
        LedgerEntryModel.find({
          ledgerType: "fee",
          entityType: "offering",
          entityId: String(offering._id),
        }).lean(),
        // Distribution-level fee entries for servicing fee totals
        DistributionModel.find({ offeringId: offering._id, status: "paid" })
          .select("_id period amount paidAt")
          .lean()
          .then(async (paidDists: any[]) => {
            if (paidDists.length === 0) return [];
            const paidDistIds = paidDists.map((d: any) => String(d._id));
            return LedgerEntryModel.find({
              ledgerType: "fee",
              entityType: "distribution",
              entityId: { $in: paidDistIds },
            }).lean();
          }),
      ]);

      const raiseAmount = Number((offering as any).terms?.raiseAmount?.toString() ?? (offering as any).metrics?.raiseAmount?.toString() ?? "0");
      const totalSubscribed = subscriptions.reduce(
        (sum: number, s: any) => sum + Number(s.amount?.toString() ?? "0"),
        0,
      );
      const paidSubscriptions = subscriptions.filter((s: any) => ["paid", "allocation_confirmed"].includes(s.status));
      const totalRaised = paidSubscriptions.reduce(
        (sum: number, s: any) => sum + Number(s.amount?.toString() ?? "0"),
        0,
      );

      const paidDistributions = distributions.filter((d: any) => d.status === "paid");
      const totalDistributed = paidDistributions.reduce(
        (sum: number, d: any) => sum + Number(d.amount?.toString() ?? "0"),
        0,
      );

      const totalFeesPaid = [...feeEntries, ...distributionLines].reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );

      // Projected yield from terms
      const targetYieldPct = Number((offering as any).terms?.targetYieldPct ?? 0);
      const projectedYield = totalRaised > 0 && targetYieldPct > 0
        ? (totalRaised * targetYieldPct) / 100
        : null;

      // Actual yield to date
      const actualYieldToDate = totalDistributed;
      const actualYieldPct = totalRaised > 0 && totalDistributed > 0
        ? Number(((totalDistributed / totalRaised) * 100).toFixed(2))
        : 0;

      const distributionHistory = distributions.map((d: any) => ({
        distributionId: String(d._id),
        period: d.period ?? d.periodStart,
        amount: Number(d.amount?.toString() ?? "0"),
        status: d.status,
        paidAt: d.paidAt ?? null,
        currency: "NGN",
      }));

      const valuation = (offering as any).valuation
        ? {
            amount: Number((offering as any).valuation.amount?.toString() ?? "0"),
            date: (offering as any).valuation.date ?? null,
            valuedBy: (offering as any).valuation.valuedBy ?? null,
          }
        : null;

      return serialize({
        offeringId: String(offering._id),
        offeringName: offering.name,
        templateCode: offering.templateCode,
        status: offering.status,
        currency: "NGN",
        opensAt: offering.opensAt,
        closesAt: offering.closesAt,
        // Raise summary
        raiseAmount: raiseAmount.toFixed(2),
        totalSubscribed: totalSubscribed.toFixed(2),
        totalRaised: totalRaised.toFixed(2),
        subscriptionFillPct: raiseAmount > 0 ? Number(((totalSubscribed / raiseAmount) * 100).toFixed(2)) : 0,
        investorCount: paidSubscriptions.length,
        // Distribution summary
        distributionCount: distributions.length,
        paidDistributionCount: paidDistributions.length,
        totalDistributed: totalDistributed.toFixed(2),
        distributionHistory,
        // Yield analysis
        targetYieldPct,
        projectedAnnualYield: projectedYield !== null ? projectedYield.toFixed(2) : null,
        actualYieldToDate: actualYieldToDate.toFixed(2),
        actualYieldPct,
        // Fees
        totalFeesPaid: totalFeesPaid.toFixed(2),
        feeSnapshot: {
          setupFee: offering.feeSnapshot?.setupFee?.toString() ?? "0",
          platformFeePct: offering.feeSnapshot?.platformFeePct?.toString() ?? "0",
          servicingFeePct: offering.feeSnapshot?.servicingFeePct?.toString() ?? "0",
        },
        // Asset valuation
        currentValuation: valuation,
        // Report metadata
        generatedAt: new Date().toISOString(),
      });
    },
  );

  // I-60: Broadcast message from issuer to all investors in an offering
  app.post(
    "/v1/offerings/:id/broadcast",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
      authorize(request.authUser, "update", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          subject: z.string().min(5).max(200),
          message: z.string().min(10).max(5000),
        })
        .parse(request.body);

      const offering = await OfferingModel.findById(params.id).lean();
      if (!offering) throw new HttpError(404, "Offering not found");
      assertIssuerBusinessScope(request.authUser, String(offering.businessId));

      if (!["open", "paused", "closed", "servicing"].includes(offering.status)) {
        throw new HttpError(422, "Broadcasts can only be sent for active or recently closed offerings");
      }

      // createNotificationsFromEvent resolves all subscribed investors and issuer business users
      await createNotificationsFromEvent(request.authUser, {
        entityType: "offering",
        entityId: params.id,
        action: "IssuerBroadcast",
        notes: `${payload.subject}: ${payload.message}`,
      });

      await appendEvent(request.authUser, {
        entityType: "offering",
        entityId: params.id,
        action: "IssuerBroadcast",
        notes: `Subject: ${payload.subject}`,
      });

      return { ok: true, recipientsQueued: true };
    },
  );
}
