import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), database: { query: vi.fn() }, audit: vi.fn(), outbox: vi.fn(), lifecycle: vi.fn(), ledger: vi.fn(), journal: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => mocks.database, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../postgres-distribution-lifecycle.js", () => ({ bindDistributionLifecyclePolicy: mocks.lifecycle, DistributionLifecyclePolicyError: class DistributionLifecyclePolicyError extends Error {} }));
vi.mock("../postgres-journal.js", () => ({ ensureLedgerAccount: mocks.ledger, postJournalInTransaction: mocks.journal }));

import {
  DistributionPayoutError,
  addDistributionPayoutExceptionEvidence,
  approveDistributionPayoutExceptionPolicy,
  createDistributionPayoutExceptionPolicy,
  decideDistributionFundingRequest,
  decideDistributionPayoutExceptionHold,
  decideDistributionPayoutExceptionResolution,
  getInvestorDistributionPayoutProfile,
  openDistributionPayoutException,
  proposeDistributionPayoutExceptionHold,
  proposeDistributionPayoutExceptionResolution,
  recordDistributionPayoutProviderOutcome,
  submitDistributionFundingRequest,
  verifyInvestorDistributionPayoutProfile,
} from "../postgres-distribution-payouts.js";

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.database.query.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); mocks.lifecycle.mockReset().mockResolvedValue(undefined); mocks.ledger.mockReset().mockResolvedValue(undefined); mocks.journal.mockReset().mockResolvedValue({ journalId: "journal-1" }); });

