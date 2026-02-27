/**
 * Rate limiting middleware for Fastify.
 *
 * Global limit  : 200 req/min per IP
 * Auth endpoints: 5 req/min per IP (stricter)
 * Sensitive endpoints: custom limits per route
 */

import type { FastifyInstance } from "fastify";

// Route-specific rate limits for sensitive endpoints
const ROUTE_RATE_LIMITS: Record<string, { max: number; timeWindow: string }> = {
  "/v1/applications/*/approve": { max: 3, timeWindow: "1 minute" },
  "/v1/investor/kyc/*": { max: 5, timeWindow: "1 minute" },
  "/v1/auth/forgot-password": { max: 3, timeWindow: "1 minute" },
  "/v1/auth/reset-password": { max: 5, timeWindow: "1 minute" },
};

function matchRouteLimit(url: string): { max: number; timeWindow: string } | undefined {
  for (const [pattern, limit] of Object.entries(ROUTE_RATE_LIMITS)) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, "[^/]+") + "$");
    if (regex.test(url)) return limit;
  }
  return undefined;
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rateLimit = require("@fastify/rate-limit");

    await app.register(rateLimit, {
      global: true,
      max: 200,
      timeWindow: "1 minute",
      keyGenerator: (request: any) => {
        // Use authenticated user ID when available, else IP
        if (request.authUser?.userId) return request.authUser.userId;
        const xff = request.headers["x-forwarded-for"];
        return (Array.isArray(xff) ? xff[0] : xff?.split(",")[0]) ?? request.ip ?? "unknown";
      },
      errorResponseBuilder: (_request: any, context: any) => ({
        error: `Rate limit exceeded. Retry after ${context.after}.`,
        code: "RATE_LIMITED",
      }),
    });

    // Stricter limits on auth and sensitive routes
    app.addHook("onRoute", (routeOptions) => {
      if (routeOptions.url?.startsWith("/v1/auth")) {
        (routeOptions as any).config = {
          ...routeOptions.config,
          rateLimit: { max: 5, timeWindow: "1 minute" },
        };
      }

      // Apply route-specific limits
      const routeLimit = matchRouteLimit(routeOptions.url ?? "");
      if (routeLimit) {
        (routeOptions as any).config = {
          ...routeOptions.config,
          rateLimit: routeLimit,
        };
      }

      // Stricter limit for subscription creation
      if (routeOptions.url === "/v1/subscriptions" && routeOptions.method === "POST") {
        (routeOptions as any).config = {
          ...routeOptions.config,
          rateLimit: { max: 10, timeWindow: "1 minute" },
        };
      }
    });

    app.log.info("[rate-limit] @fastify/rate-limit registered (200 req/min global, custom per-route)");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.warn(`[rate-limit] @fastify/rate-limit not available (${msg}). Rate limiting is disabled.`);
    app.log.warn("[rate-limit] Run 'npm install @fastify/rate-limit' to enable.");
  }
}
