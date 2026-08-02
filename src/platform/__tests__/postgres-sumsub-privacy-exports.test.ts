import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), capability: vi.fn(), audit: vi.fn(), outbox: vi.fn(), configuration: vi.fn(), parsePolicy: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability, AdministratorCapabilityError: class AdministratorCapabilityError extends Error {} }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: mocks.configuration }));
vi.mock("../../modules/privacy/domain/privacy-package-policy.js", () => ({ parsePrivacyPackagePolicy: mocks.parsePolicy }));

import { authorizeSumsubPrivacyExportUpload, expireAndQueueSumsubPrivacyExportCleanup, listAdministratorSumsubPrivacyExports, mapSumsubPrivacyExport, queueSumsubPrivacyExportCleanupAfterSnapshot, recordSumsubPrivacyExportUpload, SumsubPrivacyExportError, sumsubPrivacyScanEvidenceSha256 } from "../postgres-sumsub-privacy-exports.js";

const now = new Date("2026-07-29T12:00:00.000Z");
const row = (overrides: Record<string, unknown> = {}) => ({ id: "export-1", reference: "PVE-20260729-ABCD1234", privacy_request_id: "request-1", requester_identity_id: "requester-1", request_type: "access", source_key: "external.identity_verification.provider", applicant_id: "applicant-1", external_user_id: "external-1", inspection_id: "inspection-1", report_reference: "report-1", entry_count: 1, sensitive_tier: "higher_sensitive_data", generated_at: now, downloaded_at: now, uploaded_at: now, content_sha256: "a".repeat(64), byte_count: 10, settings_sha256: "b".repeat(64), scanner: "clamav_instream", scanned_at: now, malware_scan_evidence_sha256: "c".repeat(64), storage_key: "privacy/export-1.json", status: "staged", retain_until: new Date("2026-08-01T12:00:00.000Z"), destroyed_at: null, failure_category: null, uploaded_by_identity_id: "admin-1", command_key: "command-1", ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); mocks.configuration.mockReset(); mocks.parsePolicy.mockReset(); });

