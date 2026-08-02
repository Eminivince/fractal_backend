import { beforeEach, describe, expect, it, vi } from "vitest";

const withTransaction = vi.hoisted(() => vi.fn());
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: withTransaction }));

import {
  appendOutboxEvent,
  claimOutboxEvents,
  markOutboxEventForRetry,
  markOutboxEventPublished,
} from "../postgres-outbox.js";

const actor = "11111111-1111-4111-8111-111111111111";
const additional = "22222222-2222-4222-8222-222222222222";
const authoritative = "33333333-3333-4333-8333-333333333333";
const auditId = "44444444-4444-4444-8444-444444444444";
const base = { aggregateType: "payment", aggregateId: "payment-1", eventType: "payment.updated" };

function clientFor(input: { authoritative?: string[]; emptyAuthoritativeRow?: boolean; audit?: { actor_id: string | null; actor_type: string } | null; insertRowCount?: number } = {}) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>>(async (sql: string) => {
    if (sql.includes("resolve_outbox_privacy_subjects")) return { rows: input.emptyAuthoritativeRow ? [] : [{ subject_ids: input.authoritative ?? [] }], rowCount: input.emptyAuthoritativeRow ? 0 : 1 };
    if (sql.includes("FROM fractal.audit_events")) return { rows: input.audit ? [input.audit] : [], rowCount: input.audit ? 1 : 0 };
    return { rows: [], rowCount: input.insertRowCount ?? 1 };
  });
  return { query };
}

beforeEach(() => vi.clearAllMocks());

describe("Postgres outbox privacy attribution", () => {
  it("stores explicit subject attribution with canonical identity IDs", async () => {
    const client = clientFor();
    await expect(appendOutboxEvent(client as any, { ...base, payload: {}, privacy: { kind: "subjects", subjectIdentityIds: [additional] } })).resolves.toEqual(expect.any(String));
    const insert = client.query.mock.calls.find(([sql]) => String(sql).includes("INSERT INTO fractal.outbox_events"));
    expect(insert?.[1]).toEqual(expect.arrayContaining(["subject_attributed", [additional], "explicit_subjects"]));
  });

  it("combines explicit and authoritative subjects", async () => {
    const client = clientFor({ authoritative: [authoritative] });
    await appendOutboxEvent(client as any, { ...base, payload: {}, privacy: { kind: "subjects", subjectIdentityIds: [additional] } });
    const insert = client.query.mock.calls.at(-1);
    expect(insert?.[1]).toEqual(expect.arrayContaining([[additional, authoritative], "explicit_and_authoritative_subjects"]));
  });

  it("uses authoritative subjects for a technical event when present, or technical attribution when absent", async () => {
    const attributed = clientFor({ authoritative: [authoritative] });
    await appendOutboxEvent(attributed as any, { ...base, payload: {}, privacy: { kind: "technical_no_subject" } });
    expect(attributed.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["subject_attributed", [authoritative], "authoritative_subjects"]));

    const technical = clientFor();
    await appendOutboxEvent(technical as any, { ...base, payload: {}, privacy: { kind: "technical_no_subject" } });
    expect(technical.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["technical_no_subject", [], "explicit_technical"]));

    const noAuthoritativeRow = clientFor({ emptyAuthoritativeRow: true });
    await appendOutboxEvent(noAuthoritativeRow as any, { ...base, payload: {}, privacy: { kind: "technical_no_subject" } });
    expect(noAuthoritativeRow.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["explicit_technical"]));
  });

  it("uses audit actor, explicit subjects, and authoritative subjects as required", async () => {
    const cases = [
      { audit: { actor_id: actor, actor_type: "user" }, authoritative: [], additional: [], basis: "audit_event_actor" },
      { audit: { actor_id: actor, actor_type: "user" }, authoritative: [], additional: [additional], basis: "audit_event_actor_and_explicit_subjects" },
      { audit: { actor_id: actor, actor_type: "user" }, authoritative: [authoritative], additional: [], basis: "audit_event_actor_and_authoritative_subjects" },
      { audit: { actor_id: actor, actor_type: "user" }, authoritative: [authoritative], additional: [additional], basis: "audit_event_actor_explicit_and_authoritative_subjects" },
      { audit: { actor_id: null, actor_type: "service" }, authoritative: [authoritative], additional: [], basis: "audit_event_authoritative_subjects" },
    ];
    for (const scenario of cases) {
      const client = clientFor({ audit: scenario.audit, authoritative: scenario.authoritative });
      await appendOutboxEvent(client as any, { ...base, payload: { auditEventId: auditId }, privacy: { kind: "audit_event", additionalSubjectIdentityIds: scenario.additional } });
      expect(client.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([scenario.basis]));
    }
  });

  it("records a non-human audited technical event", async () => {
    const client = clientFor({ audit: { actor_id: null, actor_type: "service" } });
    await appendOutboxEvent(client as any, { ...base, payload: { auditEventId: auditId } });
    expect(client.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["technical_no_subject", [], "audit_event_nonhuman"]));
  });

  it("rejects invalid or unsafe privacy attribution", async () => {
    const client = clientFor({ audit: { actor_id: null, actor_type: "user" } });
    await expect(appendOutboxEvent(client as any, { ...base, payload: {}, privacy: { kind: "subjects", subjectIdentityIds: [] } })).rejects.toThrow("at least one identity");
    await expect(appendOutboxEvent(client as any, { ...base, payload: {}, privacy: { kind: "subjects", subjectIdentityIds: ["not-a-uuid"] } })).rejects.toThrow("unique UUIDs");
    await expect(appendOutboxEvent(client as any, { ...base, payload: { auditEventId: "invalid" } })).rejects.toThrow("valid audit event UUID");
    await expect(appendOutboxEvent(client as any, { ...base, payload: { auditEventId: auditId } })).rejects.toThrow("cannot omit its actor identity");
  });

  it("rejects oversized attribution, missing audit evidence, and missing audit records", async () => {
    const noAudit = clientFor();
    await expect(appendOutboxEvent(noAudit as any, { ...base, payload: { auditEventId: auditId }, privacy: { kind: "audit_event" } })).rejects.toThrow("requires an existing immutable audit event");
    await expect(appendOutboxEvent(clientFor() as any, { ...base, payload: {}, privacy: { kind: "audit_event" } } as any)).rejects.toThrow("require an audit event UUID");
    await expect(appendOutboxEvent(clientFor() as any, { ...base, payload: {}, privacy: { kind: "subjects", subjectIdentityIds: Array.from({ length: 26 }, () => additional) } })).rejects.toThrow("more than 25 identities");
  });
});

