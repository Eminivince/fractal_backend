import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() } }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres }));

import { appendPostgresAuditEvent } from "../postgres-audit.js";
import { PostgresAuditVerificationError, verifyAllPostgresAuditScopes, verifyPostgresAuditScope } from "../postgres-audit-verification.js";
import { stableJsonStringify } from "../../utils/idempotency.js";

const zero = "0".repeat(64);
const occurredAt = new Date("2026-07-29T10:00:00.000Z");
function digest(value: unknown) { return createHash("sha256").update(stableJsonStringify(value)).digest("hex"); }
function auditRow(overrides: Record<string, unknown> = {}) {
  const row = { sequence: "1", id: "event-1", scope_key: "organization:1", organization_id: "organization-1", actor_id: "actor-1", actor_type: "user", action: "action", entity_type: "entity", entity_id: "entity-1", reason: null, payload: { value: 1 }, parent_hash: zero, canonical_hash: "", occurred_at: occurredAt, ...overrides };
  return { ...row, canonical_hash: digest({ id: row.id, scopeKey: row.scope_key, organizationId: row.organization_id, actorId: row.actor_id, actorType: row.actor_type, action: row.action, entityType: row.entity_type, entityId: row.entity_id, reason: row.reason, payload: row.payload, parentHash: row.parent_hash, occurredAt: row.occurred_at.toISOString() }) };
}

beforeEach(() => mocks.postgres.query.mockReset());

describe("PostgreSQL audit integrity", () => {
  it("appends an event from a locked chain head and updates the head", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ latest_hash: zero }] }).mockResolvedValueOnce({ rows: [{ sequence: "1" }] }).mockResolvedValueOnce({}) };
    const result = await appendPostgresAuditEvent(client as never, { scopeKey: "organization:1", organizationId: "organization-1", actorId: "actor-1", actorType: "user", action: "action", entityType: "entity", entityId: "entity-1", payload: { value: 1 }, occurredAt });
    expect(result).toMatchObject({ sequence: 1, parentHash: null, canonicalHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(client.query).toHaveBeenCalledTimes(4);
    expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining("UPDATE fractal.audit_chain_heads"), [1, result.canonicalHash, "organization:1"]);
  });

  it("fails closed when the chain head or inserted sequence is missing", async () => {
    const missingHead = { query: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [] }) };
    await expect(appendPostgresAuditEvent(missingHead as never, { scopeKey: "scope", actorType: "user", action: "action", entityType: "entity", entityId: "entity", payload: {} })).rejects.toThrow("Unable to lock");
    const missingSequence = { query: vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({ rows: [{ latest_hash: zero }] }).mockResolvedValueOnce({ rows: [] }) };
    await expect(appendPostgresAuditEvent(missingSequence as never, { scopeKey: "scope", actorType: "user", action: "action", entityType: "entity", entityId: "entity", payload: {} })).rejects.toThrow("sequence was not returned");
  });

  it("verifies a canonical event chain and its stored head", async () => {
    const row = auditRow();
    mocks.postgres.query.mockResolvedValueOnce({ rows: [row] }).mockResolvedValueOnce({ rows: [{ latest_sequence: "1", latest_hash: row.canonical_hash }] });
    await expect(verifyPostgresAuditScope(" organization:1 ")).resolves.toEqual({ scopeKey: "organization:1", events: 1, latestSequence: 1, latestHash: row.canonical_hash });
  });

  it("reports invalid scope keys, broken chains, and orphaned heads", async () => {
    await expect(verifyPostgresAuditScope(" ")).rejects.toBeInstanceOf(PostgresAuditVerificationError);
    const badParent = auditRow({ parent_hash: "f".repeat(64) });
    mocks.postgres.query.mockResolvedValueOnce({ rows: [badParent] });
    await expect(verifyPostgresAuditScope("organization:1")).rejects.toThrow("parent hash mismatch");
    mocks.postgres.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ latest_sequence: "1", latest_hash: "a".repeat(64) }] });
    await expect(verifyPostgresAuditScope("organization:2")).rejects.toThrow("head exists without");
  });

  it("verifies every scoped chain and reports legacy unscoped records", async () => {
    const row = auditRow();
    mocks.postgres.query
      .mockResolvedValueOnce({ rows: [{ scope_key: "organization:1" }] })
      .mockResolvedValueOnce({ rows: [{ count: "3" }] })
      .mockResolvedValueOnce({ rows: [row] })
      .mockResolvedValueOnce({ rows: [{ latest_sequence: "1", latest_hash: row.canonical_hash }] });
    await expect(verifyAllPostgresAuditScopes()).resolves.toEqual({ scopes: [{ scopeKey: "organization:1", events: 1, latestSequence: 1, latestHash: row.canonical_hash }], unverifiableLegacyEvents: 3 });
  });
});
