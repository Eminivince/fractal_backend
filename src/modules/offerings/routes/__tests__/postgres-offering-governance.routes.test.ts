import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../../../utils/errors.js";
import { postgresOfferingGovernanceRoutes } from "../postgres-offering-governance.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "admin";

beforeEach(async () => {
  role = "admin";
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role, sessionId: "session-1" }; });
  await app.register(postgresOfferingGovernanceRoutes);
});

afterEach(async () => { await app.close(); });

describe("offering governance role boundaries", () => {
  it("rejects a non-investor before it can use investor verification, portfolio, or document routes", async () => {
    for (const request of [
      { method: "GET", url: "/v1/investor/identity-verification/application" },
      { method: "POST", url: "/v1/investor/identity-verification/applications" },
      { method: "POST", url: "/v1/investor/identity-verification/access-token" },
      { method: "GET", url: "/v1/investor/portfolio" },
      { method: "GET", url: "/v1/investor/documents" },
      { method: "GET", url: "/v1/investor/documents/agreement-1/download" },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
    }
  });

  it("rejects a non-issuer before it can read the issuer overview", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/issuer/overview" });

    expect(response.statusCode).toBe(403);
  });
});
