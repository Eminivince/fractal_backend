import { createHash, createHmac } from "node:crypto";
import { ZipFile } from "yazl";
import { describe, expect, it, vi } from "vitest";
import {
  collectSumsubPrivacyRecords,
  parseSumsubProviderExportArchive,
  SumsubPrivacyAdapterError,
  type SumsubProviderExportArtifact,
} from "../privacy-external-sumsub-adapter.js";

const applicantId = "sumsub-applicant-1";
const externalUserId = "00000000-0000-4000-8000-000000000001";
const inspectionId = "sumsub-inspection-1";
const settingsContent = Buffer.from('{"reportType":"applicant","selection":"controlled"}', "utf8");

async function zip(entries: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
  const archive = new ZipFile();
  const chunks: Buffer[] = [];
  const complete = new Promise<Buffer>((resolve, reject) => {
    archive.outputStream.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    archive.outputStream.once("error", reject);
    archive.outputStream.once("end", () => resolve(Buffer.concat(chunks)));
  });
  for (const entry of entries) {
    archive.addBuffer(entry.content, entry.name, {
      mtime: new Date("2026-07-27T08:00:00.000Z"),
      mode: 0o100600,
      compress: true,
    });
  }
  archive.end();
  return complete;
}

const reportContent = Buffer.from(
  `applicantId,externalUserId,email\r\n${applicantId},${externalUserId},ada@example.test\r\n`,
  "utf8",
);
const exportContent = await zip([
  { name: "applicants.csv", content: reportContent },
  { name: "report-settings.json", content: settingsContent },
]);

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function providerExport(overrides: Partial<SumsubProviderExportArtifact> = {}): SumsubProviderExportArtifact {
  return {
    reportReference: "sumsub-report-20260727-001",
    applicantId,
    externalUserId,
    entryCount: 1,
    generatedAt: "2026-07-27T08:00:00.000Z",
    downloadedAt: "2026-07-27T08:05:00.000Z",
    sensitiveTier: "higher_sensitive_data",
    content: exportContent,
    sha256: digest(exportContent),
    settingsSha256: digest(settingsContent),
    malwareScanEvidenceSha256: digest("clean-scan-evidence"),
    ...overrides,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function responses() {
  return new Map<string, Response | (() => Response)>([
    [`/resources/applicants/${applicantId}/one`, () => json({
      id: applicantId,
      externalUserId,
      inspectionId,
      info: { firstName: "Ada", lastName: "Example" },
    })],
    [`/resources/applicants/${applicantId}/review/history`, () => json({
      items: [{ attemptId: "attempt-1", reviewStatus: "completed" }],
      totalItems: 1,
    })],
    [`/resources/applicants/${applicantId}/requiredIdDocsStatus`, () => json({
      IDENTITY: { imageIds: ["image-1"] },
      SELFIE: { imageIds: ["image-2"] },
    })],
    [`/resources/applicants/${applicantId}/metadata/resources`, () => json({
      items: [
        { id: "image-1", source: "docapture", idDocDef: { idDocType: "PASSPORT" } },
        { id: "image-2", source: "liveness", idDocDef: { idDocType: "SELFIE" } },
      ],
      totalItems: 2,
    })],
    [`/resources/applicants/${applicantId}/acceptedAgreements`, () => json({
      applicantAgreements: [{ acceptedAt: "2026-07-27 07:00:00", records: [{ content: "Consent" }] }],
    })],
    [`/resources/checks/latest?type=IP_CHECK&applicantId=${applicantId}`, () => json({
      checks: [{ checkType: "IP_CHECK", ipCheckInfo: { ip: "192.0.2.1" } }],
    })],
    [`/resources/applicantActions/-;applicantId=${applicantId}?limit=1000&offset=0`, () => json({
      items: [{ id: "action-1", reviewStatus: "completed" }],
      totalItems: 1,
    })],
    [`/resources/api/applicants/${applicantId}/amlCase`, () => json({
      targetEntityId: applicantId,
      hits: [],
      review: { reviewAnswer: "GREEN" },
    })],
    [`/resources/inspections/${inspectionId}/resources/image-1`, () => new Response(
      Buffer.from("passport-image"),
      { status: 200, headers: { "Content-Type": "image/jpeg" } },
    )],
    [`/resources/inspections/${inspectionId}/resources/image-2`, () => new Response(
      Buffer.from("selfie-image"),
      { status: 200, headers: { "Content-Type": "image/png" } },
    )],
  ]);
}

function input(request: (url: string, init: RequestInit) => Promise<Response>) {
  return {
    appToken: "sumsub-privacy-app-token",
    secretKey: "sumsub-privacy-secret-key",
    reference: { applicantId, externalUserId, inspectionId },
    providerExport: providerExport(),
    timeoutMs: 10_000,
    maximumRecords: 100,
    maximumBytes: 5 * 1024 * 1024,
    maximumArtifacts: 10,
    request,
    now: new Date("2026-07-27T09:00:00.000Z"),
  };
}

describe("Sumsub complete privacy adapter", () => {
  it("requires exact correlation and collects all eight components with binary artifacts", async () => {
    const available = responses();
    const request = vi.fn(async (url: string, init: RequestInit) => {
      const parsed = new URL(url);
      const path = `${parsed.pathname}${parsed.search}`;
      const response = available.get(path);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      const timestamp = "1785142800";
      expect((init.headers as Record<string, string>)["X-App-Access-Ts"]).toBe(timestamp);
      expect((init.headers as Record<string, string>)["X-App-Access-Sig"]).toBe(
        createHmac("sha256", "sumsub-privacy-secret-key")
          .update(`${timestamp}GET${path}`)
          .digest("hex"),
      );
      if (!response) return new Response(null, { status: 404 });
      return typeof response === "function" ? response() : response;
    });

    const result = await collectSumsubPrivacyRecords(input(request));

    expect(result.records.map((record) => record.componentKey)).toEqual([
      "applicant_profile",
      "review_results",
      "identity_documents",
      "biometric_media",
      "questionnaire_and_consent",
      "device_and_network_metadata",
      "screening_and_watchlist_results",
      "provider_export_artifacts",
    ]);
    expect(result.artifacts).toHaveLength(3);
    expect(result.artifacts.map((artifact) => artifact.componentKey)).toEqual([
      "provider_export_artifacts",
      "identity_documents",
      "biometric_media",
    ]);
    expect(result.records.at(-1)).toMatchObject({
      reportReference: "sumsub-report-20260727-001",
      sensitiveTier: "higher_sensitive_data",
      sha256: digest(exportContent),
      reportFileName: "applicants.csv",
      settingsFileName: "report-settings.json",
      reportColumns: ["applicantId", "externalUserId", "email"],
      sensitiveColumns: ["email"],
    });
    expect(request).toHaveBeenCalledTimes(10);
  });

  it("rejects a provider applicant that does not match the immutable application", async () => {
    const available = responses();
    available.set(`/resources/applicants/${applicantId}/one`, () => json({
      id: "different-applicant",
      externalUserId,
      inspectionId,
    }));
    const request = vi.fn(async (url: string) => {
      const parsed = new URL(url);
      const response = available.get(`${parsed.pathname}${parsed.search}`);
      return typeof response === "function" ? response() : response ?? new Response(null, { status: 404 });
    });

    await expect(collectSumsubPrivacyRecords(input(request))).rejects.toMatchObject({
      name: "SumsubPrivacyAdapterError",
      category: "correlation_mismatch",
    });
    expect(request).toHaveBeenCalledOnce();
  });

  it("rejects a missing, changed, or lower-sensitive provider export before API access", async () => {
    const request = vi.fn(async () => json({}));
    await expect(collectSumsubPrivacyRecords({
      ...input(request),
      providerExport: providerExport({ sha256: "0".repeat(64) }),
    })).rejects.toBeInstanceOf(SumsubPrivacyAdapterError);
    await expect(collectSumsubPrivacyRecords({
      ...input(request),
      providerExport: {
        ...providerExport(),
        sensitiveTier: "lower_sensitive_data" as "higher_sensitive_data",
      },
    })).rejects.toMatchObject({ category: "provider_export_missing" });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects changed settings, multiple applicants, and reports without sensitive columns", async () => {
    await expect(parseSumsubProviderExportArchive({
      content: exportContent,
      applicantId,
      externalUserId,
      settingsSha256: "0".repeat(64),
      maximumBytes: 5 * 1024 * 1024,
    })).rejects.toMatchObject({ category: "provider_export_missing" });

    const multipleApplicants = await zip([
      {
        name: "applicants.csv",
        content: Buffer.from(
          `applicantId,externalUserId,email\r\n${applicantId},${externalUserId},ada@example.test\r\nother,other@example.test,other@example.test\r\n`,
          "utf8",
        ),
      },
      { name: "report-settings.json", content: settingsContent },
    ]);
    await expect(parseSumsubProviderExportArchive({
      content: multipleApplicants,
      applicantId,
      externalUserId,
      settingsSha256: digest(settingsContent),
      maximumBytes: 5 * 1024 * 1024,
    })).rejects.toMatchObject({ category: "provider_export_missing" });

    const lowerSensitive = await zip([
      {
        name: "applicants.csv",
        content: Buffer.from(
          `applicantId,externalUserId\r\n${applicantId},${externalUserId}\r\n`,
          "utf8",
        ),
      },
      { name: "report-settings.json", content: settingsContent },
    ]);
    await expect(parseSumsubProviderExportArchive({
      content: lowerSensitive,
      applicantId,
      externalUserId,
      settingsSha256: digest(settingsContent),
      maximumBytes: 5 * 1024 * 1024,
    })).rejects.toMatchObject({ category: "provider_export_missing" });
  });

  it("rejects incomplete document metadata and response bodies above the byte limit", async () => {
    const incomplete = responses();
    incomplete.set(`/resources/applicants/${applicantId}/metadata/resources`, () => json({
      items: [{ id: "image-1", idDocDef: { idDocType: "PASSPORT" } }],
      totalItems: 2,
    }));
    const incompleteRequest = async (url: string) => {
      const parsed = new URL(url);
      const response = incomplete.get(`${parsed.pathname}${parsed.search}`);
      return typeof response === "function" ? response() : response ?? new Response(null, { status: 404 });
    };
    await expect(collectSumsubPrivacyRecords(input(incompleteRequest)))
      .rejects.toMatchObject({ category: "provider_response_invalid" });

    const oversizedRequest = async () => new Response(null, {
      status: 200,
      headers: { "Content-Type": "application/json", "Content-Length": String(10 * 1024 * 1024) },
    });
    await expect(collectSumsubPrivacyRecords(input(oversizedRequest)))
      .rejects.toMatchObject({ category: "provider_response_too_large" });
  });
});
