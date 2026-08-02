import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), capability: vi.fn(), binding: vi.fn(), unavailable: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: mocks.binding }));
vi.mock("../postgres-support-evidence-lifecycle.js", () => ({ isSupportAttachmentUnavailable: mocks.unavailable }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { SupportAttachmentError, SupportAttachmentReplayError, authorizeSupportCaseAttachmentUpload, getSupportCaseAttachmentForDownload, readSupportCaseAttachments, recordSupportCaseAttachment, recordSupportCaseAttachmentDownload } from "../postgres-support-attachments.js";

const classifications = ["general", "personal_data", "financial_record", "identity_document", "security_sensitive"];
const policy = { policyReference: "SUPPORT-DATA-01", policyName: "Approved support-case data policy", maximumBytes: 1_000_000, allowedMimeTypes: ["application/pdf", "image/png"], classifications: Object.fromEntries(classifications.map((item) => [item, { retentionDays: 365 }])) };
const binding = { versionId: "policy-version-1", versionNumber: 1, projectionVersion: 2, valueSha256: "b".repeat(64), value: policy };
const timestamp = new Date("2026-07-01T10:00:00.000Z");
const attachment = (overrides: Record<string, unknown> = {}) => ({ id: "attachment-1", case_id: "case-1", uploaded_by_identity_id: "investor-1", command_key: "command-1", uploader_legal_name: "Investor One", visibility: "requester", classification: "general", filename: "statement.pdf", mime_type: "application/pdf", bytes: 100, content_sha256: "a".repeat(64), storage_key: "support/statement.pdf", scanner: "clamav_instream", scanned_at: timestamp, policy_version_id: "policy-version-1", policy_version_number: 1, policy_projection_version: 2, policy_value_sha256: "b".repeat(64), policy_reference: policy.policyReference, policy_name: policy.policyName, retention_days: 365, uploaded_at: timestamp, retention_due_at: new Date("2027-07-01T10:00:00.000Z"), ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.binding.mockReset().mockResolvedValue(binding); mocks.unavailable.mockReset().mockResolvedValue(false); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("support attachments", () => {
  it("does not let a requester create an internal-only attachment", async () => {
    transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] });
    await expect(authorizeSupportCaseAttachmentUpload({ caseId: "case-1", actorIdentityId: "investor-1", staff: false, visibility: "internal", mimeType: "application/pdf" })).rejects.toBeInstanceOf(SupportAttachmentError);
  });

  it("requires a valid active data policy and allowed file type", async () => {
    transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] });
    await expect(authorizeSupportCaseAttachmentUpload({ caseId: "case-1", actorIdentityId: "investor-1", staff: false, visibility: "requester", mimeType: "application/x-executable" })).rejects.toThrow("not allowed");
    mocks.binding.mockResolvedValueOnce(null);
    transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] });
    await expect(authorizeSupportCaseAttachmentUpload({ caseId: "case-1", actorIdentityId: "investor-1", staff: false, visibility: "requester", mimeType: "application/pdf" })).rejects.toThrow("approved data policy");
  });

  it("requires administrator capability for staff attachment operations", async () => {
    transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] });
    await authorizeSupportCaseAttachmentUpload({ caseId: "case-1", actorIdentityId: "admin-1", staff: true, visibility: "internal", mimeType: "application/pdf" });
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "support_case_manage");
  });

  it("records a clean attachment with retention, audit, and outbox data", async () => {
    const query = transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] }, { rows: [] }, {}, { rows: [attachment()] });
    await expect(recordSupportCaseAttachment({ caseId: "case-1", actorIdentityId: "investor-1", staff: false, visibility: "requester", commandKey: "command-1", classification: "general", filename: " statement.pdf ", mimeType: "Application/PDF", bytes: 100, contentSha256: "a".repeat(64), storageKey: "support/statement.pdf", scanner: "clamav_instream", scannedAt: timestamp })).resolves.toMatchObject({ attachment: { id: "attachment-1", retentionDays: 365, scan: { status: "clean" } } });
    expect(query).toHaveBeenCalledTimes(4); expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "support.case.attachment_recorded" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "support.case.attachment_recorded" }));
  });

  it("returns a typed replay only when attachment facts are unchanged", async () => {
    transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] }, { rows: [attachment()] });
    await expect(recordSupportCaseAttachment({ caseId: "case-1", actorIdentityId: "investor-1", staff: false, visibility: "requester", commandKey: "command-1", classification: "general", filename: "statement.pdf", mimeType: "application/pdf", bytes: 100, contentSha256: "a".repeat(64), storageKey: "support/statement.pdf", scanner: "clamav_instream", scannedAt: timestamp })).rejects.toBeInstanceOf(SupportAttachmentReplayError);
    transactionWithResponses({ rows: [{ requester_identity_id: "investor-1" }] }, { rows: [attachment({ filename: "other.pdf" })] });
    await expect(recordSupportCaseAttachment({ caseId: "case-1", actorIdentityId: "investor-1", staff: false, visibility: "requester", commandKey: "command-1", classification: "general", filename: "statement.pdf", mimeType: "application/pdf", bytes: 100, contentSha256: "a".repeat(64), storageKey: "support/statement.pdf", scanner: "clamav_instream", scannedAt: timestamp })).rejects.toThrow("different content or metadata");
  });

  it("returns requester-visible attachment records only to the case requester", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{ requester_identity_id: "investor-1" }] }).mockResolvedValueOnce({ rows: [attachment()] });
    await expect(readSupportCaseAttachments({ query } as never, { caseId: "case-1", actorIdentityId: "investor-1", staff: false })).resolves.toEqual([expect.objectContaining({ uploadedBy: { id: "investor-1", legalName: "Investor One" } })]);
    const forbidden = vi.fn().mockResolvedValueOnce({ rows: [{ requester_identity_id: "investor-1" }] });
    await expect(readSupportCaseAttachments({ query: forbidden } as never, { caseId: "case-1", actorIdentityId: "investor-2", staff: false })).rejects.toThrow("not found");
  });

  it("blocks a download after governed disposition starts", async () => {
    mocks.unavailable.mockResolvedValueOnce(true);
    transactionWithResponses({ rows: [attachment()] }, { rows: [{ requester_identity_id: "investor-1" }] });
    await expect(getSupportCaseAttachmentForDownload({ attachmentId: "attachment-1", actorIdentityId: "investor-1", staff: false })).rejects.toThrow("governed disposition has begun");
  });

  it("records downloads only after the exact digest is verified", async () => {
    transactionWithResponses({ rows: [attachment()] }, { rows: [{ requester_identity_id: "investor-1" }] });
    await expect(recordSupportCaseAttachmentDownload({ attachmentId: "attachment-1", actorIdentityId: "investor-1", staff: false, verifiedSha256: "b".repeat(64) })).rejects.toThrow("failed integrity validation");
    const query = transactionWithResponses({ rows: [attachment()] }, { rows: [{ requester_identity_id: "investor-1" }] }, {});
    await expect(recordSupportCaseAttachmentDownload({ attachmentId: "attachment-1", actorIdentityId: "investor-1", staff: false, verifiedSha256: "a".repeat(64) })).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledTimes(3); expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "support.case.attachment_downloaded" }));
  });
});
