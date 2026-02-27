import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PlatformConfigModel } from "../../db/models.js";
import { toDecimal } from "../../utils/decimal.js";
import { authorize } from "../../utils/rbac.js";
import { appendEvent } from "../../utils/audit.js";
import { HttpError } from "../../utils/errors.js";
import { serialize } from "../../utils/serialize.js";

const configSchema = z.object({
  featureFlags: z
    .object({
      enableTemplateB: z.boolean(),
      enableStablecoinPayouts: z.boolean(),
      enableSecondaryTransfers: z.boolean(),
    })
    .optional(),
  complianceRules: z
    .object({
      requireKycToView: z.boolean(),
      requireKycToSubscribe: z.boolean(),
      transferModeDefault: z.enum(["whitelist", "open"]),
      defaultLockupDays: z.number().int().nonnegative(),
      minInvestmentByTemplate: z.object({ A: z.number().positive(), B: z.number().positive() }),
    })
    .optional(),
  feeConfig: z
    .object({
      setupFee: z.number().nonnegative(),
      platformFeePct: z.number().nonnegative(),
      servicingFeePct: z.number().nonnegative(),
    })
    .optional(),
  feeOverrides: z
    .object({
      byTemplate: z
        .object({
          A: z
            .object({
              setupFee: z.number().nonnegative().optional(),
              platformFeePct: z.number().nonnegative().optional(),
              servicingFeePct: z.number().nonnegative().optional(),
            })
            .optional(),
          B: z
            .object({
              setupFee: z.number().nonnegative().optional(),
              platformFeePct: z.number().nonnegative().optional(),
              servicingFeePct: z.number().nonnegative().optional(),
            })
            .optional(),
        })
        .default({}),
      byBusiness: z.record(z.string(), z.record(z.string(), z.number().nonnegative())).default({}),
      byOffering: z.record(z.string(), z.record(z.string(), z.number().nonnegative())).default({}),
    })
    .optional(),
});

const contentSchema = z.object({
  heroHeadline: z.string().min(3),
  heroSubtext: z.string().min(3),
  ctas: z.array(z.string().min(1)).min(1),
  howItWorks: z.array(z.string().min(1)).min(1),
  faqs: z.array(z.object({ q: z.string().min(2), a: z.string().min(2) })).min(1),
});

export async function platformRoutes(app: FastifyInstance) {
  app.get(
    "/v1/platform/config",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "platform");
      const config = await PlatformConfigModel.findById("platform_config").lean();
      if (!config) throw new HttpError(404, "Platform config not found");
      return serialize(config);
    },
  );

  app.put(
    "/v1/platform/config",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "platform");
      const payload = configSchema.parse(request.body);

      const config = await PlatformConfigModel.findById("platform_config");
      if (!config) throw new HttpError(404, "Platform config not found");

      if (payload.featureFlags) {
        config.featureFlags = payload.featureFlags;
      }
      if (payload.complianceRules) {
        config.complianceRules = {
          ...payload.complianceRules,
          minInvestmentByTemplate: {
            A: toDecimal(payload.complianceRules.minInvestmentByTemplate.A),
            B: toDecimal(payload.complianceRules.minInvestmentByTemplate.B),
          },
        } as any;
      }

      if (payload.feeConfig) {
        config.feeConfig = {
          setupFee: toDecimal(payload.feeConfig.setupFee),
          platformFeePct: toDecimal(payload.feeConfig.platformFeePct),
          servicingFeePct: toDecimal(payload.feeConfig.servicingFeePct),
        } as any;
      }

      if (payload.feeOverrides) {
        config.feeOverrides = payload.feeOverrides as any;
      }

      config.updatedBy = request.authUser.userId as any;
      config.updatedAt = new Date();
      await config.save();

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(config._id),
        action: "Platform config updated",
      });

      return serialize(config.toObject());
    },
  );

  app.get(
    "/v1/platform/content",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "platform");
      const config = await PlatformConfigModel.findById("platform_config").lean();
      if (!config) throw new HttpError(404, "Platform config not found");
      return serialize(config.contentConfig ?? {});
    },
  );

  app.put(
    "/v1/platform/content",
    {
      preHandler: [app.authenticate],
    },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "update", "platform");
      const payload = contentSchema.parse(request.body);

      const config = await PlatformConfigModel.findById("platform_config");
      if (!config) throw new HttpError(404, "Platform config not found");

      config.contentConfig = payload as any;
      config.updatedBy = request.authUser.userId as any;
      config.updatedAt = new Date();
      await config.save();

      await appendEvent(request.authUser, {
        entityType: "platform_config",
        entityId: String(config._id),
        action: "Platform content updated",
      });

      return serialize(config.contentConfig ?? {});
    },
  );
}
