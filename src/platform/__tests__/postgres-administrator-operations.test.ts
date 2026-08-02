import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePostgres: vi.fn(),
  withTransaction: vi.fn(),
  appendAudit: vi.fn(),
  appendOutbox: vi.fn(),
  enqueueDelivery: vi.fn(),
  revokeSessions: vi.fn(),
}));

vi.mock("../../db/postgres.js", () => ({
  requirePostgres: mocks.requirePostgres,
  withPostgresTransaction: mocks.withTransaction,
}));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));
vi.mock("../postgres-auth-email-deliveries.js", () => ({ enqueueAdministratorActivationDelivery: mocks.enqueueDelivery }));
vi.mock("../auth-sessions.js", () => ({ revokeAllAuthSessionsForIdentityInTransaction: mocks.revokeSessions }));

import {
  AdministratorOperationsError,
  administratorOperationsKeyFingerprint,
  approveAdministratorRecoveryRequest,
  bootstrapAdministratorCohort,
  createAdministratorRecoveryRequest,
  readAdministratorOperationsStatus,
} from "../postgres-administrator-operations.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };

function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}

const identityId = "11111111-1111-4111-8111-111111111111";
const requestId = "22222222-2222-4222-8222-222222222222";
const requesterKey = "a".repeat(64);
const approverKey = "b".repeat(64);

function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    id: requestId,
    target_identity_id: identityId,
    incident_reference: "INC-123456",
    status: "pending",
    requested_by: "operator-maker",
    requester_key_fingerprint: requesterKey,
    requested_at: new Date("2026-07-01T00:00:00.000Z"),
    expires_at: new Date("2026-07-01T00:30:00.000Z"),
    reviewed_at: null,
    applied_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.requirePostgres.mockReturnValue({ query: vi.fn() });
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
  mocks.enqueueDelivery.mockResolvedValue("delivery-1");
  mocks.revokeSessions.mockResolvedValue(2);
});