describe("Sumsub privacy exports", () => {
  it("maps staged higher-sensitive exports and creates deterministic malware-scan evidence", () => {
    expect(mapSumsubPrivacyExport(row() as never)).toMatchObject({ id: "export-1", status: "staged", scan: { status: "clean", scanner: "clamav_instream", scannedAt: now.toISOString() }, retainUntil: "2026-08-01T12:00:00.000Z" });
    const input = { scanner: "clamav_instream" as const, scannedAt: now, contentSha256: "a".repeat(64), byteCount: 10 };
    expect(sumsubPrivacyScanEvidenceSha256(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(sumsubPrivacyScanEvidenceSha256(input)).toBe(sumsubPrivacyScanEvidenceSha256(input));
  });

  it("rejects invalid upload staging inputs before it starts a transaction", async () => {
    await expect(authorizeSumsubPrivacyExportUpload({ actorIdentityId: "admin-1", privacyRequestId: "request-1", reportReference: " ", generatedAt: now, downloadedAt: now, settingsSha256: "a".repeat(64), commandKey: "command-1", now })).rejects.toBeInstanceOf(SumsubPrivacyExportError);
    await expect(authorizeSumsubPrivacyExportUpload({ actorIdentityId: "admin-1", privacyRequestId: "request-1", reportReference: "report-1", generatedAt: now, downloadedAt: new Date("2026-07-31T12:00:00.000Z"), settingsSha256: "invalid", commandKey: "command-1", now })).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("does not create cleanup work for a zero batch and queues cleanup for a staged snapshot export", async () => {
    await expect(expireAndQueueSumsubPrivacyExportCleanup(0, now)).resolves.toBe(0);
    const client = { query: vi.fn().mockResolvedValueOnce({ rows: [row()] }).mockResolvedValueOnce({}).mockResolvedValueOnce({}) };
    await expect(queueSumsubPrivacyExportCleanupAfterSnapshot(client as never, { providerExportId: "export-1", snapshotId: "snapshot-1", now })).resolves.toBeUndefined();
    expect(mocks.audit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "privacy.request.sumsub_provider_export_cleanup_requested" }));
  });

  it("rejects unavailable exports and malformed existing cleanup state", async () => {
    const missing = { query: vi.fn().mockResolvedValueOnce({ rows: [] }) };
    await expect(queueSumsubPrivacyExportCleanupAfterSnapshot(missing as never, { providerExportId: "export-1", snapshotId: "snapshot-1", now })).rejects.toMatchObject({ code: "conflict" });
    const malformed = { query: vi.fn().mockResolvedValueOnce({ rows: [row({ status: "cleanup_requested" })] }).mockResolvedValueOnce({ rowCount: 0 }) };
    await expect(queueSumsubPrivacyExportCleanupAfterSnapshot(malformed as never, { providerExportId: "export-1", snapshotId: "snapshot-1", now })).rejects.toThrow("no durable task");
  });

  it("authorizes an assigned owner to stage an exact ready Sumsub export", async () => {
    mocks.configuration.mockResolvedValue({ versionId: "policy-1", versionNumber: 1, projectionVersion: 1, valueSha256: "b".repeat(64), value: {} });
    mocks.parsePolicy.mockReturnValue({ schemaVersion: "privacy-package-policy-v2", canonicalFormat: "application/vnd.fractal.privacy-package+tar;version=2", maximumArtifacts: 1, packageRetentionHours: 24 });
    transactionWithResponses(
      { rowCount: 1 }, { rowCount: 1 }, { rows: [] },
      { rows: [{ id: "request-1", requester_identity_id: "requester-1", request_type: "access", status: "in_review", assigned_to_identity_id: "admin-1" }] },
      { rows: [{ id: "application-1", external_user_id: "external-1", applicant_id: "applicant-1", inspection_id: "inspection-1" }] },
    );
    await expect(authorizeSumsubPrivacyExportUpload({ actorIdentityId: "admin-1", privacyRequestId: "request-1", reportReference: " report-1 ", generatedAt: now, downloadedAt: now, settingsSha256: "a".repeat(64), commandKey: "command-1", now })).resolves.toMatchObject({ privacyRequestId: "request-1", requesterIdentityId: "requester-1", identityVerificationApplicationId: "application-1", reportReference: "report-1", existing: null });
  });

  it("records an integrity-checked staged export with subject-bound audit evidence", async () => {
    const authorization = { exportId: "export-1", actorIdentityId: "admin-1", privacyRequestId: "request-1", requesterIdentityId: "requester-1", requestType: "access" as const, identityVerificationApplicationId: "application-1", applicantId: "applicant-1", externalUserId: "external-1", inspectionId: "inspection-1", reportReference: "report-1", generatedAt: now, downloadedAt: now, settingsSha256: "b".repeat(64), commandKey: "command-1", packagePolicy: { versionId: "policy-1", versionNumber: 1, projectionVersion: 1, valueSha256: "c".repeat(64), packageRetentionHours: 24 }, existing: null };
    const contentSha256 = "a".repeat(64); const scan = sumsubPrivacyScanEvidenceSha256({ scanner: "clamav_instream", scannedAt: now, contentSha256, byteCount: 10 });
    transactionWithResponses({ rowCount: 1 }, { rows: [] }, { rows: [row({ ...authorization, content_sha256: contentSha256, settings_sha256: authorization.settingsSha256, malware_scan_evidence_sha256: scan, byte_count: 10, storage_key: "privacy/export-1.json", uploaded_at: now, scanned_at: now, retain_until: new Date("2026-07-30T12:00:00.000Z") })] });
    await expect(recordSumsubPrivacyExportUpload({ authorization, storageKey: "privacy/export-1.json", contentSha256, byteCount: 10, scanner: "clamav_instream", scannedAt: now, malwareScanEvidenceSha256: scan, uploadedAt: now })).resolves.toMatchObject({ replayed: false, providerExport: { id: "export-1", status: "staged" } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.sumsub_provider_export_staged" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ privacy: { kind: "subjects", subjectIdentityIds: ["requester-1"] } }));
  });

  it("lists governed exports and queues retention cleanup for expired exports", async () => {
    transactionWithResponses({ rowCount: 1 }, { rows: [row()] });
    await expect(listAdministratorSumsubPrivacyExports({ actorIdentityId: "admin-1", privacyRequestId: "request-1" })).resolves.toHaveLength(1);
    transactionWithResponses({ rows: [row()] }, { rowCount: 1 }, { rowCount: 1 });
    await expect(expireAndQueueSumsubPrivacyExportCleanup(10, now)).resolves.toBe(1);
    expect(mocks.audit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.sumsub_provider_export_cleanup_requested" }));
  });
});
