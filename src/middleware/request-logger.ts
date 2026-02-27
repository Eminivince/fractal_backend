import type { FastifyInstance } from "fastify";

const SENSITIVE_PATHS = ["/v1/auth/login", "/v1/auth/reset-password"];

export async function registerRequestLogger(app: FastifyInstance): Promise<void> {
  app.addHook("onResponse", (request, reply, done) => {
    const duration = reply.elapsedTime;
    const userId = (request as any).authUser?.userId ?? "anonymous";
    const logData = {
      method: request.method,
      url: request.url,
      userId,
      statusCode: reply.statusCode,
      duration: Math.round(duration),
      userAgent: request.headers["user-agent"] ?? "unknown",
    };

    // Skip logging health checks at info level
    if (request.url === "/health") {
      app.log.debug(logData, "request completed");
    } else if (reply.statusCode >= 400) {
      app.log.warn(logData, "request failed");
    } else {
      app.log.info(logData, "request completed");
    }

    done();
  });
}
