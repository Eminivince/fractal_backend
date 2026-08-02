import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ tx: vi.fn(), pg: vi.fn(), audit: vi.fn(), outbox: vi.fn(), bind: vi.fn(), account: vi.fn(), journal: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: m.tx, requirePostgres: m.pg }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: m.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: m.outbox }));
vi.mock("../postgres-distribution-lifecycle.js", () => ({ bindDistributionLifecyclePolicy: m.bind, DistributionLifecyclePolicyError: class DistributionLifecyclePolicyError extends Error {} }));
vi.mock("../postgres-journal.js", () => ({ ensureLedgerAccount: m.account, postJournalInTransaction: m.journal }));
import { approveDistributionTaxPolicy, createDistributionTaxPolicy, decideDistributionTaxFiling, submitDistributionTaxPaymentEvidence, submitDistributionTaxRemittance } from "../postgres-distribution-tax.js";

function client(...items: any[]) { const query = vi.fn(); for (const item of items) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...item }); return { query }; }
const hash = "a".repeat(64);
beforeEach(() => { vi.clearAllMocks(); m.tx.mockImplementation(async (work: any) => work({ query: vi.fn() })); m.audit.mockResolvedValue({ id: "audit-1" }); m.outbox.mockResolvedValue(undefined); m.bind.mockResolvedValue(undefined); });

describe("distribution tax policy and evidence", () => {
  it("creates an independently approvable policy and validates its inputs", async () => {
    await expect(createDistributionTaxPolicy({ organizationId: "org-1", jurisdictionCode: "NG", currency: "NGN", taxAuthorityName: "Tax", taxAuthorityReference: "short", filingDueDays: -1, paymentDueDays: 1, effectiveFrom: new Date(), actorIdentityId: "maker" })).rejects.toThrow("due-day");
    const c = client({}, { rows: [{ version: 2 }], rowCount: 1 }, {}); m.tx.mockImplementation(async (work: any) => work(c));
    await expect(createDistributionTaxPolicy({ organizationId: "org-1", jurisdictionCode: "ng", currency: "ngn", taxAuthorityName: "Revenue Authority", taxAuthorityReference: "AUTH-12345", filingDueDays: 10, paymentDueDays: 20, effectiveFrom: new Date("2026-01-01"), actorIdentityId: "maker" })).resolves.toMatchObject({ version: 2, policyId: expect.any(String) });
    expect(c.query.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["NG", "NGN", "Revenue Authority"]));
    expect(m.outbox).toHaveBeenCalledWith(c, expect.objectContaining({ eventType: "distribution_tax_policy.proposed" }));
  });

  it("requires a different approver before it activates and supersedes a policy", async () => {
    const own = client({ rows: [{ organization_id: "org-1", jurisdiction_code: "NG", currency: "NGN", status: "draft", prepared_by_identity_id: "maker" }], rowCount: 1 }); m.tx.mockImplementation(async (work: any) => work(own));
    await expect(approveDistributionTaxPolicy({ policyId: "policy-1", actorIdentityId: "maker" })).rejects.toThrow("different person");
    const approved = client({ rows: [{ organization_id: "org-1", jurisdiction_code: "NG", currency: "NGN", status: "draft", prepared_by_identity_id: "maker" }], rowCount: 1 }, {}, {}, {}); m.tx.mockImplementation(async (work: any) => work(approved));
    await expect(approveDistributionTaxPolicy({ policyId: "policy-1", actorIdentityId: "checker" })).resolves.toEqual({ policyId: "policy-1", status: "active" });
  });

  it("records remittance evidence only for approved declarations with active policy", async () => {
    const c = client({ rows: [{ organization_id: "org-1", currency: "NGN", withholding_tax_minor: "1000", policy_jurisdiction_code: "NG", status: "approved" }], rowCount: 1 }, { rows: [{ id: "policy-1", filing_due_days: 10, payment_due_days: 20 }], rowCount: 1 }, {}, {}); m.tx.mockImplementation(async (work: any) => work(c));
    await expect(submitDistributionTaxRemittance({ organizationId: "org-1", declarationRequestId: "declaration-1", taxPeriodStart: new Date("2026-01-01"), taxPeriodEnd: new Date("2026-01-31"), filingReference: "FILING-12345", filingEvidenceSha256: hash, actorIdentityId: "maker" })).resolves.toMatchObject({ requestId: expect.any(String) });
    expect(m.bind).toHaveBeenCalled();
    const noPolicy = client({ rows: [{ organization_id: "org-1", currency: "NGN", withholding_tax_minor: "1000", policy_jurisdiction_code: "NG", status: "approved" }], rowCount: 1 }, { rows: [], rowCount: 0 }); m.tx.mockImplementation(async (work: any) => work(noPolicy));
    await expect(submitDistributionTaxRemittance({ organizationId: "org-1", declarationRequestId: "declaration-1", taxPeriodStart: new Date(), taxPeriodEnd: new Date(), filingReference: "FILING-12345", filingEvidenceSha256: hash, actorIdentityId: "maker" })).rejects.toThrow("active independently approved");
  });

  it("enforces independent filing review and payment-evidence state", async () => {
    const row = { id: "tax-1", organization_id: "org-1", declaration_request_id: "declaration-1", status: "submitted", submitted_by_identity_id: "maker" };
    const self = client({ rows: [row], rowCount: 1 }); m.tx.mockImplementation(async (work: any) => work(self));
    await expect(decideDistributionTaxFiling({ requestId: "tax-1", approve: true, decisionReason: "Independent reviewer approves filing evidence.", actorIdentityId: "maker" })).rejects.toThrow("different person");
    const approved = client({ rows: [row], rowCount: 1 }, {}, {}); m.tx.mockImplementation(async (work: any) => work(approved));
    await expect(decideDistributionTaxFiling({ requestId: "tax-1", approve: true, decisionReason: "Independent reviewer approves filing evidence.", actorIdentityId: "checker" })).resolves.toEqual({ requestId: "tax-1", status: "approved" });
    const payment = client({ rows: [{ ...row, status: "approved" }], rowCount: 1 }, {}, {}); m.tx.mockImplementation(async (work: any) => work(payment));
    await expect(submitDistributionTaxPaymentEvidence({ requestId: "tax-1", paymentReference: "PAYMENT-12345", paymentEvidenceSha256: hash, actorIdentityId: "maker" })).resolves.toEqual({ requestId: "tax-1", status: "payment_evidence_submitted" });
  });
});