describe("administrator bootstrap", () => {
  it("rejects invalid cohorts before it opens a transaction", async () => {
    await expect(bootstrapAdministratorCohort({ members: [], initiatedBy: "ops" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(bootstrapAdministratorCohort({
      initiatedBy: "ops",
      members: [
        { email: "admin@example.test", legalName: "One" },
        { email: "ADMIN@example.test", legalName: "Two" },
        { email: "three@example.test", legalName: "Three" },
      ],
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(bootstrapAdministratorCohort({
      initiatedBy: "  ",
      members: [
        { email: "one@example.test", legalName: "One" },
        { email: "two@example.test", legalName: "Two" },
        { email: "three@example.test", legalName: "Three" },
      ],
    })).rejects.toThrow("Initiating operator");
    expect(mocks.withTransaction).not.toHaveBeenCalled();
  });

  it("seals the first cohort, grants active capabilities, and records immutable evidence", async () => {
    const members = [
      { email: "zeta@example.test", legalName: "Zeta" },
      { email: "alpha@example.test", legalName: "Alpha" },
      { email: "middle@example.test", legalName: "Middle" },
    ];
    const results: QueryResult[] = [
      {}, {}, {}, {}, { rows: [{ sealed_at: new Date("2026-07-01T00:00:00.000Z") }], rowCount: 1 },
    ];
    for (let index = 0; index < 3; index += 1) results.push({}, {}, { rows: [{ capability_key: "audit_export" }, { capability_key: "identity_recovery" }], rowCount: 2 }, {}, {});
    const client = clientWith(...results);
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    const result = await bootstrapAdministratorCohort({ members, initiatedBy: "bootstrap-operator" });

    expect(result).toMatchObject({ cohortSize: 3, identityIds: expect.any(Array), sealedAt: "2026-07-01T00:00:00.000Z" });
    expect(result.identityIds).toHaveLength(3);
    expect(client.query.mock.calls[3]?.[1]).toEqual([["alpha@example.test", "middle@example.test", "zeta@example.test"]]);
    expect(mocks.enqueueDelivery).toHaveBeenCalledTimes(3);
    expect(mocks.appendAudit).toHaveBeenCalledTimes(4);
    expect(mocks.appendOutbox).toHaveBeenCalledTimes(4);
    expect(client.query.mock.calls.filter(([sql]) => sql.includes("administrator_capability_assignments"))).toHaveLength(6);
  });

  it("refuses a sealed, historical, or conflicting bootstrap state", async () => {
    const input = {
      initiatedBy: "bootstrap-operator",
      members: [
        { email: "one@example.test", legalName: "One" },
        { email: "two@example.test", legalName: "Two" },
        { email: "three@example.test", legalName: "Three" },
      ],
    };
    for (const results of [
      [{}, { rows: [], rowCount: 1 }],
      [{}, {}, { rows: [], rowCount: 1 }],
      [{}, {}, {}, { rows: [{ email: "one@example.test" }], rowCount: 1 }],
    ]) {
      const client = clientWith(...results);
      mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
      await expect(bootstrapAdministratorCohort(input)).rejects.toBeInstanceOf(AdministratorOperationsError);
    }
  });
});

describe("administrator recovery", () => {
  it("validates recovery input and fingerprints operations keys", async () => {
    await expect(createAdministratorRecoveryRequest({
      targetEmail: "bad-email", incidentReference: "short", reason: "too short", requestedBy: "op", requesterKeyFingerprint: "bad",
    })).rejects.toMatchObject({ code: "invalid_input" });
    expect(() => administratorOperationsKeyFingerprint("short")).toThrow("at least 32 bytes");
    expect(administratorOperationsKeyFingerprint("x".repeat(32))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("expires stale requests, creates a distinct recovery request, and records evidence", async () => {
    const row = recoveryRow();
    const client = clientWith(
      {},
      { rows: [{ id: "stale-request", target_identity_id: identityId }], rowCount: 1 },
      { rows: [{ id: identityId }], rowCount: 1 },
      {},
      { rows: [row], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    const created = await createAdministratorRecoveryRequest({
      targetEmail: " ADMIN@example.test ",
      incidentReference: " INC-123456 ",
      reason: "Recover this administrator after a verified credential loss.",
      requestedBy: "operator-maker",
      requesterKeyFingerprint: requesterKey.toUpperCase(),
    });

    expect(created).toMatchObject({ id: requestId, targetIdentityId: identityId, status: "pending" });
    expect(mocks.appendAudit).toHaveBeenCalledTimes(2);
    expect(mocks.appendOutbox).toHaveBeenCalledTimes(2);
    expect(client.query.mock.calls[4]?.[1]).toEqual(expect.arrayContaining([identityId, "INC-123456", requesterKey]));
  });

  it("rejects a duplicate request or a missing historical administrator", async () => {
    const baseInput = {
      targetEmail: "admin@example.test", incidentReference: "INC-123456", reason: "Recover this administrator after a verified credential loss.", requestedBy: "operator-maker", requesterKeyFingerprint: requesterKey,
    };
    const missing = clientWith({}, {}, { rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(missing));
    await expect(createAdministratorRecoveryRequest(baseInput)).rejects.toMatchObject({ code: "not_found" });

    const duplicate = clientWith({}, {}, { rows: [{ id: identityId }], rowCount: 1 }, { rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(duplicate));
    await expect(createAdministratorRecoveryRequest(baseInput)).rejects.toMatchObject({ code: "conflict" });
  });

  it("applies a valid independently approved recovery and invalidates old access", async () => {
    const pending = recoveryRow({ expires_at: new Date(Date.now() + 60_000) });
    const applied = recoveryRow({ status: "applied", expires_at: pending.expires_at, reviewed_at: new Date(), applied_at: new Date() });
    const client = clientWith(
      {}, { rows: [pending], rowCount: 1 }, { rows: [], rowCount: 1 },
      { rows: [{ id: "cancelled-access" }], rowCount: 1 }, {}, {}, {}, {}, {}, {}, {},
      { rows: [applied], rowCount: 1 },
    );
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));

    const result = await approveAdministratorRecoveryRequest({ requestId, approvedBy: "operator-checker", approverKeyFingerprint: approverKey });

    expect(result).toMatchObject({ activationDeliveryId: "delivery-1", revokedSessionCount: 2, request: { status: "applied", targetIdentityId: identityId } });
    expect(mocks.revokeSessions).toHaveBeenCalledWith(client, identityId, "administrator_break_glass_recovery");
    expect(mocks.enqueueDelivery).toHaveBeenCalledWith(client, identityId);
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "identity.administrator_recovery.applied" }));
  });

  it("rejects invalid approval separation and records expiration before it rejects", async () => {
    const invalid = clientWith({}, { rows: [recoveryRow({ expires_at: new Date(Date.now() + 60_000) })], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(invalid));
    await expect(approveAdministratorRecoveryRequest({ requestId, approvedBy: "operator-maker", approverKeyFingerprint: approverKey })).rejects.toMatchObject({ code: "forbidden" });

    const expired = clientWith({}, { rows: [recoveryRow({ expires_at: new Date(Date.now() - 1) })], rowCount: 1 }, {}, { rows: [], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(expired));
    await expect(approveAdministratorRecoveryRequest({ requestId, approvedBy: "operator-checker", approverKeyFingerprint: approverKey })).rejects.toMatchObject({ code: "expired" });
    expect(mocks.appendAudit).toHaveBeenCalledWith(expired, expect.objectContaining({ action: "identity.administrator_recovery.expired" }));
  });
});

describe("administrator operations status", () => {
  it("maps the bootstrap and recovery aggregate state without returning private recovery data", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ cohort_id: "cohort-1", cohort_size: 3, sealed_at: new Date("2026-07-01T00:00:00.000Z") }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ pending_count: 2, overdue_pending_count: 1, applied_count: 4, expired_count: 3, earliest_pending_expiry: new Date("2026-07-02T00:00:00.000Z") }], rowCount: 1 });
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(readAdministratorOperationsStatus()).resolves.toEqual({
      bootstrap: { cohortId: "cohort-1", cohortSize: 3, sealedAt: "2026-07-01T00:00:00.000Z" },
      recovery: { pendingCount: 2, overduePendingCount: 1, appliedCount: 4, expiredCount: 3, earliestPendingExpiry: "2026-07-02T00:00:00.000Z" },
    });
  });
});
