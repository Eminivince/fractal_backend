import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  getOpenInvestmentOffering,
  getPublicInvestmentOffering,
  listOpenInvestmentOfferings,
  listPublicInvestmentOfferings,
} from "../../../platform/postgres-investment-offerings.js";
import { HttpError } from "../../../utils/errors.js";
import { authorize } from "../../../utils/rbac.js";
import { readActivePlatformConfiguration } from "../../../platform/postgres-platform-configuration.js";

const publicOfferingProperties = {
  slug: { type: "string", pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" },
  reference: { type: "string" }, name: { type: "string" }, issuerName: { type: "string" },
  assetName: { type: "string" }, assetType: { type: "string" },
  assetClass: { type: "string", enum: ["logistics_industrial", "mixed_use_real_estate", "renewable_energy", "infrastructure", "healthcare", "education", "agribusiness", "other"] },
  countryCode: { type: "string", pattern: "^[A-Z]{2}$" }, state: { type: "string" }, city: { type: "string" },
  summary: { type: "string" }, thesis: { type: "string" }, currency: { type: "string", pattern: "^[A-Z]{3}$" },
  capacityMinor: { type: "string", pattern: "^[0-9]+$" }, minimumTicketMinor: { type: "integer", minimum: 1 },
  targetReturnBps: { type: "integer", minimum: 1, maximum: 10_000 }, termMonths: { type: "integer", minimum: 1, maximum: 600 },
  riskSummary: { type: "string" }, incomeSource: { type: "string" }, structure: { type: "string" }, security: { type: "string" },
  feeSummary: { type: "string" }, nextMilestone: { type: "string" },
  opensAt: { type: "string", format: "date-time" }, closesAt: { type: "string", format: "date-time" },
  publishedAt: { type: "string", format: "date-time" }, publicationVersion: { type: "integer", minimum: 1 },
} as const;
const publicOfferingRequired = Object.keys(publicOfferingProperties);
const publicOfferingResponse = { type: "object", additionalProperties: false, required: publicOfferingRequired, properties: publicOfferingProperties } as const;

export async function investmentOfferingReadRoutes(app: FastifyInstance) {
  app.get("/v1/public/investment-offerings", {
    schema: {
      querystring: { type: "object", additionalProperties: false, properties: { limit: { type: "integer", minimum: 1, maximum: 100 } } },
      response: { 200: { type: "object", additionalProperties: false, required: ["offerings"], properties: { offerings: { type: "array", items: publicOfferingResponse } } } },
    },
  }, async (request, reply) => {
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
    const binding = limit === undefined
      ? await readActivePlatformConfiguration("public.catalogue.default_page_size")
      : null;
    const governedDefault = binding && typeof binding.value === "number" && Number.isSafeInteger(binding.value)
      ? binding.value
      : undefined;
    reply.header("Cache-Control", "no-store");
    if (binding) {
      reply.header("X-Fractal-Configuration-Version", binding.versionId);
      reply.header("X-Fractal-Configuration-Projection", String(binding.projectionVersion));
    }
    return { offerings: await listPublicInvestmentOfferings(limit ?? governedDefault) };
  });

  app.get("/v1/public/investment-offerings/:slug", {
    schema: {
      params: { type: "object", additionalProperties: false, required: ["slug"], properties: { slug: { type: "string", maxLength: 120, pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" } } },
      response: { 200: publicOfferingResponse },
    },
  }, async (request, reply) => {
    const { slug } = z.object({ slug: z.string().trim().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(120) }).parse(request.params);
    const offering = await getPublicInvestmentOffering(slug);
    if (!offering) throw new HttpError(404, "Public investment offering not found or not open");
    reply.header("Cache-Control", "no-store");
    return offering;
  });

  app.get("/v1/investment-offerings", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const { limit } = z.object({ limit: z.coerce.number().int().min(1).max(100).optional() }).parse(request.query);
    return { offerings: await listOpenInvestmentOfferings(limit) };
  });

  app.get("/v1/investment-offerings/:reference", { preHandler: [app.authenticate] }, async (request: FastifyRequest) => {
    authorize(request.authUser, "read", "offering");
    const { reference } = z.object({ reference: z.string().trim().min(1).max(200) }).parse(request.params);
    const offering = await getOpenInvestmentOffering(reference);
    if (!offering) throw new HttpError(404, "Investment offering not found or not open");
    return offering;
  });
}
