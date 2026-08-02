import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ walletClient: vi.fn(), publicClient: vi.fn(), account: vi.fn(), privateKey: vi.fn(), registerWallet: vi.fn(), encode: vi.fn(), packed: vi.fn(), hash: vi.fn() }));
const env = vi.hoisted(() => ({ CLAIM_ISSUER_ADDRESS: undefined as string | undefined, IDENTITY_FACTORY_ADDRESS: undefined as string | undefined, CHAIN_ID: 11155111, SEPOLIA_RPC_URL: "https://example.test", POLYGON_RPC_URL: "https://example.test", POLYGON_AMOY_RPC_URL: "https://example.test", BLOCKCHAIN_CONFIRMATIONS: 1 }));
vi.mock("../../config/env.js", () => ({ env }));
vi.mock("viem", () => ({ createWalletClient: mocks.walletClient, createPublicClient: mocks.publicClient, http: vi.fn((url: string) => ({ url })), encodeAbiParameters: mocks.encode, encodePacked: mocks.packed, keccak256: mocks.hash, nonceManager: {} }));
vi.mock("viem/accounts", () => ({ privateKeyToAccount: mocks.account }));
vi.mock("../key-manager.js", () => ({ keyManager: { getPrivateKey: mocks.privateKey } }));
vi.mock("../blockchain.service.js", () => ({ registerWallet: mocks.registerWallet }));

import { deployIdentityContract, issueKycClaim, provisionInvestorOnChainIdentity } from "../onchainid.service.js";

beforeEach(() => {
  env.CLAIM_ISSUER_ADDRESS = undefined; env.IDENTITY_FACTORY_ADDRESS = undefined;
  mocks.walletClient.mockReset(); mocks.publicClient.mockReset(); mocks.account.mockReset(); mocks.privateKey.mockReset(); mocks.registerWallet.mockReset(); mocks.encode.mockReset().mockReturnValue("0xclaim"); mocks.packed.mockReset().mockReturnValue("0xpacked"); mocks.hash.mockReset().mockReturnValue("0xhash");
  mocks.privateKey.mockResolvedValue(`0x${"1".repeat(64)}`);
  mocks.account.mockReturnValue({ address: `0x${"c".repeat(40)}`, signMessage: vi.fn().mockResolvedValue("0xsigned") });
});

describe("OnchainID service", () => {
  it("fails closed when the claim issuer is not configured", async () => {
    await expect(issueKycClaim({ identityContractAddress: `0x${"a".repeat(40)}`, walletAddress: `0x${"b".repeat(40)}`, eligibility: "retail", countryCode: 566, approvedAt: 1_700_000_000 })).rejects.toThrow("CLAIM_ISSUER_ADDRESS not configured");
  });

  it("fails closed when the identity factory is not configured", async () => {
    await expect(deployIdentityContract(`0x${"a".repeat(40)}`)).rejects.toThrow("IDENTITY_FACTORY_ADDRESS not configured");
  });

  it("deploys, registers, and signs an identity claim through controlled clients", async () => {
    env.IDENTITY_FACTORY_ADDRESS = `0x${"d".repeat(40)}`;
    env.CLAIM_ISSUER_ADDRESS = `0x${"e".repeat(40)}`;
    const writeContract = vi.fn().mockResolvedValueOnce("0xdeploy").mockResolvedValueOnce("0xclaimtx");
    const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
    const readContract = vi.fn().mockResolvedValue(`0x${"f".repeat(40)}`);
    mocks.walletClient.mockReturnValue({ writeContract });
    mocks.publicClient.mockReturnValue({ waitForTransactionReceipt, readContract });
    mocks.registerWallet.mockResolvedValue(undefined);
    await expect(provisionInvestorOnChainIdentity({ walletAddress: `0x${"a".repeat(40)}`, eligibility: "institutional", countryCode: 566, approvedAt: 1_700_000_000 })).resolves.toEqual({ identityContractAddress: `0x${"f".repeat(40)}`, deployTxHash: "0xdeploy", kycClaimTxHash: "0xclaimtx" });
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: "0xdeploy", confirmations: 1 });
    expect(mocks.registerWallet).toHaveBeenCalledWith(`0x${"a".repeat(40)}`, `0x${"f".repeat(40)}`);
    expect(writeContract).toHaveBeenNthCalledWith(1, expect.objectContaining({ functionName: "deployIdentity", args: [`0x${"a".repeat(40)}`] }));
    expect(writeContract).toHaveBeenNthCalledWith(2, expect.objectContaining({ functionName: "issueKycClaim", args: expect.arrayContaining([`0x${"f".repeat(40)}`, `0x${"a".repeat(40)}`, "0xclaim", "0xsigned"]) }));
  });

  it("rejects a zero address after a confirmed factory transaction", async () => {
    env.IDENTITY_FACTORY_ADDRESS = `0x${"d".repeat(40)}`;
    mocks.walletClient.mockReturnValue({ writeContract: vi.fn().mockResolvedValue("0xdeploy") });
    mocks.publicClient.mockReturnValue({ waitForTransactionReceipt: vi.fn(), readContract: vi.fn().mockResolvedValue("0x0000000000000000000000000000000000000000") });
    await expect(deployIdentityContract(`0x${"a".repeat(40)}`)).rejects.toThrow("without an identity address");
  });
});
