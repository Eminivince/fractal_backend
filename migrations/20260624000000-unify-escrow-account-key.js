/**
 * 3.1: Unify the escrow account key.
 *
 * Historically, escrow CREDITS (investor money in) were posted to `offering:<id>`
 * while escrow DEBITS and balance reads used `escrow:offering:<id>`, splitting one
 * logical account across two keys. Every `offering:<id>` ledger row represents an
 * escrow-pool movement, so this migration rewrites them to the canonical
 * `escrow:offering:<id>` key. Migrated rows are tagged so `down` can revert safely.
 *
 * It also (re)creates the unique index on `idempotencyKey` and the
 * accountRef+direction index used by escrow balance reads.
 */

export const up = async (db) => {
  const ledger = db.collection("ledgerEntries");

  // Rewrite `offering:<id>` -> `escrow:offering:<id>` for every escrow-pool row.
  await ledger.updateMany({ accountRef: { $regex: "^offering:" } }, [
    {
      $set: {
        accountRef: { $concat: ["escrow:", "$accountRef"] },
        "metadata.escrowKeyMigrated": true,
      },
    },
  ]);

  // 3.3: enforce DB-level idempotency. Drop the old non-unique compound index if present.
  await ledger.dropIndex("idempotencyKey_1_ledgerType_1_accountRef_1").catch(() => {});
  await ledger.dropIndex("idempotencyKey_1").catch(() => {});
  await ledger.createIndex({ idempotencyKey: 1 }, { unique: true, sparse: true, background: true });

  // Balance reads aggregate by accountRef + direction.
  await ledger.createIndex({ accountRef: 1, direction: 1 }, { background: true });
};

export const down = async (db) => {
  const ledger = db.collection("ledgerEntries");

  // Revert only the rows this migration rewrote.
  await ledger.updateMany({ "metadata.escrowKeyMigrated": true }, [
    {
      $set: {
        accountRef: {
          $replaceOne: { input: "$accountRef", find: "escrow:", replacement: "" },
        },
      },
    },
    { $unset: "metadata.escrowKeyMigrated" },
  ]);

  await ledger.dropIndex("idempotencyKey_1").catch(() => {});
  await ledger.dropIndex("accountRef_1_direction_1").catch(() => {});
};
