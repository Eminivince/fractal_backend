import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  NODE_ENV: "test",
  MALWARE_SCAN_HOST: undefined as string | undefined,
  MALWARE_SCAN_REQUIRED: false,
  MALWARE_SCAN_PORT: 3310,
  MALWARE_SCAN_TIMEOUT_MS: 1000,
  FILE_STORAGE_PROVIDER: "s3",
  FILE_STORAGE_FALLBACK_TO_LOCAL: false,
  FILE_STORAGE_DIR: ".fractal-test-storage",
  S3_BUCKET: "fractal-private",
  S3_REGION: "eu-west-1",
  S3_ENDPOINT: "https://s3.example.test",
  S3_ACCESS_KEY_ID: "access-key",
  S3_SECRET_ACCESS_KEY: "secret-key",
  S3_SESSION_TOKEN: "session-token",
  S3_KMS_KEY_ID: "kms-key",
  S3_FORCE_PATH_STYLE: true,
  S3_KEY_PREFIX: "private",
  CLOUDINARY_CLOUD_NAME: undefined as string | undefined,
  CLOUDINARY_API_KEY: undefined as string | undefined,
  CLOUDINARY_API_SECRET: undefined as string | undefined,
  CLOUDINARY_UPLOAD_FOLDER: undefined as string | undefined,
}));
const scanBuffer = vi.hoisted(() => vi.fn());
const MalwareDetectedError = vi.hoisted(() => class MalwareDetectedError extends Error {});
const MalwareScannerUnavailableError = vi.hoisted(() => class MalwareScannerUnavailableError extends Error {});

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../malware-scanner.js", () => ({ MalwareDetectedError, MalwareScannerUnavailableError, scanBufferWithClamAv: scanBuffer }));

import {
  deleteStoredFile,
  persistBusinessBinary,
  persistDossierBinary,
  persistGovernanceEvidenceBinary,
  persistKycBinary,
  persistOfferingImage,
  persistOfferingPublicationEvidenceBinary,
  persistOrganizationDocumentBinary,
  persistOrganizationVerificationEvidenceBinary,
  persistPrivacyExternalSnapshotBinary,
  persistPrivacyPackageBinary,
  persistProfessionalBinary,
  persistProfessionalFinanceExceptionBinary,
  persistSumsubPrivacyExportBinary,
  persistSupportAttachmentBinary,
  persistWorkOrderBinary,
  retrieveFile,
} from "../storage.js";

const pdfBase64 = Buffer.from("%PDF-1.7\nvalid", "utf8").toString("base64");
const fetchMock = vi.fn();

