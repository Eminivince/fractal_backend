import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export type IdentityVerificationApplicationStatus = "requested" | "ready" | "failed" | "terminal";

export interface IdentityVerificationApplication {
  id: string;
  provider: "sumsub";
  externalUserId: string;
  applicantId: string | null;
  status: IdentityVerificationApplicationStatus;
  attempts: number;
  readyAt: string | null;
  terminalAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ClaimedIdentityVerificationApplication {
  id: string;
  identityId: string;
  provider: "sumsub";
  externalUserId: string;
  attempts: number;
}

export class IdentityVerificationApplicationError extends Error {}

type ApplicationRow = {
  id: string;
  provider: "sumsub";
  external_user_id: string;
  applicant_id: string | null;
  inspection_id: string | null;
  status: IdentityVerificationApplicationStatus;
  attempts: number;
  ready_at: Date | null;
  terminal_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function serialize(row: ApplicationRow): IdentityVerificationApplication {
  return {
    id: row.id,
    provider: row.provider,
    externalUserId: row.external_user_id,
    applicantId: row.applicant_id,
    status: row.status,
    attempts: row.attempts,
    readyAt: row.ready_at?.toISOString() ?? null,
    terminalAt: row.terminal_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

const applicationColumns = `id, provider, external_user_id, applicant_id, inspection_id, status, attempts,
  ready_at, terminal_at, created_at, updated_at`;

/**
 * Requests an applicant asynchronously. The request transaction never calls
 * Sumsub: a worker first resolves the external user ID remotely, then creates
 * it only when absent. This makes both browser retries and worker crashes
 * recoverable without creating an untracked applicant.
 */
export async function requestIdentityVerificationApplication(input: {
  identityId: string;
  commandKey: string;
}): Promise<{ application: IdentityVerificationApplication; replayed: boolean }> {
  const identityId = input.identityId.trim();
  const commandKey = input.commandKey.trim();
  if (!identityId || !commandKey) throw new IdentityVerificationApplicationError("Identity-verification application requires an identity and command key");

  const result = await runPostgresIdempotentCommand<{ application: IdentityVerificationApplication }>({
    actorIdentityId: identityId,
    scopeKey: `identity:${identityId}`,
    route: "/v1/investor/identity-verification/applications",
    commandKey,
    payload: { provider: "sumsub" },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      const identity = await client.query<{ id: string }>(
        "SELECT id FROM fractal.identities WHERE id = $1 AND status = 'active' FOR SHARE",
        [identityId],
      );
      if (!identity.rows[0]) throw new IdentityVerificationApplicationError("Active identity is required for identity verification");

      const id = randomUUID();
      const inserted = await client.query<ApplicationRow>(
        `INSERT INTO fractal.provider_identity_verification_applications
           (id, identity_id, provider, external_user_id, status)
         VALUES ($1, $2::uuid, 'sumsub', ($2::uuid)::text, 'requested')
         ON CONFLICT (identity_id, provider) DO NOTHING
         RETURNING ${applicationColumns}`,
        [id, identityId],
      );
      const application = inserted.rows[0] ?? (await client.query<ApplicationRow>(
        `SELECT ${applicationColumns}
           FROM fractal.provider_identity_verification_applications
          WHERE identity_id = $1 AND provider = 'sumsub'
          FOR SHARE`,
        [identityId],
      )).rows[0];
      if (!application) throw new Error("Identity-verification application disappeared during request");

      if (inserted.rowCount === 1) {
        await appendPostgresAuditEvent(client, {
          scopeKey: `identity:${identityId}`,
          actorId: identityId,
          actorType: "user",
          action: "identity.verification_application.requested",
          entityType: "provider_identity_verification_application",
          entityId: application.id,
          payload: { provider: "sumsub", externalUserId: application.external_user_id },
        });
        await appendOutboxEvent(client, {
          aggregateType: "identity_verification_application",
          aggregateId: application.id,
          eventType: "IdentityVerificationApplicationRequested",
          payload: { identityId, provider: "sumsub" },
          privacy: { kind: "subjects", subjectIdentityIds: [identityId] },
        });
      }
      return { status: 202, body: { application: serialize(application) } };
    },
  });
  return { application: result.body.application, replayed: result.replayed };
}

export async function getIdentityVerificationApplication(identityId: string): Promise<IdentityVerificationApplication | null> {
  const result = await requirePostgres().query<ApplicationRow>(
    `SELECT ${applicationColumns}
       FROM fractal.provider_identity_verification_applications
      WHERE identity_id = $1 AND provider = 'sumsub'`,
    [identityId],
  );
  return result.rows[0] ? serialize(result.rows[0]) : null;
}

/** Records issuance metadata without ever storing the bearer token itself. */
export async function recordIdentityVerificationAccessTokenIssued(input: {
  applicationId: string;
  identityId: string;
  expiresAt: Date;
}): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `SELECT 1 FROM fractal.provider_identity_verification_applications
        WHERE id = $1 AND identity_id = $2 AND provider = 'sumsub' AND status = 'ready'
        FOR SHARE`,
      [input.applicationId, input.identityId],
    );
    if (!result.rows[0]) throw new IdentityVerificationApplicationError("Identity-verification application is not ready");
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${input.identityId}`,
      actorId: input.identityId,
      actorType: "user",
      action: "identity.verification_access_token.issued",
      entityType: "provider_identity_verification_application",
      entityId: input.applicationId,
      payload: { provider: "sumsub", expiresAt: input.expiresAt.toISOString() },
    });
  });
}

export async function claimIdentityVerificationApplications(input: {
  workerId: string;
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedIdentityVerificationApplication[]> {
  if (input.limit <= 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string; identity_id: string; provider: "sumsub"; external_user_id: string; attempts: number;
    }>(
      `WITH candidates AS (
         SELECT id FROM fractal.provider_identity_verification_applications
          WHERE provider = 'sumsub'
            AND status IN ('requested', 'failed')
            AND terminal_at IS NULL
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($1 * interval '1 second'))
          ORDER BY created_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE fractal.provider_identity_verification_applications application
          SET claimed_at = now(), claimed_by = $3, attempts = application.attempts + 1
         FROM candidates
        WHERE application.id = candidates.id
       RETURNING application.id, application.identity_id, application.provider, application.external_user_id, application.attempts`,
      [input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      identityId: row.identity_id,
      provider: row.provider,
      externalUserId: row.external_user_id,
      attempts: row.attempts,
    }));
  });
}

export async function loadClaimedIdentityVerificationApplication(input: {
  applicationId: string;
  workerId: string;
}): Promise<{ email: string; externalUserId: string }> {
  const result = await requirePostgres().query<{ email: string; external_user_id: string }>(
    `SELECT identity.email, application.external_user_id
       FROM fractal.provider_identity_verification_applications application
       JOIN fractal.identities identity ON identity.id = application.identity_id
      WHERE application.id = $1
        AND application.claimed_by = $2
        AND application.status IN ('requested', 'failed')
        AND identity.status = 'active'`,
    [input.applicationId, input.workerId],
  );
  const application = result.rows[0];
  if (!application) throw new IdentityVerificationApplicationError("Identity-verification application is no longer claimed by this worker");
  return { email: application.email, externalUserId: application.external_user_id };
}

export async function markIdentityVerificationApplicationReady(input: {
  applicationId: string;
  workerId: string;
  applicantId: string;
  inspectionId: string;
}): Promise<void> {
  const applicantId = input.applicantId.trim();
  const inspectionId = input.inspectionId.trim();
  if (!applicantId) throw new IdentityVerificationApplicationError("Provider applicant ID is required");
  if (!inspectionId) throw new IdentityVerificationApplicationError("Provider inspection ID is required");
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{ identity_id: string; attempts: number }>(
      `UPDATE fractal.provider_identity_verification_applications
          SET applicant_id = $3, inspection_id = $4, status = 'ready', ready_at = now(), claimed_at = NULL, claimed_by = NULL,
              last_error = NULL, terminal_at = NULL, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status IN ('requested', 'failed')
        RETURNING identity_id, attempts`,
      [input.applicationId, input.workerId, applicantId, inspectionId],
    );
    const application = result.rows[0];
    if (!application) throw new IdentityVerificationApplicationError("Identity-verification application is no longer claimed by this worker");
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${application.identity_id}`,
      actorType: "worker",
      action: "identity.verification_application.ready",
      entityType: "provider_identity_verification_application",
      entityId: input.applicationId,
      payload: { provider: "sumsub", applicantId, inspectionId },
    });
    await appendOutboxEvent(client, {
      aggregateType: "identity_verification_application",
      aggregateId: input.applicationId,
      eventType: "IdentityVerificationApplicationReady",
      payload: { identityId: application.identity_id, provider: "sumsub", applicantId, inspectionId },
      privacy: { kind: "subjects", subjectIdentityIds: [application.identity_id] },
    });
  });
}

