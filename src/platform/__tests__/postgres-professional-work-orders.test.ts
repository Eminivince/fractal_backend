import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), database: { query: vi.fn() }, audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.database, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  ProfessionalWorkOrderError,
  assertProfessionalDeliverableEvidenceUploadAllowed,
  createProfessionalWorkOrder,
  decideProfessionalDeliverable,
  getIssuerProfessionalDeliverableEvidence,
  listAssignedProfessionalWorkOrderDeliverables,
  listIssuerProfessionalWorkOrders,
  recordProfessionalDeliverableEvidence,
  respondToProfessionalWorkOrder,
  submitProfessionalDeliverable,
} from "../postgres-professional-work-orders.js";

const now = new Date("2026-07-01T10:00:00.000Z");
const invited = {
  id: "order-1", reference: "ENG-01", issuer_organization_id: "issuer-1", professional_firm_organization_id: "firm-1", asset_application_request_id: "request-1",
  title: "Independent legal review", scope: "Review the offering terms and regulatory disclosures.", exclusions: "No tax advice.", confidentiality: "restricted", response_due_at: new Date("2026-07-03T10:00:00.000Z"), delivery_due_at: new Date("2026-07-10T10:00:00.000Z"), fee_minor: "50000", currency: "USD", status: "invited", invited_by_identity_id: "issuer-admin", invited_at: now, decided_by_identity_id: null, decided_at: null, decision_reason: null,
};

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.transaction.mockReset(); mocks.database.query.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined);
});

describe("professional work orders", () => {
  it("rejects unsafe work-order terms before it writes data", async () => {
    await expect(createProfessionalWorkOrder({ issuerOrganizationId: "issuer-1", invitedByIdentityId: "issuer-admin", professionalFirmOrganizationId: "firm-1", assetApplicationRequestId: "request-1", assignedFirmMembershipId: "membership-1", reference: "ENG-01", title: "Independent legal review", scope: "too short", exclusions: "No tax advice.", confidentiality: "restricted", responseDueAt: new Date("2026-07-10"), deliveryDueAt: new Date("2026-07-03"), feeMinor: 50000, currency: "usd" })).rejects.toBeInstanceOf(ProfessionalWorkOrderError);
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("creates a work order, its assignment, audit event, and outbox event", async () => {
    const query = transactionWithResponses({}, {}, {});
    await expect(createProfessionalWorkOrder({ issuerOrganizationId: "issuer-1", invitedByIdentityId: "issuer-admin", professionalFirmOrganizationId: "firm-1", assetApplicationRequestId: "request-1", assignedFirmMembershipId: "membership-1", reference: " ENG-01 ", title: "Independent legal review", scope: "Review the offering terms and regulatory disclosures.", exclusions: "No tax advice.", confidentiality: "restricted", responseDueAt: new Date("2026-07-03"), deliveryDueAt: new Date("2026-07-10"), feeMinor: 50000, currency: "usd" })).resolves.toMatchObject({ workOrderId: expect.any(String) });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[0]![1]).toContain("ENG-01");
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "professional_work_order.invited" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "professional_work_order.invited" }));
  });

  it("requires an assigned professional and a reason for a decline", async () => {
    transactionWithResponses({ rows: [invited] }, { rowCount: 1 });
    await expect(respondToProfessionalWorkOrder({ workOrderId: "order-1", actorIdentityId: "professional-1", response: "decline" })).rejects.toThrow("reason is required");
  });

  it("accepts an invited work order and publishes the decision", async () => {
    const query = transactionWithResponses({ rows: [invited] }, { rowCount: 1 }, {}, {}, {});
    await expect(respondToProfessionalWorkOrder({ workOrderId: "order-1", actorIdentityId: "professional-1", response: "accept" })).resolves.toEqual({ workOrderId: "order-1", status: "accepted" });
    expect(query).toHaveBeenCalledTimes(5);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "professional_work_order.accepted" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "professional_work_order.accepted" }));
  });

  it("maps issuer work orders and keeps money as a string", async () => {
    mocks.database.query.mockResolvedValueOnce({ rows: [invited] });
    await expect(listIssuerProfessionalWorkOrders("issuer-1")).resolves.toEqual([expect.objectContaining({ feeMinor: "50000", responseDueAt: "2026-07-03T10:00:00.000Z" })]);
  });

  it("blocks deliverable uploads from an inactive work order", async () => {
    mocks.database.query.mockResolvedValueOnce({ rows: [{ status: "invited" }] });
    await expect(assertProfessionalDeliverableEvidenceUploadAllowed({ workOrderId: "order-1", identityId: "professional-1" })).rejects.toThrow("accepted active work order");
    mocks.database.query.mockResolvedValueOnce({ rows: [] });
    await expect(assertProfessionalDeliverableEvidenceUploadAllowed({ workOrderId: "order-1", identityId: "professional-1" })).rejects.toThrow("not assigned");
  });

  it("requires distinct evidence before it starts a deliverable", async () => {
    transactionWithResponses({ rows: [{ id: "order-1", reference: "ENG-01", issuer_organization_id: "issuer-1", status: "accepted" }] }, { rowCount: 1 });
    await expect(submitProfessionalDeliverable({ workOrderId: "order-1", submittedByIdentityId: "professional-1", title: "Review", submissionSummary: "The review is complete.", evidenceDocumentIds: ["evidence-1", "evidence-1"] })).rejects.toThrow("distinct evidence");
  });

  it("records valid evidence and restricts issuer evidence lookup", async () => {
    const query = transactionWithResponses({ rows: [{ id: "order-1", reference: "ENG-01", issuer_organization_id: "issuer-1", status: "accepted" }] }, { rowCount: 1 }, {}, {}, {});
    await expect(recordProfessionalDeliverableEvidence({ workOrderId: "order-1", uploadedByIdentityId: "professional-1", filename: "review.pdf", mimeType: "application/pdf", storageKey: "deliverables/review.pdf", contentSha256: "a".repeat(64), bytes: 100 })).resolves.toMatchObject({ evidenceDocumentId: expect.any(String) });
    expect(query).toHaveBeenCalledTimes(4);
    mocks.database.query.mockResolvedValueOnce({ rows: [] });
    await expect(getIssuerProfessionalDeliverableEvidence({ issuerOrganizationId: "issuer-1", evidenceDocumentId: "evidence-1" })).rejects.toThrow("not found in this organization");
  });

  it("does not return deliverables to an unassigned professional", async () => {
    mocks.database.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(listAssignedProfessionalWorkOrderDeliverables("order-1", "professional-1")).rejects.toThrow("not assigned");
  });

  it("prevents self-review of a submitted deliverable", async () => {
    transactionWithResponses({ rows: [{ id: "deliverable-1", work_order_id: "order-1", submitted_by_identity_id: "professional-1", issuer_organization_id: "issuer-1", reference: "ENG-01" }] });
    await expect(decideProfessionalDeliverable({ deliverableVersionId: "deliverable-1", reviewedByIdentityId: "professional-1", decision: "accepted", notes: "Looks complete." })).rejects.toThrow("different person");
  });
});