beforeEach(() => {
  env.FILE_STORAGE_PROVIDER = "s3";
  env.FILE_STORAGE_FALLBACK_TO_LOCAL = false;
  env.CLOUDINARY_CLOUD_NAME = undefined;
  env.CLOUDINARY_API_KEY = undefined;
  env.CLOUDINARY_API_SECRET = undefined;
  env.CLOUDINARY_UPLOAD_FOLDER = undefined;
  env.MALWARE_SCAN_HOST = undefined;
  fetchMock.mockReset();
  scanBuffer.mockReset();
  scanBuffer.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("S3 document storage", () => {
  it("uploads a signed, encrypted dossier to the configured private bucket", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    const result = await persistDossierBinary({ applicationId: "application-1", filename: "Valuation Report.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" });

    expect(result).toMatchObject({ storageKey: expect.stringMatching(/^s3:\/\/fractal-private\/private\/dossiers\/application-1\//), bytes: expect.any(Number), sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringMatching(/^https:\/\/s3\.example\.test\/fractal-private\/private\/dossiers\/application-1\//), expect.objectContaining({ method: "PUT", headers: expect.objectContaining({ "Content-Type": "application/pdf", "x-amz-server-side-encryption": "aws:kms", "x-amz-security-token": "session-token", Authorization: expect.stringContaining("AWS4-HMAC-SHA256") }) }));
  });

  it("retrieves signed S3 objects and returns their exact binary payload", async () => {
    const bytes = Buffer.from("stored private evidence");
    fetchMock.mockResolvedValue({ ok: true, arrayBuffer: vi.fn().mockResolvedValue(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)) });

    await expect(retrieveFile("s3://fractal-private/private/dossiers/application-1/evidence.pdf")).resolves.toEqual({ buffer: bytes });
    expect(fetchMock).toHaveBeenCalledWith("https://s3.example.test/fractal-private/private/dossiers/application-1/evidence.pdf", expect.objectContaining({ method: "GET", headers: expect.objectContaining({ Authorization: expect.stringContaining("AWS4-HMAC-SHA256") }) }));
  });

  it("deletes only objects in the configured bucket and refuses cross-bucket keys", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await expect(deleteStoredFile("s3://fractal-private/private/dossiers/application-1/evidence.pdf")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("https://s3.example.test/fractal-private/private/dossiers/application-1/evidence.pdf", expect.objectContaining({ method: "DELETE" }));
    await expect(deleteStoredFile("s3://attacker-bucket/private/dossiers/application-1/evidence.pdf")).rejects.toMatchObject({ statusCode: 422 });
  });

  it("reports provider failures without exposing an unbounded response body", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: vi.fn().mockResolvedValue("service unavailable") });
    await expect(persistDossierBinary({ applicationId: "application-1", filename: "report.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" })).rejects.toMatchObject({ statusCode: 502, message: expect.stringContaining("S3 upload failed with status 503") });
  });

  it.each([
    ["privacy package", () => persistPrivacyPackageBinary({ deliveryId: "delivery-1", content: Buffer.from('{"subject":"investor-1"}'), canonicalFormat: "application/vnd.fractal.privacy-package+json;version=1" }), "privacy-packages/delivery-1"],
    ["external privacy snapshot", () => persistPrivacyExternalSnapshotBinary({ snapshotId: "snapshot-1", content: Buffer.from('{"provider":"resend"}') }), "privacy-external-snapshots/snapshot-1"],
    ["governance evidence", () => persistGovernanceEvidenceBinary({ organizationId: "organization-1", offeringId: "offering-1", filename: "valuation.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "governance-evidence/organization-1/offering-1"],
    ["organization verification evidence", () => persistOrganizationVerificationEvidenceBinary({ organizationId: "organization-1", evidenceType: "incorporation", filename: "certificate.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "organization-verification-evidence/organization-1/incorporation"],
    ["offering publication evidence", () => persistOfferingPublicationEvidenceBinary({ organizationId: "organization-1", evidenceKind: "agreement", filename: "agreement.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "offering-publication-evidence/organization-1/agreement"],
    ["organization document", () => persistOrganizationDocumentBinary({ organizationId: "organization-1", documentId: "document-1", filename: "board-resolution.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "organization-documents/organization-1/document-1"],
    ["business evidence", () => persistBusinessBinary({ businessId: "business-1", filename: "registration.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "businesses/business-1"],
    ["KYC evidence", () => persistKycBinary({ investorUserId: "investor-1", filename: "identity.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "kyc/investor-1"],
    ["offering image", () => persistOfferingImage({ offeringId: "offering-1", filename: "hero.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "offering-images/offering-1"],
    ["professional evidence", () => persistProfessionalBinary({ professionalId: "professional-1", filename: "licence.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "professionals/professional-1"],
    ["work-order evidence", () => persistWorkOrderBinary({ workOrderId: "work-order-1", filename: "deliverable.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "work-orders/work-order-1"],
    ["restricted finance evidence", () => persistProfessionalFinanceExceptionBinary({ financeExceptionCaseId: "finance-case-1", filename: "exception.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" }), "professional-finance-exceptions/finance-case-1"],
  ])("stores %s in its private namespace", async (_name, persist, expectedPath) => {
    fetchMock.mockResolvedValue({ ok: true });

    const result = await persist();

    expect(result.storageKey).toContain(`s3://fractal-private/private/${expectedPath}/`);
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`/fractal-private/private/${expectedPath}/`), expect.objectContaining({ method: "PUT" }));
  });

  it("fails closed when mandatory malware screening is not configured", async () => {
    await expect(persistSupportAttachmentBinary({ caseId: "case-1", filename: "evidence.pdf", content: Buffer.from("%PDF-1.7\nvalid"), mimeType: "application/pdf" })).rejects.toMatchObject({ statusCode: 503 });
    await expect(persistSumsubPrivacyExportBinary({ exportId: "export-1", content: Buffer.from([0x50, 0x4b, 0x03, 0x04]) })).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("scans mandatory support and Sumsub evidence before private persistence", async () => {
    env.MALWARE_SCAN_HOST = "clamav.internal";
    fetchMock.mockResolvedValue({ ok: true });
    const support = await persistSupportAttachmentBinary({ caseId: "case-1", filename: "evidence.pdf", content: Buffer.from("%PDF-1.7\nvalid"), mimeType: "application/pdf" });
    const sumsub = await persistSumsubPrivacyExportBinary({ exportId: "export-1", content: Buffer.from([0x50, 0x4b, 0x03, 0x04]) });

    expect(scanBuffer).toHaveBeenNthCalledWith(1, expect.any(Buffer), { host: "clamav.internal", port: 3310, timeoutMs: 1000 });
    expect(scanBuffer).toHaveBeenNthCalledWith(2, expect.any(Buffer), { host: "clamav.internal", port: 3310, timeoutMs: 1000 });
    expect(support).toMatchObject({ storageKey: expect.stringContaining("support-case-attachments/case-1/"), scanner: "clamav_instream", scannedAt: expect.any(Date) });
    expect(sumsub).toMatchObject({ storageKey: expect.stringContaining("privacy-provider-exports/export-1/"), scanner: "clamav_instream", scannedAt: expect.any(Date) });
  });

  it("does not persist evidence that fails mandatory malware screening", async () => {
    env.MALWARE_SCAN_HOST = "clamav.internal";
    scanBuffer.mockRejectedValueOnce(new MalwareDetectedError("infected"));

    await expect(persistSupportAttachmentBinary({ caseId: "case-1", filename: "evidence.pdf", content: Buffer.from("%PDF-1.7\nvalid"), mimeType: "application/pdf" })).rejects.toMatchObject({ statusCode: 422 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns a retryable error when the mandatory scanner is unavailable", async () => {
    env.MALWARE_SCAN_HOST = "clamav.internal";
    scanBuffer.mockRejectedValueOnce(new MalwareScannerUnavailableError("offline"));

    await expect(persistSupportAttachmentBinary({ caseId: "case-1", filename: "evidence.pdf", content: Buffer.from("%PDF-1.7\nvalid"), mimeType: "application/pdf" })).rejects.toMatchObject({ statusCode: 503 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uploads a dossier to Cloudinary and exposes its provider URL only as a redirect", async () => {
    env.FILE_STORAGE_PROVIDER = "cloudinary";
    env.CLOUDINARY_CLOUD_NAME = "fractal-private";
    env.CLOUDINARY_API_KEY = "cloud-key";
    env.CLOUDINARY_API_SECRET = "cloud-secret";
    env.CLOUDINARY_UPLOAD_FOLDER = "private-evidence";
    fetchMock.mockResolvedValue({ ok: true, json: vi.fn().mockResolvedValue({ secure_url: "https://res.cloudinary.com/fractal-private/raw/upload/private-evidence/evidence.pdf" }) });

    const result = await persistDossierBinary({ applicationId: "application-1", filename: "Evidence.pdf", contentBase64: pdfBase64, mimeType: "application/pdf" });
    const retrieved = await retrieveFile(result.storageKey);

    expect(result.storageKey).toBe("https://res.cloudinary.com/fractal-private/raw/upload/private-evidence/evidence.pdf");
    expect(fetchMock).toHaveBeenCalledWith("https://api.cloudinary.com/v1_1/fractal-private/auto/upload", expect.objectContaining({ method: "POST", body: expect.any(FormData) }));
    expect(retrieved).toEqual({ buffer: Buffer.alloc(0), redirectUrl: result.storageKey });
  });
});
