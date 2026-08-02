import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePostgres: vi.fn(), withTransaction: vi.fn(), revokeSessions: vi.fn(), enqueueVerification: vi.fn(), legalAcceptances: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.requirePostgres, withPostgresTransaction: mocks.withTransaction }));
vi.mock("../auth-sessions.js", () => ({ revokeAllAuthSessionsForSubjectInTransaction: mocks.revokeSessions }));
vi.mock("../postgres-auth-email-deliveries.js", () => ({ enqueueInitialEmailVerificationDelivery: mocks.enqueueVerification }));
vi.mock("../postgres-platform-content.js", () => ({ recordLegalAcceptancesInTransaction: mocks.legalAcceptances }));

import {
  PostgresAuthIdentityConflictError,
  PostgresIdentityProjectionError,
  PostgresIdentityUnavailableError,
  consumePostgresEmailVerificationToken,
  consumePostgresPasswordResetToken,
  createPostgresAuthIdentity,
  getPostgresAuthIdentityByEmail,
  getPostgresAuthIdentityById,
  projectLegacyIdentity,
  recordPostgresEmailVerificationToken,
  recordPostgresPasswordResetToken,
  requirePostgresIdentityForSubject,
} from "../postgres-identities.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
function row(overrides: Record<string, unknown> = {}) {
  return { id: "identity-1", email: "person@example.test", legal_name: "Person One", role: "investor", status: "active", password_hash: "hash", email_verified_at: null, credential_invalidated_at: null, created_at: new Date("2026-07-01"), updated_at: new Date("2026-07-02"), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.requirePostgres.mockReturnValue({ query: vi.fn() });
  mocks.revokeSessions.mockResolvedValue(0);
  mocks.enqueueVerification.mockResolvedValue("delivery-1");
  mocks.legalAcceptances.mockResolvedValue(undefined);
});

describe("PostgreSQL auth identity reads", () => {
  it("normalizes a valid active global role and rejects a missing or invalid role", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row()], rowCount: 1 }).mockResolvedValueOnce({ rows: [row({ role: null })], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(getPostgresAuthIdentityById("identity-1")).resolves.toMatchObject({ legalName: "Person One", role: "investor", createdAt: new Date("2026-07-01") });
    await expect(getPostgresAuthIdentityByEmail(" PERSON@EXAMPLE.TEST ")).resolves.toBeNull();
    expect(query.mock.calls[1]?.[1]).toEqual(["person@example.test"]);
    await expect(getPostgresAuthIdentityById("missing")).resolves.toBeNull();
  });
});

