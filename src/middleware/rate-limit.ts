/**
 * Rate limiting middleware for Fastify.
 *
 * Global limit  : 200 req/min per IP
 * Auth abuse endpoints: route-specific per-IP ceilings below the global limit
 * Sensitive endpoints: custom limits per route
 */

import { createHmac } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import rateLimit from "@fastify/rate-limit";
import { getRedis } from "../db/redis.js";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

// Route-specific rate limits for sensitive endpoints
const ROUTE_RATE_LIMITS: Record<string, { max: number; timeWindow: string }> = {
  // Only routes that can be used to guess credentials, create accounts, or
  // trigger delivery are intentionally constrained. Session reads such as
  // `/v1/auth/me` run on every protected navigation and must retain the
  // global ceiling instead of turning routine workspace movement into 429s.
  // Login has two independent controls: this broader peer-address ceiling
  // limits credential stuffing across many accounts, while the manual
  // account-keyed limiter below permits only ten attempts for one normalized
  // email even when an attacker distributes requests across addresses.
  "/v1/auth/login": { max: 60, timeWindow: "1 minute" },
  "/v1/auth/register": { max: 5, timeWindow: "1 minute" },
  "/v1/auth/sync": { max: 5, timeWindow: "1 minute" },
  "/v1/auth/refresh": { max: 10, timeWindow: "1 minute" },
  "/v1/applications/*/approve": { max: 3, timeWindow: "1 minute" },
  "/v1/investor/kyc/*": { max: 5, timeWindow: "1 minute" },
  "/v1/auth/forgot-password": { max: 3, timeWindow: "1 minute" },
  "/v1/auth/reset-password": { max: 5, timeWindow: "1 minute" },
  "/v1/auth/request-email-verification": { max: 3, timeWindow: "1 minute" },
  "/v1/auth/resend-verification": { max: 3, timeWindow: "1 minute" },
  // Verification mirrors login's dual-key policy. A low peer-address limit
  // would let five attempts by any users lock out an entire office, carrier
  // NAT, or household. The separate account-keyed limiter below retains the
  // strict six-digit guessing ceiling for each normalized email address.
  "/v1/auth/verify-email": { max: 60, timeWindow: "10 minutes" },
};

function matchRouteLimit(url: string): { max: number; timeWindow: string } | undefined {
  for (const [pattern, limit] of Object.entries(ROUTE_RATE_LIMITS)) {
    const regex = new RegExp("^" + pattern.replace(/\*/g, "[^/]+") + "$");
    if (regex.test(url)) return limit;
  }
  return undefined;
}

function accountRateLimitKey(prefix: string, request: FastifyRequest): string {
  const body = request.body;
  const email = typeof body === "object" && body !== null && "email" in body && typeof body.email === "string"
    ? body.email.trim().toLowerCase()
    : "invalid-or-missing-email";
  // Redis keys must not expose account identifiers to operators or tooling.
  // JWT_SECRET is deployment-specific and already mandatory in every runtime.
  const digest = createHmac("sha256", env.JWT_SECRET).update(email).digest("hex");
  return `${prefix}:${digest}`;
}

export async function registerRateLimit(app: FastifyInstance): Promise<void> {
  try {
    // Register this before @fastify/rate-limit's own onRoute hook. That plugin
    // reads routeOptions.config exactly when a route is registered; adding the
    // policy hook afterwards leaves every route on the global limit.
    app.addHook("onRoute", (routeOptions) => {
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

    // B10: Use Redis store when available for distributed rate limiting
    const redis = getRedis();
    const storeOpts = redis && env.RATE_LIMIT_REDIS_ENABLED
      ? { redis }
      : undefined;

    await app.register(rateLimit, {
      global: true,
      max: 200,
      timeWindow: "1 minute",
      ...(storeOpts ? { redis: storeOpts.redis } : {}),
      keyGenerator: (request: any) => {
        // B10: Per-tenant rate limiting — key by businessId:userId
        const userId = request.authUser?.userId;
        const businessId = request.authUser?.businessId;
        if (userId) return businessId ? `${businessId}:${userId}` : userId;
        // `request.ip` is derived by Fastify. With the default trustProxy=false
        // it is the peer address, so a public caller cannot choose its key by
        // sending X-Forwarded-For. Add a narrowly scoped trusted-proxy policy
        // before enabling forwarded client addresses in a deployed environment.
        return request.ip ?? "unknown";
      },
      // @fastify/rate-limit throws this value. It must carry a statusCode;
      // returning a plain payload without one silently turns a 429 into a 500.
      errorResponseBuilder: (_request: any, context: any) => new HttpError(
        context.statusCode,
        `Rate limit exceeded. Retry after ${context.after}.`,
        undefined,
        "RATE_LIMITED",
      ),
    });

    const checkLoginAccountRateLimit = app.createRateLimit({
      max: 10,
      timeWindow: "1 minute",
      keyGenerator: (request) => accountRateLimitKey("login-account", request),
    });
    const checkEmailVerificationAccountRateLimit = app.createRateLimit({
      max: 5,
      timeWindow: "10 minutes",
      keyGenerator: (request) => accountRateLimitKey("email-verification-account", request),
    });
    app.addHook("preHandler", async (request) => {
      if (request.method !== "POST") return;
      const route = request.routeOptions.url;
      const limiter = route === "/v1/auth/login"
        ? checkLoginAccountRateLimit
        : route === "/v1/auth/verify-email"
          ? checkEmailVerificationAccountRateLimit
          : undefined;
      if (!limiter) return;
      const limit = await limiter(request);
      if (!limit.isAllowed && limit.isExceeded) {
        throw new HttpError(
          429,
          `Rate limit exceeded. Retry after ${limit.ttlInSeconds} seconds.`,
          undefined,
          "RATE_LIMITED",
        );
      }
    });

    app.log.info("[rate-limit] @fastify/rate-limit registered (200 req/min global, dual-key login controls, custom per-route)");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Fail CLOSED in production: running a public API with no rate limiting is a
    // DoS/abuse risk, so refuse to boot rather than silently disabling protection.
    if (env.NODE_ENV === "production") {
      throw new Error(
        `[rate-limit] @fastify/rate-limit is required in production but failed to load: ${msg}`,
      );
    }
    app.log.warn(`[rate-limit] @fastify/rate-limit not available (${msg}). Rate limiting is disabled (non-production only).`);
    app.log.warn("[rate-limit] Run 'pnpm add @fastify/rate-limit' to enable.");
  }
}
