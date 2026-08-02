import { describe, it, expect } from "vitest";
import {
  escrowAccountRef,
  computeBalanceKobo,
  assertTransactionBalanced,
  exceedsAvailableEscrow,
  postLedger,
  isDuplicateKeyError,
  type LedgerStore,
} from "../ledger.js";

describe("escrowAccountRef — single canonical key (3.1)", () => {
  it("produces escrow:offering:<id> for any id type", () => {
    expect(escrowAccountRef("abc")).toBe("escrow:offering:abc");
    expect(escrowAccountRef({ toString: () => "xyz" })).toBe("escrow:offering:xyz");
  });
});

describe("computeBalanceKobo — escrow balance invariant", () => {
  it("computes credits - debits in exact kobo", () => {
    const b = computeBalanceKobo([
      { direction: "credit", amount: 100 },
      { direction: "credit", amount: 50.5 },
      { direction: "debit", amount: 30.25 },
    ]);
    expect(b.creditsKobo).toBe(15_050);
    expect(b.debitsKobo).toBe(3_025);
    expect(b.balanceKobo).toBe(12_025);
    expect(b.balance).toBe(120.25);
  });

  it("can report a negative (depleted) balance — never silently clamps", () => {
    const b = computeBalanceKobo([
      { direction: "credit", amount: 10 },
      { direction: "debit", amount: 25 },
    ]);
    expect(b.balance).toBe(-15);
  });

  it("preserves Decimal128-scale amounts without binary floating-point drift", () => {
    const b = computeBalanceKobo([
      { direction: "credit", amount: "90071992547409.91" },
      { direction: "debit", amount: "90071992547409.90" },
    ]);
    expect(b.balanceKobo).toBe(1);
    expect(b.balance).toBe(0.01);
  });
});

describe("assertTransactionBalanced — double-entry invariant (debit==credit)", () => {
  it("passes when debits equal credits (e.g. tranche release)", () => {
    expect(() =>
      assertTransactionBalanced([
        { direction: "debit", amount: 1000 }, // escrow out
        { direction: "credit", amount: 1000 }, // issuer in
      ]),
    ).not.toThrow();
  });

  it("throws when a transaction does not balance", () => {
    expect(() =>
      assertTransactionBalanced([
        { direction: "debit", amount: 1000 },
        { direction: "credit", amount: 999.99 },
      ]),
    ).toThrow(/Unbalanced/);
  });
});

describe("exceedsAvailableEscrow — over-distribution guard (3.2, no >= 0 bypass)", () => {
  it("allows a distribution within available escrow", () => {
    expect(
      exceedsAvailableEscrow({ escrowBalance: 1000, pendingAmount: 200, requestedAmount: 700 }),
    ).toBe(false);
  });

  it("rejects a distribution that exceeds available escrow", () => {
    expect(
      exceedsAvailableEscrow({ escrowBalance: 1000, pendingAmount: 200, requestedAmount: 900 }),
    ).toBe(true);
  });

  it("CRITICAL: still rejects when escrow is depleted (negative available) — the old bypass is gone", () => {
    // Old buggy guard skipped the check whenever available < 0. This must reject.
    expect(
      exceedsAvailableEscrow({ escrowBalance: -500, pendingAmount: 0, requestedAmount: 100 }),
    ).toBe(true);
    expect(
      exceedsAvailableEscrow({ escrowBalance: 100, pendingAmount: 300, requestedAmount: 50 }),
    ).toBe(true);
  });
});

describe("isDuplicateKeyError", () => {
  it("detects mongo E11000/E11001", () => {
    expect(isDuplicateKeyError({ code: 11000 })).toBe(true);
    expect(isDuplicateKeyError({ code: 11001 })).toBe(true);
    expect(isDuplicateKeyError({ code: 121 })).toBe(false);
    expect(isDuplicateKeyError(null)).toBe(false);
  });
});

// In-memory ledger store emulating the unique idempotencyKey index.
function makeStore(opts: { findOneAlwaysNull?: boolean } = {}): LedgerStore & { rows: any[] } {
  const rows: any[] = [];
  return {
    rows,
    findOne(query: Record<string, unknown>) {
      return {
        session() {
          return {
            async lean() {
              if (opts.findOneAlwaysNull) return null;
              return (
                rows.find(
                  (r) => r.idempotencyKey && r.idempotencyKey === (query as any).idempotencyKey,
                ) ?? null
              );
            },
          };
        },
      };
    },
    async create(docs: any[]) {
      for (const d of docs) {
        if (d.idempotencyKey && rows.some((r) => r.idempotencyKey === d.idempotencyKey)) {
          const err: any = new Error("E11000 duplicate key error");
          err.code = 11000;
          throw err;
        }
        rows.push(d);
      }
      return docs;
    },
  };
}

describe("postLedger — idempotent payments (3.3)", () => {
  const entry = {
    ledgerType: "escrow",
    accountRef: escrowAccountRef("off1"),
    direction: "credit" as const,
    amount: 500,
    entityType: "subscription",
    entityId: "sub1",
    idempotencyKey: "paystack:charge:ref123",
  };

  it("posts once; a repeat with the same idempotencyKey is a no-op (pre-check)", async () => {
    const store = makeStore();
    await postLedger(entry, null, store);
    await postLedger(entry, null, store);
    expect(store.rows).toHaveLength(1);
  });

  it("swallows a duplicate-key race (pre-check missed) as a no-op", async () => {
    // findOne always returns null to simulate the race window; the unique index
    // throws E11000 on the second create, which postLedger must treat as success.
    const store = makeStore({ findOneAlwaysNull: true });
    await postLedger(entry, null, store);
    await expect(postLedger(entry, null, store)).resolves.toBeUndefined();
    expect(store.rows).toHaveLength(1);
  });

  it("posts distinct entries with different idempotency keys", async () => {
    const store = makeStore();
    await postLedger({ ...entry, idempotencyKey: "k1" }, null, store);
    await postLedger({ ...entry, idempotencyKey: "k2" }, null, store);
    expect(store.rows).toHaveLength(2);
  });
});
