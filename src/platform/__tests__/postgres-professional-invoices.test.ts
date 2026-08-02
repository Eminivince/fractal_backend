import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  postgres: vi.fn(), transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn(),
  ensureLedgerAccount: vi.fn(), postJournal: vi.fn(), reverseJournal: vi.fn(),
}));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../postgres-journal.js", () => ({ ensureLedgerAccount: mocks.ensureLedgerAccount, postJournalInTransaction: mocks.postJournal, reverseJournal: mocks.reverseJournal }));

import {
  approveProfessionalFinanceApprovalPolicy,
  approveProfessionalInvoiceTaxTreatment,
  createProfessionalFinanceApprovalPolicy,
  createProfessionalInvoiceTaxTreatment,
  listIssuerProfessionalInvoices,
  listProfessionalFinanceApprovalPolicies,
  listProfessionalInvoiceTaxTreatments,
  listProfessionalPayouts,
  authorizeProfessionalPayout,
  decideProfessionalInvoice,
  ProfessionalInvoiceError,
  recordProfessionalPayoutProviderOutcome,
  submitProfessionalInvoice,
  verifyProfessionalPayoutProfile,
} from "../postgres-professional-invoices.js";

function postgresWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.postgres.mockReturnValue({ query }); return query; }
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.postgres.mockReset(); mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); mocks.ensureLedgerAccount.mockReset().mockResolvedValue(undefined); mocks.postJournal.mockReset().mockResolvedValue({ journalId: "journal-1" }); mocks.reverseJournal.mockReset().mockResolvedValue({ journalId: "reversal-1" }); });

