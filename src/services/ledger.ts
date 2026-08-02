/**
 * Central ledger service.
 *
 * Invariants enforced here:
 *  - There is ONE canonical escrow account per offering: `escrow:offering:<id>`.
 *    All escrow credits (investor money in) and escrow debits (distributions,
 *    refunds, tranche/fund releases) post to this single key so the escrow
 *    balance is knowable. (Fixes the split-key accounting bug.)
 *  - Ledger writes are idempotent: an entry whose `idempotencyKey` already exists
 *    is a no-op. The unique index on `idempotencyKey` is the race backstop.
 *  - Balance math is done in integer kobo to avoid floating-point drift.
 */
import type mongoose from "mongoose";
import { LedgerEntryModel } from "../db/models.js";
import { toDecimal } from "../utils/decimal.js";
import { nairaToKobo } from "../utils/money.js";

/** The single canonical escrow account key for an offering. */
export function escrowAccountRef(offeringId: { toString(): string }): string {
  return `escrow:offering:${String(offeringId)}`;
}

/** MongoDB duplicate-key error guard. */
export function isDuplicateKeyError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    ((err as { code?: number }).code === 11000 ||
      (err as { code?: number }).code === 11001)
  );
}

export interface LedgerEntryInput {
  ledgerType: string;
  accountRef: string;
  direction: "debit" | "credit";
  amount: number | string | mongoose.Types.Decimal128;
  currency?: string;
  entityType: string;
  entityId: string;
  externalRef?: string;
  idempotencyKey?: string;
  postedAt?: Date;
  metadata?: Record<string, unknown>;
}

/**
 * Post one or more ledger entries idempotently.
 *
 * For each entry that carries an `idempotencyKey`, we first check whether it has
 * already been posted (within the same session) and skip if so — making the
 * common idempotent-retry path a clean no-op. The unique index on
 * `idempotencyKey` protects against the rare truly-concurrent race (one writer
 * fails with E11000; safe — no double write).
 */
/** Minimal store interface the ledger needs — satisfied by the Mongoose model;
 * an in-memory fake can be injected for unit tests. */
export interface LedgerStore {
  findOne(query: Record<string, unknown>): {
    session(s: mongoose.ClientSession | null): { lean(): Promise<unknown> };
  };
  create(docs: unknown[], options?: { session?: mongoose.ClientSession }): Promise<unknown>;
}

export async function postLedger(
  entries: LedgerEntryInput | LedgerEntryInput[],
  session?: mongoose.ClientSession | null,
  store: LedgerStore = LedgerEntryModel as unknown as LedgerStore,
): Promise<void> {
  const arr = Array.isArray(entries) ? entries : [entries];
  for (const raw of arr) {
    const entry = {
      currency: "NGN",
      postedAt: new Date(),
      metadata: {},
      ...raw,
      amount: toDecimal(raw.amount as string | number | mongoose.Types.Decimal128),
    };

    if (entry.idempotencyKey) {
      const existing = await store
        .findOne({ idempotencyKey: entry.idempotencyKey })
        .session(session ?? null)
        .lean();
      if (existing) continue;
    }

    try {
      if (session) {
        await store.create([entry], { session });
      } else {
        await store.create([entry]);
      }
    } catch (err) {
      if (isDuplicateKeyError(err) && entry.idempotencyKey) continue;
      throw err;
    }
  }
}

export interface EscrowBalance {
  creditsKobo: number;
  debitsKobo: number;
  balanceKobo: number;
  /** balance in naira */
  balance: number;
}

type BalanceRow = { direction: string; amount: number | string | { toString(): string } };

/**
 * Pure balance computation in integer kobo. Exported for unit testing the
 * "balance" and "debit==credit" invariants without a database.
 */
export function computeBalanceKobo(rows: BalanceRow[]): EscrowBalance {
  let creditsKobo = 0;
  let debitsKobo = 0;
  for (const r of rows) {
    const kobo = nairaToKobo(r.amount);
    if (r.direction === "credit") creditsKobo += kobo;
    else debitsKobo += kobo;
  }
  const balanceKobo = creditsKobo - debitsKobo;
  return { creditsKobo, debitsKobo, balanceKobo, balance: balanceKobo / 100 };
}

/**
 * Invariant: a single financial transaction's postings must balance
 * (total debits == total credits) when modelled as double-entry. Throws otherwise.
 */
export function assertTransactionBalanced(rows: BalanceRow[]): void {
  const { creditsKobo, debitsKobo } = computeBalanceKobo(rows);
  if (creditsKobo !== debitsKobo) {
    throw new Error(
      `Unbalanced ledger transaction: credits=${creditsKobo} kobo, debits=${debitsKobo} kobo`,
    );
  }
}

/**
 * Over-distribution / over-release guard (no `>= 0` bypass): returns true when the
 * requested amount exceeds escrow available after reserving in-flight amounts.
 * Rejects even when the balance is already depleted (available < 0).
 */
export function exceedsAvailableEscrow(args: {
  escrowBalance: number;
  pendingAmount: number;
  requestedAmount: number;
}): boolean {
  const available = args.escrowBalance - args.pendingAmount;
  return args.requestedAmount > available;
}

/**
 * Compute the escrow balance for an offering from the canonical key.
 * Sums every credit/debit posted to `escrow:offering:<id>` in integer kobo.
 */
export async function getEscrowBalance(
  offeringId: { toString(): string },
  session?: mongoose.ClientSession | null,
): Promise<EscrowBalance> {
  const ref = escrowAccountRef(offeringId);
  const rows = await LedgerEntryModel.find({ accountRef: ref })
    .session(session ?? null)
    .select("direction amount")
    .lean();

  return computeBalanceKobo(
    (rows as Array<{ direction: string; amount: unknown }>).map((r) => ({
      direction: r.direction,
      amount: (r.amount as { toString(): string })?.toString() ?? "0",
    })),
  );
}

/**
 * An investor's ownership position (in NGN value) for a specific offering, derived
 * from the ownership ledger: allocation credits minus any transfers out.
 */
export async function getOwnershipHolding(
  userId: { toString(): string },
  offeringId: { toString(): string },
  session?: mongoose.ClientSession | null,
): Promise<number> {
  const rows = await LedgerEntryModel.find({
    ledgerType: "ownership",
    accountRef: `investor:${String(userId)}`,
    entityType: "offering",
    entityId: String(offeringId),
  })
    .session(session ?? null)
    .select("direction amount")
    .lean();

  const { balance } = computeBalanceKobo(
    (rows as Array<{ direction: string; amount: unknown }>).map((r) => ({
      direction: r.direction,
      amount: (r.amount as { toString(): string })?.toString() ?? "0",
    })),
  );
  return balance;
}
