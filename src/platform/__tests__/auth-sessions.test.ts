import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: {
    JWT_SECRET: "unit-test-secret",
    JWT_ACTIVE_KEY_ID: "primary",
    JWT_KEY_RING_JSON: undefined as string | undefined,
    AUTH_REFRESH_TOKEN_TTL_DAYS: 14,
    AUTH_ACCESS_TOKEN_TTL_SECONDS: 900,
    AUTH_IDENTITY_AUTHORITY: "mongo" as "mongo" | "postgres",
  },
  requirePostgres: vi.fn(),
  withTransaction: vi.fn(),
  appendAudit: vi.fn(),
  appendOutbox: vi.fn(),
  createKeyring: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../db/postgres.js", () => ({
  requirePostgres: mocks.requirePostgres,
  withPostgresTransaction: mocks.withTransaction,
}));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));
vi.mock("../../services/jwt-keyring.js", () => ({ createJwtKeyring: mocks.createKeyring }));

import {
  AuthSessionError,
  createAuthSession,
  listAuthSessions,
  revokeAllAuthSessionsForIdentityInTransaction,
  revokeAllAuthSessionsForSubject,
  revokeAllAuthSessionsForSubjectInTransaction,
  revokeAuthSession,
  revokeAuthSessionForSubject,
  rotateAuthSession,
  validateAuthSession,
} from "../auth-sessions.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };

function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-current",
    token_family_id: "family-1",
    subject_id: "legacy-user-1",
    identity_id: "identity-1",
    role: "investor",
    business_id: null,
    expires_at: new Date(Date.now() + 60_000),
    revoked_at: null,
    revoked_reason: null,
    ...overrides,
  };
}

const app = {
  jwt: { sign: vi.fn((payload: unknown) => `access:${JSON.stringify(payload)}`) },
} as any;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.env.AUTH_IDENTITY_AUTHORITY = "mongo";
  mocks.requirePostgres.mockReturnValue({ query: vi.fn() });
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
  mocks.createKeyring.mockReturnValue({ activeKeyId: "primary", keys: new Map([["primary", "signing-key"]]) });
});

