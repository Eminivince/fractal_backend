import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import mongoose from "mongoose";
import {
  ApplicationModel,
  CorporateActionModel,
  InvestorProfileModel,
  LedgerEntryModel,
  MilestoneModel,
  OfferingModel,
  PlatformConfigModel,
  SubscriptionModel,
  TrancheModel,
} from "../../db/models.js";
import { toDecimal } from "../../utils/decimal.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { assertTransition } from "../../utils/state-machine.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";
import { runInTransaction } from "../../utils/tx.js";
import { serialize } from "../../utils/serialize.js";
import type { AuthUser } from "../../types.js";
import { economicPolicyHash, isEconomicPolicyValid, normalizeEconomicPolicy } from "../../utils/economic-policy.js";
import { createAnchorRecord, hasAnchor } from "../../utils/anchor.js";
import { readCommandId, runIdempotentCommand } from "../../utils/idempotency.js";

const createOfferingSchema = z.object({
  applicationId: z.string(),
  name: z.string().min(3),
  summary: z.string().min(3),
  opensAt: z.string(),
  closesAt: z.string(),
  terms: z.record(z.string(), z.unknown()),
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
});

const listOfferingsQuerySchema = z.object({
  status: z
    .enum(["draft", "pending_review", "open", "paused", "closed", "servicing", "exited", "cancelled"])
    .optional(),
  templateCode: z.enum(["A", "B"]).optional(),
  businessId: z.string().optional(),
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

      return runInTransaction(async (session) => {
        const application = await ApplicationModel.findById(payload.applicationId).session(session);
        if (!application) throw new HttpError(404, "Application not found");

        assertIssuerBusinessScope(request.authUser, String(application.businessId));
        if (application.status !== "approved") {
          throw new HttpError(422, "Offering can only be created from an approved application");
        }

        const platformConfig = await PlatformConfigModel.findById("platform_config").session(session);
        if (!platformConfig) throw new HttpError(404, "Platform config not found");

        if (application.templateCode === "B" && !platformConfig.featureFlags.enableTemplateB) {
          throw new HttpError(422, "Template B is disabled by feature flag");
        }

        const raiseAmount = extractRaiseAmount(payload.terms);
        const economicPolicy = normalizeEconomicPolicy(payload.economicPolicy, application.templateCode);
        const disclosureDocs = payload.disclosurePack?.documentIds ?? [];

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
                subscribedAmount: toDecimal(0),
                investorCount: 0,
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
      });
    },
  );

  app.get("/v1/offerings", async (request: FastifyRequest) => {
    const query = listOfferingsQuerySchema.parse(request.query);
    const config = await PlatformConfigModel.findById("platform_config").lean();
    if (!config) throw new HttpError(404, "Platform config not found");

    const authUser = await getOptionalAuthUser(app, request);
    await assertCanViewOfferings(config.complianceRules.requireKycToView, authUser);

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

    const rows = await OfferingModel.find(filter).sort({ createdAt: -1 }).lean();
    return serialize(rows);
  });

  app.get("/v1/offerings/:id", async (request: FastifyRequest) => {
    const params = z.object({ id: z.string() }).parse(request.params);
    const offering = await OfferingModel.findById(params.id).lean();
    if (!offering) throw new HttpError(404, "Offering not found");

    const config = await PlatformConfigModel.findById("platform_config").lean();
    if (!config) throw new HttpError(404, "Platform config not found");

    const authUser = await getOptionalAuthUser(app, request);
    await assertCanViewOfferings(config.complianceRules.requireKycToView, authUser);

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

            assertTransition("offering", offering.status as any, "open", {
              applicationApproved: application.status === "approved",
              economicPolicyValid: isEconomicPolicyValid(offering.economicPolicy),
              disclosurePackPresent: offering.disclosurePack?.status === "ready",
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

            return serialize(offering.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/offerings/:id/pause",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z.object({ confirm: z.literal("PAUSE"), notes: z.string().min(3) }).parse(request.body);
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
                  payload: { notes: payload.notes },
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

            return serialize(offering.toObject());
          }),
      });
    },
  );

  app.post(
    "/v1/offerings/:id/unpause",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);
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
              },
              session,
            );

            return serialize(offering.toObject());
          }),
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

            const anchor = await createAnchorRecord(
              {
                entityType: "offering",
                entityId: String(offering._id),
                eventType: "AllocationFinalized",
                payload: {
                  allocationBatchId,
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

            assertTransition("offering", offering.status as any, "exited");
            offering.status = "exited";
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
}
