import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { hashPayload } from "../utils/idempotency.js";

export type JournalDirection = "debit" | "credit";
export type LedgerAccountType = "asset" | "liability" | "equity" | "revenue" | "expense";

export class JournalValidationError extends Error {}
export class JournalIdempotencyConflictError extends Error {}

export interface LedgerAccountInput {
  organizationId?: string;
  code: string;
  name: string;
  accountType: LedgerAccountType;
  normalBalance: JournalDirection;
}

export interface JournalPostingInput {
  accountCode: string;
  direction: JournalDirection;
  amountMinor: bigint | number;
  metadata?: Record<string, unknown>;
}

export interface PostJournalInput {
  scopeKey: string;
  organizationId?: string;
  idempotencyKey: string;
  currency: string;
  narrative: string;
  externalRef?: string;
  effectiveAt?: Date;
  reversalOf?: string;
  metadata?: Record<string, unknown>;
  postings: readonly JournalPostingInput[];
}

export interface PostedJournal {
  journalId: string;
  replayed: boolean;
}

type AccountRow = { id: string; code: string };
type ExistingJournalRow = { id: string; request_hash: string };

function normalizeCurrency(value: string): string {
  const currency = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new JournalValidationError("Journal currency must be an ISO 4217 alpha-3 code");
  return currency;
}

function normalizeAccountCode(value: string): string {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._:-]{1,63}$/.test(code)) {
    throw new JournalValidationError("Ledger account code must be 2-64 uppercase alphanumeric characters");
  }
  return code;
}

function normalizeMinor(value: bigint | number): bigint {
  if (typeof value === "number" && (!Number.isSafeInteger(value) || value <= 0)) {
    throw new JournalValidationError("Posting amountMinor must be a positive safe integer");
  }
  const minor = typeof value === "bigint" ? value : BigInt(value);
  if (minor <= 0n || minor > 9_223_372_036_854_775_807n) {
    throw new JournalValidationError("Posting amountMinor is outside the PostgreSQL BIGINT range");
  }
  return minor;
}

function validateJournal(input: PostJournalInput) {
  if (!input.scopeKey.trim()) throw new JournalValidationError("Journal scopeKey is required");
  if (!input.idempotencyKey.trim()) throw new JournalValidationError("Journal idempotencyKey is required");
  if (!input.narrative.trim()) throw new JournalValidationError("Journal narrative is required");
  if (input.postings.length < 2) throw new JournalValidationError("A journal requires at least two postings");

  const currency = normalizeCurrency(input.currency);
  let debits = 0n;
  let credits = 0n;
  const postings = input.postings.map((posting) => {
    if (posting.direction !== "debit" && posting.direction !== "credit") {
      throw new JournalValidationError("Posting direction must be debit or credit");
    }
    const amountMinor = normalizeMinor(posting.amountMinor);
    if (posting.direction === "debit") debits += amountMinor;
    else credits += amountMinor;
    return { ...posting, accountCode: normalizeAccountCode(posting.accountCode), amountMinor };
  });
  if (debits !== credits) throw new JournalValidationError("Journal debits must equal credits");
  return { currency, postings };
}

/** Create an account once. Accounts with financial history are not mutable. */
export async function ensureLedgerAccount(client: PoolClient, input: LedgerAccountInput): Promise<string> {
  const code = normalizeAccountCode(input.code);
  if (!input.name.trim()) throw new JournalValidationError("Ledger account name is required");
  const result = await client.query<{ id: string }>(
    `INSERT INTO fractal.ledger_accounts (id, organization_id, code, name, account_type, normal_balance)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (organization_id, code) DO UPDATE SET code = fractal.ledger_accounts.code
     RETURNING id`,
    [randomUUID(), input.organizationId ?? null, code, input.name.trim(), input.accountType, input.normalBalance],
  );
  const accountId = result.rows[0]?.id;
  if (!accountId) throw new Error("Unable to resolve ledger account");
  return accountId;
}

/**
 * Appends a fully balanced journal using the caller's transaction. The deferred
 * database constraint independently proves the balance at commit, so a raw SQL
 * caller cannot persist a one-sided or cross-currency journal either.
 */
