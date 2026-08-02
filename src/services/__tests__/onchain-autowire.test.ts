import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueBlockchainOp: vi.fn(),
  env: {
    BLOCKCHAIN_WORKER_ENABLED: false,
    LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED: false,
    FRACTAL_AGENT_PRIVATE_KEY: undefined as string | undefined,
    FRACTAL_AGENT_ADDRESS: undefined as string | undefined,
    TOKEN_FACTORY_ADDRESS: undefined as string | undefined,
    IDENTITY_REGISTRY_ADDRESS: undefined as string | undefined,
    IDENTITY_FACTORY_ADDRESS: undefined as string | undefined,
    CLAIM_ISSUER_ADDRESS: undefined as string | undefined,
    AGENT_REGISTRY_ADDRESS: undefined as string | undefined,
    DISTRIBUTION_AUDIT_ADDRESS: undefined as string | undefined,
    USDT_ADDRESS: undefined as string | undefined,
  },
}));

vi.mock("../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../workers/blockchain.worker.js", () => ({
  enqueueBlockchainOp: mocks.enqueueBlockchainOp,
}));

import {
  autowireAllocationMint,
  autowireKycWhitelist,
  isOnchainEnabled,
} from "../onchain-autowire.js";

function enableOnchain() {
  Object.assign(mocks.env, {
    BLOCKCHAIN_WORKER_ENABLED: true,
    LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED: true,
    FRACTAL_AGENT_PRIVATE_KEY: "0xprivate",
    FRACTAL_AGENT_ADDRESS: "0xagent",
    TOKEN_FACTORY_ADDRESS: "0xfactory",
    IDENTITY_REGISTRY_ADDRESS: "0xregistry",
    IDENTITY_FACTORY_ADDRESS: "0xidentityFactory",
    CLAIM_ISSUER_ADDRESS: "0xissuer",
    AGENT_REGISTRY_ADDRESS: "0xagentRegistry",
    DISTRIBUTION_AUDIT_ADDRESS: "0xaudit",
    USDT_ADDRESS: "0xusdt",
  });
}

beforeEach(() => {
  mocks.enqueueBlockchainOp.mockReset().mockResolvedValue(undefined);
  Object.assign(mocks.env, {
    BLOCKCHAIN_WORKER_ENABLED: false,
    LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED: false,
    FRACTAL_AGENT_PRIVATE_KEY: undefined,
    FRACTAL_AGENT_ADDRESS: undefined,
    TOKEN_FACTORY_ADDRESS: undefined,
    IDENTITY_REGISTRY_ADDRESS: undefined,
    IDENTITY_FACTORY_ADDRESS: undefined,
    CLAIM_ISSUER_ADDRESS: undefined,
    AGENT_REGISTRY_ADDRESS: undefined,
    DISTRIBUTION_AUDIT_ADDRESS: undefined,
    USDT_ADDRESS: undefined,
  });
});

describe("on-chain event wiring", () => {
  it("requires the worker, automation flag, signing authority, and every deployed contract", () => {
    expect(isOnchainEnabled()).toBe(false);

    enableOnchain();
    expect(isOnchainEnabled()).toBe(true);

    mocks.env.USDT_ADDRESS = undefined;
    expect(isOnchainEnabled()).toBe(false);
  });

  it("does not whitelist without a configured on-chain graph, wallet, or token", async () => {
    await autowireKycWhitelist({
      investorProfileId: "investor-1",
      walletAddress: "0xwallet",
      tokenContractAddresses: ["0xtoken"],
    });
    enableOnchain();
    await autowireKycWhitelist({
      investorProfileId: "investor-1",
      tokenContractAddresses: ["0xtoken"],
    });
    await autowireKycWhitelist({
      investorProfileId: "investor-1",
      walletAddress: "0xwallet",
      tokenContractAddresses: [],
    });

    expect(mocks.enqueueBlockchainOp).not.toHaveBeenCalled();
  });

  it("enqueues one whitelist operation for each token contract", async () => {
    enableOnchain();

    await autowireKycWhitelist({
      investorProfileId: "investor-1",
      walletAddress: "0xwallet",
      tokenContractAddresses: ["0xtoken-a", "0xtoken-b"],
    });

    expect(mocks.enqueueBlockchainOp).toHaveBeenCalledTimes(2);
    expect(mocks.enqueueBlockchainOp).toHaveBeenNthCalledWith(1, {
      opType: "whitelist_investor",
      entityType: "investor_profile",
      entityId: "investor-1",
      payload: { contractAddress: "0xtoken-a", walletAddress: "0xwallet" },
    });
    expect(mocks.enqueueBlockchainOp).toHaveBeenNthCalledWith(2, {
      opType: "whitelist_investor",
      entityType: "investor_profile",
      entityId: "investor-1",
      payload: { contractAddress: "0xtoken-b", walletAddress: "0xwallet" },
    });
  });

  it("only queues mint operations for a deployed token and positive wallet-backed allocations", async () => {
    enableOnchain();
    const entries = [
      { subscriptionId: "subscription-1", walletAddress: "0xwallet", amount: 3 },
      { subscriptionId: "subscription-2", walletAddress: "", amount: 5 },
      { subscriptionId: "subscription-3", walletAddress: "0xwallet", amount: 0 },
    ];

    await autowireAllocationMint({ offering: { _id: "offering-1" }, entries });
    await autowireAllocationMint({
      offering: { _id: "offering-1", tokenDeployment: { contractAddress: "0xtoken", status: "pending" } },
      entries,
    });
    await autowireAllocationMint({
      offering: { _id: "offering-1", tokenDeployment: { contractAddress: "0xtoken", status: "deployed" } },
      entries,
    });

    expect(mocks.enqueueBlockchainOp).toHaveBeenCalledOnce();
    expect(mocks.enqueueBlockchainOp).toHaveBeenCalledWith({
      opType: "mint",
      entityType: "offering",
      entityId: "offering-1",
      payload: {
        contractAddress: "0xtoken",
        entries: [{ subscriptionId: "subscription-1", to: "0xwallet", amount: 3 }],
      },
    });
  });

  it("does not queue a mint when the enabled offering has no eligible allocation", async () => {
    await autowireAllocationMint({
      offering: { _id: "offering-disabled", tokenDeployment: { contractAddress: "0xtoken", status: "deployed" } },
      entries: [{ subscriptionId: "subscription-0", walletAddress: "0xwallet", amount: 4 }],
    });
    enableOnchain();

    await autowireAllocationMint({
      offering: { _id: 42, tokenDeployment: { contractAddress: "0xtoken", status: "deployed" } },
      entries: [{ subscriptionId: "subscription-1", walletAddress: null, amount: 4 }],
    });

    expect(mocks.enqueueBlockchainOp).not.toHaveBeenCalled();
  });
});
