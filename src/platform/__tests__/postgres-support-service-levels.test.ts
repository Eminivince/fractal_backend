import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: { query: vi.fn() }, transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { sweepSupportCaseServiceDeadlines } from "../postgres-support-service-levels.js";

const now = new Date("2026-07-29T10:00:00.000Z");
function transactionWithResponses(...responses: Array<{ rows?: unknown[] }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}
beforeEach(() => { mocks.postgres.query.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("support service-level deadline sweep", () => {
  it("records each due deadline type once and returns separate counts", async () => {
    const candidates = [
      { obligation_id: "obligation-1", case_id: "case-1", case_reference: "SUP-1", event_type: "acknowledgement_breached", due_at: new Date("2026-07-28") },
      { obligation_id: "obligation-2", case_id: "case-2", case_reference: "SUP-2", event_type: "escalated", due_at: new Date("2026-07-28") },
      { obligation_id: "obligation-3", case_id: "case-3", case_reference: "SUP-3", event_type: "resolution_breached", due_at: new Date("2026-07-28") },
    ];
    mocks.postgres.query.mockResolvedValueOnce({ rows: candidates }).mockResolvedValueOnce({});
    for (const candidate of candidates) transactionWithResponses({ rows: [{ id: `event-${candidate.obligation_id}` }] });
    await expect(sweepSupportCaseServiceDeadlines({ workerId: "worker-1", now, limit: 999 })).resolves.toEqual({ acknowledgementBreaches: 1, escalations: 1, resolutionBreaches: 1 });
    expect(mocks.audit).toHaveBeenCalledTimes(3);
    expect(mocks.outbox).toHaveBeenCalledTimes(3);
    expect(mocks.postgres.query).toHaveBeenLastCalledWith(expect.stringContaining("support_case_service_sweeps"), [expect.any(String), "worker-1", expect.any(Date), expect.any(Date), 1, 1, 1]);
  });

  it("does not count an already-recorded deadline event", async () => {
    mocks.postgres.query.mockResolvedValueOnce({ rows: [{ obligation_id: "obligation-1", case_id: "case-1", case_reference: "SUP-1", event_type: "acknowledgement_breached", due_at: now }] }).mockResolvedValueOnce({});
    transactionWithResponses({ rows: [] });
    await expect(sweepSupportCaseServiceDeadlines({ workerId: "worker-1", now, limit: 1 })).resolves.toEqual({ acknowledgementBreaches: 0, escalations: 0, resolutionBreaches: 0 });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("records a bounded failure detail when candidate discovery fails", async () => {
    mocks.postgres.query.mockRejectedValueOnce(new Error("database unavailable")).mockResolvedValueOnce({});
    await expect(sweepSupportCaseServiceDeadlines({ workerId: "worker-1", now })).rejects.toThrow("database unavailable");
    expect(mocks.postgres.query).toHaveBeenLastCalledWith(expect.stringContaining("support_service_sweep_failed"), [expect.any(String), "worker-1", expect.any(Date), expect.any(Date), "database unavailable"]);
  });
});
