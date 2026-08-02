import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";

export class StepUpRequiredError extends Error {}

export async function grantTotpStepUp(input: {
  sessionId: string;
  identityId: string;
}): Promise<{ expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + env.AUTH_STEP_UP_TTL_SECONDS * 1_000);
  await withPostgresTransaction(async (client) => {
    const activeSession = await client.query(
      `SELECT 1 FROM fractal.auth_sessions
        WHERE id = $1 AND identity_id = $2 AND revoked_at IS NULL AND expires_at > now()`,
      [input.sessionId, input.identityId],
    );
    if (!activeSession.rows[0]) throw new StepUpRequiredError("The current session is not eligible for step-up authentication.");
    await client.query(
      `INSERT INTO fractal.auth_step_up_grants (session_id, identity_id, method, granted_at, expires_at)
       VALUES ($1, $2, 'totp', now(), $3)
       ON CONFLICT (session_id) DO UPDATE SET
         identity_id = EXCLUDED.identity_id, method = EXCLUDED.method,
         granted_at = EXCLUDED.granted_at, expires_at = EXCLUDED.expires_at`,
      [input.sessionId, input.identityId, expiresAt],
    );
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${input.identityId}`,
      actorId: input.identityId,
      actorType: "user",
      action: "auth.step_up.granted",
      entityType: "auth_step_up_grant",
      entityId: input.sessionId,
      payload: { method: "totp", expiresAt: expiresAt.toISOString() },
    });
  });
  return { expiresAt };
}

/**
 * Production always requires a fresh grant. Non-production only bypasses this
 * when TOTP is explicitly disabled, keeping isolated integration tests usable.
 */
export async function requireFreshTotpStepUp(input: {
  sessionId?: string;
  identityId: string;
}): Promise<void> {
  if (!env.MFA_TOTP_ENABLED) return;
  if (!input.sessionId) throw new StepUpRequiredError("A server-backed session is required for this action.");
  const result = await requirePostgres().query(
    `SELECT 1 FROM fractal.auth_step_up_grants step_grant
      JOIN fractal.auth_sessions session ON session.id = step_grant.session_id
     WHERE step_grant.session_id = $1
       AND step_grant.identity_id = $2
       AND step_grant.expires_at > now()
       AND session.revoked_at IS NULL
       AND session.expires_at > now()`,
    [input.sessionId, input.identityId],
  );
  if (!result.rows[0]) {
    throw new StepUpRequiredError("Complete authenticator-app step-up verification before approving or executing this action.");
  }
}
