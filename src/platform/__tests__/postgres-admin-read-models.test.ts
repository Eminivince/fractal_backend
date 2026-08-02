import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query }) }));

import {
  decodeAdminAccessCursor,
  listAdminAccessIdentities,
  listAdminAuditEvents,
} from "../postgres-admin-read-models.js";

beforeEach(() => query.mockReset());

describe("administrator read models", () => {
  it("decodes only complete, valid access-register cursors", () => {
    const cursor = Buffer.from(JSON.stringify({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-07-29T10:00:00.000Z" }), "utf8").toString("base64url");
    expect(decodeAdminAccessCursor(cursor)).toEqual({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-07-29T10:00:00.000Z" });
    expect(() => decodeAdminAccessCursor("not-a-cursor")).toThrow("Invalid access-register cursor");
    expect(() => decodeAdminAccessCursor(Buffer.from(JSON.stringify({ id: "only-id" })).toString("base64url"))).toThrow("Invalid access-register cursor");
  });

  it("maps access identities, trims search, and produces an opaque next cursor", async () => {
    query.mockResolvedValueOnce({ rows: [
      { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", email: "one@example.com", legal_name: "One Person", status: "active", global_role: "admin", email_verified_at: new Date("2026-07-01T00:00:00.000Z"), created_at: new Date("2026-07-29T10:00:00.000Z"), updated_at: new Date("2026-07-29T11:00:00.000Z"), cursor_created_at: "2026-07-29T10:00:00.000000Z" },
      { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", email: "two@example.com", legal_name: "Two Person", status: "disabled", global_role: null, email_verified_at: null, created_at: new Date("2026-07-28T10:00:00.000Z"), updated_at: new Date("2026-07-28T11:00:00.000Z"), cursor_created_at: "2026-07-28T10:00:00.000000Z" },
    ] });
    const page = await listAdminAccessIdentities({ query: "  one ", limit: 1 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("identity.email ILIKE"), ["one", null, null, 2]);
    expect(page.identities).toEqual([expect.objectContaining({ legalName: "One Person", emailVerifiedAt: "2026-07-01T00:00:00.000Z", globalRole: "admin" })]);
    expect(decodeAdminAccessCursor(page.nextCursor!)).toEqual({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", createdAt: "2026-07-29T10:00:00.000000Z" });
  });

  it("maps audit events and sends every controlled filter to the query", async () => {
    query.mockResolvedValueOnce({ rows: [
      { sequence: "42", id: "event-1", scope_key: "organization:org-1", actor_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", actor_name: "Admin One", actor_email: "admin@example.com", actor_type: "user", action: "offering.approved", entity_type: "offering", entity_id: "offering-1", reason: "Independent approval", canonical_hash: "a".repeat(64), occurred_at: new Date("2026-07-29T10:00:00.000Z") },
      { sequence: "41", id: "event-2", scope_key: null, actor_id: null, actor_name: null, actor_email: null, actor_type: "worker", action: "worker.completed", entity_type: "job", entity_id: "job-1", reason: null, canonical_hash: "b".repeat(64), occurred_at: new Date("2026-07-28T10:00:00.000Z") },
    ] });
    const from = new Date("2026-07-01T00:00:00.000Z");
    const to = new Date("2026-07-30T00:00:00.000Z");
    const page = await listAdminAuditEvents({ query: "  offering ", action: "offering.approved", scopeKey: "organization:org-1", actorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", from, to, beforeSequence: 100, limit: 1 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("event.sequence < $7"), ["offering", "offering.approved", "organization:org-1", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", from, to, 100, 2]);
    expect(page).toEqual({ events: [expect.objectContaining({ sequence: 42, actorName: "Admin One", occurredAt: "2026-07-29T10:00:00.000Z" })], nextCursor: "42" });
  });
});