describe("PostgreSQL auth sessions", () => {
  it("creates a bridge session with token fingerprints and a security event", async () => {
    const client = clientWith(
      { rows: [{ id: "identity-1" }], rowCount: 1 },
      { rowCount: 1 },
      { rows: [{ identity_id: "identity-1" }], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    const created = await createAuthSession(app, { userId: "legacy-user-1", role: "investor", businessId: "business-1" }, { ip: "127.0.0.1", userAgent: "vitest" });

    expect(created).toMatchObject({ sessionId: expect.any(String), accessToken: expect.stringContaining("legacy-user-1") });
    expect(created.refreshToken).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(app.jwt.sign).toHaveBeenCalledWith(expect.objectContaining({ sid: created.sessionId, businessId: "business-1" }), expect.objectContaining({ key: "signing-key" }));
    expect(client.query.mock.calls[0]?.[0]).toContain("legacy_mongo_id");
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([created.sessionId, "legacy-user-1", "identity-1"]));
    expect(client.query.mock.calls[1]?.[1]?.[6]).not.toBe(created.refreshToken);
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "auth.session.created" }));
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ privacy: { kind: "audit_event", additionalSubjectIdentityIds: ["identity-1"] } }));
  });

  it("requires an active native identity before it creates a native session", async () => {
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres";
    const client = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    await expect(createAuthSession(app, { userId: "identity-1", role: "investor" }, {})).rejects.toThrow("PostgreSQL identity is not available");
    expect(client.query.mock.calls[0]?.[0]).toContain("WHERE id = $1");
    expect(mocks.appendAudit).not.toHaveBeenCalled();
  });

  it("rotates an active refresh token and binds its replacement to the active authority", async () => {
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres";
    const client = clientWith(
      { rows: [sessionRow()], rowCount: 1 },
      { rows: [{ id: "identity-1" }], rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [{ identity_id: "identity-1" }], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    const rotated = await rotateAuthSession(app, "old-refresh-token", { ip: "10.0.0.1" });

    expect(rotated.accessToken).toContain("identity-1");
    expect(rotated.sessionId).not.toBe("session-current");
    expect(client.query.mock.calls[0]?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[3]?.[1]?.[1]).toBe("session-current");
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "auth.session.rotated" }));

    mocks.env.AUTH_IDENTITY_AUTHORITY = "mongo";
    const bridgeClient = clientWith(
      { rows: [sessionRow({ identity_id: null })], rowCount: 1 },
      { rows: [{ id: "identity-1" }], rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
      { rows: [{ identity_id: "identity-1" }], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(bridgeClient));
    await expect(rotateAuthSession(app, "legacy-refresh-token", {})).resolves.toMatchObject({ accessToken: expect.stringContaining("legacy-user-1") });
    expect(bridgeClient.query.mock.calls[1]?.[0]).toContain("legacy_mongo_id");
  });

  it("commits token-family revocation before it rejects refresh-token reuse", async () => {
    const client = clientWith(
      { rows: [sessionRow({ revoked_at: new Date(), revoked_reason: "rotated" })], rowCount: 1 },
      { rowCount: 2 },
      { rows: [{ identity_id: null }], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    await expect(rotateAuthSession(app, "reused-refresh-token", {})).rejects.toThrow("reuse detected");
    expect(client.query.mock.calls[1]?.[0]).toContain("refresh_reuse_detected");
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ privacy: { kind: "technical_no_subject" } }));
  });

  it("rejects expired, revoked, and unmapped refresh sessions", async () => {
    for (const current of [
      sessionRow({ expires_at: new Date(Date.now() - 1) }),
      sessionRow({ revoked_at: new Date(), revoked_reason: "manual" }),
    ]) {
      const client = clientWith({ rows: [current], rowCount: 1 });
      mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
      await expect(rotateAuthSession(app, "token", {})).rejects.toBeInstanceOf(AuthSessionError);
    }
    mocks.env.AUTH_IDENTITY_AUTHORITY = "postgres";
    const unmapped = clientWith({ rows: [sessionRow({ identity_id: null })], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unmapped));
    await expect(rotateAuthSession(app, "token", {})).rejects.toThrow("not mapped");
  });

  it("lists active sessions and validates the current session", async () => {
    const first = new Date("2026-01-02T00:00:00.000Z");
    const second = new Date("2026-01-03T00:00:00.000Z");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ id: "session-1", created_at: first, last_seen_at: second, expires_at: second }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: "session-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });

    await expect(listAuthSessions("legacy-user-1", "session-1")).resolves.toEqual([{ id: "session-1", createdAt: first, lastSeenAt: second, expiresAt: second, current: true }]);
    await expect(validateAuthSession("session-1", "legacy-user-1")).resolves.toBeUndefined();
    expect(query.mock.calls[2]?.[0]).toContain("last_seen_at");
  });

  it("rejects a session that is no longer active", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(validateAuthSession("session-1", "legacy-user-1")).rejects.toThrow("no longer active");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("records revocations only when an active session changed", async () => {
    const changed = clientWith({ rows: [{ id: "session-1" }], rowCount: 1 }, { rows: [{ identity_id: "identity-1" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(changed));
    await revokeAuthSession("session-1", "legacy-user-1", "sign-out");
    expect(mocks.appendAudit).toHaveBeenCalledWith(changed, expect.objectContaining({ action: "auth.session.revoked" }));

    const unchanged = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unchanged));
    await expect(revokeAuthSessionForSubject("session-1", "legacy-user-1", "sign-out")).resolves.toBe(false);
    expect(mocks.appendAudit).toHaveBeenCalledTimes(1);

    const changedForSubject = clientWith(
      { rows: [], rowCount: 1 },
      { rows: [{ identity_id: "identity-1" }], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(changedForSubject));
    await expect(revokeAuthSessionForSubject("session-2", "legacy-user-1", "security-reset")).resolves.toBe(true);
    expect(mocks.appendAudit).toHaveBeenLastCalledWith(changedForSubject, expect.objectContaining({ entityId: "session-2" }));
  });

  it("revokes every subject or identity session and emits a recovery audit event", async () => {
    const subjectClient = clientWith(
      { rows: [{ id: "session-1" }, { id: "session-2" }], rowCount: 2 },
      { rows: [{ identity_id: null }], rowCount: 1 },
      { rows: [{ identity_id: null }], rowCount: 1 },
    );
    await expect(revokeAllAuthSessionsForSubjectInTransaction(subjectClient as any, "legacy-user-1", "security-reset")).resolves.toBe(2);
    expect(mocks.appendAudit).toHaveBeenCalledTimes(2);

    const identityClient = clientWith(
      { rows: [{ id: "session-3", subject_id: "legacy-user-1" }], rowCount: 1 },
      { rows: [{ identity_id: "identity-1" }], rowCount: 1 },
    );
    await expect(revokeAllAuthSessionsForIdentityInTransaction(identityClient as any, "identity-1", "identity-recovery")).resolves.toBe(1);
    expect(mocks.appendAudit).toHaveBeenLastCalledWith(identityClient, expect.objectContaining({ actorType: "operator", payload: expect.objectContaining({ recoveredIdentityId: "identity-1" }) }));

    const wrapper = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(wrapper));
    await expect(revokeAllAuthSessionsForSubject("legacy-user-1", "security-reset")).resolves.toBe(0);
  });
});
