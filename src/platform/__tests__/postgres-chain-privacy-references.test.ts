import { describe, expect, it, vi } from "vitest";

import { queryChainPrivacyRecordsForIdentity } from "../postgres-chain-privacy-references.js";

describe("chain privacy references", () => {
  it("returns only exact identity-linked chain records in a stable normalized order", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ chain_id: 8453, wallet_address: " 0xAbC " }] })
      .mockResolvedValueOnce({ rows: [
        { chain_id: 8453, wallet_address: "0xABC", transaction_hash: " 0xTx ", token_contract_address: " 0xToken ", operation_type: "mint" },
        { chain_id: 8453, wallet_address: "0xabc", transaction_hash: "0xtx", token_contract_address: "0xtoken", operation_type: "mint" },
      ] })
      .mockResolvedValueOnce({ rows: [{ chain_id: 8453, wallet_address: "0xABC", token_contract_address: "0xToken", block_number: "123", block_hash: " 0xBlock ", balance_units: "50" }] });
    await expect(queryChainPrivacyRecordsForIdentity({ query }, "identity-1")).resolves.toEqual([
      { recordType: "ownership_snapshot", chainId: 8453, walletAddress: "0xabc", tokenContractAddress: "0xtoken", blockNumber: "123", blockHash: "0xblock", balanceUnits: "50" },
      { recordType: "allocation_transaction", chainId: 8453, walletAddress: "0xabc", transactionHash: "0xtx", tokenContractAddress: "0xtoken", operationType: "mint" },
      { recordType: "wallet", chainId: 8453, walletAddress: "0xabc" },
    ]);
    expect(query).toHaveBeenCalledTimes(3);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("investor_wallets"), ["identity-1"]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("investment_allocation_chain_operations"), ["identity-1"]);
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining("ownership_snapshot_holdings"), ["identity-1"]);
  });

  it("returns no records when the identity has no exact wallet or allocation linkage", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await expect(queryChainPrivacyRecordsForIdentity({ query }, "identity-1")).resolves.toEqual([]);
  });
});
