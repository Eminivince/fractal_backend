import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../../../utils/errors.js";
import { postgresAdminReadRoutes } from "../postgres-admin-read.routes.js";

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role: "investor", sessionId: "session-1" }; });
  await app.register(postgresAdminReadRoutes);
});
afterEach(async () => { await app.close(); });

describe("administrator read routes", () => {
  it("rejects non-administrators before it reads sensitive access, audit, and export data", async () => {
    for (const request of [
      { method: "GET", url: "/v1/admin/access-identities" },
      { method: "GET", url: "/v1/admin/audit-events" },
      { method: "GET", url: "/v1/admin/access-change-requests" },
      { method: "GET", url: "/v1/admin/capabilities" },
      { method: "GET", url: "/v1/admin/audit-exports" },
      { method: "GET", url: "/v1/admin/system-health" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
    }
  });

  it("rejects a non-administrator command before it can change access", async () => {
    for (const request of [
      { method: "POST", url: "/v1/admin/access-change-requests", headers: { "x-command-id": "access-change-1" }, payload: { targetIdentityId: "00000000-0000-4000-8000-000000000001", changeType: "suspend", reason: "A governed security investigation requires temporary access suspension." } },
      { method: "POST", url: "/v1/admin/capability-change-requests", headers: { "x-command-id": "capability-change-1" }, payload: { targetIdentityId: "00000000-0000-4000-8000-000000000001", capabilityKey: "privacy_request_manage", changeType: "grant", reason: "A governed administration assignment requires this capability." } },
      { method: "POST", url: "/v1/admin/audit-exports", headers: { "x-command-id": "audit-export-1" }, payload: {} },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
    }
  });
});