export async function postJournalInTransaction(client: PoolClient, input: PostJournalInput): Promise<PostedJournal> {
  const { currency, postings } = validateJournal(input);
  const effectiveAt = input.effectiveAt ?? new Date();
  const requestHash = hashPayload({
    scopeKey: input.scopeKey,
    organizationId: input.organizationId ?? null,
    idempotencyKey: input.idempotencyKey,
    currency,
    narrative: input.narrative,
    externalRef: input.externalRef ?? null,
    effectiveAt: input.effectiveAt?.toISOString() ?? null,
    reversalOf: input.reversalOf ?? null,
    metadata: input.metadata ?? {},
    postings: postings.map((posting) => ({
      accountCode: posting.accountCode,
      direction: posting.direction,
      amountMinor: posting.amountMinor.toString(),
      metadata: posting.metadata ?? {},
    })),
  });
  const journalId = randomUUID();
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO fractal.journal_entries
       (id, scope_key, organization_id, idempotency_key, request_hash, currency, effective_at, narrative, external_ref, reversal_of, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (scope_key, idempotency_key) DO NOTHING
     RETURNING id`,
    [
      journalId,
      input.scopeKey,
      input.organizationId ?? null,
      input.idempotencyKey,
      requestHash,
      currency,
      effectiveAt,
      input.narrative.trim(),
      input.externalRef ?? null,
      input.reversalOf ?? null,
      input.metadata ?? {},
    ],
  );
  if (inserted.rowCount === 0) {
    const existing = await client.query<ExistingJournalRow>(
      `SELECT id, request_hash FROM fractal.journal_entries
        WHERE scope_key = $1 AND idempotency_key = $2 FOR UPDATE`,
      [input.scopeKey, input.idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Journal disappeared during idempotency resolution");
    if (row.request_hash !== requestHash) {
      throw new JournalIdempotencyConflictError("Journal idempotency key has already been used with a different payload");
    }
    return { journalId: row.id, replayed: true };
  }

  const accountCodes = [...new Set(postings.map((posting) => posting.accountCode))];
  const accounts = await client.query<AccountRow>(
    `SELECT id, code FROM fractal.ledger_accounts
      WHERE code = ANY($1::text[])
        AND organization_id IS NOT DISTINCT FROM $2
        AND active = true
      FOR SHARE`,
    [accountCodes, input.organizationId ?? null],
  );
  const accountByCode = new Map(accounts.rows.map((account) => [account.code, account.id]));
  if (accountByCode.size !== accountCodes.length) {
    const unresolved = accountCodes.filter((code) => !accountByCode.has(code));
    throw new JournalValidationError(`Unknown or inactive ledger account: ${unresolved.join(", ")}`);
  }

  for (const [index, posting] of postings.entries()) {
    await client.query(
      `INSERT INTO fractal.journal_postings
         (journal_id, line_number, account_id, direction, amount_minor, currency, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [journalId, index + 1, accountByCode.get(posting.accountCode), posting.direction, posting.amountMinor.toString(), currency, posting.metadata ?? {}],
    );
  }
  return { journalId, replayed: false };
}

export async function postJournal(input: PostJournalInput): Promise<PostedJournal> {
  return withPostgresTransaction((client) => postJournalInTransaction(client, input));
}

/** Create a compensating entry. Original journals are never altered or deleted. */
export async function reverseJournal(input: Omit<PostJournalInput, "currency" | "postings" | "reversalOf"> & { originalJournalId: string }): Promise<PostedJournal> {
  return withPostgresTransaction(async (client) => {
    const original = await client.query<{ currency: string }>(
      "SELECT currency FROM fractal.journal_entries WHERE id = $1 FOR SHARE",
      [input.originalJournalId],
    );
    const currency = original.rows[0]?.currency;
    if (!currency) throw new JournalValidationError("Original journal was not found");
    const postings = await client.query<{ code: string; direction: JournalDirection; amount_minor: string; metadata: Record<string, unknown> }>(
      `SELECT account.code, posting.direction, posting.amount_minor, posting.metadata
         FROM fractal.journal_postings AS posting
         JOIN fractal.ledger_accounts AS account ON account.id = posting.account_id
        WHERE posting.journal_id = $1 ORDER BY posting.line_number`,
      [input.originalJournalId],
    );
    if (postings.rows.length < 2) throw new JournalValidationError("Original journal has no reversible postings");
    return postJournalInTransaction(client, {
      ...input,
      currency,
      reversalOf: input.originalJournalId,
      narrative: input.narrative.trim() || `Reversal of ${input.originalJournalId}`,
      postings: postings.rows.map((posting) => ({
        accountCode: posting.code,
        direction: posting.direction === "debit" ? "credit" : "debit",
        amountMinor: BigInt(posting.amount_minor),
        metadata: posting.metadata,
      })),
    });
  });
}
