import { describe, expect, it, vi } from "vitest";

const requirePostgres = vi.hoisted(() => vi.fn());
vi.mock("../../db/postgres.js", () => ({ requirePostgres }));

import { listSecurityEvents, projectSecurityEvent } from "../security-event-projection.js";

describe("security event projection", () => {
  it("projects supported events into an idempotent security notification", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) } as any;
    await projectSecurityEvent(client, {
      id: "outbox-1",
      aggregateId: "session-1",
      eventType: "auth.session.created",
      payload: { subjectId: "subject-1", auditEventId: "audit-1" },
    } as any);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("ON CONFLICT (outbox_event_id) DO NOTHING"), [
      expect.any(String), "outbox-1", "audit-1", "subject-1", "session-1", "auth.session.created",
    ]);
  });

  it("rejects unsupported events and missing required payload values", async () => {
    const client = { query: vi.fn() } as any;
    await expect(projectSecurityEvent(client, { id: "outbox-1", aggregateId: "session-1", eventType: "payment.completed", payload: {} } as any)).rejects.toThrow("Unsupported security event type");
    await expect(projectSecurityEvent(client, { id: "outbox-1", aggregateId: "session-1", eventType: "auth.session.revoked", payload: { subjectId: "" } } as any)).rejects.toThrow("subjectId is missing or invalid");
    await expect(projectSecurityEvent(client, { id: "outbox-1", aggregateId: "session-1", eventType: "auth.session.revoked", payload: { subjectId: "subject-1" } } as any)).rejects.toThrow("auditEventId is missing or invalid");
  });

  it("lists the most recent security events for a subject", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: "notification-1", event_type: "auth.session.created" }] });
    requirePostgres.mockReturnValue({ query });
    await expect(listSecurityEvents("subject-1")).resolves.toEqual([{ id: "notification-1", event_type: "auth.session.created" }]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("LIMIT 100"), ["subject-1"]);
  });
});
