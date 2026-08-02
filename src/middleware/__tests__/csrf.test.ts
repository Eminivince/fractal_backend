import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { afterEach, describe, expect, it } from "vitest";
import { csrfGuard, registerCsrfRoutes } from "../csrf.js";

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  process.env.NODE_ENV = originalNodeEnv;
});

function request(input: { method?: string; url?: string; authorization?: string; headerToken?: string; cookieToken?: string }) {
  return {
    method: input.method ?? "POST",
    url: input.url ?? "/v1/protected-resource",
    headers: {
      ...(input.authorization ? { authorization: input.authorization } : {}),
      ...(input.headerToken ? { "x-csrf-token": input.headerToken } : {}),
    },
    cookies: input.cookieToken ? { fractal_csrf: input.cookieToken } : {},
  } as never;
}

describe("CSRF boundary", () => {
  it("issues a strong token and browser cookie with development-safe attributes", async () => {
    process.env.NODE_ENV = "test";
    const app = Fastify();
    await app.register(cookie);
    registerCsrfRoutes(app);

    const response = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const body = response.json<{ csrfToken: string }>();
    expect(response.statusCode).toBe(200);
    expect(body.csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.headers["set-cookie"]).toContain(`fractal_csrf=${body.csrfToken}`);
    expect(response.headers["set-cookie"]).toContain("HttpOnly");
    expect(response.headers["set-cookie"]).toContain("SameSite=Lax");
    expect(response.headers["set-cookie"]).not.toContain("Secure");
    await app.close();
  });

  it("uses cross-site secure cookies only in production", async () => {
    process.env.NODE_ENV = "production";
    const app = Fastify();
    await app.register(cookie);
    registerCsrfRoutes(app);

    const response = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    expect(response.headers["set-cookie"]).toContain("SameSite=None");
    expect(response.headers["set-cookie"]).toContain("Secure");
    await app.close();
  });

  it("allows reads, signed bearer calls, and explicitly protected webhook or worker paths", async () => {
    await expect(csrfGuard(request({ method: "GET" }), {} as never)).resolves.toBeUndefined();
    await expect(csrfGuard(request({ authorization: "Bearer script-token" }), {} as never)).resolves.toBeUndefined();
    await expect(csrfGuard(request({ url: "/v1/webhooks/paystack" }), {} as never)).resolves.toBeUndefined();
    await expect(csrfGuard(request({ url: "/health" }), {} as never)).resolves.toBeUndefined();
    await expect(csrfGuard(request({ url: "/v1/work-orders/escalate-overdue" }), {} as never)).resolves.toBeUndefined();
  });

  it("rejects a cookie mutation when either CSRF token is absent", async () => {
    await expect(csrfGuard(request({}), {} as never)).rejects.toMatchObject({ statusCode: 403, code: "CSRF_TOKEN_MISSING" });
    await expect(csrfGuard(request({ headerToken: "a".repeat(64) }), {} as never)).rejects.toMatchObject({ statusCode: 403, code: "CSRF_TOKEN_MISSING" });
    await expect(csrfGuard(request({ cookieToken: "a".repeat(64) }), {} as never)).rejects.toMatchObject({ statusCode: 403, code: "CSRF_TOKEN_MISSING" });
  });

  it("rejects length and constant-time token mismatches", async () => {
    await expect(csrfGuard(request({ headerToken: "short", cookieToken: "longer" }), {} as never)).rejects.toMatchObject({ statusCode: 403, code: "CSRF_TOKEN_MISMATCH" });
    await expect(csrfGuard(request({ headerToken: "a".repeat(64), cookieToken: "b".repeat(64) }), {} as never)).rejects.toMatchObject({ statusCode: 403, code: "CSRF_TOKEN_MISMATCH" });
  });

  it("accepts each state-changing browser method only when tokens match", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(csrfGuard(request({ method, headerToken: "c".repeat(64), cookieToken: "c".repeat(64) }), {} as never)).resolves.toBeUndefined();
    }
  });
});
