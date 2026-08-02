import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  batchMint: vi.fn(),
  deployToken: vi.fn(),
  find: vi.fn(),
  getDeployedToken: vi.fn(),
  offeringFindById: vi.fn(),
  offeringUpdate: vi.fn(),
  subscriptionUpdate: vi.fn(),
  update: vi.fn(),
  whitelistInvestor: vi.fn(),
  waitForTransaction: vi.fn(),
  env: { CHAIN_ID: 11155111, BLOCKCHAIN_MAX_RETRIES: 3, BLOCKCHAIN_POLL_INTERVAL_MS: 60_000 },
}));

vi.mock("../../db/models/index.js", () => ({
  BlockchainOpModel: { create: mocks.create, find: mocks.find, findByIdAndUpdate: mocks.update },
  OfferingModel: { findById: mocks.offeringFindById, findByIdAndUpdate: mocks.offeringUpdate },
  SubscriptionModel: { findById: vi.fn(), findByIdAndUpdate: mocks.subscriptionUpdate, findOneAndUpdate: vi.fn(), countDocuments: vi.fn() },
  DistributionModel: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
  InvestorProfileModel: { findById: vi.fn(), findByIdAndUpdate: vi.fn() },
}));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../services/blockchain.service.js", () => ({ deployToken: mocks.deployToken, batchMint: mocks.batchMint, batchLockTokens: vi.fn(), burnTokens: vi.fn(), freezeTokens: vi.fn(), unfreezeTokens: vi.fn(), executePayout: vi.fn(), whitelistInvestor: mocks.whitelistInvestor, setInvestorTier: vi.fn(), getDeployedToken: mocks.getDeployedToken, waitForTransaction: mocks.waitForTransaction, declareDistribution: vi.fn() }));
vi.mock("../../services/onchainid.service.js", () => ({ issueKycClaim: vi.fn() }));

import { enqueueBlockchainOp, startBlockchainWorker, stopBlockchainWorker } from "../blockchain.worker.js";

function emptyOperationQuery() {
  return { sort: vi.fn(() => ({ limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([]) })) })) };
}

function operationQuery(operations: unknown[]) {
  return { sort: vi.fn(() => ({ limit: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(operations) })) })) };
}

async function flushWorker() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
  }
  mocks.create.mockResolvedValue(undefined);
  mocks.find.mockReturnValue(emptyOperationQuery());
  mocks.whitelistInvestor.mockResolvedValue("0xabc123");
  mocks.batchMint.mockResolvedValue("0xmint");
  mocks.deployToken.mockResolvedValue("0xdeploy");
  mocks.getDeployedToken.mockResolvedValue({ tokenContract: "0xtoken" });
  mocks.offeringFindById.mockResolvedValue(null);
  mocks.offeringUpdate.mockResolvedValue(undefined);
  mocks.subscriptionUpdate.mockResolvedValue(undefined);
  mocks.waitForTransaction.mockResolvedValue({ status: "success", blockNumber: 123n });
});

afterEach(async () => {
  await stopBlockchainWorker();
  vi.useRealTimers();
});

