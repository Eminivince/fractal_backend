import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  SUMSUB_SECRET_KEY: "sumsub-secret",
  SUMSUB_APP_TOKEN: "sumsub-token",
  SUMSUB_LEVEL_NAME: "basic-kyc-level",
  SUMSUB_REQUEST_TIMEOUT_MS: 500,
  SUMSUB_SDK_TOKEN_TTL_SECONDS: 600,
  SUMSUB_WEBHOOK_SECRET: "sumsub-webhook-secret",
}));
vi.mock("../../config/env.js", () => ({ env }));

async function loadSumsub() {
  vi.resetModules();
  return import("../sumsub.js");
}

function response(data: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: vi.fn().mockResolvedValue(data) };
}

beforeEach(() => {
  env.SUMSUB_SECRET_KEY = "sumsub-secret";
  env.SUMSUB_APP_TOKEN = "sumsub-token";
  env.SUMSUB_LEVEL_NAME = "basic-kyc-level";
  env.SUMSUB_REQUEST_TIMEOUT_MS = 500;
  env.SUMSUB_SDK_TOKEN_TTL_SECONDS = 600;
  env.SUMSUB_WEBHOOK_SECRET = "sumsub-webhook-secret";
});
afterEach(() => vi.unstubAllGlobals());

describe("Sumsub applicant adapter", () => {
  it("creates, reads, resets applicants, and creates SDK tokens with signed requests", async () => {
    const applicant = { id: "applicant-1", createdAt: "2026-01-01", inspectionId: "inspection-1", externalUserId: "user-1" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(applicant))
      .mockResolvedValueOnce(response(applicant))
      .mockResolvedValueOnce(response(applicant))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ token: "sdk-token", userId: "user-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const sumsub = await loadSumsub();

    await expect(sumsub.createApplicant("user-1", "user@fractal.test")).resolves.toEqual(applicant);
    await expect(sumsub.getApplicant("applicant-1")).resolves.toEqual(applicant);
    await expect(sumsub.getApplicantByExternalUserId(" user-1 ")).resolves.toEqual(applicant);
    await expect(sumsub.resetApplicant("applicant-1")).resolves.toBeUndefined();
    await expect(sumsub.generateAccessToken("user-1")).resolves.toEqual({ token: "sdk-token", userId: "user-1" });

    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.sumsub.com/resources/applicants?levelName=basic-kyc-level");
    expect(fetchMock.mock.calls[2]?.[0]).toContain("/byExternalUserId/user-1");
    expect(fetchMock.mock.calls[4]?.[0]).toBe("https://api.sumsub.com/resources/accessTokens/sdk");
    expect(JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body))).toEqual({ userId: "user-1", levelName: "basic-kyc-level", ttlInSecs: 600 });
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers).toMatchObject({ "X-App-Token": "sumsub-token", "Content-Type": "application/json" });
  });

  it("validates external IDs, SDK token input, and webhook signatures", async () => {
    const sumsub = await loadSumsub();
    await expect(sumsub.getApplicantByExternalUserId(" ")).rejects.toThrow("external user ID is required");
    expect(() => sumsub.sumsubSdkAccessTokenPayload({ externalUserId: " ", levelName: "basic", ttlInSecs: 600 })).toThrow("external user ID");
    expect(() => sumsub.sumsubSdkAccessTokenPayload({ externalUserId: "user", levelName: " ", ttlInSecs: 600 })).toThrow("verification level");
    expect(() => sumsub.sumsubSdkAccessTokenPayload({ externalUserId: "user", levelName: "basic", ttlInSecs: 59 })).toThrow("TTL");
    expect(sumsub.sumsubSdkAccessTokenPayload({ externalUserId: " user ", levelName: " basic ", ttlInSecs: 600 })).toEqual({ userId: "user", levelName: "basic", ttlInSecs: 600 });
    const body = '{"type":"applicantReviewed"}';
    const signature = crypto.createHmac("sha256", "sumsub-webhook-secret").update(body).digest("hex");
    expect(sumsub.verifySumsubWebhookSignature(body, signature)).toBe(true);
    expect(sumsub.verifySumsubWebhookSignature(body, "invalid")).toBe(false);
    env.SUMSUB_WEBHOOK_SECRET = undefined as any;
    env.SUMSUB_SECRET_KEY = undefined as any;
    expect(sumsub.verifySumsubWebhookSignature(body, signature)).toBe(false);
  });
});

describe("Sumsub provider failures", () => {
  it("classifies missing configuration, provider errors, invalid JSON, and connection failures", async () => {
    env.SUMSUB_APP_TOKEN = undefined as any;
    let sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toThrow("SUMSUB_APP_TOKEN is not configured");

    env.SUMSUB_APP_TOKEN = "sumsub-token";
    env.SUMSUB_SECRET_KEY = undefined as any;
    sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toThrow("SUMSUB_SECRET_KEY is not configured");

    env.SUMSUB_SECRET_KEY = "sumsub-secret";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 404)));
    sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toMatchObject({ name: "SumsubApplicantNotFoundError", retryable: false, statusCode: 404 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({}, 503)));
    sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toMatchObject({ name: "SumsubRequestError", retryable: true, statusCode: 503 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: vi.fn().mockRejectedValue(new Error("bad JSON")) }));
    sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toThrow("response was invalid");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" })));
    sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toThrow("request timed out");

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));
    sumsub = await loadSumsub();
    await expect(sumsub.getApplicant("applicant-1")).rejects.toThrow("could not be completed");
  });
});
