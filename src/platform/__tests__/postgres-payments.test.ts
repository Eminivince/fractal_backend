import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPayload } from "../../utils/idempotency.js";

const mocks = vi.hoisted(() => ({ withTransaction: vi.fn(), ensureAccount: vi.fn(), postJournal: vi.fn(), appendAudit: vi.fn(), appendOutbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-journal.js", () => ({
  JournalValidationError: class JournalValidationError extends Error {},
  ensureLedgerAccount: mocks.ensureAccount,
  postJournalInTransaction: mocks.postJournal,
}));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));

import {
  PaymentIntentNotFoundError,
  PaymentReceiptConflictError,
  PaymentStateError,
  createPaymentCommitment,
  createPaymentCommitmentInTransaction,
  ensureCollectionAccounts,
  recordProviderPaymentReceipt,
} from "../postgres-payments.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
const receivedAt = new Date("2026-07-29T12:00:00.000Z");
const futureExpiry = () => new Date(Date.now() + 24 * 60 * 60 * 1_000);
const lateReceiptAt = () => new Date(Date.now() + 48 * 60 * 60 * 1_000);
function commitmentInput(overrides: Record<string, unknown> = {}) {
  return { organizationId: "organization-1", investorIdentityId: "identity-1", offeringReference: "OFF-1", currency: "usd", committedMinor: 1000, provider: "paystack", providerReference: "reference-1", expiresAt: futureExpiry(), ...overrides };
}
function intent(overrides: Record<string, unknown> = {}) {
  return { id: "intent-1", commitment_id: "commitment-1", organization_id: "organization-1", investor_identity_id: "identity-1", expected_minor: "1000", currency: "USD", status: "pending", expires_at: futureExpiry(), ...overrides };
}
function receiptInput(overrides: Record<string, unknown> = {}) {
  return { provider: "paystack", providerReference: "reference-1", providerEventId: "event-1", amountMinor: 1000, currency: "usd", receivedAt, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.ensureAccount.mockResolvedValue(undefined);
  mocks.postJournal.mockResolvedValue({ journalId: "journal-1" });
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
});

describe("payment commitments", () => {
  it("provisions balanced clearing and investor escrow accounts", async () => {
    const client = clientWith();
    await ensureCollectionAccounts(client as any, "organization-1", "usd");
    expect(mocks.ensureAccount).toHaveBeenNthCalledWith(1, client, expect.objectContaining({ code: "ASSET.PAYSTACK_CLEARING.USD", accountType: "asset", normalBalance: "debit" }));
    expect(mocks.ensureAccount).toHaveBeenNthCalledWith(2, client, expect.objectContaining({ code: "LIABILITY.INVESTOR_ESCROW.USD", accountType: "liability", normalBalance: "credit" }));
  });

  it("creates a durable payment intent with audit and outbox evidence", async () => {
    const client = clientWith({}, {});
    const created = await createPaymentCommitmentInTransaction(client as any, commitmentInput());
    expect(created).toMatchObject({ commitmentId: expect.any(String), paymentIntentId: expect.any(String) });
    expect(client.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["OFF-1", "USD", "1000"]));
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["paystack", "reference-1", "USD"]));
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "payment.intent.created" }));
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "payment.intent.created" }));
  });

  it("rejects invalid amount, currency, identity fields, and expired commitments", async () => {
    const client = { query: vi.fn() } as any;
    await expect(createPaymentCommitmentInTransaction(client, commitmentInput({ committedMinor: 0 }))).rejects.toThrow("outside BIGINT range");
    await expect(createPaymentCommitmentInTransaction(client, commitmentInput({ currency: "US" }))).rejects.toThrow("ISO 4217");
    await expect(createPaymentCommitmentInTransaction(client, commitmentInput({ offeringReference: " " }))).rejects.toThrow("offeringReference");
    await expect(createPaymentCommitmentInTransaction(client, commitmentInput({ expiresAt: new Date("2020-01-01") }))).rejects.toBeInstanceOf(PaymentStateError);
    const wrapped = clientWith({}, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(wrapped));
    await expect(createPaymentCommitment(commitmentInput())).resolves.toMatchObject({ commitmentId: expect.any(String) });
  });
});

describe("provider payment receipts", () => {
  it("rejects a receipt for an unknown or already-final payment intent", async () => {
    const unknown = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unknown));
    await expect(recordProviderPaymentReceipt(receiptInput())).rejects.toBeInstanceOf(PaymentIntentNotFoundError);
    const final = clientWith({ rows: [intent({ status: "receipt_matched" })], rowCount: 1 }, { rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(final));
    await expect(recordProviderPaymentReceipt(receiptInput())).rejects.toThrow("receipt_matched");
  });

  it("returns an exact provider-event replay and rejects changed payload reuse", async () => {
    const matchingHash = hashPayload({ provider: "paystack", providerReference: "reference-1", providerEventId: "event-1", amountMinor: "1000", currency: "USD", receivedAt: receivedAt.toISOString(), metadata: {} });
    const replay = clientWith({ rows: [intent()], rowCount: 1 }, { rows: [{ id: "receipt-1", payload_hash: matchingHash, status: "matched", journal_id: "journal-1" }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(replay));
    await expect(recordProviderPaymentReceipt(receiptInput())).resolves.toMatchObject({ receiptId: "receipt-1", replayed: true, journalId: "journal-1" });
    const changed = clientWith({ rows: [intent()], rowCount: 1 }, { rows: [{ id: "receipt-1", payload_hash: "different", status: "matched", journal_id: null }], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(changed));
    await expect(recordProviderPaymentReceipt(receiptInput())).rejects.toBeInstanceOf(PaymentReceiptConflictError);
  });

  it("matches a timely exact receipt, posts a balanced journal, and confirms its reservation", async () => {
    const client = clientWith({ rows: [intent()], rowCount: 1 }, { rows: [], rowCount: 0 }, {}, {}, {}, {});
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    const result = await recordProviderPaymentReceipt(receiptInput());
    expect(result).toMatchObject({ status: "matched", journalId: "journal-1", replayed: false });
    expect(mocks.postJournal).toHaveBeenCalledWith(client, expect.objectContaining({ postings: [expect.objectContaining({ direction: "debit", amountMinor: 1000n }), expect.objectContaining({ direction: "credit", amountMinor: 1000n })] }));
    expect(client.query.mock.calls.some(([sql]) => sql.includes("status = 'confirmed'"))).toBe(true);
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "payment.receipt.matched" }));
  });

  it("creates reconciliation cases for amount, currency, and late payment mismatches", async () => {
    for (const [input, expectedCase, expectedIntentStatus] of [
      [receiptInput({ amountMinor: 999 }), "amount_mismatch", "amount_mismatch"],
      [receiptInput({ currency: "EUR" }), "currency_mismatch", "amount_mismatch"],
      [receiptInput({ receivedAt: lateReceiptAt() }), "late_payment", "expired"],
    ] as const) {
      const client = clientWith({ rows: [intent()], rowCount: 1 }, { rows: [], rowCount: 0 }, {}, {}, {}, {});
      mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
      await expect(recordProviderPaymentReceipt(input)).resolves.toMatchObject({ status: "amount_mismatch", reconciliationCaseId: expect.any(String), replayed: false });
      expect(client.query.mock.calls[3]?.[1]).toEqual(expect.arrayContaining([expectedCase]));
      expect(client.query.mock.calls[4]?.[1]).toEqual(["intent-1", expectedIntentStatus]);
      expect(mocks.appendAudit).toHaveBeenLastCalledWith(client, expect.objectContaining({ action: "payment.receipt.reconciliation_required" }));
    }
  });
});
