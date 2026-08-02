import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  revokeAuthSession: vi.fn(),
  validateAuthSession: vi.fn(),
  findById: vi.fn(),
  createJwtKeyring: vi.fn(),
  resolveJwtVerificationKey: vi.fn(),
  env: {
    NODE_ENV: "test",
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
    AUTH_REFRESH_TOKEN_TTL_DAYS: 30,
    JWT_SECRET: "s".repeat(32),
    JWT_ACTIVE_KEY_ID: "primary",
    JWT_KEY_RING_JSON: undefined,
    AUTH_IDENTITY_AUTHORITY: "mongo",
  },
}));

vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../platform/auth-sessions.js", () => ({
  AuthSessionError: class AuthSessionError extends Error {},
  revokeAuthSession: mocks.revokeAuthSession,
  validateAuthSession: mocks.validateAuthSession,
}));
vi.mock("../../db/models.js", () => ({ UserModel: { findById: mocks.findById } }));
vi.mock("../../services/jwt-keyring.js", () => ({ createJwtKeyring: mocks.createJwtKeyring, resolveJwtVerificationKey: mocks.resolveJwtVerificationKey }));
vi.mock("../../platform/postgres-identities.js", () => ({ getPostgresAuthIdentityById: vi.fn() }));

import {
  AUTH_ACCESS_COOKIE_NAME,
  AUTH_REFRESH_COOKIE_NAME,
  clearAuthCookie,
  revokeCurrentAuthSession,
  setAuthCookies,
} from "../auth.js";
import authPlugin from "../auth.js";

function reply() {
  return { setCookie: vi.fn(), clearCookie: vi.fn() } as any;
}

beforeEach(() => {
  mocks.revokeAuthSession.mockReset().mockResolvedValue(undefined);
  mocks.validateAuthSession.mockReset().mockResolvedValue(undefined);
  mocks.findById.mockReset();
  mocks.createJwtKeyring.mockReset().mockReturnValue({});
  mocks.resolveJwtVerificationKey.mockReset().mockReturnValue("s".repeat(32));
  Object.assign(mocks.env, { NODE_ENV: "test", AUTH_ACCESS_TOKEN_TTL_SECONDS: 900, AUTH_REFRESH_TOKEN_TTL_DAYS: 30 });
});

describe("authentication helpers", () => {
  it("sets scoped HTTP-only cookies with development security settings", () => {
    const target = reply();
    setAuthCookies(target, "access-token", "refresh-token");
    expect(target.setCookie).toHaveBeenNthCalledWith(1, AUTH_ACCESS_COOKIE_NAME, "access-token", {
      httpOnly: true, secure: false, sameSite: "lax", path: "/", maxAge: 900,
    });
    expect(target.setCookie).toHaveBeenNthCalledWith(2, AUTH_REFRESH_COOKIE_NAME, "refresh-token", {
      httpOnly: true, secure: false, sameSite: "lax", path: "/v1/auth", maxAge: 2_592_000,
    });
  });

  it("uses cross-site secure cookie settings in production and clears the same scopes", () => {
    mocks.env.NODE_ENV = "production";
    const target = reply();
    setAuthCookies(target, "access-token", "refresh-token");
    clearAuthCookie(target);
    expect(target.setCookie).toHaveBeenCalledWith(AUTH_ACCESS_COOKIE_NAME, "access-token", expect.objectContaining({ secure: true, sameSite: "none" }));
    expect(target.clearCookie).toHaveBeenNthCalledWith(1, AUTH_ACCESS_COOKIE_NAME, {
      httpOnly: true, secure: true, sameSite: "none", path: "/",
    });
    expect(target.clearCookie).toHaveBeenNthCalledWith(2, AUTH_REFRESH_COOKIE_NAME, {
      httpOnly: true, secure: true, sameSite: "none", path: "/v1/auth",
    });
  });

  it("revokes an active session and does nothing for a request without one", async () => {
    await revokeCurrentAuthSession({ authUser: { userId: "user-1", role: "investor", sessionId: "session-1" } } as any);
    await revokeCurrentAuthSession({ authUser: { userId: "user-1", role: "investor" } } as any);
    expect(mocks.revokeAuthSession).toHaveBeenCalledOnce();
    expect(mocks.revokeAuthSession).toHaveBeenCalledWith("session-1", "user-1", "logout");
  });
});

describe("authentication plugin", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    mocks.findById.mockReturnValue({ select: () => ({ lean: async () => ({ status: "active", emailVerified: true }) }) });
    app = Fastify();
    await app.register(authPlugin);
    app.get("/protected", { preHandler: (request: any, reply: any) => (app as any).authenticate(request, reply) }, async (request: any) => ({ user: request.authUser }));
    await app.ready();
  });

  afterEach(async () => { await app.close(); });

  it("rejects missing and invalid tokens", async () => {
    await expect(app.inject({ method: "GET", url: "/protected" })).resolves.toMatchObject({ statusCode: 401 });
    await expect(app.inject({ method: "GET", url: "/protected", headers: { authorization: "Bearer invalid" } })).resolves.toMatchObject({ statusCode: 401 });
  });

  it("accepts a valid access token and validates its linked session", async () => {
    const token = app.jwt.sign({ userId: "user-1", role: "investor", sid: "session-1" });
    const response = await app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: { userId: "user-1", role: "investor", sessionId: "session-1" } });
    expect(mocks.validateAuthSession).toHaveBeenCalledWith("session-1", "user-1");
    expect(mocks.findById).toHaveBeenCalledWith("user-1");
  });

  it("rejects disabled or unverified accounts", async () => {
    const token = app.jwt.sign({ userId: "user-1", role: "investor" });
    mocks.findById.mockReturnValueOnce({ select: () => ({ lean: async () => ({ status: "disabled", emailVerified: true }) }) });
    await expect(app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } })).resolves.toMatchObject({ statusCode: 403 });
    mocks.findById.mockReturnValueOnce({ select: () => ({ lean: async () => ({ status: "active", emailVerified: false }) }) });
    await expect(app.inject({ method: "GET", url: "/protected", headers: { authorization: `Bearer ${token}` } })).resolves.toMatchObject({ statusCode: 403 });
  });
});
