import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn(), transaction: vi.fn() }));
const { query, transaction } = mocks;
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => ({ query: mocks.query }), withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: vi.fn() }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: vi.fn() }));
vi.mock("../postgres-journal.js", () => ({ ensureLedgerAccount: vi.fn(), postJournalInTransaction: vi.fn() }));

import {
  DistributionAuthorityError,
  getDistributionDeclaration,
  getOwnershipSnapshotRequest,
  listDistributionDeclarations,
  listInvestorDistributionEntitlements,
  listOwnershipSnapshotRequests,
  submitDistributionDeclaration,
  submitOwnershipSnapshot,
} from "../postgres-distributions.js";

beforeEach(() => { query.mockReset(); transaction.mockReset(); });

describe("distribution authority read models", () => {
  it("maps ownership snapshots and returns null for an unknown request", async () => {
    const row = { id: "snapshot-1", reference: "OSR-1", organization_id: "org-1", offering_id: "offering-1", public_reference: "OFFER-1", terms: { name: "Income Fund" }, chain_id: 1, token_contract_address: `0x${"a".repeat(40)}`, record_at: new Date("2026-07-01T00:00:00.000Z"), block_number: "10", block_hash: `0x${"b".repeat(64)}`, confirmations: 12, source_type: "archive_rpc", source_reference: "block 10", source_manifest_sha256: "c".repeat(64), total_supply_units: "100", holder_count: 1, status: "approved", submitted_by_identity_id: "maker-1", submitter_name: "Maker One", submitted_at: new Date("2026-07-01T01:00:00.000Z"), reviewed_by_identity_id: "reviewer-1", reviewer_name: "Reviewer One", reviewed_at: new Date("2026-07-01T02:00:00.000Z"), decision_reason: "Verified" };
    query.mockResolvedValueOnce({ rows: [row] });
    await expect(listOwnershipSnapshotRequests("org-1")).resolves.toEqual([expect.objectContaining({ offeringName: "Income Fund", reviewedBy: { id: "reviewer-1", legalName: "Reviewer One" } })]);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(getOwnershipSnapshotRequest("missing")).resolves.toBeNull();
  });

  it("maps declarations and investor entitlements with payout state", async () => {
    const declaration = { id: "declaration-1", reference: "DDR-1", organization_id: "org-1", offering_id: "offering-1", public_reference: "OFFER-1", terms: {}, ownership_snapshot_request_id: "snapshot-1", period_label: "Q1 2026", currency: "NGN", gross_amount_minor: "1000", withholding_tax_bps: 500, withholding_tax_minor: "50", net_amount_minor: "950", payment_due_at: new Date("2026-08-01T00:00:00.000Z"), entitlement_count: 1, policy_version_id: "policy-1", policy_reference: "Policy", policy_name: "Nigeria policy", policy_jurisdiction_code: "NG", policy_legal_basis_reference: "Law", retention_days: 365, retain_until: new Date("2027-07-01T00:00:00.000Z"), status: "approved", submitted_by_identity_id: "maker-1", submitter_name: "Maker One", submitted_at: new Date("2026-07-01T01:00:00.000Z"), reviewed_by_identity_id: null, reviewer_name: null, reviewed_at: null, decision_reason: null, declaration_journal_id: "journal-1" };
    query.mockResolvedValueOnce({ rows: [declaration] });
    await expect(listDistributionDeclarations("org-1")).resolves.toEqual([expect.objectContaining({ offeringName: "OFFER-1", payoutStatus: "not_instructed" })]);
    query.mockResolvedValueOnce({ rows: [{ id: "entitlement-1", reference: "DDR-1", period_label: "Q1 2026", currency: "NGN", gross_amount_minor: "1000", withholding_tax_minor: "50", net_amount_minor: "950", payment_due_at: new Date("2026-08-01T00:00:00.000Z"), retain_until: new Date("2027-07-01T00:00:00.000Z"), reviewed_at: new Date("2026-07-01T02:00:00.000Z"), declaration_journal_id: "journal-1", balance_units: "10", public_reference: "OFFER-1", terms: { name: "Income Fund" }, organization_name: "Issuer One", policy_reference: "Policy", policy_legal_basis_reference: "Law", payout_status: "confirmed", payout_reference: "PAYOUT-1", payout_submitted_at: null, payout_confirmed_at: new Date("2026-07-02T00:00:00.000Z"), payout_failed_at: null, payout_failure_reason: null, settlement_journal_id: "journal-2", reversal_journal_id: null }] });
    await expect(listInvestorDistributionEntitlements("investor-1")).resolves.toEqual([expect.objectContaining({ offeringName: "Income Fund", payoutStatus: "confirmed", payoutConfirmedAt: "2026-07-02T00:00:00.000Z" })]);
  });

  it("rejects invalid snapshot and declaration input before records are written", async () => {
    transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
    query.mockResolvedValueOnce({ rows: [] });
    await expect(submitOwnershipSnapshot({ organizationId: "org-1", offeringId: "offering-1", chainId: 0, tokenContractAddress: "invalid", recordAt: new Date(), blockNumber: "1", blockHash: "invalid", confirmations: 1, sourceType: "archive_rpc", sourceReference: "source", sourceManifestSha256: "a".repeat(64), totalSupplyUnits: "1", holdings: [{ walletAddress: `0x${"a".repeat(40)}`, balanceUnits: "1", sourceRowSha256: "b".repeat(64) }], actorIdentityId: "maker-1", commandKey: "key" })).rejects.toMatchObject({ code: "invalid_input" });
    transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
    query.mockResolvedValueOnce({ rows: [] });
    await expect(submitDistributionDeclaration({ organizationId: "org-1", offeringId: "offering-1", ownershipSnapshotRequestId: "snapshot-1", periodLabel: "Q1", currency: "NG", grossAmountMinor: "100", withholdingTaxBps: 0, paymentDueAt: new Date(Date.now() + 86_400_000), actorIdentityId: "maker-1", commandKey: "key" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("uses a typed authority error", () => {
    expect(new DistributionAuthorityError("missing", "not_found")).toBeInstanceOf(Error);
  });
});
