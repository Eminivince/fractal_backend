import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), audit: vi.fn() }));
const totpEnv = vi.hoisted(() => ({
  MFA_TOTP_ENCRYPTION_KEY: "11".repeat(32),
  MFA_RECOVERY_CODE_PEPPER: "22".repeat(32),
}));

vi.mock("../../config/env.js", () => ({ env: totpEnv }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));

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

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.transaction.mockReset();
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" });
  totpEnv.MFA_TOTP_ENCRYPTION_KEY = "11".repeat(32);
  totpEnv.MFA_RECOVERY_CODE_PEPPER = "22".repeat(32);
});

describe("TOTP factors", () => {
  it("generates stable six-digit TOTP codes and rejects malformed confirmation codes", async () => {
    const secret = "JBSWY3DPEHPK3PXP";
    expect(generateTotpCode(secret, 1)).toMatch(/^\d{6}$/);
    const enrollmentQuery = transactionWithResponses({ rows: [] });
    const enrollment = await enrollTotpFactor("identity-1");
    const ciphertext = (enrollmentQuery.mock.calls[1]![1] as unknown[])[2] as string;
    const query = transactionWithResponses({ rows: [{ secret_ciphertext: ciphertext, confirmed_at: null, last_used_counter: null, disabled_at: null }] });
    await expect(confirmOrVerifyTotpFactor("identity-1", "bad", new Date(60_000))).rejects.toThrow("Invalid authentication code");
    expect(query).toHaveBeenCalledOnce();
  });

  it("enrolls a new encrypted factor and refuses replacement of an active factor", async () => {
    const query = transactionWithResponses({ rows: [] });
    const enrollment = await enrollTotpFactor("identity-1");
    expect(enrollment.secret).toMatch(/^[A-Z2-7]+$/);
    expect(enrollment.otpauthUri).toContain("issuer=Fractal");
    const insert = query.mock.calls[1]![1] as unknown[];
    expect(insert[2]).not.toContain(enrollment.secret);

    transactionWithResponses({ rows: [{ confirmed_at: new Date(), disabled_at: null }] });
    await expect(enrollTotpFactor("identity-1")).rejects.toThrow("active TOTP factor already exists");
  });

  it("reports enrolled, confirmed, disabled, and absent factor status", async () => {
    transactionWithResponses({ rows: [{ confirmed_at: new Date(), disabled_at: null, recovery_codes_remaining: "7" }] });
    await expect(getTotpFactorStatus("identity-1")).resolves.toEqual({ enrolled: true, confirmed: true, recoveryCodesRemaining: 7 });
    transactionWithResponses({ rows: [{ confirmed_at: new Date(), disabled_at: new Date(), recovery_codes_remaining: "7" }] });
    await expect(getTotpFactorStatus("identity-1")).resolves.toEqual({ enrolled: false, confirmed: false, recoveryCodesRemaining: 7 });
    transactionWithResponses({ rows: [] });
    await expect(getTotpFactorStatus("identity-1")).resolves.toEqual({ enrolled: false, confirmed: false, recoveryCodesRemaining: 0 });
  });

  it("confirms a factor once, creates recovery codes, and writes an audit event", async () => {
    const enrollmentQuery = transactionWithResponses({ rows: [] });
    const enrollment = await enrollTotpFactor("identity-1");
    const ciphertext = (enrollmentQuery.mock.calls[1]![1] as unknown[])[2] as string;
    const now = new Date(1_800_000_000_000);
    const code = generateTotpCode(enrollment.secret, Math.floor(now.getTime() / 30_000));
    const query = transactionWithResponses(
      { rows: [{ secret_ciphertext: ciphertext, confirmed_at: null, last_used_counter: null, disabled_at: null }] },
      { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 },
    );
    const confirmed = await confirmOrVerifyTotpFactor("identity-1", code, now);
    expect(confirmed.confirmedNow).toBe(true);
    expect(confirmed.recoveryCodes).toHaveLength(10);
    expect(confirmed.recoveryCodes?.every((value) => /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/.test(value))).toBe(true);
    expect(query).toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "auth.totp.confirmed" }));
  });

  it("rejects an unavailable, unconfirmed, or replayed factor", async () => {
    transactionWithResponses({ rows: [] });
    await expect(verifyConfirmedTotpFactor("identity-1", "000000", new Date())).rejects.toBeInstanceOf(TotpFactorError);

    const enrollmentQuery = transactionWithResponses({ rows: [] });
    const enrollment = await enrollTotpFactor("identity-1");
    const ciphertext = (enrollmentQuery.mock.calls[1]![1] as unknown[])[2] as string;
    const now = new Date(1_800_000_000_000);
    const code = generateTotpCode(enrollment.secret, Math.floor(now.getTime() / 30_000));
    transactionWithResponses({ rows: [{ secret_ciphertext: ciphertext, confirmed_at: null, last_used_counter: null, disabled_at: null }] });
    await expect(verifyConfirmedTotpFactor("identity-1", code, now)).rejects.toThrow("not confirmed");
    transactionWithResponses({ rows: [{ secret_ciphertext: ciphertext, confirmed_at: new Date(), last_used_counter: String(Math.floor(now.getTime() / 30_000)), disabled_at: null }] });
    await expect(confirmOrVerifyTotpFactor("identity-1", code, now)).rejects.toThrow("already used");
  });

  it("rejects a six-digit code that does not match the enrolled factor", async () => {
    const enrollmentQuery = transactionWithResponses({ rows: [] });
    const enrollment = await enrollTotpFactor("identity-1");
    const ciphertext = (enrollmentQuery.mock.calls[1]![1] as unknown[])[2] as string;
    transactionWithResponses({ rows: [{ secret_ciphertext: ciphertext, confirmed_at: null, last_used_counter: null, disabled_at: null }] });
    await expect(confirmOrVerifyTotpFactor("identity-1", "000000", new Date(1_800_000_000_000))).rejects.toThrow("Invalid authentication code");
  });

  it("regenerates recovery codes only after a confirmed factor code", async () => {
    const enrollmentQuery = transactionWithResponses({ rows: [] });
    const enrollment = await enrollTotpFactor("identity-1");
    const ciphertext = (enrollmentQuery.mock.calls[1]![1] as unknown[])[2] as string;
    const now = new Date(1_800_000_000_000);
    const code = generateTotpCode(enrollment.secret, Math.floor(now.getTime() / 30_000));
    transactionWithResponses(
      { rows: [{ secret_ciphertext: ciphertext, confirmed_at: new Date(), last_used_counter: null, disabled_at: null }] },
      { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 },
    );
    await expect(regenerateTotpRecoveryCodes("identity-1", code, now)).resolves.toHaveLength(10);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "auth.totp.recovery_codes.regenerated" }));
  });

  it("uses a recovery code to replace the factor and revoke related access", async () => {
    const query = transactionWithResponses(
      { rows: [{ subject_id: "subject-1" }] },
      { rows: [{ confirmed_at: new Date(), disabled_at: null }] },
      { rows: [{ id: "recovery-1" }] },
      { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 }, { rowCount: 1 },
    );
    await expect(recoverTotpFactor({ identityId: "identity-1", sessionId: "session-1", code: "ABCD-EFGH-JKLM-NPQR" })).resolves.toMatchObject({ otpauthUri: expect.stringContaining("identity-1") });
    expect(query).toHaveBeenCalledTimes(8);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "auth.totp.recovered" }));
  });

  it("rejects malformed recovery codes and missing recovery configuration", async () => {
    await expect(recoverTotpFactor({ identityId: "identity-1", sessionId: "session-1", code: "bad" })).rejects.toThrow("Invalid recovery code");
    totpEnv.MFA_RECOVERY_CODE_PEPPER = "";
    await expect(recoverTotpFactor({ identityId: "identity-1", sessionId: "session-1", code: "ABCD-EFGH-JKLM-NPQR" })).rejects.toThrow("MFA recovery codes are not configured");
  });

  it("requires a confirmed active factor before it accepts a recovery code", async () => {
    transactionWithResponses({ rows: [{ subject_id: "subject-1" }] }, { rows: [{ confirmed_at: null, disabled_at: null }] });
    await expect(recoverTotpFactor({ identityId: "identity-1", sessionId: "session-1", code: "ABCD-EFGH-JKLM-NPQR" })).rejects.toThrow("active authenticator factor");
  });
});
