import { beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const initiate = vi.hoisted(() => vi.fn());
const appendEvent = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ SUMSUB_ENABLED: false }));

vi.mock("../../db/models.js", () => ({ InvestorProfileModel: { find, updateOne: update } }));
vi.mock("../../services/sumsub-aml.service.js", () => ({ initiateAmlCheck: initiate }));
vi.mock("../../utils/audit.js", () => ({ appendEvent }));
vi.mock("../../config/env.js", () => ({ env }));

import { startSanctionsRescreeningWorker } from "../sanctions-rescreening.worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
  env.SUMSUB_ENABLED = false;
});

describe("sanctions re-screening worker", () => {
  it("stays inert when Sumsub is disabled", async () => {
    const worker = startSanctionsRescreeningWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    expect(find).not.toHaveBeenCalled();
  });

  it("requests AML re-screening, writes the check date, and records audit evidence", async () => {
    env.SUMSUB_ENABLED = true;
    find.mockReturnValue({ limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ _id: "profile-1", userId: "user-1", sumsubApplicantId: "applicant-1" }]) });
    initiate.mockResolvedValue({ inspectionId: "inspection-1" });
    update.mockResolvedValue(undefined);
    appendEvent.mockResolvedValue(undefined);
    const worker = startSanctionsRescreeningWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(initiate).toHaveBeenCalledWith("applicant-1");
    expect(update).toHaveBeenCalledWith({ _id: "profile-1" }, { $set: { amlCheckedAt: expect.any(Date) } });
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "system" }), expect.objectContaining({ entityId: "user-1", action: "SanctionsRescreenInitiated" }));
    expect(log.info).toHaveBeenCalledWith("[sanctions-rescreening] re-screened 1 investor(s)");
  });

  it("logs individual and outer failures and runs the daily schedule", async () => {
    vi.useFakeTimers();
    try {
      env.SUMSUB_ENABLED = true;
      find.mockReturnValueOnce({ limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ _id: "profile-1", userId: "user-1", sumsubApplicantId: "applicant-1" }]) })
        .mockReturnValueOnce({ limit: vi.fn().mockReturnThis(), lean: vi.fn().mockRejectedValue(new Error("Database unavailable")) });
      initiate.mockRejectedValue(new Error("Sumsub unavailable"));
      const worker = startSanctionsRescreeningWorker(log);
      await worker.triggerNow();
      await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
      worker.stop();
      expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ investorProfileId: "profile-1" }), expect.stringContaining("AML re-screen failed"));
      expect(log.error).toHaveBeenCalledWith(expect.any(Error), "[sanctions-rescreening] worker error");
    } finally {
      vi.useRealTimers();
    }
  });
});
