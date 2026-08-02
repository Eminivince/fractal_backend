import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";
import { postgresPrivacyRightsRoutes } from "../postgres-privacy-rights.routes.js";

const mocks = vi.hoisted(() => ({
  identity: vi.fn(),
  listOwn: vi.fn(),
  create: vi.fn(),
}));

vi.mock("../../../../platform/postgres-identities.js", () => ({
  requirePostgresIdentityForSubject: mocks.identity,
  PostgresIdentityUnavailableError: class PostgresIdentityUnavailableError extends Error {},
}));
vi.mock("../../../../platform/postgres-privacy-rights.js", () => ({
  createPrivacyRightsRequest: mocks.create,
  listOwnPrivacyRightsRequests: mocks.listOwn,
  PrivacyRightsError: class PrivacyRightsError extends Error {},
}));

let app: ReturnType<typeof Fastify>;
let authenticated = true;

beforeEach(async () => {
  vi.clearAllMocks();
  authenticated = true;
  mocks.identity.mockResolvedValue("00000000-0000-4000-8000-000000000001");
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    if (authenticated) request.authUser = { userId: "user-1", role: "investor", sessionId: "session-1" };
  });
  await app.register(postgresPrivacyRightsRoutes);
});

afterEach(async () => { await app.close(); });

describe("privacy-rights routes", () => {
  it("lists only the authenticated identity's privacy requests", async () => {
    mocks.listOwn.mockResolvedValue({ requests: [] });

    const response = await app.inject({ method: "GET", url: "/v1/privacy/requests" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ requests: [] });
    expect(mocks.identity).toHaveBeenCalledWith("user-1");
    expect(mocks.listOwn).toHaveBeenCalledWith({ actorIdentityId: "00000000-0000-4000-8000-000000000001" });
  });

  it("requires authentication before it reads privacy requests", async () => {
    authenticated = false;

    const response = await app.inject({ method: "GET", url: "/v1/privacy/requests" });

    expect(response.statusCode).toBe(401);
    expect(mocks.listOwn).not.toHaveBeenCalled();
  });

  it("rejects a privacy request that has no command key before it changes data", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/privacy/requests",
      payload: { requestType: "access", details: "Please provide the personal data that you process for my account." },
    });

    expect(response.statusCode).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
