import { beforeEach, describe, expect, it, vi } from "vitest";

const findOne = vi.hoisted(() => vi.fn());
const workerEnv = vi.hoisted(() => ({ WORK_ORDER_SLA_ESCALATION_ENABLED: true, WORK_ORDER_SLA_ESCALATION_INTERVAL_MS: 60_000, WORK_ORDER_SLA_ESCALATION_BATCH_LIMIT: 50 }));
vi.mock("../../config/env.js", () => ({ env: workerEnv }));
vi.mock("../../db/models.js", () => ({ UserModel: { findOne } }));
import { startWorkOrderSlaWorker } from "../work-order-sla-worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const chain = (value: unknown) => ({ select: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue(value) });
beforeEach(() => { findOne.mockReset(); log.info.mockReset(); log.warn.mockReset(); log.error.mockReset(); workerEnv.WORK_ORDER_SLA_ESCALATION_ENABLED = true; });

describe("work-order SLA worker", () => {
  it("returns a safe inert handle when disabled", async () => {
    workerEnv.WORK_ORDER_SLA_ESCALATION_ENABLED = false;
    const handle = startWorkOrderSlaWorker({} as any, log);
    await handle.triggerNow(); handle.stop();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });

  it("uses an operator token to escalate and reports successful escalations", async () => {
    findOne.mockReturnValueOnce(chain({ _id: "operator-1", role: "operator", businessId: "business-1" }));
    const app = { jwt: { sign: vi.fn().mockReturnValue("token") }, inject: vi.fn().mockResolvedValue({ statusCode: 200, body: '{"escalatedCount":2}' }) };
    const handle = startWorkOrderSlaWorker(app as any, log); await handle.triggerNow(); handle.stop();
    expect(app.inject).toHaveBeenCalledWith(expect.objectContaining({ headers: expect.objectContaining({ authorization: "Bearer token" }), payload: { limit: 50 } }));
    expect(log.warn).toHaveBeenCalledWith("Work-order SLA worker escalated overdue work-orders=2");
  });

  it("uses an admin fallback and handles missing actors, bad responses, and thrown errors", async () => {
    findOne.mockReturnValueOnce(chain(null)).mockReturnValueOnce(chain({ _id: "admin-1", role: "admin" }));
    const app = { jwt: { sign: vi.fn().mockReturnValue("token") }, inject: vi.fn().mockResolvedValue({ statusCode: 500, body: "failure" }) };
    let handle = startWorkOrderSlaWorker(app as any, log); await handle.triggerNow(); handle.stop();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("status=500"));
    findOne.mockReturnValueOnce(chain(null)).mockReturnValueOnce(chain(null));
    handle = startWorkOrderSlaWorker(app as any, log); await handle.triggerNow(); handle.stop();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no active operator"));
    findOne.mockReturnValueOnce(chain({ _id: "operator-1", role: "operator" }));
    handle = startWorkOrderSlaWorker({ jwt: { sign: vi.fn(() => { throw new Error("sign failed"); }) } } as any, log); await handle.triggerNow(); handle.stop();
    expect(log.error).toHaveBeenCalledWith("Work-order SLA worker error: sign failed");
  });
});
