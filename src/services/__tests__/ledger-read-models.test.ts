import { describe, expect, it, vi } from "vitest";

const find = vi.hoisted(() => vi.fn());

vi.mock("../../db/models.js", () => ({ LedgerEntryModel: { find } }));

import { getEscrowBalance, getOwnershipHolding, postLedger, type LedgerStore } from "../ledger.js";

function query(rows: unknown[]) {
  const lean = vi.fn().mockResolvedValue(rows);
  const select = vi.fn().mockReturnValue({ lean });
  const session = vi.fn().mockReturnValue({ select });
  return { session, select, lean };
}

describe("ledger read models", () => {
  it("reads the canonical escrow balance in a database session", async () => {
    const record = query([
      { direction: "credit", amount: { toString: () => "100.50" } },
      { direction: "debit", amount: { toString: () => "25.25" } },
    ]);
    find.mockReturnValue(record);
    const session = {} as any;

    await expect(getEscrowBalance({ toString: () => "offering-1" }, session)).resolves.toMatchObject({ creditsKobo: 10_050, debitsKobo: 2_525, balance: 75.25 });
    expect(find).toHaveBeenCalledWith({ accountRef: "escrow:offering:offering-1" });
    expect(record.session).toHaveBeenCalledWith(session);
    expect(record.select).toHaveBeenCalledWith("direction amount");
  });

  it("reads an investor ownership balance", async () => {
    const record = query([
      { direction: "credit", amount: { toString: () => "500.00" } },
      { direction: "debit", amount: { toString: () => "120.50" } },
    ]);
    find.mockReturnValue(record);

    await expect(getOwnershipHolding({ toString: () => "investor-1" }, { toString: () => "offering-1" })).resolves.toBe(379.5);
    expect(find).toHaveBeenCalledWith({ ledgerType: "ownership", accountRef: "investor:investor-1", entityType: "offering", entityId: "offering-1" });
  });
});

describe("ledger write failures", () => {
  it("uses the supplied session and propagates non-duplicate write errors", async () => {
    const create = vi.fn().mockRejectedValue(new Error("Database unavailable"));
    const store: LedgerStore = {
      findOne: vi.fn(() => ({ session: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(null) })) })),
      create,
    };
    const session = {} as any;

    await expect(postLedger({ ledgerType: "escrow", accountRef: "escrow:offering:one", direction: "credit", amount: 20, entityType: "subscription", entityId: "subscription-1" }, session, store)).rejects.toThrow("Database unavailable");
    expect(create).toHaveBeenCalledWith([expect.objectContaining({ currency: "NGN" })], { session });
  });
});