describe("Postgres outbox claims and state changes", () => {
  it("returns no claim for an empty event-type list and maps a claimed record", async () => {
    await expect(claimOutboxEvents({ workerId: "worker", eventTypes: [], limit: 5, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ id: "outbox-1", aggregate_type: "payment", aggregate_id: "payment-1", event_type: "payment.updated", payload: { value: 1 }, occurred_at: new Date("2026-01-01"), attempts: 2 }] }) };
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(claimOutboxEvents({ workerId: "worker", eventTypes: ["payment.updated"], limit: 5, claimTimeoutSeconds: 60 })).resolves.toEqual([expect.objectContaining({ aggregateType: "payment", aggregateId: "payment-1", eventType: "payment.updated", attempts: 2 })]);
  });

  it("publishes only the worker claim and rejects a lost claim", async () => {
    const client = { query: vi.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 0 }) };
    await expect(markOutboxEventPublished(client as any, "outbox-1", "worker")).resolves.toBeUndefined();
    await expect(markOutboxEventPublished(client as any, "outbox-1", "worker")).rejects.toThrow("no longer claimed");
  });

  it("stores a bounded retry error in a transaction", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await markOutboxEventForRetry({ eventId: "outbox-1", workerId: "worker", retryAt: new Date("2026-01-02"), error: new Error("x".repeat(2_100)) });
    expect(client.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["x".repeat(2_000)]));
    await markOutboxEventForRetry({ eventId: "outbox-2", workerId: "worker", retryAt: new Date("2026-01-02"), error: "plain failure" });
    expect(client.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining(["plain failure"]));
  });
});
