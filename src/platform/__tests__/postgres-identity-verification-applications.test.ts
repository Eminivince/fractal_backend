import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePostgres: vi.fn(), withTransaction: vi.fn(), idempotent: vi.fn(), appendAudit: vi.fn(), appendOutbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.requirePostgres, withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));

import {
  IdentityVerificationApplicationError,
  claimIdentityVerificationApplications,
  getIdentityVerificationApplication,
  loadClaimedIdentityVerificationApplication,
  markIdentityVerificationApplicationForRetry,
  markIdentityVerificationApplicationReady,
  recordIdentityVerificationAccessTokenIssued,
  requestIdentityVerificationApplication,
} from "../postgres-identity-verification-applications.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
function row(overrides: Record<string, unknown> = {}) {
  return { id: "application-1", provider: "sumsub", external_user_id: "identity-1", applicant_id: null, inspection_id: null, status: "requested", attempts: 0, ready_at: null, terminal_at: null, created_at: new Date("2026-07-01"), updated_at: new Date("2026-07-01"), ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.requirePostgres.mockReturnValue({ query: vi.fn() });
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
  mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: unknown }> }) => ({ body: (await input.execute({ query: vi.fn() })).body, replayed: false }));
});

describe("identity verification applications", () => {
  it("validates request identifiers before it starts an idempotent command", async () => {
    await expect(requestIdentityVerificationApplication({ identityId: " ", commandKey: "key" })).rejects.toBeInstanceOf(IdentityVerificationApplicationError);
    await expect(requestIdentityVerificationApplication({ identityId: "identity-1", commandKey: " " })).rejects.toBeInstanceOf(IdentityVerificationApplicationError);
    expect(mocks.idempotent).not.toHaveBeenCalled();
  });

  it("creates a tracked Sumsub application and publishes subject-attributed evidence", async () => {
    const client = clientWith({ rows: [{ id: "identity-1" }], rowCount: 1 }, { rows: [row()], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: any }> }) => ({ body: (await input.execute(client)).body, replayed: false }));
    await expect(requestIdentityVerificationApplication({ identityId: " identity-1 ", commandKey: "command-1" })).resolves.toMatchObject({ replayed: false, application: { id: "application-1", provider: "sumsub", externalUserId: "identity-1" } });
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "identity.verification_application.requested" }));
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ privacy: { kind: "subjects", subjectIdentityIds: ["identity-1"] } }));
  });

  it("returns an existing application without duplicate request evidence and rejects absent identities", async () => {
    const existing = clientWith({ rows: [{ id: "identity-1" }], rowCount: 1 }, { rows: [], rowCount: 0 }, { rows: [row()], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: any }> }) => ({ body: (await input.execute(existing)).body, replayed: true }));
    await expect(requestIdentityVerificationApplication({ identityId: "identity-1", commandKey: "command-1" })).resolves.toMatchObject({ replayed: true, application: { id: "application-1" } });
    expect(mocks.appendAudit).not.toHaveBeenCalled();

    const absent = clientWith({ rows: [], rowCount: 0 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(absent));
    await expect(requestIdentityVerificationApplication({ identityId: "identity-1", commandKey: "command-2" })).rejects.toThrow("Active identity");
  });

  it("reads, claims, and loads only current active application work", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [row({ status: "ready", applicant_id: "applicant-1", ready_at: new Date("2026-07-02") })], rowCount: 1 }).mockResolvedValueOnce({ rows: [{ email: "person@example.test", external_user_id: "identity-1" }], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(getIdentityVerificationApplication("identity-1")).resolves.toMatchObject({ status: "ready", applicantId: "applicant-1", readyAt: "2026-07-02T00:00:00.000Z" });
    await expect(loadClaimedIdentityVerificationApplication({ applicationId: "application-1", workerId: "worker-a" })).resolves.toEqual({ email: "person@example.test", externalUserId: "identity-1" });
    await expect(claimIdentityVerificationApplications({ workerId: "worker-a", limit: 0, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    const claim = clientWith({ rows: [{ id: "application-1", identity_id: "identity-1", provider: "sumsub", external_user_id: "identity-1", attempts: 2 }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(claim));
    await expect(claimIdentityVerificationApplications({ workerId: "worker-a", limit: 1, claimTimeoutSeconds: 60 })).resolves.toEqual([{ id: "application-1", identityId: "identity-1", provider: "sumsub", externalUserId: "identity-1", attempts: 2 }]);
    mocks.requirePostgres.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) });
    await expect(loadClaimedIdentityVerificationApplication({ applicationId: "application-1", workerId: "worker-a" })).rejects.toThrow("no longer claimed");
  });

  it("records token issuance only for ready applications", async () => {
    const ready = clientWith({ rows: [{ one: 1 }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(ready));
    await expect(recordIdentityVerificationAccessTokenIssued({ applicationId: "application-1", identityId: "identity-1", expiresAt: new Date("2026-07-01") })).resolves.toBeUndefined();
    expect(mocks.appendAudit).toHaveBeenCalledWith(ready, expect.objectContaining({ action: "identity.verification_access_token.issued" }));
    const unready = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unready));
    await expect(recordIdentityVerificationAccessTokenIssued({ applicationId: "application-1", identityId: "identity-1", expiresAt: new Date() })).rejects.toThrow("not ready");
  });

  it("marks valid worker results ready and rejects missing provider IDs or lost claims", async () => {
    await expect(markIdentityVerificationApplicationReady({ applicationId: "application-1", workerId: "worker-a", applicantId: " ", inspectionId: "inspection-1" })).rejects.toThrow("applicant ID");
    const ready = clientWith({ rows: [{ identity_id: "identity-1", attempts: 2 }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(ready));
    await markIdentityVerificationApplicationReady({ applicationId: "application-1", workerId: "worker-a", applicantId: " applicant-1 ", inspectionId: " inspection-1 " });
    expect(mocks.appendOutbox).toHaveBeenCalledWith(ready, expect.objectContaining({ eventType: "IdentityVerificationApplicationReady" }));
    const lost = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(lost));
    await expect(markIdentityVerificationApplicationReady({ applicationId: "application-1", workerId: "worker-a", applicantId: "applicant-1", inspectionId: "inspection-1" })).rejects.toThrow("no longer claimed");
  });

  it("records retry and terminal worker errors without retaining an unbounded message", async () => {
    for (const terminal of [false, true]) {
      const client = clientWith({ rows: [{ identity_id: "identity-1", attempts: 3 }], rowCount: 1 });
      mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
      await markIdentityVerificationApplicationForRetry({ applicationId: "application-1", workerId: "worker-a", retryAt: new Date(), error: "x".repeat(2_000), terminal });
      expect(client.query.mock.calls[0]?.[1]?.[4]).toHaveLength(1_000);
      expect(mocks.appendAudit).toHaveBeenLastCalledWith(client, expect.objectContaining({ action: terminal ? "identity.verification_application.terminal" : "identity.verification_application.retry_scheduled" }));
    }
    const lost = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(lost));
    await expect(markIdentityVerificationApplicationForRetry({ applicationId: "application-1", workerId: "worker-a", retryAt: new Date(), error: null, terminal: false })).rejects.toThrow("no longer claimed");
  });
});
