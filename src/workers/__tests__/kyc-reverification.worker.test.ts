import { beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());
const resetApplicant = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ SUMSUB_ENABLED: false }));

vi.mock("../../db/models.js", () => ({ InvestorProfileModel: { find, findByIdAndUpdate: update } }));
vi.mock("../../services/notifications.js", () => ({ createNotificationsFromEvent: notify }));
vi.mock("../../services/sumsub.js", () => ({ resetApplicant }));
vi.mock("../../config/env.js", () => ({ env }));

import { startKycReverificationWorker } from "../kyc-reverification.worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

beforeEach(() => {
  vi.clearAllMocks();
  env.SUMSUB_ENABLED = false;
});

describe("KYC re-verification worker", () => {
  it("marks expired KYC records for renewal and notifies the investor", async () => {
    find.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: "profile-1", userId: "user-1", sumsubApplicantId: "applicant-1" }]) });
    update.mockResolvedValue(undefined);
    notify.mockResolvedValue(undefined);
    const worker = startKycReverificationWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(resetApplicant).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith("profile-1", { kycStatus: "renewal_required", sumsubReviewAnswer: null });
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "system" }), expect.objectContaining({ entityId: "user-1", action: "KYCRenewalRequired" }));
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Flagged 1 profiles"));
  });

  it("resets a Sumsub applicant and continues after a reset failure", async () => {
    env.SUMSUB_ENABLED = true;
    find.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: "profile-1", userId: "user-1", sumsubApplicantId: "applicant-ok" }, { _id: "profile-2", userId: "user-2", sumsubApplicantId: "applicant-fail" }]) });
    resetApplicant.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Sumsub unavailable"));
    update.mockResolvedValue(undefined);
    notify.mockResolvedValue(undefined);
    const worker = startKycReverificationWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(resetApplicant).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ investorProfileId: "profile-2" }), expect.stringContaining("reset failed"));
  });

  it("logs an outer query failure and runs its weekly schedule", async () => {
    vi.useFakeTimers();
    try {
      find.mockReturnValue({ lean: vi.fn().mockRejectedValue(new Error("Database unavailable")) });
      const worker = startKycReverificationWorker(log);
      await worker.triggerNow();
      await vi.advanceTimersByTimeAsync(7 * 24 * 60 * 60 * 1000);
      worker.stop();
      expect(log.error).toHaveBeenCalledWith(expect.any(Error), "[kyc-reverification-worker] error");
      expect(find).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
