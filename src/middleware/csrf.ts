import crypto from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { HttpError } from "../utils/errors.js";

const CSRF_HEADER = "x-csrf-token";
const CSRF_COOKIE = "fractal_csrf";
const MUTATING_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

// Paths exempt from CSRF.
// Webhooks use their own signature verification.
// Internal worker self-calls use Bearer JWT auth (not cookies), so CSRF is not applicable.
const CSRF_EXEMPT_PATHS = [
  "/v1/webhooks/",
  "/health",
  "/v1/work-orders/escalate-overdue",
];

function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function registerCsrfRoutes(app: FastifyInstance) {
  // Endpoint to get a CSRF token
  app.get("/v1/auth/csrf-token", async (_request: FastifyRequest, reply: FastifyReply) => {
    const token = generateCsrfToken();
    const isProd = process.env.NODE_ENV === "production";
    reply.setCookie(CSRF_COOKIE, token, {
      httpOnly: true,
      secure: isProd,
      // Allow cross-site API calls from the web app in production.
      sameSite: isProd ? "none" : "lax",
      path: "/",
      maxAge: 8 * 60 * 60,
    });
    return { csrfToken: token };
  });
}

export async function csrfGuard(request: FastifyRequest, _reply: FastifyReply) {
  if (!MUTATING_METHODS.has(request.method)) return;

  // Skip CSRF for exempt paths (webhooks have their own signature verification)
  const isExempt = CSRF_EXEMPT_PATHS.some((p) => request.url.startsWith(p));
  if (isExempt) return;

  // Bearer credentials are explicitly supplied by script/API clients rather
  // than attached by a browser cookie, so they are not CSRF-authenticable.
  // Authentication and CORS still independently protect those endpoints.
  if (/^Bearer\s+\S+$/i.test(request.headers.authorization ?? "")) return;

  const headerToken = request.headers[CSRF_HEADER] as string | undefined;
  const cookieToken = (request.cookies as Record<string, string | undefined>)?.[CSRF_COOKIE];

  if (!headerToken || !cookieToken) {
    throw new HttpError(403, "CSRF token missing", undefined, "CSRF_TOKEN_MISSING");
  }

  // Constant-time comparison
  if (headerToken.length !== cookieToken.length) {
    throw new HttpError(403, "CSRF token mismatch", undefined, "CSRF_TOKEN_MISMATCH");
  }

  const a = Buffer.from(headerToken);
  const b = Buffer.from(cookieToken);
  if (!crypto.timingSafeEqual(a, b)) {
    throw new HttpError(403, "CSRF token mismatch", undefined, "CSRF_TOKEN_MISMATCH");
  }
}
