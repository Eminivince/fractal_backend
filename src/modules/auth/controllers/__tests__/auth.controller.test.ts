import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ setCookies: vi.fn(), clearCookie: vi.fn(), revokeCurrent: vi.fn(), createSession: vi.fn(), listSessions: vi.fn(), revokeSession: vi.fn(), rotate: vi.fn(), events: vi.fn(), serialize: vi.fn((value: unknown) => value), login: vi.fn(), register: vi.fn(), sync: vi.fn(), getById: vi.fn() }));
const { SessionError } = vi.hoisted(() => ({ SessionError: class SessionError extends Error {} }));
vi.mock("../../../../plugins/auth.js", () => ({ setAuthCookies: mocks.setCookies, clearAuthCookie: mocks.clearCookie, revokeCurrentAuthSession: mocks.revokeCurrent }));
vi.mock("../../../../platform/auth-sessions.js", () => ({ AuthSessionError: SessionError, createAuthSession: mocks.createSession, listAuthSessions: mocks.listSessions, revokeAuthSessionForSubject: mocks.revokeSession, rotateAuthSession: mocks.rotate }));
vi.mock("../../../../services/security-event-projection.js", () => ({ listSecurityEvents: mocks.events }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../services/auth.service.js", () => ({ authenticateByPassword: mocks.login, registerAuthUser: mocks.register, syncAuthUser: mocks.sync, getAuthUserById: mocks.getById }));
import { createAuthController } from "../auth.controller.js";

const user = { _id: "user-1", role: "investor", email: "member@example.test" };
const request = (body: unknown = {}, extra: Record<string, unknown> = {}) => ({ body, ip: "127.0.0.1", headers: { "user-agent": "Vitest" }, cookies: {}, authUser: { userId: "user-1", sessionId: "session-current", role: "investor" }, ...extra }) as any;
const reply = () => ({}) as any;
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset(); mocks.serialize.mockImplementation((value: unknown) => value); mocks.createSession.mockResolvedValue({ accessToken: "access", refreshToken: "refresh", accessTokenExpiresAt: new Date("2026-01-01T00:00:00.000Z") }); mocks.login.mockResolvedValue(user); mocks.register.mockResolvedValue(user); mocks.sync.mockResolvedValue(user); mocks.getById.mockResolvedValue(user); mocks.revokeCurrent.mockResolvedValue(undefined); mocks.rotate.mockResolvedValue({ accessToken: "access-2", refreshToken: "refresh-2", accessTokenExpiresAt: new Date("2026-01-02T00:00:00.000Z") });
});

describe("authentication controller", () => {
  it("creates browser sessions for login, register, and legacy sync with request metadata", async () => {
    const controller = createAuthController({} as any);
    await expect(controller.login(request({ email: "member@example.test", password: "ValidPassword1" }), reply())).resolves.toMatchObject({ token: "access", user });
    await expect(controller.register(request({ email: "member@example.test", name: "Member", role: "investor", password: "ValidPassword1", legalAcceptances: [{ documentKey: "terms_global_public", versionId: "11111111-1111-4111-8111-111111111111", contentSha256: "a".repeat(64) }, { documentKey: "privacy_global_public", versionId: "22222222-2222-4222-8222-222222222222", contentSha256: "b".repeat(64) }] }), reply())).resolves.toMatchObject({ accessTokenExpiresAt: "2026-01-01T00:00:00.000Z" });
    await expect(controller.sync(request({ email: "member@example.test", name: "Member", role: "investor" }), reply())).resolves.toMatchObject({ token: "access" });
    expect(mocks.createSession).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ userId: "user-1", role: "investor" }), { ip: "127.0.0.1", userAgent: "Vitest" }); expect(mocks.setCookies).toHaveBeenCalledTimes(3);
  });

  it("rotates only a valid refresh session and clears an invalid browser cookie", async () => {
    const controller = createAuthController({} as any);
    await expect(controller.refresh(request({}, { cookies: { fractal_refresh: "refresh" } }), reply())).resolves.toMatchObject({ token: "access-2" });
    await expect(controller.refresh(request(), reply())).rejects.toMatchObject({ statusCode: 401 });
    mocks.rotate.mockRejectedValueOnce(new SessionError("expired")); await expect(controller.refresh(request({}, { cookies: { fractal_refresh: "expired" } }), reply())).rejects.toMatchObject({ statusCode: 401 }); expect(mocks.clearCookie).toHaveBeenCalled();
    mocks.rotate.mockRejectedValueOnce(new Error("session database unavailable")); await expect(controller.refresh(request({}, { cookies: { fractal_refresh: "error" } }), reply())).rejects.toThrow("session database unavailable");
  });

  it("returns authenticated user, session, and security-event records in safe shapes", async () => {
    const controller = createAuthController({} as any);
    mocks.listSessions.mockResolvedValue([{ id: "session-1", createdAt: new Date("2026-01-01"), lastSeenAt: new Date("2026-01-02"), expiresAt: new Date("2026-02-01"), current: true }]); mocks.events.mockResolvedValue([{ id: "event-1", event_type: "login", session_id: "session-1", created_at: new Date("2026-01-01"), read_at: null }]);
    await expect(controller.me(request())).resolves.toEqual(user); await expect(controller.sessions(request())).resolves.toEqual([expect.objectContaining({ id: "session-1", current: true })]); await expect(controller.securityEvents(request())).resolves.toEqual([expect.objectContaining({ id: "event-1", type: "login", readAt: null })]);
  });

  it("revokes sessions, clears the current cookie, and reports a missing active session", async () => {
    const controller = createAuthController({} as any); mocks.revokeSession.mockResolvedValueOnce(true);
    await expect(controller.revokeSession(request({}, { params: { id: "11111111-1111-4111-8111-111111111111" }, authUser: { userId: "user-1", sessionId: "11111111-1111-4111-8111-111111111111", role: "investor" } }), reply())).resolves.toEqual({ ok: true }); expect(mocks.clearCookie).toHaveBeenCalled();
    mocks.revokeSession.mockResolvedValueOnce(false); await expect(controller.revokeSession(request({}, { params: { id: "22222222-2222-4222-8222-222222222222" } }), reply())).rejects.toMatchObject({ statusCode: 404 });
    await expect(controller.logout(request(), reply())).resolves.toEqual({ ok: true });
  });
});
