import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {}
  return { transaction: vi.fn(), capability: vi.fn(), lock: vi.fn(), audit: vi.fn(), outbox: vi.fn(), CapabilityError };
});
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ AdministratorCapabilityError: mocks.CapabilityError, requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-data-lifecycle-lock.js", () => ({ lockDataLifecycleAuthority: mocks.lock }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  decideOrganizationDocumentDisposition,
  listOrganizationDocumentsForLifecycle,
  OrganizationDocumentLifecycleError,
  proposeOrganizationDocumentDisposition,
  readOrganizationDocumentLifecycle,
} from "../postgres-organization-document-lifecycle.js";

const documentRow = { id: "document-1", organization_id: "org-1", title: "Issuer certificate", status: "archived", retention_binding_status: "governed", retain_until: new Date("2026-07-01T00:00:00.000Z"), retention_policy_version_id: "policy-1", version_count: 2 };
const requestRow = { id: "request-1", reference: "ODSP-20260729-ABCD1234", document_id: "document-1", organization_id: "org-1", reason: "Retention has elapsed and this document can enter governed disposition.", retain_until_snapshot: documentRow.retain_until, retention_policy_version_id_snapshot: "policy-1", version_count_snapshot: 2, status: "pending", requested_by_identity_id: "maker-1", requested_by_legal_name: "Maker One", reviewed_by_identity_id: null, reviewed_by_legal_name: null, decision_reason: null, requested_at: new Date("2026-07-29T10:00:00.000Z"), reviewed_at: null, applied_at: null };

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}
beforeEach(() => { mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.lock.mockReset().mockResolvedValue(undefined); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("organization document lifecycle", () => {
  it("lists lifecycle documents with only the requested status", async () => {
    const query = transactionWithResponses({ rows: [{ ...documentRow, disposition_status: "cleanup_requested" }] });
    await expect(listOrganizationDocumentsForLifecycle({ actorIdentityId: "admin-1", status: "archived", limit: 20 })).resolves.toEqual({ documents: [expect.objectContaining({ id: "document-1", retentionElapsed: true, dispositionStatus: "cleanup_requested" })] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("document.status=$1"), ["archived", 20]);
  });

  it("rejects invalid proposals before it reads document authority", async () => {
    transactionWithResponses();
    await expect(proposeOrganizationDocumentDisposition({ actorIdentityId: "admin-1", documentId: "document-1", reason: "short", commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("prevents a proposer from deciding the same disposition", async () => {
    transactionWithResponses({ rows: [requestRow] });
    await expect(decideOrganizationDocumentDisposition({ actorIdentityId: "maker-1", requestId: "request-1", decision: "approve", decisionReason: "A separate reviewer must decide this governed document disposition." })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("maps a complete lifecycle read model including holds and pending requests", async () => {
    transactionWithResponses(
      { rows: [documentRow] },
      { rows: [{ id: "hold-1", reference: "HOLD-1", target_type: "organization_document", target_id: "document-1", reason_category: "litigation", reason: "Keep evidence for proceedings.", imposed_at: new Date("2026-07-02T00:00:00.000Z"), imposed_by_identity_id: "admin-2", legal_name: "Admin Two" }] },
      { rows: [{ id: "hold-change-1", reference: "HCR-1", target_type: "organization_document", target_id: "document-1", change_type: "impose", reason_category: "regulatory", reason: "Await a regulator response.", status: "pending", requested_at: new Date("2026-07-03T00:00:00.000Z"), requested_by_identity_id: "admin-3", legal_name: "Admin Three" }] },
      { rows: [requestRow] },
      { rows: [{ id: "disposition-1", status: "cleanup_requested", approved_at: new Date("2026-07-04T00:00:00.000Z"), completed_at: null, failed_at: null }] },
    );
    await expect(readOrganizationDocumentLifecycle({ actorIdentityId: "admin-1", documentId: "document-1" })).resolves.toEqual(expect.objectContaining({ activeHolds: [expect.objectContaining({ id: "hold-1" })], pendingHoldChanges: [expect.objectContaining({ id: "hold-change-1" })], pendingDispositionRequest: expect.objectContaining({ id: "request-1" }), disposition: expect.objectContaining({ id: "disposition-1" }) }));
  });

  it("uses the typed error for capability failures", async () => {
    const error = new OrganizationDocumentLifecycleError("denied", "forbidden");
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe("forbidden");
  });
});
