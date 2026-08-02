import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import {
  JournalIdempotencyConflictError,
  JournalValidationError,
  ensureLedgerAccount,
  postJournal,
  reverseJournal,
} from "../postgres-journal.js";

const CASH = "ASSET.CASH.NGN";
const ESCROW = "LIABILITY.ESCROW.NGN";

async function seedAccounts() {
  await withPostgresTransaction(async (client) => {
    await ensureLedgerAccount(client, { code: CASH, name: "Naira cash", accountType: "asset", normalBalance: "debit" });
    await ensureLedgerAccount(client, { code: ESCROW, name: "Investor escrow", accountType: "liability", normalBalance: "credit" });
  });
}

function depositInput() {
  return {
    scopeKey: "offering:journal-test",
    idempotencyKey: "deposit-1",
    currency: "NGN",
    narrative: "Investor cash received into escrow",
    externalRef: "paystack:deposit-1",
    postings: [
      { accountCode: CASH, direction: "debit" as const, amountMinor: 125_050 },
      { accountCode: ESCROW, direction: "credit" as const, amountMinor: 125_050 },
    ],
  };
}

describe("PostgreSQL accounting journal", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.payment_provider_instructions, fractal.investment_reservations, fractal.payment_reconciliation_cases, fractal.payment_receipts, fractal.payment_intents, fractal.investment_commitments, fractal.journal_postings, fractal.journal_entries, fractal.ledger_accounts CASCADE");
    await seedAccounts();
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("writes exact balanced minor-unit postings and replays an identical command", async () => {
    const first = await postJournal(depositInput());
    const replay = await postJournal(depositInput());
    expect(first.replayed).toBe(false);
    expect(replay).toEqual({ journalId: first.journalId, replayed: true });

    const rows = await postgresQuery<{ direction: string; amount_minor: string }>(
      "SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number",
      [first.journalId],
    );
    expect(rows.rows).toEqual([
      { direction: "debit", amount_minor: "125050" },
      { direction: "credit", amount_minor: "125050" },
    ]);
    await expect(postgresQuery("UPDATE fractal.journal_postings SET amount_minor = 1 WHERE journal_id = $1", [first.journalId]))
      .rejects.toThrow("append-only");
  });

  it("rejects an idempotency key reused with a different financial payload", async () => {
    await postJournal(depositInput());
    await expect(postJournal({ ...depositInput(), narrative: "Different accounting intent" }))
      .rejects.toBeInstanceOf(JournalIdempotencyConflictError);
  });

  it("reverses through a compensating journal and prevents a second reversal", async () => {
    const original = await postJournal(depositInput());
    const reversal = await reverseJournal({
      scopeKey: "offering:journal-test",
      idempotencyKey: "deposit-1-reversal",
      originalJournalId: original.journalId,
      narrative: "",
    });
    const lines = await postgresQuery<{ direction: string; amount_minor: string }>(
      "SELECT direction, amount_minor FROM fractal.journal_postings WHERE journal_id = $1 ORDER BY line_number",
      [reversal.journalId],
    );
    expect(lines.rows).toEqual([
      { direction: "credit", amount_minor: "125050" },
      { direction: "debit", amount_minor: "125050" },
    ]);
    await expect(reverseJournal({
      scopeKey: "offering:journal-test",
      idempotencyKey: "deposit-1-reversal-duplicate",
      originalJournalId: original.journalId,
      narrative: "Duplicate reversal",
    })).rejects.toThrow();
  });

  it("enforces a balanced two-sided journal even for direct database writers", async () => {
    await expect(withPostgresTransaction(async (client) => {
      const account = await client.query<{ id: string }>("SELECT id FROM fractal.ledger_accounts WHERE code = $1", [CASH]);
      await client.query(
        `INSERT INTO fractal.journal_entries
           (id, scope_key, idempotency_key, request_hash, currency, effective_at, narrative)
         VALUES ('00000000-0000-0000-0000-000000000001', 'direct:unbalanced', 'bad-1', repeat('0', 64), 'NGN', now(), 'Bad direct insert')`,
      );
      await client.query(
        `INSERT INTO fractal.journal_postings
           (journal_id, line_number, account_id, direction, amount_minor, currency)
         VALUES ('00000000-0000-0000-0000-000000000001', 1, $1, 'debit', 100, 'NGN')`,
        [account.rows[0]?.id],
      );
    })).rejects.toThrow("at least two postings");
  });

  it("rejects unsafe or unbalanced application inputs before writing", async () => {
    await expect(postJournal({ ...depositInput(), postings: [{ accountCode: CASH, direction: "debit", amountMinor: 1 }] }))
      .rejects.toBeInstanceOf(JournalValidationError);
    await expect(postJournal({ ...depositInput(), postings: [
      { accountCode: CASH, direction: "debit", amountMinor: 101 },
      { accountCode: ESCROW, direction: "credit", amountMinor: 100 },
    ] })).rejects.toBeInstanceOf(JournalValidationError);
  });

  it("does not permit an organization journal to use another organization’s chart of accounts", async () => {
    const organizationA = "00000000-0000-0000-0000-000000000101";
    const organizationB = "00000000-0000-0000-0000-000000000102";
    await postgresQuery(
      "INSERT INTO fractal.organizations (id, legal_name, status) VALUES ($1, 'Journal A', 'active'), ($2, 'Journal B', 'active') ON CONFLICT (id) DO NOTHING",
      [organizationA, organizationB],
    );
    await withPostgresTransaction(async (client) => {
      await ensureLedgerAccount(client, { organizationId: organizationA, code: "ASSET.CASH.TENANT", name: "Tenant cash", accountType: "asset", normalBalance: "debit" });
      await ensureLedgerAccount(client, { organizationId: organizationA, code: "LIABILITY.ESCROW.TENANT", name: "Tenant escrow", accountType: "liability", normalBalance: "credit" });
    });
    await expect(postJournal({
      ...depositInput(),
      organizationId: organizationB,
      idempotencyKey: "tenant-scope-1",
      postings: [
        { accountCode: "ASSET.CASH.TENANT", direction: "debit", amountMinor: 100 },
        { accountCode: "LIABILITY.ESCROW.TENANT", direction: "credit", amountMinor: 100 },
      ],
    })).rejects.toBeInstanceOf(JournalValidationError);
  });
});