describe("distribution payout controls", () => {
  it("rejects a malformed Nigerian account number before provider calls", async () => {
    await expect(verifyInvestorDistributionPayoutProfile({ investorIdentityId: "investor-1", bankCode: "058", accountNumber: "123", resolve: vi.fn(), createRecipient: vi.fn() })).rejects.toBeInstanceOf(DistributionPayoutError);
  });

  it("requires an active verified investor before it verifies a payout profile", async () => {
    mocks.database.query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(verifyInvestorDistributionPayoutProfile({ investorIdentityId: "investor-1", bankCode: "058", accountNumber: "0123456789", resolve: vi.fn(), createRecipient: vi.fn() })).rejects.toThrow("active verified identity");
  });

  it("rejects a provider account resolution that does not match the submitted account", async () => {
    mocks.database.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    await expect(verifyInvestorDistributionPayoutProfile({ investorIdentityId: "investor-1", bankCode: "058", accountNumber: "0123456789", resolve: vi.fn().mockResolvedValue({ account_number: "9999999999", account_name: "Investor One" }), createRecipient: vi.fn() })).rejects.toThrow("did not match");
  });

  it("creates a verified payout profile only after provider verification", async () => {
    mocks.database.query.mockResolvedValueOnce({ rowCount: 1, rows: [] });
    const query = transactionWithResponses({}, { rows: [{ version: 2 }] }, {}, {});
    await expect(verifyInvestorDistributionPayoutProfile({ investorIdentityId: "investor-1", bankCode: "058", accountNumber: "0123456789", resolve: vi.fn().mockResolvedValue({ account_number: "0123456789", account_name: " Investor One " }), createRecipient: vi.fn().mockResolvedValue({ recipient_code: "RCP-1" }) })).resolves.toMatchObject({ version: 2, currency: "NGN", accountLast4: "6789", accountHolderName: "Investor One" });
    expect(query).toHaveBeenCalledTimes(4); expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "distribution_payout_profile.verified" }));
  });

  it("maps only verified payout profile data", async () => {
    mocks.database.query.mockResolvedValueOnce({ rows: [{ id: "profile-1", version: 2, currency: "NGN", account_holder_name: "Investor One", account_last4: "6789", verified_at: new Date("2026-07-01T10:00:00.000Z") }] });
    await expect(getInvestorDistributionPayoutProfile("investor-1")).resolves.toEqual({ id: "profile-1", version: 2, currency: "NGN", accountHolderName: "Investor One", accountLast4: "6789", verifiedAt: "2026-07-01T10:00:00.000Z" });
  });

  it("refuses a funding request when the live provider balance is insufficient", async () => {
    mocks.database.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ organization_id: "organization-1", currency: "NGN", net_amount_minor: "1000", status: "approved" }] });
    await expect(submitDistributionFundingRequest({ organizationId: "organization-1", declarationRequestId: "declaration-1", fundingEvidenceReference: "BANK-TRANSFER-01", fundingEvidenceSha256: "a".repeat(64), actorIdentityId: "issuer-1", commandKey: "command-1", readBalance: vi.fn().mockResolvedValue(999) })).rejects.toThrow("below the declaration net liability");
  });

  it("does not let the funding submitter approve the same request", async () => {
    mocks.database.query.mockResolvedValueOnce({ rows: [{ status: "submitted", submitted_by_identity_id: "issuer-1" }] });
    await expect(decideDistributionFundingRequest({ requestId: "funding-1", actorIdentityId: "issuer-1", decision: "reject", decisionReason: "The funding evidence is incomplete and cannot be approved." })).rejects.toThrow("cannot approve");
  });

  it("does not process an invalid provider payout outcome", async () => {
    await expect(recordDistributionPayoutProviderOutcome({ reference: "DPI-1", outcome: "success", transferCode: "TRF-1", amountMinor: 0, currency: "NGN", source: "webhook" })).rejects.toThrow("amount is invalid");
    const query = transactionWithResponses({}, { rows: [] });
    await expect(recordDistributionPayoutProviderOutcome({ reference: "DPI-1", outcome: "success", transferCode: "TRF-1", amountMinor: 1000, currency: "NGN", source: "webhook" })).resolves.toEqual({ handled: false });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("uses separate people for payout-exception policy preparation and approval", async () => {
    const query = transactionWithResponses({}, { rows: [{ version: 1 }] }, {});
    await expect(createDistributionPayoutExceptionPolicy({ organizationId: "organization-1", resolutionType: "write_off", currency: "ngn", maximumAmountMinor: 1000, effectiveFrom: new Date("2026-07-01"), policyReference: "POLICY-001", actorIdentityId: "maker-1" })).resolves.toMatchObject({ version: 1, policyId: expect.any(String) });
    expect(query).toHaveBeenCalledTimes(3);
    transactionWithResponses({ rows: [{ organization_id: "organization-1", prepared_by_identity_id: "maker-1", status: "draft", resolution_type: "write_off", currency: "NGN" }] });
    await expect(approveDistributionPayoutExceptionPolicy({ policyId: "policy-1", actorIdentityId: "maker-1" })).rejects.toThrow("different person");
  });

  it("opens only failed, uncertain, or reversed payouts for exception handling", async () => {
    transactionWithResponses({ rows: [{ organization_id: "organization-1", status: "confirmed" }] });
    await expect(openDistributionPayoutException({ payoutInstructionId: "payout-1", actorIdentityId: "operator-1" })).rejects.toThrow("Only uncertain, failed, or reversed");
    transactionWithResponses({ rows: [{ organization_id: "organization-1", status: "failed" }] }, { rows: [{ id: "exception-1" }] });
    await expect(openDistributionPayoutException({ payoutInstructionId: "payout-1", actorIdentityId: "operator-1" })).resolves.toEqual({ exceptionCaseId: "exception-1", replayed: true });
  });

  it("records exception evidence before a correction can be proposed", async () => {
    const query = transactionWithResponses({ rows: [{ organization_id: "organization-1", status: "open" }] }, {}, {});
    await expect(addDistributionPayoutExceptionEvidence({ exceptionCaseId: "exception-1", evidenceType: "bank_statement", contentSha256: "a".repeat(64), storageKey: "payouts/statement.pdf", filename: "statement.pdf", mimeType: "application/pdf", actorIdentityId: "operator-1" })).resolves.toMatchObject({ evidenceId: expect.any(String) });
    expect(query).toHaveBeenCalledTimes(3);
    transactionWithResponses({ rows: [{ status: "evidence_submitted", payout_status: "uncertain" }] });
    await expect(proposeDistributionPayoutExceptionResolution({ exceptionCaseId: "exception-1", resolutionType: "replacement_payout", resolutionReason: "The provider confirmed that the original payout did not complete.", actorIdentityId: "maker-1" })).rejects.toThrow("uncertain payout cannot be replaced");
  });

  it("enforces independent correction and fraud-hold decisions", async () => {
    transactionWithResponses({ rows: [{ status: "decision_pending", prepared_by_identity_id: "maker-1" }] });
    await expect(decideDistributionPayoutExceptionResolution({ exceptionCaseId: "exception-1", approve: true, actorIdentityId: "maker-1" })).rejects.toThrow("different person");
    transactionWithResponses({ rows: [{ status: "approved", hold_status: "clear" }] }, {});
    await expect(proposeDistributionPayoutExceptionHold({ exceptionCaseId: "exception-1", action: "place", reason: "A fraud review is required before the payout correction can proceed.", actorIdentityId: "maker-1" })).resolves.toMatchObject({ status: "pending", holdRequestId: expect.any(String) });
    transactionWithResponses({ rows: [{ case_id: "exception-1", action: "place", status: "pending", prepared_by_identity_id: "maker-1" }] });
    await expect(decideDistributionPayoutExceptionHold({ holdRequestId: "hold-1", approve: true, actorIdentityId: "maker-1" })).rejects.toThrow("different person");
  });
});
