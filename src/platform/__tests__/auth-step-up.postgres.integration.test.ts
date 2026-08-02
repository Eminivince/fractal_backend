import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import { grantTotpStepUp, requireFreshTotpStepUp, StepUpRequiredError } from "../auth-step-up.js";
import { confirmOrVerifyTotpFactor, enrollTotpFactor, generateTotpCode } from "../totp-factors.js";

describe("PostgreSQL TOTP step-up grants", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => { await disconnectPostgres(); });

  it("requires a current session-bound TOTP grant, prevents cross-identity grants, and rejects expiry", async () => {
    const identityId = randomUUID();
    const sessionId = randomUUID();
    const otherIdentityId = randomUUID();
    const mismatchedSessionId = randomUUID();
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Step-up identity', 'active')",
      [identityId, `step-up-${identityId}@example.test`],
    );
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'Other step-up identity', 'active')",
      [otherIdentityId, `step-up-other-${otherIdentityId}@example.test`],
    );
    await postgresQuery(
      `INSERT INTO fractal.auth_sessions (id, token_family_id, subject_id, identity_id, role, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, 'operator', $5, now() + interval '1 day')`,
      [sessionId, randomUUID(), `subject-${identityId}`, identityId, "a".repeat(64)],
    );
    await postgresQuery(
      `INSERT INTO fractal.auth_sessions (id, token_family_id, subject_id, identity_id, role, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, 'operator', $5, now() + interval '1 day')`,
      [mismatchedSessionId, randomUUID(), `subject-mismatch-${identityId}`, identityId, "b".repeat(64)],
    );

    await expect(requireFreshTotpStepUp({ sessionId, identityId })).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(grantTotpStepUp({ sessionId: mismatchedSessionId, identityId: otherIdentityId })).rejects.toBeInstanceOf(StepUpRequiredError);
    await expect(postgresQuery(
      `INSERT INTO fractal.auth_step_up_grants (session_id, identity_id, method, expires_at)
       VALUES ($1, $2, 'totp', now() + interval '5 minutes')`,
      [mismatchedSessionId, otherIdentityId],
    )).rejects.toThrow();

    const enrollment = await enrollTotpFactor(identityId);
    const now = new Date();
    const counter = Math.floor(now.getTime() / 30_000);
    await confirmOrVerifyTotpFactor(identityId, generateTotpCode(enrollment.secret, counter), now);
    const grant = await grantTotpStepUp({ sessionId, identityId });
    expect(grant.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expect(requireFreshTotpStepUp({ sessionId, identityId })).resolves.toBeUndefined();

    await postgresQuery("UPDATE fractal.auth_step_up_grants SET granted_at = now() - interval '2 seconds', expires_at = now() - interval '1 second' WHERE session_id = $1", [sessionId]);
    await expect(requireFreshTotpStepUp({ sessionId, identityId })).rejects.toBeInstanceOf(StepUpRequiredError);
  });
});
