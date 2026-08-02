import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requirePostgres: vi.fn(), revokeSessions: vi.fn(), appendAudit: vi.fn(), appendOutbox: vi.fn(), idempotent: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.requirePostgres }));
vi.mock("../auth-sessions.js", () => ({ revokeAllAuthSessionsForSubjectInTransaction: mocks.revokeSessions }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));

import {
  AdministratorCapabilityError,
  createAdministratorCapabilityChangeRequest,
  decideAdministratorCapabilityChangeRequest,
  listAdministratorCapabilityRegister,
  requireAdministratorCapability,
} from "../postgres-administrator-capabilities.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
function requestRow(overrides: Record<string, unknown> = {}) {
  return { id: "request-1", target_identity_id: "target-1", target_email: "target@example.test", target_legal_name: "Target", capability_key: "audit_export", capability_label: "Audit export", change_type: "grant", prior_enabled: false, reason: "Grant verified export access", status: "pending", requested_by_identity_id: "maker-1", requester_email: "maker@example.test", requester_legal_name: "Maker", reviewed_by_identity_id: null, reviewer_email: null, reviewer_legal_name: null, decision_reason: null, requested_at: new Date("2026-07-01"), reviewed_at: null, applied_at: null, ...overrides };
}
function active() { return { rows: [{ one: 1 }], rowCount: 1 }; }

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requirePostgres.mockReturnValue({ query: vi.fn() });
  mocks.revokeSessions.mockResolvedValue(0);
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
  mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: unknown }> }) => ({ body: (await input.execute({ query: vi.fn() })).body, replayed: false }));
});

