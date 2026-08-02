import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../utils/errors.js";
import { PaystackRequestError } from "../services/paystack.js";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  env: { NODE_ENV: "test", ALLOWED_ORIGINS: "http://localhost:3000" },
  registerApiRoutes: vi.fn(),
}));

vi.mock("@fastify/cors", () => ({ default: async () => undefined }));
vi.mock("@fastify/swagger", () => ({ default: async () => undefined }));
vi.mock("@fastify/swagger-ui", () => ({ default: async () => undefined }));
vi.mock("@fastify/helmet", () => ({ default: async () => undefined }));
vi.mock("../config/env.js", () => ({ env: mocks.env }));
vi.mock("../plugins/auth.js", () => ({ default: async () => undefined }));
vi.mock("../plugins/api-version.js", () => ({ apiVersionPlugin: async () => undefined }));
vi.mock("../routes/health.js", () => ({ healthRoutes: async () => undefined }));
vi.mock("../routes/index.js", () => ({ registerApiRoutes: mocks.registerApiRoutes }));
vi.mock("../middleware/rate-limit.js", () => ({ registerRateLimit: async () => undefined }));
vi.mock("../middleware/request-logger.js", () => ({ registerRequestLogger: async () => undefined }));
vi.mock("../middleware/correlation-id.js", () => ({ registerCorrelationId: async () => undefined }));
vi.mock("../middleware/financial-logger.js", () => ({ registerFinancialLogger: async () => undefined }));
vi.mock("../middleware/authoritative-api-boundary.js", () => ({ registerAuthoritativeApiBoundary: () => undefined }));
vi.mock("../middleware/privileged-action-step-up.js", () => ({ registerPrivilegedActionStepUpPolicy: () => undefined }));
vi.mock("../middleware/csrf.js", () => ({ csrfGuard: async () => undefined, registerCsrfRoutes: () => undefined }));
vi.mock("../services/sentry.js", () => ({ captureException: mocks.captureException }));

import { buildApp } from "../app.js";

describe("application error boundary", () => {
  let app: Awaited<ReturnType<typeof buildApp>>;

  beforeEach(async () => {
    mocks.captureException.mockReset();
    mocks.registerApiRoutes.mockReset();
    mocks.env.NODE_ENV = "test";
    mocks.registerApiRoutes.mockImplementation(async (instance: any) => {
      instance.get("/__test/http-error", async () => {
        throw new HttpError(409, "The governed state changed.", { currentVersion: 2 }, "STALE_VERSION");
      });
      for (const [path, statusCode] of [["unauthenticated", 401], ["forbidden", 403], ["missing", 404], ["unavailable", 410], ["conflict", 409], ["invalid", 422], ["generic", 400]] as const) {
        instance.get(`/__test/${path}`, async () => {
          throw new HttpError(statusCode, `${path} failure`);
        });
      }
      instance.get("/__test/paystack-rejected", async () => {
        throw new PaystackRequestError("Invalid bank account", false, 422);
      });
      instance.get("/__test/paystack-unavailable", async () => {
        throw new PaystackRequestError("Provider timeout", true, 503);
      });
      instance.get("/__test/zod", async () => {
        throw { name: "ZodError", issues: [], flatten: () => ({ formErrors: ["Invalid request"], fieldErrors: {} }) };
      });
      instance.get("/__test/zod-without-flatten", async () => {
        throw { name: "ZodError", issues: [] };
      });
      instance.get("/__test/rate-limited", async () => {
        throw Object.assign(new Error("Too many requests"), { statusCode: 429 });
      });
      instance.get("/__test/unexpected", async () => {
        throw new Error("Unexpected internal failure");
      });
    });
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns stable codes and details for expected application errors", async () => {
    const response = await app.inject({ method: "GET", url: "/__test/http-error" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: "The governed state changed.",
      message: "The governed state changed.",
      code: "STALE_VERSION",
      details: { currentVersion: 2 },
    });
  });

  it("distinguishes a provider rejection from a temporary provider failure", async () => {
    const [rejected, unavailable] = await Promise.all([
      app.inject({ method: "GET", url: "/__test/paystack-rejected" }),
      app.inject({ method: "GET", url: "/__test/paystack-unavailable" }),
    ]);

    expect(rejected.statusCode).toBe(422);
    expect(rejected.json()).toMatchObject({ code: "PAYMENT_PROVIDER_REJECTED" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ code: "PAYMENT_PROVIDER_UNAVAILABLE" });
  });

  it("maps every uncoded HTTP error status to its stable client code", async () => {
    const responses = await Promise.all([
      app.inject({ method: "GET", url: "/__test/unauthenticated" }),
      app.inject({ method: "GET", url: "/__test/forbidden" }),
      app.inject({ method: "GET", url: "/__test/missing" }),
      app.inject({ method: "GET", url: "/__test/unavailable" }),
      app.inject({ method: "GET", url: "/__test/conflict" }),
      app.inject({ method: "GET", url: "/__test/invalid" }),
      app.inject({ method: "GET", url: "/__test/generic" }),
    ]);

    expect(responses.map((response) => response.json().code)).toEqual([
      "AUTH_FAILED", "FORBIDDEN", "NOT_FOUND", "CAPABILITY_UNAVAILABLE", "CONFLICT", "VALIDATION_ERROR", "INTERNAL",
    ]);
  });

  it("normalizes Zod, rate-limit, and unexpected failures", async () => {
    const [zod, zodWithoutFlatten, rateLimited, unexpected] = await Promise.all([
      app.inject({ method: "GET", url: "/__test/zod" }),
      app.inject({ method: "GET", url: "/__test/zod-without-flatten" }),
      app.inject({ method: "GET", url: "/__test/rate-limited" }),
      app.inject({ method: "GET", url: "/__test/unexpected" }),
    ]);

    expect(zod.statusCode).toBe(400);
    expect(zod.json()).toMatchObject({ code: "VALIDATION_ERROR", details: { formErrors: ["Invalid request"] } });
    expect(zodWithoutFlatten.json()).toMatchObject({ details: { formErrors: [], fieldErrors: {} } });
    expect(rateLimited.statusCode).toBe(429);
    expect(rateLimited.json()).toMatchObject({ code: "RATE_LIMITED" });
    expect(unexpected.statusCode).toBe(500);
    expect(unexpected.json()).toEqual({ error: "Internal Server Error", message: "Internal Server Error", code: "INTERNAL" });
    expect(mocks.captureException).toHaveBeenCalledWith(expect.objectContaining({ message: "Unexpected internal failure" }));
  });

  it("accepts both loopback origins while assembling the development application", async () => {
    await app.close();
    const registeredBeforeDevelopmentBuild = mocks.registerApiRoutes.mock.calls.length;
    mocks.env.NODE_ENV = "development";
    app = await buildApp();

    expect(mocks.registerApiRoutes).toHaveBeenCalledTimes(registeredBeforeDevelopmentBuild + 1);
  });
});
