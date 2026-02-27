/**
 * A-64: Server-side feature flag enforcement helper.
 *
 * Use this as a Fastify preHandler to gate routes behind feature flags
 * stored in the platform configuration.
 *
 * Example usage in a route:
 *
 *   app.post("/v1/tokens/secondary-transfer", {
 *     preHandler: [app.authenticate, requireFeatureFlag("enableSecondaryTransfers")],
 *   }, handler);
 */

import type { FastifyRequest, FastifyReply } from "fastify";
import { PlatformConfigModel } from "../db/models.js";
import { HttpError } from "../utils/errors.js";

type FeatureFlagKey = "enableTemplateB" | "enableStablecoinPayouts" | "enableSecondaryTransfers";

/**
 * Returns a Fastify preHandler that checks whether the given feature flag
 * is enabled in the platform configuration. Throws 403 if the flag is off.
 */
export function requireFeatureFlag(flagKey: FeatureFlagKey) {
  return async (_request: FastifyRequest, _reply: FastifyReply) => {
    const config = await PlatformConfigModel.findById("platform_config")
      .select("featureFlags")
      .lean();

    const flags = config?.featureFlags ?? {};
    const enabled = (flags as Record<string, boolean>)[flagKey] ?? false;

    if (!enabled) {
      throw new HttpError(
        403,
        `Feature "${flagKey}" is not enabled on this platform. Contact the platform administrator.`,
      );
    }
  };
}

/**
 * Soft check — returns true/false instead of throwing.
 * Useful for conditional logic inside handlers.
 */
export async function isFeatureFlagEnabled(flagKey: FeatureFlagKey): Promise<boolean> {
  const config = await PlatformConfigModel.findById("platform_config")
    .select("featureFlags")
    .lean();
  const flags = config?.featureFlags ?? {};
  return (flags as Record<string, boolean>)[flagKey] ?? false;
}
