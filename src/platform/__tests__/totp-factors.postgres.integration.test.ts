import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../../db/postgres.js";
import {
  confirmOrVerifyTotpFactor,
  enrollTotpFactor,
  generateTotpCode,
  getTotpFactorStatus,
  recoverTotpFactor,
  regenerateTotpRecoveryCodes,
  TotpFactorError,
  verifyConfirmedTotpFactor,
} from "../totp-factors.js";

describe("PostgreSQL TOTP factors", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => { await disconnectPostgres(); });

  it("encrypts the factor, confirms a valid code, and rejects replay", async () => {
    const identityId = randomUUID();
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'MFA test identity', 'active')",
      [identityId, `mfa-${identityId}@example.test`],
    );
    const enrollment = await enrollTotpFactor(identityId);
    expect(enrollment.otpauthUri).toContain(`secret=${enrollment.secret}`);
    const now = new Date(1_800_000_000_000);
    const code = generateTotpCode(enrollment.secret, Math.floor(now.getTime() / 30_000));
    const confirmation = await confirmOrVerifyTotpFactor(identityId, code, now);
    expect(confirmation).toMatchObject({ confirmedNow: true });
    expect(confirmation.recoveryCodes).toHaveLength(10);
    expect(confirmation.recoveryCodes?.every((recoveryCode) => /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(recoveryCode))).toBe(true);
    await expect(confirmOrVerifyTotpFactor(identityId, code, now)).rejects.toBeInstanceOf(TotpFactorError);
    const next = new Date(now.getTime() + 30_000);
    await expect(confirmOrVerifyTotpFactor(identityId, generateTotpCode(enrollment.secret, Math.floor(next.getTime() / 30_000)), next)).resolves.toMatchObject({
      confirmedNow: false,
      recoveryCodes: null,
    });
    const stored = await postgresQuery<{ secret_ciphertext: string; confirmed_at: Date | null }>(
      "SELECT secret_ciphertext, confirmed_at FROM fractal.totp_factors WHERE identity_id = $1", [identityId],
    );
    expect(stored.rows[0]?.secret_ciphertext).not.toContain(enrollment.secret);
    expect(stored.rows[0]?.confirmed_at).toBeInstanceOf(Date);
    expect(await getTotpFactorStatus(identityId)).toMatchObject({ recoveryCodesRemaining: 10 });

    const regeneratedAt = new Date(next.getTime() + 30_000);
    const regenerated = await regenerateTotpRecoveryCodes(
      identityId,
      generateTotpCode(enrollment.secret, Math.floor(regeneratedAt.getTime() / 30_000)),
      regeneratedAt,
    );
    expect(regenerated).toHaveLength(10);
    expect(regenerated).not.toContain(confirmation.recoveryCodes![0]);
    expect(await getTotpFactorStatus(identityId)).toMatchObject({ recoveryCodesRemaining: 10 });
  });

  it("uses a recovery code only to replace the authenticator, revoke other sessions, and clear old step-up grants", async () => {
    const identityId = randomUUID();
    const sessionId = randomUUID();
    const otherSessionId = randomUUID();
    const subjectId = `mfa-recovery-subject-${identityId}`;
    await postgresQuery(
      "INSERT INTO fractal.identities (id, email, legal_name, status) VALUES ($1, $2, 'MFA recovery identity', 'active')",
      [identityId, `mfa-recovery-${identityId}@example.test`],
    );
    await postgresQuery(
      `INSERT INTO fractal.auth_sessions (id, token_family_id, subject_id, identity_id, role, refresh_token_hash, expires_at)
       VALUES ($1, $2, $3, $4, 'operator', $5, now() + interval '1 day'),
              ($6, $7, $3, $4, 'operator', $8, now() + interval '1 day')`,
      [sessionId, randomUUID(), subjectId, identityId, "c".repeat(64), otherSessionId, randomUUID(), "d".repeat(64)],
    );

    const enrollment = await enrollTotpFactor(identityId);
    const now = new Date(1_800_000_060_000);
    const confirmation = await confirmOrVerifyTotpFactor(
      identityId,
      generateTotpCode(enrollment.secret, Math.floor(now.getTime() / 30_000)),
      now,
    );
    const recoveryCode = confirmation.recoveryCodes![0]!;
    await postgresQuery(
      `INSERT INTO fractal.auth_step_up_grants (session_id, identity_id, method, expires_at)
       VALUES ($1, $2, 'totp', now() + interval '5 minutes')`,
      [sessionId, identityId],
    );

    const recovered = await recoverTotpFactor({ identityId, sessionId, code: recoveryCode });
    expect(recovered.secret).not.toBe(enrollment.secret);
    expect(await getTotpFactorStatus(identityId)).toMatchObject({ confirmed: false, recoveryCodesRemaining: 0 });
    await expect(recoverTotpFactor({ identityId, sessionId, code: recoveryCode })).rejects.toBeInstanceOf(TotpFactorError);
    await expect(confirmOrVerifyTotpFactor(
      identityId,
      generateTotpCode(enrollment.secret, Math.floor((now.getTime() + 60_000) / 30_000)),
      new Date(now.getTime() + 60_000),
    )).rejects.toBeInstanceOf(TotpFactorError);

    const stepUp = await postgresQuery<{ count: string }>(
      "SELECT count(*) FROM fractal.auth_step_up_grants WHERE identity_id = $1", [identityId],
    );
    const otherSession = await postgresQuery<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM fractal.auth_sessions WHERE id = $1", [otherSessionId],
    );
    expect(Number(stepUp.rows[0]?.count)).toBe(0);
    expect(otherSession.rows[0]?.revoked_at).toBeInstanceOf(Date);

    const replacementConfirmationTime = new Date(now.getTime() + 90_000);
    const replacementConfirmationCode = generateTotpCode(recovered.secret, Math.floor(replacementConfirmationTime.getTime() / 30_000));
    await expect(verifyConfirmedTotpFactor(identityId, replacementConfirmationCode, replacementConfirmationTime)).rejects.toBeInstanceOf(TotpFactorError);
    const newConfirmation = await confirmOrVerifyTotpFactor(
      identityId,
      replacementConfirmationCode,
      replacementConfirmationTime,
    );
    expect(newConfirmation).toMatchObject({ confirmedNow: true });
    expect(newConfirmation.recoveryCodes).toHaveLength(10);
  });
});