describe("native identity registration", () => {
  it("creates one role-bound identity, legal acceptance, and verification delivery", async () => {
    const client = clientWith({ rows: [{ id: "identity-1" }], rowCount: 1 }, {}, { rows: [row()], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    const created = await createPostgresAuthIdentity({ email: " PERSON@EXAMPLE.TEST ", legalName: " Person One ", role: "investor", passwordHash: "hash", legalAcceptances: [{ documentId: "terms", versionId: "version-1" }] as any, acceptanceMetadata: { ip: "127.0.0.1" } });
    expect(created).toMatchObject({ id: "identity-1", email: "person@example.test" });
    expect(client.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["person@example.test", "Person One", "hash"]));
    expect(mocks.legalAcceptances).toHaveBeenCalledWith(client, expect.objectContaining({ context: "registration", ip: "127.0.0.1" }));
    expect(mocks.enqueueVerification).toHaveBeenCalledWith(client, client.query.mock.calls[0]?.[1]?.[0]);
  });

  it("rejects invalid registration, duplicate email, and missing assigned role", async () => {
    await expect(createPostgresAuthIdentity({ email: " ", legalName: "Person", role: "investor", passwordHash: "hash" })).rejects.toBeInstanceOf(PostgresIdentityProjectionError);
    const conflict = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(conflict));
    await expect(createPostgresAuthIdentity({ email: "person@example.test", legalName: "Person", role: "investor", passwordHash: "hash" })).rejects.toBeInstanceOf(PostgresAuthIdentityConflictError);
    const roleMissing = clientWith({ rows: [{ id: "identity-1" }], rowCount: 1 }, {}, { rows: [row({ role: null })], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(roleMissing));
    await expect(createPostgresAuthIdentity({ email: "person@example.test", legalName: "Person", role: "investor", passwordHash: "hash" })).rejects.toThrow("did not produce");
  });
});

describe("verification and reset credential state", () => {
  it("records and consumes email verification only when its row is valid", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "identity-1" }], rowCount: 1 }).mockResolvedValueOnce({ rows: [row()], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(recordPostgresEmailVerificationToken({ identityId: "identity-1", tokenHash: "token", expiresAt: new Date() })).resolves.toMatchObject({ id: "identity-1" });
    await expect(consumePostgresEmailVerificationToken({ email: "PERSON@EXAMPLE.TEST", tokenHash: "token" })).resolves.toBe(false);
    expect(query.mock.calls[2]?.[1]).toEqual(["person@example.test", "token"]);
  });

  it("records reset tokens and only consumes live tokens while revoking sessions", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "identity-1" }], rowCount: 1 }).mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(recordPostgresPasswordResetToken({ identityId: "identity-1", tokenHash: "token", expiresAt: new Date() })).resolves.toMatchObject({ id: "identity-1" });
    const reset = clientWith({ rows: [{ id: "identity-1" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(reset));
    await expect(consumePostgresPasswordResetToken({ tokenHash: "token", passwordHash: "new-hash" })).resolves.toBe("identity-1");
    expect(mocks.revokeSessions).toHaveBeenCalledWith(reset, "identity-1", "password_reset");
    const expired = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(expired));
    await expect(consumePostgresPasswordResetToken({ tokenHash: "token", passwordHash: "new-hash" })).resolves.toBeNull();
  });
});

describe("legacy identity projection", () => {
  it("projects a bridge identity, synchronizes its global role, and binds legal acceptance", async () => {
    const client = clientWith({ rows: [], rowCount: 0 }, { rows: [{ id: "identity-1" }], rowCount: 1 }, {}, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(projectLegacyIdentity({ legacyMongoId: "mongo-1", email: " PERSON@EXAMPLE.TEST ", legalName: " Person One ", role: "investor", emailVerified: true, legalAcceptances: [{ documentId: "terms", versionId: "version-1" }] as any })).resolves.toBe("identity-1");
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["mongo-1", "person@example.test", "Person One", "active"]));
    expect(mocks.legalAcceptances).toHaveBeenCalledWith(client, expect.objectContaining({ identityId: "identity-1" }));
  });

  it("rejects malformed or conflicting legacy identity data", async () => {
    await expect(projectLegacyIdentity({ legacyMongoId: "", email: "person@example.test", legalName: "Person", role: "investor" })).rejects.toBeInstanceOf(PostgresIdentityProjectionError);
    const conflict = clientWith({ rows: [{ id: "identity-2", legacy_mongo_id: "mongo-other" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(conflict));
    await expect(projectLegacyIdentity({ legacyMongoId: "mongo-1", email: "person@example.test", legalName: "Person", role: "investor" })).rejects.toThrow("different account");
    const missing = clientWith({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(missing));
    await expect(projectLegacyIdentity({ legacyMongoId: "mongo-1", email: "person@example.test", legalName: "Person", role: "investor" })).rejects.toThrow("did not return");
  });

  it("requires a live PostgreSQL mapping for a session subject", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ id: "identity-1" }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(requirePostgresIdentityForSubject("mongo-1")).resolves.toBe("identity-1");
    await expect(requirePostgresIdentityForSubject("missing")).rejects.toBeInstanceOf(PostgresIdentityUnavailableError);
  });
});