describe("blockchain worker", () => {
  it("queues an operation with the configured chain and a safe empty payload", async () => {
    await enqueueBlockchainOp({ opType: "whitelist_investor", entityType: "investor", entityId: "investor-1" });
    expect(mocks.create).toHaveBeenCalledWith({ opType: "whitelist_investor", entityType: "investor", entityId: "investor-1", payload: {}, chainId: 11155111, status: "pending", retryCount: 0 });
  });

  it("starts one polling interval, processes an empty queue, and stops cleanly", async () => {
    vi.useFakeTimers();
    startBlockchainWorker();
    startBlockchainWorker();
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.find).toHaveBeenCalledTimes(1);
    await stopBlockchainWorker();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(mocks.find).toHaveBeenCalledTimes(1);
  });

  it("submits, confirms, and records a successful whitelist operation", async () => {
    mocks.find.mockReturnValue(operationQuery([{
      _id: "op-1",
      opType: "whitelist_investor",
      entityType: "investor",
      entityId: "investor-1",
      payload: { contractAddress: "0xcontract", walletAddress: "0xwallet" },
      retryCount: 0,
    }]));

    startBlockchainWorker();
    await flushWorker();

    expect(mocks.whitelistInvestor).toHaveBeenCalledWith("0xcontract", "0xwallet");
    expect(mocks.waitForTransaction).toHaveBeenCalledWith("0xabc123");
    expect(mocks.update).toHaveBeenCalledWith("op-1", expect.objectContaining({ status: "confirmed" }));
  });

  it("uses exponential backoff after an operation failure", async () => {
    mocks.whitelistInvestor.mockRejectedValueOnce(new Error("RPC unavailable"));
    mocks.find.mockReturnValue(operationQuery([{
      _id: "op-2",
      opType: "whitelist_investor",
      entityType: "investor",
      entityId: "investor-2",
      payload: { contractAddress: "0xcontract", walletAddress: "0xwallet" },
      retryCount: 0,
    }]));

    startBlockchainWorker();
    await flushWorker();

    expect(mocks.update).toHaveBeenCalledWith("op-2", expect.objectContaining({
      status: "pending",
      error: "RPC unavailable",
      $inc: { retryCount: 1 },
      nextRetryAt: expect.any(Date),
    }));
  });

  it("moves an operation to the dead-letter state at its retry limit", async () => {
    mocks.whitelistInvestor.mockRejectedValueOnce(new Error("invalid transaction"));
    mocks.find.mockReturnValue(operationQuery([{
      _id: "op-3",
      opType: "whitelist_investor",
      entityType: "investor",
      entityId: "investor-3",
      payload: { contractAddress: "0xcontract", walletAddress: "0xwallet" },
      retryCount: 2,
    }]));

    startBlockchainWorker();
    await flushWorker();

    expect(mocks.update).toHaveBeenCalledWith("op-3", {
      status: "dead_letter",
      $inc: { retryCount: 1 },
      error: "invalid transaction",
    });
  });

  it("records each minted subscription and queues its configured lockup", async () => {
    mocks.find.mockReturnValue(operationQuery([{
      _id: "op-mint",
      opType: "mint",
      entityType: "offering",
      entityId: "offering-1",
      payload: {
        contractAddress: "0xtoken",
        tokenId: 1,
        lockupDays: 30,
        entries: [{ subscriptionId: "subscription-1", wallet: "0xwallet", tokenAmount: 25 }],
      },
      retryCount: 0,
    }]));

    startBlockchainWorker();
    await flushWorker();

    expect(mocks.batchMint).toHaveBeenCalledWith("0xtoken", [{ subscriptionId: "subscription-1", wallet: "0xwallet", tokenAmount: 25 }], 1n);
    expect(mocks.subscriptionUpdate).toHaveBeenCalledWith("subscription-1", expect.objectContaining({
      "tokenMint.txHash": "0xmint",
      "tokenMint.tokenAmount": 25,
      "tokenMint.contractAddress": "0xtoken",
      "tokenMint.tokenId": 1,
    }));
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      opType: "lock_tokens",
      entityId: "offering-1",
      payload: expect.objectContaining({ contractAddress: "0xtoken", tokenId: 1, entries: [{ wallet: "0xwallet", tokenAmount: 25 }] }),
    }));
  });

  it("moves a deployed offering from submission to its confirmed contract address", async () => {
    mocks.offeringFindById.mockResolvedValue({ _id: { toString: () => "offering-2" }, name: "Harbour Apartments" });
    mocks.find.mockReturnValue(operationQuery([{
      _id: "op-deploy",
      opType: "deploy_token",
      entityType: "offering",
      entityId: "offering-2",
      payload: { tokenName: "Harbour Token", tokenSymbol: "HBR", maxTotalSupply: 1_000 },
      retryCount: 0,
    }]));

    startBlockchainWorker();
    await flushWorker();

    expect(mocks.deployToken).toHaveBeenCalledWith(expect.objectContaining({ offeringId: "offering-2", offeringName: "Harbour Apartments", tokenName: "Harbour Token", tokenSymbol: "HBR", maxTotalSupply: 1_000 }));
    expect(mocks.offeringUpdate).toHaveBeenCalledWith("offering-2", expect.objectContaining({ "tokenDeployment.status": "deploying", "tokenDeployment.deployTxHash": "0xdeploy" }));
    expect(mocks.offeringUpdate).toHaveBeenCalledWith("offering-2", expect.objectContaining({ "tokenDeployment.status": "deployed", "tokenDeployment.contractAddress": "0xtoken", "tokenDeployment.deployTxHash": "0xdeploy" }));
  });
});
