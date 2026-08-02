import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {}
  return { transaction: vi.fn(), capability: vi.fn(), audit: vi.fn(), outbox: vi.fn(), CapabilityError };
});

vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ AdministratorCapabilityError: mocks.CapabilityError, requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  decideDistributionPrivacyTreatment,
  DistributionPrivacyTreatmentError,
  listDistributionPrivacyTreatments,
  proposeDistributionPrivacyTreatment,
} from "../postgres-distribution-privacy-treatments.js";

const treatmentRow = {
  id: "treatment-1", reference: "DPT-20260729-ABCD1234", privacy_request_id: "request-1", privacy_decision_request_id: "decision-1",
  requester_identity_id: "subject-1", organization_id: "org-1", target_type: "distribution_declaration", treatment_type: "erasure",
  policy_treatment_mode: "lawful_retention", decision_scope_category: "Distribution declaration", decision_scope_action: "approve",
  treatment_statement: "Record the lawful retention outcome without changing immutable declaration records.", status: "pending",
  proposed_by_identity_id: "maker-1", proposer_name: "Maker One", reviewed_by_identity_id: null, reviewer_name: null,
  review_reason: null, requester_visible_summary: null, proposed_at: new Date("2026-07-29T10:00:00.000Z"), reviewed_at: null,
  execution_id: null, execution_result: null, lawful_basis: null, policy_reference: "Policy 2026-1",
  retain_until: new Date("2027-07-29T10:00:00.000Z"), legal_hold_active: null, executed_at: null,
};

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.transaction.mockReset();
  mocks.capability.mockReset().mockResolvedValue(undefined);
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockReset().mockResolvedValue(undefined);
});

describe("distribution privacy treatments", () => {
  it("maps staff and requester treatment records without disclosing staff review notes", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [{ ...treatmentRow, status: "approved", review_reason: "Private reviewer note", requester_visible_summary: "Your request has a governed retention outcome." }] }) };
    await expect(listDistributionPrivacyTreatments(client as never, "request-1", true)).resolves.toEqual([expect.objectContaining({ treatmentStatement: treatmentRow.treatment_statement, reviewReason: "Private reviewer note" })]);
    await expect(listDistributionPrivacyTreatments(client as never, "request-1", false)).resolves.toEqual([expect.objectContaining({ treatmentStatement: "Your request has a governed retention outcome.", reviewReason: null })]);
    expect(client.query.mock.calls[1]?.[0]).toContain("treatment.status='approved'");
  });

  it("rejects weak proposal input before it reads a governed decision", async () => {
    const query = transactionWithResponses({ rowCount: 1 });
    await expect(proposeDistributionPrivacyTreatment({ actorIdentityId: "admin-1", privacyRequestId: "request-1", targetType: "distribution_declaration", targetId: "target-1", decisionScopeCategory: "x", treatmentStatement: "too short", commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("creates a subject-bound governed treatment and emits both audit scopes", async () => {
    const query = transactionWithResponses(
      { rowCount: 1 },
      { rows: [] },
      { rows: [{ requester_identity_id: "subject-1", request_type: "erasure", decision_id: "decision-1", decision_action: "approve", lifecycle_binding_id: "binding-1", organization_id: "org-1", policy_treatment_mode: "lawful_retention" }] },
      { rowCount: 1 },
      { rows: [treatmentRow] },
    );
    await expect(proposeDistributionPrivacyTreatment({ actorIdentityId: "admin-1", privacyRequestId: "request-1", targetType: "distribution_declaration", targetId: "target-1", decisionScopeCategory: "  Distribution declaration ", treatmentStatement: treatmentRow.treatment_statement, commandKey: "command-1" })).resolves.toMatchObject({ replayed: false, treatment: { id: "treatment-1" } });
    expect(query.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(["Distribution declaration", treatmentRow.treatment_statement, "command-1"]));
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "privacy.distribution_treatment.proposed" }));
  });

  it("requires a separate reviewer and produces typed capability errors", async () => {
    const query = transactionWithResponses({ rowCount: 1 }, { rows: [treatmentRow] });
    await expect(decideDistributionPrivacyTreatment({ actorIdentityId: "maker-1", treatmentRequestId: "treatment-1", decision: "approve", reviewReason: "An independent reviewer is required for this governed treatment.", requesterVisibleSummary: "Your request remains subject to an independent governed review." })).rejects.toMatchObject({ code: "forbidden" });
    expect(query).toHaveBeenCalledTimes(2);

    mocks.capability.mockRejectedValueOnce(new mocks.CapabilityError("missing"));
    transactionWithResponses({ rowCount: 1 });
    await expect(proposeDistributionPrivacyTreatment({ actorIdentityId: "admin-1", privacyRequestId: "request-1", targetType: "distribution_declaration", targetId: "target-1", decisionScopeCategory: "Distribution declaration", treatmentStatement: treatmentRow.treatment_statement, commandKey: "command-1" })).rejects.toBeInstanceOf(DistributionPrivacyTreatmentError);
  });
});
