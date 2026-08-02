// Sentry is initialized in instrumentation.ts (preloaded via `node --import`).
// Here we only report unhandled 500s through the gated captureException helper.
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import helmet from "@fastify/helmet";
import { ZodError } from "zod";
import authPlugin from "./plugins/auth.js";
import { HttpError } from "./utils/errors.js";
import { captureException } from "./services/sentry.js";
import { PaystackRequestError } from "./services/paystack.js";
import { registerApiRoutes } from "./routes/index.js";
import { healthRoutes } from "./routes/health.js";
import { apiVersionPlugin } from "./plugins/api-version.js";
import { registerRateLimit } from "./middleware/rate-limit.js";
import { registerRequestLogger } from "./middleware/request-logger.js";
import { registerCorrelationId } from "./middleware/correlation-id.js";
import { registerFinancialLogger } from "./middleware/financial-logger.js";
import { env } from "./config/env.js";
import { registerAuthoritativeApiBoundary } from "./middleware/authoritative-api-boundary.js";
import { registerPrivilegedActionStepUpPolicy } from "./middleware/privileged-action-step-up.js";

/**
 * Zod errors can cross a package boundary in local development (for example,
 * when the route module and the app resolve separate ESM instances). Do not
 * rely solely on `instanceof`, or bad client input becomes an accidental 500.
 */
function isZodValidationError(error: unknown): error is ZodError {
  if (error instanceof ZodError) return true;
  if (typeof error !== "object" || error === null) return false;

  const candidate = error as { name?: unknown; issues?: unknown };
  return candidate.name === "ZodError" && Array.isArray(candidate.issues);
}

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === "production" ? "info" : "debug",
    },
  });
  // Fastify error handlers are inherited by encapsulated plugins at the time
  // they are registered. This must precede every route/plugin registration.
  registerStandardizedErrorHandler(app);

  // 1.2: CORS lockdown - only allow configured origins. Development supports
  // both loopback aliases because browsers treat localhost and 127.0.0.1 as
  // different sites (which matters for cookie-backed CSRF protection).
  const allowedOrigins = new Set(env.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()));
  if (env.NODE_ENV === "development") {
    allowedOrigins.add("http://localhost:3000");
    allowedOrigins.add("http://127.0.0.1:3000");
  }
  await app.register(cors, {
    origin: [...allowedOrigins],
    credentials: true,
    exposedHeaders: ["Content-Disposition", "Digest", "ETag", "X-Fractal-Content-SHA256", "X-Fractal-Configuration-Version", "X-Fractal-Configuration-Projection"],
  });

  // The legacy Mongo-era route modules stay available only for migration work
  // outside production. In production, the boundary below fails them closed
  // before they can reach their own handlers or the CSRF layer.
  registerAuthoritativeApiBoundary(app);

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

  if (env.NODE_ENV !== "production") {
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
  }

  // A-85: Rate limiting (200 req/min global; stricter ceilings for credential and delivery-abuse routes)
  await registerRateLimit(app);

  await app.register(authPlugin);

  // B7: Correlation IDs
  await registerCorrelationId(app);

  // 8.6: Request logging
  await registerRequestLogger(app);

  // B11: Financial audit logging
  await registerFinancialLogger(app);

  // 1.3: CSRF token endpoint (must be before route registration for CSRF middleware)
  await app.register(async (instance) => {
    const { registerCsrfRoutes } = await import("./middleware/csrf.js");
    registerCsrfRoutes(instance);
  });

  // 1.8: Global CSRF guard on all mutating requests (webhooks are exempted inside csrfGuard)
  const { csrfGuard } = await import("./middleware/csrf.js");
  // Reject cross-site mutations before Fastify accepts or parses potentially
  // large request bodies (notably governed evidence uploads).
  app.addHook("onRequest", csrfGuard);

  // B4: API versioning
  await app.register(apiVersionPlugin);

  // B6: Deep health check
  await app.register(healthRoutes);

  // Register before route modules so the explicit privileged-action policy is
  // appended after each route's authentication pre-handler at registration.
  registerPrivilegedActionStepUpPolicy(app);
  await registerApiRoutes(app);

  return app;
}

// 8.5: Standardized error responses
function registerStandardizedErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, _request, reply) => {
    const err = error as Error & { statusCode?: number };
    if (error instanceof PaystackRequestError) {
      // Provider diagnostics can reveal integration details and must not be
      // presented to customers. The structured code lets the UI distinguish a
      // temporary degraded rail from a request the provider rejected.
      const rejectedRequest =
        !error.retryable &&
        error.status !== undefined &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 401 &&
        error.status !== 403;
      return reply.status(rejectedRequest ? 422 : 503).send({
        error: rejectedRequest
          ? "Payment provider rejected this request. Review the payment details and try again."
          : "Payment provider is temporarily unavailable. No payment action was completed; try again later.",
        message: rejectedRequest
          ? "Payment provider rejected this request. Review the payment details and try again."
          : "Payment provider is temporarily unavailable. No payment action was completed; try again later.",
        code: rejectedRequest ? "PAYMENT_PROVIDER_REJECTED" : "PAYMENT_PROVIDER_UNAVAILABLE",
      });
    }

    if (error instanceof HttpError) {
      return reply.status(error.statusCode).send({
        error: error.message,
        message: error.message,
        code: error.code ?? (error.statusCode === 401 ? "AUTH_FAILED"
          : error.statusCode === 403 ? "FORBIDDEN"
          : error.statusCode === 404 ? "NOT_FOUND"
          : error.statusCode === 410 ? "CAPABILITY_UNAVAILABLE"
          : error.statusCode === 409 ? "CONFLICT"
          : error.statusCode === 422 ? "VALIDATION_ERROR"
          : "INTERNAL"),
        details: error.details,
      });
    }

    if (isZodValidationError(error)) {
      return reply.status(400).send({
        error: "Validation failed",
        message: "Validation failed",
        code: "VALIDATION_ERROR",
        details: typeof error.flatten === "function"
          ? error.flatten()
          : { formErrors: [], fieldErrors: {} },
      });
    }

    const maybeStatusCode = err.statusCode;
    if (maybeStatusCode && maybeStatusCode >= 400 && maybeStatusCode < 600) {
      return reply.status(maybeStatusCode).send({
        error: err.message,
        message: err.message,
        code: maybeStatusCode === 429 ? "RATE_LIMITED" : "INTERNAL",
      });
    }

    app.log.error(error);
    // Report unexpected 500s to Sentry when configured.
    captureException(error);
    return reply.status(500).send({ error: "Internal Server Error", message: "Internal Server Error", code: "INTERNAL" });
  });
}
