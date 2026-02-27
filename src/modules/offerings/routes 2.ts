import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ApplicationModel,
  CorporateActionModel,
  MilestoneModel,
  OfferingModel,
  PlatformConfigModel,
  TrancheModel,
  InvestorProfileModel,
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

const createOfferingSchema = z.object({
  applicationId: z.string(),
  name: z.string().min(3),
  summary: z.string().min(3),
  opensAt: z.string(),
  closesAt: z.string(),
  terms: z.record(z.string(), z.unknown()),
});

const listOfferingsQuerySchema = z.object({
  status: z
    .enum(["draft", "pending_review", "open", "paused", "closed", "servicing", "exited"])
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

async function assertCanViewOfferings(configRequireKyc: boolean, user: AuthUser | null) {
  if (!configRequireKyc) return;
  if (!user) throw new HttpError(403, "KYC required before viewing offerings");
  if (user.role !== "investor") return;

  const profile = await InvestorProfileModel.findOne({ userId: user.userId }).lean();
  if (!profile || profile.kycStatus !== "approved") {
    throw new HttpError(403, "KYC approved profile required before viewing offerings");
  }
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
          const milestones = Array.isArray(payload.terms.milestones)
            ? payload.terms.milestones
            : [];

          const parsedMilestones = milestones
            .map((item) => {
              if (!item || typeof item !== "object") return null;
              const row = item as Record<string, unknown>;
              const name = typeof row.name === "string" ? row.name : null;
              const percent = typeof row.percent === "number" ? row.percent : typeof row.amountPct === "number" ? row.amountPct : null;
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
            action: "Offering created",
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

    if (authUser?.role === "issuer") {
      assertIssuerBusinessScope(authUser, String(offering.businessId));
    }

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

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertIssuerBusinessScope(request.authUser, String(offering.businessId));

        const application = await ApplicationModel.findById(offering.applicationId).session(session);
        if (!application) throw new HttpError(404, "Application not found");

        assertTransition("offering", offering.status as any, "pending_review", {
          applicationApproved: application.status === "approved",
        });

        offering.status = "pending_review";
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "Offering submitted for review",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/approve-open",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "approve", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertTransition("offering", offering.status as any, "open");
        offering.status = "open";
        if (offering.opensAt.getTime() > Date.now()) offering.opensAt = new Date();
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "Offering approved and opened",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/pause",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
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
              payload: {},
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
            action: "Offering paused",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/unpause",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertTransition("offering", offering.status as any, "open");
        offering.status = "open";
        await offering.save({ session });

        await CorporateActionModel.create(
          [
            {
              offeringId: offering._id,
              type: "unpause",
              status: "executed",
              payload: {},
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
            action: "Offering unpaused",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/close",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertTransition("offering", offering.status as any, "closed");
        offering.status = "closed";
        await offering.save({ session });

        await CorporateActionModel.create(
          [
            {
              offeringId: offering._id,
              type: "close",
              status: "executed",
              payload: {},
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
            action: "Offering closed",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );

  app.post(
    "/v1/offerings/:id/enter-servicing",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "execute", "offering");
      const params = z.object({ id: z.string() }).parse(request.params);

      return runInTransaction(async (session) => {
        const offering = await OfferingModel.findById(params.id).session(session);
        if (!offering) throw new HttpError(404, "Offering not found");

        assertTransition("offering", offering.status as any, "servicing");
        offering.status = "servicing";
        await offering.save({ session });

        await appendEvent(
          request.authUser,
          {
            entityType: "offering",
            entityId: String(offering._id),
            action: "Offering entered servicing",
          },
          session,
        );

        return serialize(offering.toObject());
      });
    },
  );
}
