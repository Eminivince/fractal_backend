import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ SUMSUB_SECRET_KEY: "sumsub-secret", SUMSUB_APP_TOKEN: "sumsub-token" }));
vi.mock("../../config/env.js", () => ({ env }));

async function loadAmlService() {
  vi.resetModules();
  return import("../sumsub-aml.service.js");
}

beforeEach(() => {
  env.SUMSUB_SECRET_KEY = "sumsub-secret";
  env.SUMSUB_APP_TOKEN = "sumsub-token";
});

afterEach(() => vi.unstubAllGlobals());

describe("Sumsub AML service", () => {
  it("starts an AML inspection with signed provider headers", async () => {
    const json = vi.fn().mockResolvedValue({ inspectionId: "inspection-1" });
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json });
    vi.stubGlobal("fetch", fetchMock);
    const service = await loadAmlService();

    await expect(service.initiateAmlCheck("applicant-1")).resolves.toEqual({ inspectionId: "inspection-1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.sumsub.com/resources/applicants/applicant-1/amlScreening");
    expect(init).toMatchObject({ method: "POST", headers: expect.objectContaining({ "X-App-Token": "sumsub-token" }) });
    const headers = init.headers as Record<string, string>;
    const expected = crypto.createHmac("sha256", "sumsub-secret")
      .update(`${headers["X-App-Access-Ts"]}POST/resources/applicants/applicant-1/amlScreening`)
      .digest("hex");
    expect(headers["X-App-Access-Sig"]).toBe(expected);
  });

  it("returns provider error detail and rejects missing credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 422, text: vi.fn().mockResolvedValue("Applicant is not eligible") }));
    let service = await loadAmlService();
    await expect(service.initiateAmlCheck("applicant-1")).rejects.toThrow("Sumsub AML check failed (422): Applicant is not eligible");

    env.SUMSUB_APP_TOKEN = undefined as any;
    service = await loadAmlService();
    await expect(service.initiateAmlCheck("applicant-1")).rejects.toThrow("SUMSUB_APP_TOKEN is not configured");

    env.SUMSUB_APP_TOKEN = "sumsub-token";
    env.SUMSUB_SECRET_KEY = undefined as any;
    service = await loadAmlService();
    await expect(service.initiateAmlCheck("applicant-1")).rejects.toThrow("SUMSUB_SECRET_KEY is not configured");
  });

  it("classifies AML webhook results", async () => {
    const service = await loadAmlService();
    expect(service.parseAmlWebhookResult({ type: "other", applicantId: "applicant-1" })).toBeNull();
    expect(service.parseAmlWebhookResult({ type: "applicantReviewed", applicantId: "applicant-1", reviewResult: { reviewAnswer: "GREEN" } })).toEqual({ status: "clear" });
    expect(service.parseAmlWebhookResult({ type: "applicantReviewed", applicantId: "applicant-1", reviewResult: { reviewAnswer: "RED", rejectLabels: ["SANCTIONS_LIST"] } })).toEqual({ status: "rejected" });
    expect(service.parseAmlWebhookResult({ type: "applicantReviewed", applicantId: "applicant-1", reviewResult: { reviewAnswer: "RED", rejectLabels: ["IDENTITY_DOCUMENT"] } })).toEqual({ status: "flagged" });
    expect(service.parseAmlWebhookResult({ type: "applicantReviewed", applicantId: "applicant-1" })).toBeNull();
  });
});
