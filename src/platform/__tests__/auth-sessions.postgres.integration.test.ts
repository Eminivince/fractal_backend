import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import { AuthSessionError, createAuthSession, rotateAuthSession, validateAuthSession } from "../auth-sessions.js";
import { dispatchPendingOutboxEvents } from "../../services/postgres-outbox-dispatcher.js";
import { projectSecurityEvent, securityEventTypes } from "../../services/security-event-projection.js";
import { enqueueStorageCleanupTask } from "../postgres-storage-cleanup.js";
import { dispatchPendingStorageCleanupTasks } from "../../services/postgres-storage-cleanup-worker.js";
import { env } from "../../config/env.js";

const app = {
  jwt: {
    sign: vi.fn((payload: unknown) => JSON.stringify(payload)),
  },
} as unknown as FastifyInstance;

describe("PostgreSQL auth sessions", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.storage_cleanup_tasks, fractal.payment_provider_instructions, fractal.security_notifications, fractal.auth_step_up_grants, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events, fractal.auth_sessions");
    vi.clearAllMocks();
  });

  afterEach(async () => {
    // The bridge test creates a legacy-mapped identity. It must not remain in
    // the shared development database and make the reconciliation command
    // report a false identity-count mismatch on later runs.
    await postgresQuery("DELETE FROM fractal.security_notifications WHERE subject_id LIKE 'legacy-session-subject-%'");
    await postgresQuery("DELETE FROM fractal.auth_sessions WHERE subject_id LIKE 'legacy-session-subject-%'");
    await postgresQuery(`DELETE FROM fractal.auth_sessions session
      USING fractal.identities identity
      WHERE session.identity_id = identity.id AND identity.legacy_mongo_id LIKE 'legacy-session-subject-%'`);
    await postgresQuery(`DELETE FROM fractal.identity_role_assignments role
      USING fractal.identities identity
      WHERE role.identity_id = identity.id AND identity.legacy_mongo_id LIKE 'legacy-session-subject-%'`);
    await postgresQuery("DELETE FROM fractal.identities WHERE legacy_mongo_id LIKE 'legacy-session-subject-%'");
    await postgresQuery("DELETE FROM fractal.security_notifications WHERE subject_id LIKE 'native-session-subject-%'");
    await postgresQuery(`DELETE FROM fractal.auth_sessions session
      USING fractal.identities identity
      WHERE session.identity_id = identity.id AND identity.email LIKE 'native-session-subject-%@example.test'`);
    await postgresQuery(`DELETE FROM fractal.auth_email_deliveries delivery
      USING fractal.identities identity
      WHERE delivery.identity_id = identity.id AND identity.email LIKE 'native-session-subject-%@example.test'`);
    await postgresQuery("DELETE FROM fractal.identities WHERE email LIKE 'native-session-subject-%@example.test'");
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("rotates refresh tokens and invalidates the old session", async () => {
    const created = await createAuthSession(
      app,
      { userId: "legacy-mongo-user", role: "investor" },
      { ip: "127.0.0.1", userAgent: "vitest" },
    );
    const payload = JSON.parse(created.accessToken) as { sid: string; userId: string };
    expect(payload).toMatchObject({ sid: created.sessionId, userId: "legacy-mongo-user" });

    const rotated = await rotateAuthSession(app, created.refreshToken, { ip: "127.0.0.1", userAgent: "vitest" });
    expect(rotated.sessionId).not.toBe(created.sessionId);
    await expect(validateAuthSession(created.sessionId, "legacy-mongo-user")).rejects.toBeInstanceOf(AuthSessionError);
    await expect(validateAuthSession(rotated.sessionId, "legacy-mongo-user")).resolves.toBeUndefined();
    const events = await postgresQuery<{ event_type: string }>("SELECT event_type FROM fractal.outbox_events ORDER BY occurred_at");
    expect(events.rows.map((event) => event.event_type)).toEqual(["auth.session.created", "auth.session.rotated"]);
  });

  it("links a new legacy session to its imported PostgreSQL identity", async () => {
    const identityId = randomUUID();
    const subjectId = `legacy-session-subject-${randomUUID()}`;
    await postgresQuery(
      `INSERT INTO fractal.identities (id, legacy_mongo_id, email, legal_name, status)
       VALUES ($1, $2, $3, 'Session bridge identity', 'active')`,
      [identityId, subjectId, `${subjectId}@example.test`],
    );

    const created = await createAuthSession(app, { userId: subjectId, role: "investor" }, {});
    const session = await postgresQuery<{ identity_id: string | null }>(
      "SELECT identity_id FROM fractal.auth_sessions WHERE id = $1",
      [created.sessionId],
    );
    expect(session.rows[0]?.identity_id).toBe(identityId);
  });

  it("uses the PostgreSQL identity UUID as the only native session subject", async () => {
    const identityId = randomUUID();
    const email = `native-session-subject-${randomUUID()}@example.test`;
    await postgresQuery(
      `INSERT INTO fractal.identities (id, email, legal_name, status)
       VALUES ($1, $2, 'Native session identity', 'active')`,
      [identityId, email],
    );
    const originalAuthority = env.AUTH_IDENTITY_AUTHORITY;
    env.AUTH_IDENTITY_AUTHORITY = "postgres";
    try {
      const created = await createAuthSession(app, { userId: identityId, role: "investor" }, {});
      const payload = JSON.parse(created.accessToken) as { userId: string };
      expect(payload.userId).toBe(identityId);
      const session = await postgresQuery<{ subject_id: string; identity_id: string | null }>(
        "SELECT subject_id, identity_id FROM fractal.auth_sessions WHERE id = $1",
        [created.sessionId],
      );
      expect(session.rows[0]).toEqual({ subject_id: identityId, identity_id: identityId });
    } finally {
      env.AUTH_IDENTITY_AUTHORITY = originalAuthority;
    }
  });

  it("rotates a mapped legacy refresh session onto its PostgreSQL UUID at cutover", async () => {
    const identityId = randomUUID();
    const subjectId = `legacy-session-subject-${randomUUID()}`;
    await postgresQuery(
      `INSERT INTO fractal.identities (id, legacy_mongo_id, email, legal_name, status)
       VALUES ($1, $2, $3, 'Cutover refresh identity', 'active')`,
      [identityId, subjectId, `${subjectId}@example.test`],
    );
    const legacySession = await createAuthSession(app, { userId: subjectId, role: "investor" }, {});
    const originalAuthority = env.AUTH_IDENTITY_AUTHORITY;
    env.AUTH_IDENTITY_AUTHORITY = "postgres";
    try {
      const rotated = await rotateAuthSession(app, legacySession.refreshToken, {});
      const payload = JSON.parse(rotated.accessToken) as { userId: string };
      expect(payload.userId).toBe(identityId);
      const session = await postgresQuery<{ subject_id: string; identity_id: string | null }>(
        "SELECT subject_id, identity_id FROM fractal.auth_sessions WHERE id = $1",
        [rotated.sessionId],
      );
      expect(session.rows[0]).toEqual({ subject_id: identityId, identity_id: identityId });
    } finally {
      env.AUTH_IDENTITY_AUTHORITY = originalAuthority;
    }
  });

  it("treats refresh-token reuse as compromise and revokes the token family", async () => {
    const created = await createAuthSession(app, { userId: "legacy-mongo-user", role: "investor" }, {});
    const rotated = await rotateAuthSession(app, created.refreshToken, {});

    await expect(rotateAuthSession(app, created.refreshToken, {})).rejects.toBeInstanceOf(AuthSessionError);
    await expect(validateAuthSession(rotated.sessionId, "legacy-mongo-user")).rejects.toBeInstanceOf(AuthSessionError);
    const auditEvents = await postgresQuery<{ action: string }>("SELECT action FROM fractal.audit_events ORDER BY sequence");
    expect(auditEvents.rows.map((event) => event.action)).toContain("auth.session.refresh_reuse_detected");
  });

  it("projects committed session events through the worker-owned outbox", async () => {
    const created = await createAuthSession(app, { userId: "legacy-mongo-user", role: "investor" }, {});
    const dispatched = await dispatchPendingOutboxEvents({
      workerId: "test-outbox-worker",
      eventTypes: securityEventTypes,
      project: projectSecurityEvent,
      logger: { info: () => undefined, error: () => undefined },
    });

    expect(dispatched).toBe(1);
    const notifications = await postgresQuery<{ subject_id: string; session_id: string; event_type: string }>(
      "SELECT subject_id, session_id, event_type FROM fractal.security_notifications",
    );
    expect(notifications.rows).toEqual([
      { subject_id: "legacy-mongo-user", session_id: created.sessionId, event_type: "auth.session.created" },
    ]);
  });

  it("retries a failed security projection without losing the committed event", async () => {
    await createAuthSession(app, { userId: "legacy-mongo-user", role: "investor" }, {});
    await dispatchPendingOutboxEvents({
      workerId: "failing-outbox-worker",
      eventTypes: securityEventTypes,
      project: async () => { throw new Error("projection dependency unavailable"); },
      logger: { info: () => undefined, error: () => undefined },
    });
    const failed = await postgresQuery<{ id: string; attempts: number; published_at: Date | null; last_error: string | null }>(
      "SELECT id, attempts, published_at, last_error FROM fractal.outbox_events",
    );
    expect(failed.rows[0]).toMatchObject({ attempts: 1, published_at: null, last_error: "projection dependency unavailable" });
    await postgresQuery("UPDATE fractal.outbox_events SET next_attempt_at = now() - interval '1 second'");

    await dispatchPendingOutboxEvents({
      workerId: "recovery-outbox-worker",
      eventTypes: securityEventTypes,
      project: projectSecurityEvent,
      logger: { info: () => undefined, error: () => undefined },
    });
    const recovered = await postgresQuery<{ published_at: Date | null }>("SELECT published_at FROM fractal.outbox_events");
    expect(recovered.rows[0]?.published_at).toBeInstanceOf(Date);
  });

  it("leases, retries, and records terminally removed unreferenced storage objects", async () => {
    const taskId = await enqueueStorageCleanupTask({
      storageKey: "local://governance-evidence/test/unreferenced.pdf",
      source: "test-metadata-rejection",
      metadataError: new Error("metadata constraint rejected document"),
    });
    const logger = { info: () => undefined, error: () => undefined };

    await dispatchPendingStorageCleanupTasks({
      workerId: "cleanup-worker-a",
      logger,
      remove: async () => { throw new Error("storage temporarily unavailable"); },
    });
    const failed = await postgresQuery<{ attempts: number; completed_at: Date | null; failed_at: Date | null; last_error: string | null }>(
      "SELECT attempts, completed_at, failed_at, last_error FROM fractal.storage_cleanup_tasks WHERE id = $1",
      [taskId],
    );
    expect(failed.rows[0]).toMatchObject({ attempts: 1, completed_at: null, failed_at: null, last_error: "storage temporarily unavailable" });

    await postgresQuery("UPDATE fractal.storage_cleanup_tasks SET next_attempt_at = now() - interval '1 second' WHERE id = $1", [taskId]);
    const removed: string[] = [];
    await dispatchPendingStorageCleanupTasks({
      workerId: "cleanup-worker-b",
      logger,
      remove: async (storageKey) => { removed.push(storageKey); },
    });
    expect(removed).toEqual(["local://governance-evidence/test/unreferenced.pdf"]);
    const completed = await postgresQuery<{ attempts: number; completed_at: Date | null; failed_at: Date | null }>(
      "SELECT attempts, completed_at, failed_at FROM fractal.storage_cleanup_tasks WHERE id = $1",
      [taskId],
    );
    expect(completed.rows[0]?.attempts).toBe(2);
    expect(completed.rows[0]?.completed_at).toBeInstanceOf(Date);
    expect(completed.rows[0]?.failed_at).toBeNull();
  });
});
