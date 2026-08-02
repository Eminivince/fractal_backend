import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const claim = vi.hoisted(() => vi.fn());
const load = vi.hoisted(() => vi.fn());
const ready = vi.hoisted(() => vi.fn());
const retry = vi.hoisted(() => vi.fn());

vi.mock("../../config/env.js", () => ({ env: { OUTBOX_DISPATCH_BATCH_SIZE: 10, IDENTITY_VERIFICATION_APPLICATION_CLAIM_TIMEOUT_SECONDS: 30, IDENTITY_VERIFICATION_APPLICATION_MAX_ATTEMPTS: 3, IDENTITY_VERIFICATION_APPLICATION_RETRY_BASE_SECONDS: 5, IDENTITY_VERIFICATION_APPLICATION_DISPATCH_INTERVAL_MS: 60_000 } }));
vi.mock("../../platform/postgres-identity-verification-applications.js", () => ({ claimIdentityVerificationApplications: claim, loadClaimedIdentityVerificationApplication: load, markIdentityVerificationApplicationReady: ready, markIdentityVerificationApplicationForRetry: retry }));
vi.mock("../sumsub.js", () => {
  class SumsubApplicantNotFoundError extends Error {}
  class SumsubRequestError extends Error { statusCode: number; retryable: boolean; constructor(message: string, statusCode: number, retryable = true) { super(message); this.statusCode = statusCode; this.retryable = retryable; } }
  return { createApplicant: vi.fn(), getApplicantByExternalUserId: vi.fn(), SumsubApplicantNotFoundError, SumsubRequestError };
});

import { SumsubApplicantNotFoundError, SumsubRequestError } from "../sumsub.js";
import { dispatchPendingIdentityVerificationApplications, processIdentityVerificationApplication, startIdentityVerificationApplicationDispatcher } from "../identity-verification-application-dispatcher.js";

const application = { id: "application-1", identityId: "identity-1", provider: "sumsub", attempts: 1 } as any;
const details = { externalUserId: "identity-1", email: "person@example.com" } as any;
const applicant = { id: "applicant-1", inspectionId: "inspection-1", externalUserId: "identity-1" } as any;
const logger = { info: vi.fn(), error: vi.fn() };

beforeEach(() => { claim.mockReset(); load.mockReset(); ready.mockReset(); retry.mockReset(); logger.info.mockReset(); logger.error.mockReset(); load.mockResolvedValue(details); });
afterEach(() => vi.useRealTimers());

describe("identity-verification application dispatcher", () => {
  it("resolves an existing provider applicant and marks the local application ready", async () => {
    const lookup = vi.fn().mockResolvedValue(applicant);
    await expect(processIdentityVerificationApplication(application, "worker-1", lookup)).resolves.toBeUndefined();
    expect(load).toHaveBeenCalledWith({ applicationId: "application-1", workerId: "worker-1" });
    expect(ready).toHaveBeenCalledWith({ applicationId: "application-1", workerId: "worker-1", applicantId: "applicant-1", inspectionId: "inspection-1" });
  });

  it("creates a missing applicant and recovers a concurrent create conflict through a fresh lookup", async () => {
    const lookup = vi.fn().mockRejectedValueOnce(new SumsubApplicantNotFoundError()).mockResolvedValueOnce(applicant);
    const create = vi.fn().mockRejectedValueOnce(new SumsubRequestError("conflict", 409));
    await expect(processIdentityVerificationApplication(application, "worker-1", lookup, create)).resolves.toBeUndefined();
    expect(create).toHaveBeenCalledWith("identity-1", "person@example.com");
    expect(lookup).toHaveBeenCalledTimes(2);
    const directCreate = vi.fn().mockResolvedValue(applicant);
    await expect(processIdentityVerificationApplication(application, "worker-1", vi.fn().mockRejectedValueOnce(new SumsubApplicantNotFoundError()), directCreate)).resolves.toBeUndefined();
  });

  it("fails closed for unsupported providers, unrecoverable provider errors, and mismatched applicants", async () => {
    await expect(processIdentityVerificationApplication({ ...application, provider: "other" }, "worker-1")).rejects.toThrow("Unsupported");
    await expect(processIdentityVerificationApplication(application, "worker-1", vi.fn().mockRejectedValueOnce(new Error("network")))).rejects.toThrow("network");
    await expect(processIdentityVerificationApplication(application, "worker-1", vi.fn().mockResolvedValue({ ...applicant, externalUserId: "other" }))).rejects.toThrow("did not match");
    await expect(processIdentityVerificationApplication(application, "worker-1", vi.fn().mockRejectedValueOnce(new SumsubApplicantNotFoundError()), vi.fn().mockRejectedValueOnce(new SumsubRequestError("bad", 500)))).rejects.toThrow("bad");
  });

  it("claims applications, reports success, and schedules retry with terminal policy", async () => {
    claim.mockResolvedValueOnce([application, { ...application, id: "application-2", attempts: 3 }]);
    load.mockResolvedValueOnce(details).mockRejectedValueOnce(new Error("load failed"));
    await expect(dispatchPendingIdentityVerificationApplications({ workerId: "worker-1", logger, lookup: vi.fn().mockResolvedValue(applicant) })).resolves.toBe(2);
    expect(logger.info).toHaveBeenCalledWith({ applicationId: "application-1", identityId: "identity-1" }, "Identity-verification applicant is ready");
    expect(retry).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "application-2", workerId: "worker-1", terminal: true, error: expect.any(Error), retryAt: expect.any(Date) }));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "application-2", terminal: true, delaySeconds: 20 }), "Identity-verification applicant setup failed");
  });

  it("starts one protected dispatcher loop and reports unexpected top-level failures", async () => {
    vi.useFakeTimers(); claim.mockRejectedValueOnce(new Error("claim failed")).mockResolvedValue([]);
    const handle = startIdentityVerificationApplicationDispatcher({ logger });
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(0);
    expect(logger.error).toHaveBeenCalledWith({ err: expect.any(Error) }, "Identity-verification application dispatcher failed");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(claim).toHaveBeenCalledTimes(2);
    handle.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(claim).toHaveBeenCalledTimes(2);
  });
});