export async function markIdentityVerificationApplicationForRetry(input: {
  applicationId: string;
  workerId: string;
  retryAt: Date;
  error: unknown;
  terminal: boolean;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{ identity_id: string; attempts: number }>(
      `UPDATE fractal.provider_identity_verification_applications
          SET status = CASE WHEN $4 THEN 'terminal' ELSE 'failed' END,
              claimed_at = NULL, claimed_by = NULL,
              next_attempt_at = CASE WHEN $4 THEN next_attempt_at ELSE $3 END,
              terminal_at = CASE WHEN $4 THEN now() ELSE NULL END,
              last_error = $5, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status IN ('requested', 'failed')
        RETURNING identity_id, attempts`,
      [input.applicationId, input.workerId, input.retryAt, input.terminal, message.slice(0, 1_000)],
    );
    const application = result.rows[0];
    if (!application) throw new IdentityVerificationApplicationError("Identity-verification application is no longer claimed by this worker");
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${application.identity_id}`,
      actorType: "worker",
      action: input.terminal ? "identity.verification_application.terminal" : "identity.verification_application.retry_scheduled",
      entityType: "provider_identity_verification_application",
      entityId: input.applicationId,
      payload: { provider: "sumsub", attempts: application.attempts, terminal: input.terminal },
    });
  });
}
