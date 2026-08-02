import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn(), audit: vi.fn() }));
vi.mock("../../config/env.js", () => ({ env: { AUTH_STEP_UP_TTL_SECONDS: 900, MFA_TOTP_ENABLED: true } }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));

import { grantTotpStepUp, requireFreshTotpStepUp, StepUpRequiredError } from "../auth-step-up.js";

function transactionWithResponses(...responses: Array<{ rows?: unknown[] }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); });

describe("TOTP step-up grants", () => {
  it("grants a time-bounded session grant and writes the audit event", async () => {
    const before = Date.now();
    const query = transactionWithResponses({ rows: [{ value: 1 }] }, {});
    const result = await grantTotpStepUp({ sessionId: "session-1", identityId: "identity-1" });
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining("auth_step_up_grants"), ["session-1", "identity-1", result.expiresAt]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "auth.step_up.granted", entityId: "session-1" }));
  });

  it("does not grant step-up access to an inactive session", async () => {
    transactionWithResponses({ rows: [] });
    await expect(grantTotpStepUp({ sessionId: "session-1", identityId: "identity-1" })).rejects.toBeInstanceOf(StepUpRequiredError);
  });

  it("requires both a server-backed session and a current grant", async () => {
    await expect(requireFreshTotpStepUp({ identityId: "identity-1" })).rejects.toThrow("server-backed session");
    mocks.postgres.query.mockResolvedValueOnce({ rows: [] });
    await expect(requireFreshTotpStepUp({ sessionId: "session-1", identityId: "identity-1" })).rejects.toThrow("step-up verification");
    mocks.postgres.query.mockResolvedValueOnce({ rows: [{ value: 1 }] });
    await expect(requireFreshTotpStepUp({ sessionId: "session-1", identityId: "identity-1" })).resolves.toBeUndefined();
  });
});