describe("professional invoices", () => {
  it("validates approval-policy and tax-treatment input before it writes records", async () => {
    await expect(createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: "org-1", preparedByIdentityId: "admin-1", resolutionType: "credit_note", currency: "NGN", maximumAmountMinor: 0, effectiveFrom: new Date(), policyReference: "Policy reference" })).rejects.toThrow("positive safe integer");
    await expect(createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: "org-1", preparedByIdentityId: "admin-1", resolutionType: "credit_note", currency: "NGN", maximumAmountMinor: 100, effectiveFrom: new Date("invalid"), policyReference: "Policy reference" })).rejects.toThrow("effective dates");
    await expect(createProfessionalInvoiceTaxTreatment({ issuerOrganizationId: "org-1", preparedByIdentityId: "admin-1", jurisdictionCode: "NG", serviceClass: "Legal", currency: "NGN", indirectTaxRateBps: 10_001, withholdingTaxRateBps: 0, effectiveFrom: new Date(), legalSourceReference: "Source reference" })).rejects.toThrow("basis points");
  });

  it("requires a different approver for finance policy and tax treatment", async () => {
    transactionWithResponses({ rows: [{ issuer_organization_id: "org-1", prepared_by_identity_id: "admin-1", status: "draft" }] });
    await expect(approveProfessionalFinanceApprovalPolicy({ financeApprovalPolicyId: "policy-1", approvedByIdentityId: "admin-1" })).rejects.toThrow("different person");
    transactionWithResponses({ rows: [{ issuer_organization_id: "org-1", prepared_by_identity_id: "admin-1", status: "draft" }] });
    await expect(approveProfessionalInvoiceTaxTreatment({ taxTreatmentId: "tax-1", approvedByIdentityId: "admin-1" })).rejects.toThrow("different person");
  });

  it("creates governed finance policies and tax treatments with normalized terms", async () => {
    const effectiveFrom = new Date("2026-07-01T00:00:00.000Z");
    const policyQuery = transactionWithResponses({ rowCount: 1 }, { rows: [{ version: 3 }] }, { rowCount: 1 });
    await expect(createProfessionalFinanceApprovalPolicy({ issuerOrganizationId: "org-1", preparedByIdentityId: "maker-1", resolutionType: "credit_note", currency: "ngn", maximumAmountMinor: 50_000, effectiveFrom, policyReference: "  Board limit  " })).resolves.toMatchObject({ version: 3, status: "draft" });
    expect(policyQuery.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["NGN", "Board limit"]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "professional_finance_approval_policy.prepared" }));

    const taxQuery = transactionWithResponses({ rowCount: 1 }, { rows: [{ version: 2 }] }, { rowCount: 1 });
    await expect(createProfessionalInvoiceTaxTreatment({ issuerOrganizationId: "org-1", preparedByIdentityId: "maker-1", jurisdictionCode: "ng", serviceClass: "  Legal services ", currency: "ngn", indirectTaxRateBps: 750, withholdingTaxRateBps: 500, effectiveFrom, legalSourceReference: "Tax law source" })).resolves.toMatchObject({ version: 2, status: "draft" });
    expect(taxQuery.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["NG", "Legal services", "NGN"]));
  });

  it("maps governed finance policies and tax treatments", async () => {
    postgresWithResponses({ rows: [{ id: "policy-1", version: 2, resolution_type: "credit_note", currency: "NGN", maximum_amount_minor: "150000", effective_from: new Date("2026-07-01T00:00:00.000Z"), effective_until: null, policy_reference: "Board policy", status: "active", prepared_by_identity_id: "admin-1", approved_by_identity_id: "admin-2", approved_at: new Date("2026-07-02T00:00:00.000Z") }] });
    await expect(listProfessionalFinanceApprovalPolicies("org-1")).resolves.toEqual([expect.objectContaining({ resolutionType: "credit_note", maximumAmountMinor: "150000", status: "active" })]);
    postgresWithResponses({ rows: [{ id: "tax-1", version: 1, jurisdiction_code: "NG", service_class: "Legal", currency: "NGN", indirect_tax_rate_bps: 750, withholding_tax_rate_bps: 500, effective_from: new Date("2026-07-01T00:00:00.000Z"), effective_until: null, legal_source_reference: "Tax code", status: "active", prepared_by_identity_id: "admin-1", approved_by_identity_id: null, approved_at: null }] });
    await expect(listProfessionalInvoiceTaxTreatments("org-1")).resolves.toEqual([expect.objectContaining({ jurisdictionCode: "NG", indirectTaxRateBps: 750, withholdingTaxRateBps: 500 })]);
  });

  it("maps issuer invoices and professional payout visibility", async () => {
    postgresWithResponses({ rows: [{ id: "invoice-1", reference: "PIN-1", work_order_id: "work-1", deliverable_version_id: "deliverable-1", currency: "NGN", gross_minor: "10000", net_payable_minor: "9000", due_at: new Date("2026-08-01T00:00:00.000Z"), status: "approved", submitted_at: new Date("2026-07-01T00:00:00.000Z"), review_notes: null, payout_status: "submitted", payout_reference: "PPO-1", payout_failure_reason: null }] });
    await expect(listIssuerProfessionalInvoices("org-1")).resolves.toEqual([expect.objectContaining({ workOrderId: "work-1", grossMinor: "10000", payoutStatus: "submitted" })]);
    postgresWithResponses({ rows: [{ invoice_id: "invoice-1", invoice_reference: "PIN-1", currency: "NGN", net_payable_minor: "9000", invoice_status: "approved", payout_status: "confirmed", payout_reference: "PPO-1", submitted_at: new Date("2026-07-01T00:00:00.000Z"), confirmed_at: new Date("2026-07-02T00:00:00.000Z"), failed_at: null, failure_reason: null }] });
    await expect(listProfessionalPayouts("professional-1")).resolves.toEqual([expect.objectContaining({ invoiceId: "invoice-1", payoutStatus: "confirmed", confirmedAt: "2026-07-02T00:00:00.000Z" })]);
  });

  it("rejects malformed Nigerian payout account numbers before external provider calls", async () => {
    await expect(verifyProfessionalPayoutProfile({ firmOrganizationId: "firm-1", actorIdentityId: "professional-1", bankCode: "058", accountNumber: "123" })).rejects.toThrow("10-digit Nigerian bank account");
  });

  it("submits an invoice with the active governed tax treatment", async () => {
    const query = transactionWithResponses(
      { rows: [{ id: "work-1", issuer_organization_id: "org-1", professional_firm_organization_id: "firm-1", currency: "NGN", fee_minor: "10000", reference: "WORK-1" }] },
      { rows: [{ id: "profile-1" }] },
      { rows: [{ id: "tax-1", indirect_tax_rate_bps: 750, withholding_tax_rate_bps: 500 }] },
      { rowCount: 1 },
    );
    await expect(submitProfessionalInvoice({ workOrderId: "work-1", deliverableVersionId: "deliverable-1", submittedByIdentityId: "professional-1", reference: "  INV-1 ", dueAt: new Date(Date.now() + 86_400_000) })).resolves.toHaveProperty("invoiceId");
    expect(query.mock.calls[3]?.[1]).toEqual(expect.arrayContaining(["INV-1", "750", "500", "10250"]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "professional_invoice.submitted" }));
  });

  it("posts an accrual only after an independent invoice approval", async () => {
    const query = transactionWithResponses({ rows: [{ id: "invoice-1", reference: "INV-1", work_order_id: "work-1", submitted_by_identity_id: "professional-1", issuer_organization_id: "org-1", currency: "NGN", gross_minor: "10000", tax_minor: "750", withholding_tax_minor: "500", net_payable_minor: "10250" }] }, { rowCount: 1 });
    await expect(decideProfessionalInvoice({ invoiceId: "invoice-1", decidedByIdentityId: "reviewer-1", approve: true })).resolves.toEqual({ invoiceId: "invoice-1", status: "approved", accrualJournalId: "journal-1" });
    expect(mocks.ensureLedgerAccount).toHaveBeenCalledTimes(5);
    expect(mocks.postJournal).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ idempotencyKey: "professional-invoice-accrual:invoice-1" }));
    expect(query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["approved", "reviewer-1", "journal-1"]));
  });

  it("requires an independent payout authorizer and a recorded accrual", async () => {
    transactionWithResponses({ rows: [{ id: "invoice-1", status: "approved", reviewed_by_identity_id: "reviewer-1", accrual_journal_id: "journal-1" }] });
    await expect(authorizeProfessionalPayout({ invoiceId: "invoice-1", authorizedByIdentityId: "reviewer-1" })).rejects.toThrow("different person");
    transactionWithResponses({ rows: [{ id: "invoice-1", status: "approved", reviewed_by_identity_id: "reviewer-1", accrual_journal_id: null }] });
    await expect(authorizeProfessionalPayout({ invoiceId: "invoice-1", authorizedByIdentityId: "authorizer-1" })).rejects.toThrow("missing its immutable accounting accrual");
  });

  it("rejects provider messages that do not match a governed payout", async () => {
    transactionWithResponses({ rows: [{ id: "payout-1", invoice_id: "invoice-1", issuer_organization_id: "org-1", instruction_status: "submitted", reference: "PAYOUT-1", provider_transfer_code: "transfer-1", amount_minor: "10000", currency: "NGN", settlement_journal_id: null, reversal_journal_id: null, invoice_accrual_journal_id: "journal-1" }] });
    await expect(recordProfessionalPayoutProviderOutcome({ outcome: "success", reference: "PAYOUT-1", transferCode: "transfer-2", source: "webhook" })).rejects.toThrow("transfer code does not match");
    transactionWithResponses({ rows: [] });
    await expect(recordProfessionalPayoutProviderOutcome({ outcome: "success", reference: "missing", source: "webhook" })).resolves.toEqual({ handled: false });
  });

  it("uses the professional invoice error type", () => { expect(new ProfessionalInvoiceError("message")).toBeInstanceOf(Error); });
});
