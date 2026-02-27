// A-86: Sentry SDK init stub — replace DSN with actual value in production
// npm install @sentry/node
// import * as Sentry from "@sentry/node";
// Sentry.init({ dsn: process.env.SENTRY_DSN, tracesSampleRate: 0.1 });

import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import helmet from "@fastify/helmet";
import { ZodError } from "zod";
import authPlugin from "./plugins/auth.js";
import { HttpError } from "./utils/errors.js";
import { registerApiRoutes } from "./routes/index.js";
import { registerRateLimit } from "./middleware/rate-limit.js";
import { registerRequestLogger } from "./middleware/request-logger.js";
import { env } from "./config/env.js";

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
    },
  });

  // 1.2: CORS lockdown - only allow configured origins
  await app.register(cors, {
    origin: env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()),
    credentials: true,
  });

  // 1.6: Security headers
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'"],
      },
    },
    frameguard: { action: "deny" },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
  });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Fractal API",
        version: "0.1.0",
        description: "RWA tokenization infrastructure API (MongoDB, RBAC, workflow gates)",
      },
      servers: [{ url: "/", description: "Local" }],
      tags: [
        { name: "auth" },
        { name: "platform" },
        { name: "templates" },
        { name: "professionals" },
        { name: "businesses" },
        { name: "applications" },
        { name: "work-orders" },
        { name: "dossiers" },
        { name: "offerings" },
        { name: "investor" },
        { name: "subscriptions" },
        { name: "distributions" },
        { name: "milestones" },
        { name: "events" },
        { name: "assets" },
        { name: "anchors" },
        { name: "reconciliation" },
        { name: "notifications" },
        { name: "disputes" },
        { name: "system" },
      ],
    },
  });

  await app.register(swaggerUi, {
    routePrefix: "/docs",
  });

  // A-85: Rate limiting (200 req/min global, 5 req/min on auth routes)
  await registerRateLimit(app);

  await app.register(authPlugin);

  // 8.6: Request logging
  await registerRequestLogger(app);

  // 1.3: CSRF token endpoint (must be before route registration for CSRF middleware)
  await app.register(async (instance) => {
    const { registerCsrfRoutes } = await import("./middleware/csrf.js");
    registerCsrfRoutes(instance);
  });

  // 1.8: Global CSRF guard on all mutating requests (webhooks are exempted inside csrfGuard)
  const { csrfGuard } = await import("./middleware/csrf.js");
  app.addHook("preHandler", csrfGuard);

  app.get("/health", async () => ({ ok: true }));

  await registerApiRoutes(app);

  // 8.5: Standardized error responses
  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number };
    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        code: error.statusCode === 401 ? "AUTH_FAILED"
          : error.statusCode === 403 ? "FORBIDDEN"
          : error.statusCode === 404 ? "NOT_FOUND"
          : error.statusCode === 409 ? "CONFLICT"
          : error.statusCode === 422 ? "VALIDATION_ERROR"
          : "INTERNAL",
        details: error.details,
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        details: error.flatten(),
      });
    }

    const maybeStatusCode = err.statusCode;
    if (maybeStatusCode && maybeStatusCode >= 400 && maybeStatusCode < 600) {
      return reply.status(maybeStatusCode).send({
        error: err.message,
        code: maybeStatusCode === 429 ? "RATE_LIMITED" : "INTERNAL",
      });
    }

    app.log.error(error);
    return reply.status(500).send({ error: "Internal Server Error", code: "INTERNAL" });
  });

  return app;
}
