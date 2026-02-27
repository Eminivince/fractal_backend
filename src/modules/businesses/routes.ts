import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BusinessModel, DistributionModel, LedgerEntryModel, OfferingModel, UserModel } from "../../db/models.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";
import { persistBusinessBinary, retrieveFile } from "../../services/storage.js";
import { assertIssuerBusinessScope } from "../../utils/scope.js";

const businessDocumentUploadSchema = z.object({
  type: z.string().min(2),
  filename: z.string().min(2),
  storageKey: z.string().optional(),
  contentBase64: z.string().min(8).optional(),
  mimeType: z.string().optional(),
  // I-05: Optional document expiry date (e.g., proof of address valid for 3 months)
  validUntil: z.string().optional(),
});

function sanitizeFilenameSegment(name: string): string {
  return name.replace(/[^a-z0-9.\-_]+/gi, "-").toLowerCase();
}

export async function businessRoutes(app: FastifyInstance) {
  app.get(
    "/v1/businesses",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");

      if (request.authUser.role === "issuer") {
        const rows = await BusinessModel.find({ _id: request.authUser.businessId }).lean();
        return serialize(rows);
      }

      const rows = await BusinessModel.find().lean();
      return serialize(rows);
    },
  );

  app.get(
    "/v1/businesses/me",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      if (request.authUser.role !== "issuer") throw new HttpError(403, "Issuer role required");
      const business = await BusinessModel.findById(request.authUser.businessId).lean();
      if (!business) throw new HttpError(404, "Business not found");
      return serialize(business);
    },
  );

  app.get(
    "/v1/businesses/:id/documents",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = z.object({ id: z.string() }).parse(request.params);

      const business = await BusinessModel.findById(params.id).lean();
      if (!business) throw new HttpError(404, "Business not found");
      assertIssuerBusinessScope(request.authUser, String(business._id));

      return serialize(business.documents ?? []);
    },
  );

  app.post(
    "/v1/businesses/:id/documents",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = businessDocumentUploadSchema.parse(request.body);

      const business = await BusinessModel.findById(params.id);
      if (!business) throw new HttpError(404, "Business not found");
      assertIssuerBusinessScope(request.authUser, String(business._id));

      let storageKey =
        payload.storageKey ??
        `manual://businesses/${business._id.toString()}/${Date.now()}-${sanitizeFilenameSegment(payload.filename)}`;

      if (payload.contentBase64) {
        const persisted = await persistBusinessBinary({
          businessId: String(business._id),
          filename: payload.filename,
          contentBase64: payload.contentBase64,
          mimeType: payload.mimeType,
        });
        storageKey = persisted.storageKey;
      }

      business.documents.push({
        type: payload.type,
        filename: payload.filename,
        mimeType: payload.mimeType,
        storageKey,
        uploadedBy: request.authUser.userId as any,
        uploadedAt: new Date(),
        // I-05: Document expiry tracking
        validUntil: payload.validUntil ? new Date(payload.validUntil) : undefined,
      } as any);

      if (business.kybStatus === "draft" || business.kybStatus === "rejected") {
        business.kybStatus = "submitted";
      }

      await business.save();

      await appendEvent(request.authUser, {
        entityType: "business",
        entityId: String(business._id),
        action: "Business KYB document uploaded",
        notes: `${payload.type}: ${payload.filename}`,
      });

      const createdDocument = business.documents[business.documents.length - 1];
      return serialize(createdDocument?.toObject ? createdDocument.toObject() : createdDocument);
    },
  );

  app.patch(
    "/v1/businesses/:id",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "business");
      const params = z.object({ id: z.string() }).parse(request.params);
      const payload = z
        .object({
          name: z.string().min(2).optional(),
          riskTier: z.enum(["low", "medium", "high"]).optional(),
          status: z.enum(["active", "disabled"]).optional(),
        })
        .refine(
          (input) =>
            input.name !== undefined ||
            input.riskTier !== undefined ||
            input.status !== undefined,
          {
            message: "At least one field must be provided",
          },
        )
        .parse(request.body);

      const existing = await BusinessModel.findById(params.id).lean();
      if (!existing) throw new HttpError(404, "Business not found");
      assertIssuerBusinessScope(request.authUser, String(existing._id));

      const updated = await BusinessModel.findByIdAndUpdate(
        params.id,
        payload,
        { new: true },
      ).lean();

      if (!updated) throw new HttpError(404, "Business not found");

      await appendEvent(request.authUser, {
        entityType: "business",
        entityId: String(updated._id),
        action: "Business profile updated",
      });

      return serialize(updated);
    },
  );

  // I-64: Retrieve a specific business KYB document by its _id
  app.get(
    "/v1/businesses/:id/documents/:docId",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest, reply) => {
      authorize(request.authUser, "read", "business");
      const params = z.object({ id: z.string(), docId: z.string() }).parse(request.params);

      const business = await BusinessModel.findById(params.id).lean();
      if (!business) throw new HttpError(404, "Business not found");
      assertIssuerBusinessScope(request.authUser, String(business._id));

      const doc = (business.documents as any[]).find((d) => String(d._id) === params.docId);
      if (!doc) throw new HttpError(404, "Document not found");

      const { buffer, redirectUrl } = await retrieveFile(doc.storageKey);

      if (redirectUrl) {
        return reply.redirect(redirectUrl, 302);
      }

      const mimeType = doc.mimeType ?? "application/octet-stream";
      reply.header("Content-Type", mimeType);
      reply.header("Content-Disposition", `attachment; filename="${doc.filename}"`);
      reply.header("Content-Length", buffer.length);
      return reply.send(buffer);
    },
  );

  app.get(
    "/v1/businesses/:id/users",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = z.object({ id: z.string() }).parse(request.params);
      const business = await BusinessModel.findById(params.id).lean();
      if (!business) throw new HttpError(404, "Business not found");
      assertIssuerBusinessScope(request.authUser, String(business._id));

      const users = await UserModel.find({ businessId: params.id }).lean();
      return serialize(users);
    },
  );

  // I-45: Tax year-end statement for issuers
  app.get(
    "/v1/businesses/:id/tax-statement",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "business");
      const params = z.object({ id: z.string() }).parse(request.params);
      const query = z
        .object({ year: z.coerce.number().int().min(2020).max(2100).default(new Date().getFullYear()) })
        .parse(request.query);

      const business = await BusinessModel.findById(params.id).lean();
      if (!business) throw new HttpError(404, "Business not found");
      assertIssuerBusinessScope(request.authUser, String(business._id));

      const yearStart = new Date(`${query.year}-01-01T00:00:00.000Z`);
      const yearEnd = new Date(`${query.year + 1}-01-01T00:00:00.000Z`);

      // Fetch all offerings for this business
      const offerings = await OfferingModel.find({ businessId: params.id }).lean();
      const offeringIds = offerings.map((o: any) => o._id);

      if (offeringIds.length === 0) {
        return serialize({
          businessId: params.id,
          businessName: (business as any).name,
          taxYear: query.year,
          currency: "NGN",
          totalCapitalRaised: "0.00",
          totalDistributionsPaid: "0.00",
          totalWhtDeducted: "0.00",
          totalPlatformFeesPaid: "0.00",
          totalServicingFeesPaid: "0.00",
          totalSetupFeesPaid: "0.00",
          offeringCount: 0,
          generatedAt: new Date().toISOString(),
        });
      }

      const [paidDistributions, platformFeeEntries, distributionFeeEntries] = await Promise.all([
        // Paid distributions in this tax year
        DistributionModel.find({
          offeringId: { $in: offeringIds },
          status: "paid",
          paidAt: { $gte: yearStart, $lt: yearEnd },
        }).lean(),
        // Platform/setup fee ledger entries for offerings this year
        LedgerEntryModel.find({
          ledgerType: "fee",
          entityType: "offering",
          entityId: { $in: offeringIds.map(String) },
          postedAt: { $gte: yearStart, $lt: yearEnd },
        }).lean(),
        // Servicing fee ledger entries for distributions this year
        DistributionModel.find({
          offeringId: { $in: offeringIds },
          status: "paid",
          paidAt: { $gte: yearStart, $lt: yearEnd },
        })
          .select("_id")
          .lean()
          .then(async (dists: any[]) => {
            if (dists.length === 0) return [];
            const distIds = dists.map((d: any) => String(d._id));
            return LedgerEntryModel.find({
              ledgerType: "fee",
              entityType: "distribution",
              entityId: { $in: distIds },
              postedAt: { $gte: yearStart, $lt: yearEnd },
            }).lean();
          }),
      ]);

      // Capital raised in this tax year (subscriptions paid → allocation confirmed in year)
      const capitalRaisedOfferings = await OfferingModel.find({
        businessId: params.id,
        status: { $in: ["closed", "servicing", "exited"] },
        closesAt: { $gte: yearStart, $lt: yearEnd },
      }).lean();
      const totalCapitalRaised = capitalRaisedOfferings.reduce(
        (sum: number, o: any) => sum + Number(o.metrics?.subscribedAmount?.toString() ?? "0"),
        0,
      );

      // Total distributions paid in year
      const totalDistributionsPaid = paidDistributions.reduce(
        (sum: number, d: any) => sum + Number(d.amount?.toString() ?? "0"),
        0,
      );

      // WHT deducted (from distribution ledger metadata)
      const totalWhtDeducted = paidDistributions.reduce(
        (sum: number, d: any) => sum + Number(d.whtAmount?.toString() ?? d.metadata?.whtAmount ?? "0"),
        0,
      );

      // Platform fees broken down by type
      const platformFees = platformFeeEntries.filter((e: any) => e.metadata?.feeType === "platform");
      const setupFees = platformFeeEntries.filter((e: any) => e.metadata?.feeType === "setup");
      const totalPlatformFeesPaid = platformFees.reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );
      const totalSetupFeesPaid = setupFees.reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );
      const totalServicingFeesPaid = distributionFeeEntries.reduce(
        (sum: number, e: any) => sum + Number(e.amount?.toString() ?? "0"),
        0,
      );

      const offeringSummaries = offerings.map((o: any) => ({
        offeringId: String(o._id),
        offeringName: o.name,
        status: o.status,
        templateCode: o.templateCode,
        raiseAmount: o.terms?.raiseAmount?.toString() ?? o.metrics?.raiseAmount?.toString() ?? "0",
        subscribedAmount: o.metrics?.subscribedAmount?.toString() ?? "0",
      }));

      return serialize({
        businessId: params.id,
        businessName: (business as any).name,
        taxYear: query.year,
        currency: "NGN",
        // Capital
        totalCapitalRaised: totalCapitalRaised.toFixed(2),
        // Distributions
        totalDistributionsPaid: totalDistributionsPaid.toFixed(2),
        totalWhtDeducted: totalWhtDeducted.toFixed(2),
        netDistributionsPaid: (totalDistributionsPaid - totalWhtDeducted).toFixed(2),
        // Platform fees (tax-deductible costs)
        totalPlatformFeesPaid: totalPlatformFeesPaid.toFixed(2),
        totalServicingFeesPaid: totalServicingFeesPaid.toFixed(2),
        totalSetupFeesPaid: totalSetupFeesPaid.toFixed(2),
        totalFraternalPlatformCosts: (totalPlatformFeesPaid + totalServicingFeesPaid + totalSetupFeesPaid).toFixed(2),
        // Offering breakdown
        offeringCount: offerings.length,
        offerings: offeringSummaries,
        // Report metadata
        generatedAt: new Date().toISOString(),
        disclaimer: "This statement is for informational purposes only. Consult your tax advisor for formal tax filings.",
      });
    },
  );
}
