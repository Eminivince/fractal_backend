import { beforeEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: () => postgres }));

import { listInvestorPortfolioPositions } from "../postgres-investor-portfolio.js";

beforeEach(() => postgres.query.mockReset());

describe("investor portfolio positions", () => {
  it("returns only governed allocation and mint data without inventing valuation or cash fields", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [{ allocation_request_id: "allocation-1", public_reference: "HARBOUR-1", offering_name: "Harbour Income", currency: "USD", invested_minor: "100000", token_unit_price_minor: "100", token_amount: "1000", allocation_status: "approved", submitted_at: new Date("2026-07-29T09:00:00.000Z"), decided_at: new Date("2026-07-29T10:00:00.000Z"), chain_id: 8453, wallet_address: "0xwallet", mint_status: "confirmed", mint_transaction_hash: "0xtx", mint_confirmed_at: new Date("2026-07-29T11:00:00.000Z"), mint_failure_reason: null, token_contract_address: "0xtoken" }] });
    await expect(listInvestorPortfolioPositions("investor-1")).resolves.toEqual([{
      allocationRequestId: "allocation-1", publicReference: "HARBOUR-1", offeringName: "Harbour Income", currency: "USD", investedMinor: "100000", tokenUnitPriceMinor: "100", tokenAmount: "1000", allocationStatus: "approved", submittedAt: "2026-07-29T09:00:00.000Z", decidedAt: "2026-07-29T10:00:00.000Z", chainId: 8453, walletAddress: "0xwallet", mint: { status: "confirmed", transactionHash: "0xtx", confirmedAt: "2026-07-29T11:00:00.000Z", failureReason: null, tokenContractAddress: "0xtoken" },
    }]);
    expect(postgres.query).toHaveBeenCalledWith(expect.stringContaining("investment_allocation_requests"), ["investor-1"]);
  });

  it("returns an explicit null mint when the allocation has no minted chain operation", async () => {
    postgres.query.mockResolvedValueOnce({ rows: [{ allocation_request_id: "allocation-1", public_reference: "HARBOUR-1", offering_name: "Harbour Income", currency: "USD", invested_minor: "100000", token_unit_price_minor: "100", token_amount: "1000", allocation_status: "submitted", submitted_at: new Date("2026-07-29T09:00:00.000Z"), decided_at: null, chain_id: 8453, wallet_address: "0xwallet", mint_status: null, mint_transaction_hash: null, mint_confirmed_at: null, mint_failure_reason: null, token_contract_address: null }] });
    await expect(listInvestorPortfolioPositions("investor-1")).resolves.toEqual([expect.objectContaining({ allocationStatus: "submitted", decidedAt: null, mint: null })]);
  });
});
