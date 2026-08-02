/**
 * B11: Financial request/response logging for compliance.
 * Captures sanitized request and response bodies for financial operations.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const SENSITIVE_PATTERNS = /password|token|secret|authorization|cvv|pin|sessionId/i;
const ACCOUNT_PATTERN = /accountNumber/i;

const FINANCIAL_ROUTES = new Set([
  "POST:/v1/offerings/:id/subscribe",
  "POST:/v1/subscriptions/:id/initiate-payment",
  "POST:/v1/subscriptions/:id/initiate-dva-payment",
  "POST:/v1/subscriptions/:id/cancel",
  "POST:/v1/subscriptions/:id/refund",
  "POST:/v1/webhooks/paystack",
  "POST:/v1/webhooks/sumsub",
]);

function sanitize(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === "string") return obj;
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_PATTERNS.test(key)) {
        result[key] = "[REDACTED]";
      } else if (ACCOUNT_PATTERN.test(key) && typeof value === "string" && value.length > 4) {
        result[key] = `****${value.slice(-4)}`;
      } else {
        result[key] = sanitize(value);
      }
    }
    return result;
  }
  return obj;
}

function isFinancialRoute(method: string, url: string): boolean {
  const routeKey = `${method}:${url}`;
  for (const pattern of FINANCIAL_ROUTES) {
    const regex = new RegExp("^" + pattern.replace(/:id/g, "[^/]+") + "$");
    if (regex.test(routeKey)) return true;
  }
  return false;
}

export async function registerFinancialLogger(app: FastifyInstance): Promise<void> {
  app.addHook("onSend", (request: FastifyRequest, reply: FastifyReply, payload: unknown, done) => {
    const routeUrl = (request as any).routeOptions?.url ?? request.url;
    if (!isFinancialRoute(request.method, routeUrl)) {
      return done(null, payload);
    }

    const auditLog = {
      audit: "financial",
      correlationId: (request as any).correlationId,
      method: request.method,
      route: routeUrl,
      userId: (request as any).authUser?.userId ?? "anonymous",
      requestBody: sanitize(request.body),
      statusCode: reply.statusCode,
    };

    request.log.info(auditLog, "financial-audit");
    done(null, payload);
  });
}