describe("administrator capabilities", () => {
  it("requires both an active administrator role and an active capability", async () => {
    const allowed = clientWith(active(), active());
    await expect(requireAdministratorCapability(allowed as any, "admin-1", "audit_export")).resolves.toBeUndefined();
    const noRole = clientWith({ rows: [], rowCount: 0 });
    await expect(requireAdministratorCapability(noRole as any, "admin-1", "audit_export")).rejects.toMatchObject({ code: "forbidden" });
    const noCapability = clientWith(active(), { rows: [], rowCount: 0 });
    await expect(requireAdministratorCapability(noCapability as any, "admin-1", "audit_export")).rejects.toThrow("capability audit_export");
  });

  it("lists capability definitions, active assignments, and mapped change requests", async () => {
    const definition = { rows: [{ capability_key: "audit_export", label: "Audit export", description: "Export audit records", status: "active" }], rowCount: 1 };
    const assignment = { rows: [{ identity_id: "admin-1", email: "admin@example.test", legal_name: "Admin", capability_key: "audit_export", granted_at: new Date("2026-07-01") }], rowCount: 1 };
    const requests = { rows: [requestRow()], rowCount: 1 };
    const query = vi.fn().mockResolvedValueOnce(definition).mockResolvedValueOnce(assignment).mockResolvedValueOnce(requests);
    mocks.requirePostgres.mockReturnValue({ query });
    await expect(listAdministratorCapabilityRegister({ status: "pending", query: " target " })).resolves.toEqual({
      capabilities: [{ key: "audit_export", label: "Audit export", description: "Export audit records", status: "active" }],
      assignments: [{ identityId: "admin-1", email: "admin@example.test", legalName: "Admin", capabilityKey: "audit_export", grantedAt: "2026-07-01T00:00:00.000Z" }],
      requests: [expect.objectContaining({ id: "request-1", targetIdentity: expect.objectContaining({ id: "target-1" }) })],
    });
    expect(query.mock.calls[1]?.[1]).toEqual(["target"]);
  });

  it("creates an independent pending grant with audit and outbox evidence", async () => {
    const client = clientWith(active(), active(), { rows: [{ status: "active" }], rowCount: 1 }, { rows: [], rowCount: 0 }, {}, { rows: [requestRow()], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: any }> }) => ({ body: (await input.execute(client)).body, replayed: false }));
    await expect(createAdministratorCapabilityChangeRequest({ actorIdentityId: "maker-1", targetIdentityId: "target-1", capabilityKey: "audit_export", changeType: "grant", reason: "Grant verified audit export access", commandKey: "command-1" })).resolves.toMatchObject({ replayed: false, request: { id: "request-1", changeType: "grant" } });
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "administrator.capability_change.requested" }));
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "administrator.capability_change.requested" }));
  });

  it("rejects self-proposals, duplicate pending changes, and inactive definitions", async () => {
    const self = clientWith(active());
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(self));
    await expect(createAdministratorCapabilityChangeRequest({ actorIdentityId: "admin-1", targetIdentityId: "admin-1", capabilityKey: "audit_export", changeType: "grant", reason: "reason", commandKey: "command-1" })).rejects.toMatchObject({ code: "forbidden" });
    const inactive = clientWith(active(), active(), { rows: [{ status: "retired" }], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(inactive));
    await expect(createAdministratorCapabilityChangeRequest({ actorIdentityId: "maker-1", targetIdentityId: "target-1", capabilityKey: "audit_export", changeType: "grant", reason: "reason", commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_state" });
    const conflictClient = clientWith(active(), active(), { rows: [{ status: "active" }], rowCount: 1 }, { rows: [], rowCount: 0 });
    conflictClient.query.mockRejectedValueOnce(new Error("unused"));
    // Restore the deterministic sequence and simulate the unique pending-request constraint on insertion.
    conflictClient.query.mockReset()
      .mockResolvedValueOnce(active()).mockResolvedValueOnce(active()).mockResolvedValueOnce({ rows: [{ status: "active" }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce({ code: "23505", constraint: "administrator_capability_change_pending_unique_idx" });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(conflictClient));
    await expect(createAdministratorCapabilityChangeRequest({ actorIdentityId: "maker-1", targetIdentityId: "target-1", capabilityKey: "audit_export", changeType: "grant", reason: "reason", commandKey: "command-1" })).rejects.toMatchObject({ code: "conflict" });

    const unchangedState = clientWith(active(), active(), { rows: [{ status: "active" }], rowCount: 1 }, active());
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(unchangedState));
    await expect(createAdministratorCapabilityChangeRequest({ actorIdentityId: "maker-1", targetIdentityId: "target-1", capabilityKey: "audit_export", changeType: "grant", reason: "reason", commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_state" });

    const unexpected = clientWith(active(), active(), { rows: [{ status: "active" }], rowCount: 1 }, { rows: [], rowCount: 0 });
    unexpected.query.mockRejectedValueOnce(new Error("database unavailable"));
    unexpected.query.mockReset()
      .mockResolvedValueOnce(active()).mockResolvedValueOnce(active()).mockResolvedValueOnce({ rows: [{ status: "active" }], rowCount: 1 }).mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockRejectedValueOnce(new Error("database unavailable"));
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(unexpected));
    await expect(createAdministratorCapabilityChangeRequest({ actorIdentityId: "maker-1", targetIdentityId: "target-1", capabilityKey: "audit_export", changeType: "grant", reason: "reason", commandKey: "command-1" })).rejects.toThrow("database unavailable");
  });

  it("rejects or applies decisions with two-person separation and session invalidation", async () => {
    const rejectedRow = requestRow({ status: "rejected", reviewed_by_identity_id: "checker-1", reviewer_email: "checker@example.test", reviewer_legal_name: "Checker", decision_reason: "Rejected", reviewed_at: new Date(), applied_at: null });
    const reject = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "target-1", capability_key: "audit_export", change_type: "grant", prior_enabled: false, status: "pending", requested_by_identity_id: "maker-1" }], rowCount: 1 }, active(), active(), {}, { rows: [rejectedRow], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: any }> }) => ({ body: (await input.execute(reject)).body, replayed: false }));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "reject", reason: "Independent review rejected this change", commandKey: "command-1" })).resolves.toMatchObject({ request: { status: "rejected" } });
    expect(mocks.revokeSessions).not.toHaveBeenCalled();

    const appliedRow = requestRow({ status: "applied", reviewed_by_identity_id: "checker-1", reviewer_email: "checker@example.test", reviewer_legal_name: "Checker", decision_reason: "Approved", reviewed_at: new Date(), applied_at: new Date() });
    const approve = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "target-1", capability_key: "audit_export", change_type: "grant", prior_enabled: false, status: "pending", requested_by_identity_id: "maker-1" }], rowCount: 1 }, active(), active(), { rows: [], rowCount: 0 }, {}, {}, { rows: [appliedRow], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: any }> }) => ({ body: (await input.execute(approve)).body, replayed: false }));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "approve", reason: "Independent review approved this change", commandKey: "command-2" })).resolves.toMatchObject({ request: { status: "applied" } });
    expect(mocks.revokeSessions).toHaveBeenCalledWith(approve, "target-1", "administrator_capability_change");
  });

  it("rejects self-review, changed capability state, and unsafe revocation", async () => {
    const selfReview = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "target-1", capability_key: "audit_export", change_type: "grant", prior_enabled: false, status: "pending", requested_by_identity_id: "checker-1" }], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(selfReview));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "approve", reason: "reason", commandKey: "self" })).rejects.toMatchObject({ code: "forbidden" });

    const ownTarget = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "checker-1", capability_key: "audit_export", change_type: "grant", prior_enabled: false, status: "pending", requested_by_identity_id: "maker-1" }], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(ownTarget));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "approve", reason: "reason", commandKey: "target" })).rejects.toMatchObject({ code: "forbidden" });

    const changed = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "target-1", capability_key: "audit_export", change_type: "grant", prior_enabled: false, status: "pending", requested_by_identity_id: "maker-1" }], rowCount: 1 }, active(), active(), active());
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(changed));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "approve", reason: "reason", commandKey: "changed" })).rejects.toMatchObject({ code: "conflict" });

    const unsafeRevoke = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "target-1", capability_key: "audit_export", change_type: "revoke", prior_enabled: true, status: "pending", requested_by_identity_id: "maker-1" }], rowCount: 1 }, active(), active(), active(), { rows: [{ count: "1" }], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(unsafeRevoke));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "approve", reason: "reason", commandKey: "unsafe" })).rejects.toMatchObject({ code: "last_capable_administrator" });

    const revokedRow = requestRow({ change_type: "revoke", prior_enabled: true, status: "applied", reviewed_by_identity_id: "checker-1", reviewer_email: "checker@example.test", reviewer_legal_name: "Checker", decision_reason: "Approved", reviewed_at: new Date(), applied_at: new Date() });
    const safeRevoke = clientWith({}, active(), { rows: [{ id: "request-1", target_identity_id: "target-1", capability_key: "audit_export", change_type: "revoke", prior_enabled: true, status: "pending", requested_by_identity_id: "maker-1" }], rowCount: 1 }, active(), active(), active(), { rows: [{ count: "2" }], rowCount: 1 }, {}, {}, { rows: [revokedRow], rowCount: 1 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ body: any }> }) => ({ body: (await input.execute(safeRevoke)).body, replayed: false }));
    await expect(decideAdministratorCapabilityChangeRequest({ actorIdentityId: "checker-1", requestId: "request-1", decision: "approve", reason: "reason", commandKey: "safe" })).resolves.toMatchObject({ request: { status: "applied", changeType: "revoke" } });
    expect(safeRevoke.query.mock.calls[7]?.[0]).toContain("SET revoked_at");
  });
});
