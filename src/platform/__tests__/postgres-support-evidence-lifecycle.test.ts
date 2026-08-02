import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), capability: vi.fn(), lifecycleLock: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability, AdministratorCapabilityError: class AdministratorCapabilityError extends Error {} }));
vi.mock("../postgres-data-lifecycle-lock.js", () => ({ lockDataLifecycleAuthority: mocks.lifecycleLock }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { SupportEvidenceLifecycleError, decideLegalHoldChange, isSupportAttachmentUnavailable, proposeLegalHoldChange, proposeSupportAttachmentDisposition, readSupportAttachmentLifecycle, resolveSupportEvidenceHoldTarget } from "../postgres-support-evidence-lifecycle.js";

const timestamp = new Date("2026-07-01T10:00:00.000Z");
const holdRequest = (overrides: Record<string, unknown> = {}) => ({ id: "request-1", reference: "HLD-20260701-ABCD1234", target_type: "support_attachment", target_id: "attachment-1", change_type: "impose", reason_category: "audit", reason: "An external audit requires preservation of this evidence record.", command_key: "command-1", status: "pending", requested_by_identity_id: "maker-1", requested_by_legal_name: "Maker One", reviewed_by_identity_id: null, reviewed_by_legal_name: null, decision_reason: null, requested_at: timestamp, reviewed_at: null, applied_at: null, ...overrides });
const attachment = (overrides: Record<string, unknown> = {}) => ({ id: "attachment-1", case_id: "case-1", requester_identity_id: "investor-1", retention_due_at: new Date("2025-07-01T10:00:00.000Z"), content_sha256: "a".repeat(64), storage_key: "support/statement.pdf", ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.lifecycleLock.mockReset().mockResolvedValue(undefined); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("support evidence lifecycle", () => {
  it("maps evidence hold scopes to the correct governed target", async () => {
    transactionWithResponses({ rows: [attachment()] });
    await expect(resolveSupportEvidenceHoldTarget({ actorIdentityId: "admin-1", attachmentId: "attachment-1", scope: "case" })).resolves.toEqual({ targetType: "support_case", targetId: "case-1" });
    transactionWithResponses({ rows: [attachment()] });
    await expect(resolveSupportEvidenceHoldTarget({ actorIdentityId: "admin-1", attachmentId: "attachment-1", scope: "requester_identity" })).resolves.toEqual({ targetType: "identity", targetId: "investor-1" });
  });

  it("rejects a short legal-hold reason before writing a request", async () => {
    transactionWithResponses({});
    await expect(proposeLegalHoldChange({ actorIdentityId: "admin-1", targetType: "support_attachment", targetId: "attachment-1", changeType: "impose", reasonCategory: "audit", reason: "short", commandKey: "command-1" })).rejects.toBeInstanceOf(SupportEvidenceLifecycleError);
  });

  it("creates an independently reviewable legal-hold request", async () => {
    const query = transactionWithResponses({ rows: [] }, { rows: [{ exists: false }] }, { rows: [{ exists: true }] }, { rowCount: 0 }, { rowCount: 0 }, {}, { rows: [{ case_id: "case-1" }] }, { rows: [holdRequest()] });
    await expect(proposeLegalHoldChange({ actorIdentityId: "admin-1", targetType: "support_attachment", targetId: "attachment-1", changeType: "impose", reasonCategory: "audit", reason: "An external audit requires preservation of this evidence record.", commandKey: "command-1" })).resolves.toMatchObject({ request: { id: "request-1", status: "pending", targetType: "support_attachment" }, replayed: false });
    expect(query).toHaveBeenCalledTimes(8); expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "data.legal_hold_change.proposed" }));
  });

  it("replays an identical legal-hold command and rejects changed facts", async () => {
    transactionWithResponses({ rows: [holdRequest()] });
    await expect(proposeLegalHoldChange({ actorIdentityId: "maker-1", targetType: "support_attachment", targetId: "attachment-1", changeType: "impose", reasonCategory: "audit", reason: "An external audit requires preservation of this evidence record.", commandKey: "command-1" })).resolves.toMatchObject({ replayed: true, request: { id: "request-1" } });
    transactionWithResponses({ rows: [holdRequest({ reason: "A different controlled reason requires this evidence preservation." })] });
    await expect(proposeLegalHoldChange({ actorIdentityId: "maker-1", targetType: "support_attachment", targetId: "attachment-1", changeType: "impose", reasonCategory: "audit", reason: "An external audit requires preservation of this evidence record.", commandKey: "command-1" })).rejects.toThrow("different legal hold change");
  });

  it("does not let a legal-hold proposer decide the same request", async () => {
    transactionWithResponses({ rows: [holdRequest()] });
    await expect(decideLegalHoldChange({ actorIdentityId: "maker-1", requestId: "request-1", decision: "approve", decisionReason: "An independent reviewer confirms the preservation need is valid." })).rejects.toThrow("proposer cannot decide");
  });

  it("does not allow disposition before a record's retention deadline", async () => {
    transactionWithResponses({ rows: [] }, { rows: [attachment({ retention_due_at: new Date("2030-07-01T10:00:00.000Z") })] });
    await expect(proposeSupportAttachmentDisposition({ actorIdentityId: "admin-1", attachmentId: "attachment-1", reason: "The retention period ended and the governed record is eligible for disposition.", commandKey: "command-1" })).rejects.toThrow("retention period has not elapsed");
  });

  it("returns lifecycle records with retention and pending decisions", async () => {
    transactionWithResponses(
      { rows: [attachment()] },
      { rows: [{ id: "hold-1", reference: "HLDA-20260701-ABCD", target_type: "support_attachment", target_id: "attachment-1", reason_category: "audit", reason: "Audit preservation required.", imposed_by_identity_id: "maker-1", imposed_by_legal_name: "Maker One", imposed_at: timestamp, released_at: null }] },
      { rows: [holdRequest()] }, { rows: [] }, { rows: [],
    });
    await expect(readSupportAttachmentLifecycle({ actorIdentityId: "admin-1", attachmentId: "attachment-1" })).resolves.toMatchObject({ attachmentId: "attachment-1", retentionElapsed: true, activeHolds: [{ id: "hold-1" }], pendingHoldChanges: [{ id: "request-1" }], pendingDispositionRequest: null, disposition: null });
  });

  it("reports evidence as unavailable when any governed disposition exists", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rowCount: 1, rows: [] }) };
    await expect(isSupportAttachmentUnavailable(client as never, "attachment-1")).resolves.toBe(true);
  });
});
