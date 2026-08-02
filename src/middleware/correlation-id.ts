/**
 * B7: Request correlation ID middleware.
 * Generates a UUID per request for distributed tracing and log correlation.
 */

import crypto from "node:crypto";
import type { FastifyInstance } from "fastify";

export async function registerCorrelationId(app: FastifyInstance): Promise<void> {
  app.decorateRequest("correlationId", "");

  app.addHook("onRequest", (request, reply, done) => {
    const existing = request.headers["x-request-id"];
    const correlationId = (typeof existing === "string" && existing) || crypto.randomUUID();
    (request as any).correlationId = correlationId;
    reply.header("x-request-id", correlationId);
    request.log = request.log.child({ correlationId });
    done();
  });
}
