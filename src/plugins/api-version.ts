/**
 * B4: API versioning plugin.
 * Reads Accept-Version header, decorates request.apiVersion,
 * and adds Sunset/Deprecation headers for deprecated endpoints.
 */

import type { FastifyInstance } from "fastify";

const DEPRECATED_ENDPOINTS: Record<string, { sunset: string; message: string }> = {
  // Add entries as endpoints are deprecated:
  // "GET:/v1/legacy-endpoint": { sunset: "2026-12-31", message: "Use /v2/new-endpoint instead" },
};

export async function apiVersionPlugin(app: FastifyInstance): Promise<void> {
  app.decorateRequest("apiVersion", 1);

  app.addHook("onRequest", (request, _reply, done) => {
    const versionHeader = request.headers["accept-version"];
    if (typeof versionHeader === "string") {
      const parsed = parseInt(versionHeader, 10);
      if (!isNaN(parsed) && parsed > 0) {
        (request as any).apiVersion = parsed;
      }
    }
    done();
  });

  app.addHook("onSend", (request, reply, payload, done) => {
    const routeKey = `${request.method}:${(request as any).routeOptions?.url ?? request.url}`;
    const deprecation = DEPRECATED_ENDPOINTS[routeKey];
    if (deprecation) {
      reply.header("Sunset", deprecation.sunset);
      reply.header("Deprecation", "true");
      reply.header("Link", `<${deprecation.message}>; rel="successor-version"`);
    }
    done(null, payload);
  });
}
