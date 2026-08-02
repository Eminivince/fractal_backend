import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { createJwtKeyring } from "../services/jwt-keyring.js";
import type { Role } from "../utils/constants.js";

export class AuthSessionError extends Error {}

export interface SessionSubject {
  userId: string;
  role: Role;
  businessId?: string;
}

interface SessionRow {
  id: string;
  token_family_id: string;
  subject_id: string;
  identity_id: string | null;
  role: Role;
  business_id: string | null;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
}

export interface IssuedSession {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  sessionId: string;
  expiresAt: Date;
}

function tokenHash(token: string): string {
  return createHmac("sha256", env.JWT_SECRET).update(token).digest("hex");
}

function fingerprint(value: string | undefined): string | null {
  return value ? createHmac("sha256", env.JWT_SECRET).update(value).digest("hex") : null;
}

function newRefreshToken(): string {
  return randomBytes(48).toString("base64url");
}

function refreshExpiry(): Date {
  return new Date(Date.now() + env.AUTH_REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

function accessTokenExpiry(): Date {
  return new Date(Date.now() + env.AUTH_ACCESS_TOKEN_TTL_SECONDS * 1000);
}

function issueAccessToken(app: FastifyInstance, subject: SessionSubject, sessionId: string): string {
  const keyring = createJwtKeyring({
    primarySecret: env.JWT_SECRET,
    activeKeyId: env.JWT_ACTIVE_KEY_ID,
    keyRingJson: env.JWT_KEY_RING_JSON,
  });
  const signingKey = keyring.keys.get(keyring.activeKeyId);
  if (!signingKey) throw new Error("Active JWT signing key is unavailable");
  return app.jwt.sign(
    {
      userId: subject.userId,
      role: subject.role,
      businessId: subject.businessId,
      sid: sessionId,
    },
    {
      expiresIn: `${env.AUTH_ACCESS_TOKEN_TTL_SECONDS}s`,
      key: signingKey,
      header: { alg: "HS256", kid: keyring.activeKeyId },
    },
  );
}

async function insertSession(
  client: PoolClient,
  subject: SessionSubject,
  tokenFamilyId: string,
  refreshToken: string,
  metadata: { ip?: string; userAgent?: string },
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomUUID();
  const expiresAt = refreshExpiry();
  // The migration bridge links the immutable Mongo subject. Native authority
  // mode instead requires that the session subject itself is the live
  // PostgreSQL identity; there is no silent fallback to a legacy user ID.
  const identity = env.AUTH_IDENTITY_AUTHORITY === "postgres"
    ? await client.query<{ id: string }>(
        "SELECT id FROM fractal.identities WHERE id = $1 AND status = 'active'",
        [subject.userId],
      )
    : await client.query<{ id: string }>(
        "SELECT id FROM fractal.identities WHERE legacy_mongo_id = $1 AND status = 'active'",
        [subject.userId],
      );
  if (env.AUTH_IDENTITY_AUTHORITY === "postgres" && identity.rowCount !== 1) {
    throw new AuthSessionError("PostgreSQL identity is not available for this session");
  }
  await client.query(
    `INSERT INTO fractal.auth_sessions
       (id, token_family_id, subject_id, identity_id, role, business_id, refresh_token_hash, expires_at, ip_hash, user_agent_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      tokenFamilyId,
      subject.userId,
      identity.rows[0]?.id ?? null,
      subject.role,
      subject.businessId ?? null,
      tokenHash(refreshToken),
      expiresAt,
      fingerprint(metadata.ip),
      fingerprint(metadata.userAgent),
    ],
  );
  return { id, expiresAt };
}

/**
 * A session change is both an immutable security record and an event for the
 * worker boundary. Neither record contains a refresh token, IP address, or
 * user-agent value; those stay only as keyed fingerprints on the session row.
 */
async function recordSessionEvent(
  client: PoolClient,
  input: {
    subjectId: string;
    sessionId: string;
    action: string;
    eventType: string;
    actorType?: string;
    payload?: Record<string, unknown>;
  },
): Promise<void> {
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `auth-subject:${input.subjectId}`,
    actorType: input.actorType ?? "user",
    action: input.action,
    entityType: "auth_session",
    entityId: input.sessionId,
    payload: input.payload ?? {},
  });
  const session = await client.query<{ identity_id: string | null }>(
    "SELECT identity_id FROM fractal.auth_sessions WHERE id=$1 FOR SHARE",
    [input.sessionId],
  );
  const identityId = session.rows[0]?.identity_id ?? null;
  const event = {
    aggregateType: "auth_session",
    aggregateId: input.sessionId,
    eventType: input.eventType,
    payload: { subjectId: input.subjectId, auditEventId: audit.id },
  };
  if (identityId) {
    await appendOutboxEvent(client, { ...event, privacy: { kind: "audit_event", additionalSubjectIdentityIds: [identityId] } });
  } else {
    await appendOutboxEvent(client, { ...event, privacy: { kind: "technical_no_subject" } });
  }
}

export async function createAuthSession(
  app: FastifyInstance,
  subject: SessionSubject,
  metadata: { ip?: string; userAgent?: string },
): Promise<IssuedSession> {
  requirePostgres();
  const refreshToken = newRefreshToken();
  const tokenFamilyId = randomUUID();
  const session = await withPostgresTransaction(async (client) => {
    const created = await insertSession(client, subject, tokenFamilyId, refreshToken, metadata);
    await recordSessionEvent(client, {
      subjectId: subject.userId,
      sessionId: created.id,
      action: "auth.session.created",
      eventType: "auth.session.created",
      payload: { role: subject.role, businessId: subject.businessId ?? null },
    });
    return created;
  });
  return {
    accessToken: issueAccessToken(app, subject, session.id),
    accessTokenExpiresAt: accessTokenExpiry(),
    refreshToken,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  };
}

export async function rotateAuthSession(
  app: FastifyInstance,
  refreshToken: string,
  metadata: { ip?: string; userAgent?: string },
): Promise<IssuedSession> {
  const nextRefreshToken = newRefreshToken();
  const next = await withPostgresTransaction(async (client) => {
    const result = await client.query<SessionRow>(
      `SELECT id, token_family_id, subject_id, identity_id, role, business_id, expires_at, revoked_at, revoked_reason
         FROM fractal.auth_sessions
        WHERE refresh_token_hash = $1
        FOR UPDATE`,
      [tokenHash(refreshToken)],
    );
    const current = result.rows[0];
    if (!current || current.expires_at <= new Date()) {
      throw new AuthSessionError("Refresh session is invalid or expired");
    }
    if (current.revoked_at) {
      if (current.revoked_reason === "rotated") {
        await client.query(
          `UPDATE fractal.auth_sessions
              SET revoked_at = COALESCE(revoked_at, now()),
                  revoked_reason = CASE WHEN revoked_reason = 'rotated' THEN 'refresh_reuse_detected' ELSE COALESCE(revoked_reason, 'refresh_reuse_detected') END
            WHERE token_family_id = $1`,
          [current.token_family_id],
        );
        await recordSessionEvent(client, {
          subjectId: current.subject_id,
          sessionId: current.id,
          action: "auth.session.refresh_reuse_detected",
          eventType: "auth.session.refresh_reuse_detected",
          payload: { tokenFamilyId: current.token_family_id },
        });
        // Do not throw inside this transaction: the revocation must commit
        // before we reject the replay attempt.
        return { compromised: true as const };
      }
      return { compromised: false as const };
    }

    // A mapped bridge session can survive an authority cutover through one
    // refresh: the replacement is bound to the authoritative UUID. An
    // unmapped legacy session is rejected, not cast to UUID or silently
    // accepted by the new authority.
    const subjectId = env.AUTH_IDENTITY_AUTHORITY === "postgres"
      ? current.identity_id
      : current.subject_id;
    if (!subjectId) {
      throw new AuthSessionError("Refresh session is not mapped to the PostgreSQL identity authority");
    }
    const subject: SessionSubject = {
      userId: subjectId,
      role: current.role,
      businessId: current.business_id ?? undefined,
    };
    const replacement = await insertSession(client, subject, current.token_family_id, nextRefreshToken, metadata);
    await client.query(
      `UPDATE fractal.auth_sessions
          SET revoked_at = now(), revoked_reason = 'rotated', replaced_by_session_id = $1
        WHERE id = $2`,
      [replacement.id, current.id],
    );
    await recordSessionEvent(client, {
      subjectId: subject.userId,
      sessionId: replacement.id,
      action: "auth.session.rotated",
      eventType: "auth.session.rotated",
      payload: { replacedSessionId: current.id },
    });
    return { subject, replacement, compromised: undefined };
  });

  if (next.compromised !== undefined) {
    throw new AuthSessionError(
      next.compromised ? "Refresh-token reuse detected; all related sessions were revoked" : "Refresh session is no longer valid",
    );
  }

  return {
    accessToken: issueAccessToken(app, next.subject, next.replacement.id),
    accessTokenExpiresAt: accessTokenExpiry(),
    refreshToken: nextRefreshToken,
    sessionId: next.replacement.id,
    expiresAt: next.replacement.expiresAt,
  };
}

export async function revokeAuthSession(sessionId: string, subjectId: string, reason: string): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `UPDATE fractal.auth_sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, $3)
        WHERE id = $1 AND subject_id = $2 AND revoked_at IS NULL
        RETURNING id`,
      [sessionId, subjectId, reason],
    );
    if (result.rowCount === 1) {
      await recordSessionEvent(client, {
        subjectId,
        sessionId,
        action: "auth.session.revoked",
        eventType: "auth.session.revoked",
        payload: { reason },
      });
    }
  });
}

export interface AuthSessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
  current: boolean;
}

export async function listAuthSessions(subjectId: string, currentSessionId?: string): Promise<AuthSessionSummary[]> {
  const result = await requirePostgres().query<{
    id: string;
    created_at: Date;
    last_seen_at: Date;
    expires_at: Date;
  }>(
    `SELECT id, created_at, last_seen_at, expires_at
       FROM fractal.auth_sessions
      WHERE subject_id = $1 AND revoked_at IS NULL AND expires_at > now()
      ORDER BY last_seen_at DESC`,
    [subjectId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    current: row.id === currentSessionId,
  }));
}

export async function revokeAuthSessionForSubject(
  sessionId: string,
  subjectId: string,
  reason: string,
): Promise<boolean> {
  let revoked = false;
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `UPDATE fractal.auth_sessions
          SET revoked_at = COALESCE(revoked_at, now()), revoked_reason = COALESCE(revoked_reason, $3)
        WHERE id = $1 AND subject_id = $2 AND revoked_at IS NULL`,
      [sessionId, subjectId, reason],
    );
    revoked = result.rowCount === 1;
    if (revoked) {
      await recordSessionEvent(client, {
        subjectId,
        sessionId,
        action: "auth.session.revoked",
        eventType: "auth.session.revoked",
        payload: { reason },
      });
    }
  });
  return revoked;
}

export async function revokeAllAuthSessionsForSubjectInTransaction(
  client: PoolClient,
  subjectId: string,
  reason: string,
): Promise<number> {
  const result = await client.query<{ id: string }>(
    `UPDATE fractal.auth_sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE subject_id = $1 AND revoked_at IS NULL
      RETURNING id`,
    [subjectId, reason],
  );
  for (const session of result.rows) {
    await recordSessionEvent(client, {
      subjectId,
      sessionId: session.id,
      action: "auth.session.revoked",
      eventType: "auth.session.revoked",
      payload: { reason },
    });
  }
  return result.rowCount ?? 0;
}

/**
 * Break-glass identity recovery must also catch a still-mapped legacy session
 * whose immutable subject predates the PostgreSQL cutover. Normal account
 * commands use the subject helper above; recovery uses this identity-wide form.
 */
export async function revokeAllAuthSessionsForIdentityInTransaction(
  client: PoolClient,
  identityId: string,
  reason: string,
): Promise<number> {
  const result = await client.query<{ id: string; subject_id: string }>(
    `UPDATE fractal.auth_sessions
        SET revoked_at = now(), revoked_reason = $2
      WHERE (identity_id = $1 OR subject_id = $1::text) AND revoked_at IS NULL
      RETURNING id, subject_id`,
    [identityId, reason],
  );
  for (const session of result.rows) {
    await recordSessionEvent(client, {
      subjectId: session.subject_id,
      sessionId: session.id,
      action: "auth.session.revoked",
      eventType: "auth.session.revoked",
      actorType: "operator",
      payload: { reason, recoveredIdentityId: identityId },
    });
  }
  return result.rowCount ?? 0;
}

export async function revokeAllAuthSessionsForSubject(subjectId: string, reason: string): Promise<number> {
  return withPostgresTransaction((client) => revokeAllAuthSessionsForSubjectInTransaction(client, subjectId, reason));
}

export async function validateAuthSession(sessionId: string, subjectId: string): Promise<void> {
  const result = await requirePostgres().query<Pick<SessionRow, "id">>(
    `SELECT id FROM fractal.auth_sessions
      WHERE id = $1 AND subject_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [sessionId, subjectId],
  );
  if (result.rowCount !== 1) throw new AuthSessionError("Session is no longer active");
  await requirePostgres().query("UPDATE fractal.auth_sessions SET last_seen_at = now() WHERE id = $1", [sessionId]);
}
