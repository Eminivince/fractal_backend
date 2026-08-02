import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgres: { query: vi.fn() },
  idempotency: vi.fn(),
  audit: vi.fn(),
  outbox: vi.fn(),
  revokeSessions: vi.fn(),
}));

vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres }));
vi.mock("../postgres-idempotency.js", () => ({
  PostgresIdempotencyConflictError: class PostgresIdempotencyConflictError extends Error {},
  runPostgresIdempotentCommand: mocks.idempotency,
}));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../auth-sessions.js", () => ({ revokeAllAuthSessionsForSubjectInTransaction: mocks.revokeSessions }));

import {
  createIdentityAccessChangeRequest,
  decideIdentityAccessChangeRequest,
  decodeIdentityAccessRequestCursor,
  IdentityAccessGovernanceError,
  listIdentityAccessChangeRequests,
} from "../postgres-identity-access-governance.js";

const requestedAt = new Date("2026-07-29T10:00:00.000Z");
const requestRow = (overrides: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  target_identity_id: "target-1", target_email: "target@fractal.test", target_legal_name: "Target Person",
  change_type: "suspend", prior_role: "admin", proposed_role: null, prior_status: "active", reason: "Control review",
  status: "pending", requested_by_identity_id: "requester-1", requester_email: "requester@fractal.test", requester_legal_name: "Requester Person",
  reviewed_by_identity_id: null, reviewer_email: null, reviewer_legal_name: null, decision_reason: null,
  requested_at: requestedAt, reviewed_at: null, applied_at: null, cursor_requested_at: "2026-07-29T10:00:00.000000Z", ...overrides,
});

function queryClient(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  return { query };
}

function runCommand(client: { query: ReturnType<typeof vi.fn> }) {
  mocks.idempotency.mockImplementationOnce(async (input: { execute: (value: typeof client) => Promise<{ body: unknown; status: number }> }) => {
    const result = await input.execute(client);
    return { body: result.body, replayed: false };
  });
}

beforeEach(() => {
  mocks.postgres.query.mockReset();
  mocks.idempotency.mockReset();
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockReset().mockResolvedValue(undefined);
  mocks.revokeSessions.mockReset().mockResolvedValue(undefined);
});

describe("identity access governance", () => {
  it("rejects self-service access changes after it verifies administrator authority", async () => {
    const client = queryClient({ rows: [{ value: 1 }] });
    runCommand(client);
    await expect(createIdentityAccessChangeRequest({ actorIdentityId: "admin-1", targetIdentityId: "admin-1", changeType: "suspend", reason: "Review", commandKey: "command-1" })).rejects.toMatchObject({ code: "forbidden" });
    expect(client.query).toHaveBeenCalledOnce();
  });

  it("creates a governed access-change request and records its audit trail", async () => {
    const client = queryClient(
      { rows: [{ value: 1 }] },
      { rows: [{ id: "target-1", email: "target@fractal.test", legal_name: "Target Person", status: "active" }] },
      { rows: [{ role: "investor" }] },
      {},
      { rows: [requestRow({ prior_role: "investor", proposed_role: "professional" })] },
    );
    runCommand(client);
    await expect(createIdentityAccessChangeRequest({ actorIdentityId: "admin-1", targetIdentityId: "target-1", changeType: "change_role", proposedRole: "professional", reason: "Approved role change", commandKey: "command-1" })).resolves.toMatchObject({ replayed: false, request: { id: requestRow().id, proposedRole: "professional" } });
    expect(mocks.audit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "identity.access_change.requested", entityId: expect.any(String) }));
    expect(mocks.outbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "identity.access_change.requested" }));
  });

  it("rejects invalid changes before it inserts a request", async () => {
    const client = queryClient(
      { rows: [{ value: 1 }] },
      { rows: [{ id: "target-1", email: "target@fractal.test", legal_name: "Target Person", status: "disabled" }] },
      { rows: [{ role: "investor" }] },
    );
    runCommand(client);
    await expect(createIdentityAccessChangeRequest({ actorIdentityId: "admin-1", targetIdentityId: "target-1", changeType: "change_role", proposedRole: "professional", reason: "Review", commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_state" });
    expect(client.query).toHaveBeenCalledTimes(3);
  });

  it("blocks approval when a removal would leave fewer than two active administrators", async () => {
    const client = queryClient(
      {}, { rows: [{ value: 1 }] },
      { rows: [{ id: "request-1", target_identity_id: "target-1", change_type: "suspend", prior_role: "admin", proposed_role: null, prior_status: "active", status: "pending", requested_by_identity_id: "requester-1" }] },
      { rows: [{ value: 1 }] },
      { rows: [{ id: "target-1", email: "target@fractal.test", legal_name: "Target Person", status: "active" }] },
      { rows: [{ role: "admin" }] },
      { rows: [{ count: "2" }] },
    );
    runCommand(client);
    await expect(decideIdentityAccessChangeRequest({ actorIdentityId: "reviewer-1", requestId: "request-1", decision: "approve", reason: "Review", commandKey: "command-1" })).rejects.toMatchObject({ code: "last_administrator" });
  });

  it("applies a rejected request without changing the target identity", async () => {
    const client = queryClient(
      {}, { rows: [{ value: 1 }] },
      { rows: [{ id: "request-1", target_identity_id: "target-1", change_type: "suspend", prior_role: "admin", proposed_role: null, prior_status: "active", status: "pending", requested_by_identity_id: "requester-1" }] },
      { rows: [{ value: 1 }] }, {}, { rows: [requestRow({ status: "rejected", reviewed_by_identity_id: "reviewer-1", reviewer_email: "reviewer@fractal.test", reviewer_legal_name: "Reviewer Person", decision_reason: "Insufficient evidence", reviewed_at: requestedAt })] },
    );
    runCommand(client);
    await expect(decideIdentityAccessChangeRequest({ actorIdentityId: "reviewer-1", requestId: "request-1", decision: "reject", reason: "Insufficient evidence", commandKey: "command-1" })).resolves.toMatchObject({ request: { status: "rejected", reviewedBy: { id: "reviewer-1" } } });
    expect(mocks.revokeSessions).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "identity.access_change.rejected" }));
  });

  it("rejects invalid request cursors and returns a cursor for a full result page", async () => {
    expect(() => decodeIdentityAccessRequestCursor("not-a-cursor")).toThrow(IdentityAccessGovernanceError);
    const id = "11111111-1111-4111-8111-111111111111";
    const encoded = Buffer.from(JSON.stringify({ id, requestedAt: "2026-07-29T10:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeIdentityAccessRequestCursor(encoded)).toEqual({ id, requestedAt: "2026-07-29T10:00:00.000Z" });
    mocks.postgres.query.mockResolvedValueOnce({ rows: [requestRow(), requestRow({ id: "22222222-2222-4222-8222-222222222222" })] });
    const result = await listIdentityAccessChangeRequests({ limit: 1 });
    expect(result.requests).toHaveLength(1);
    expect(decodeIdentityAccessRequestCursor(result.nextCursor!)).toMatchObject({ id: requestRow().id });
  });
});
