/**
 * blockchain.service.ts
 * Viem-based service for all on-chain interactions with Fractal smart contracts.
 * The Fractal server wallet (FRACTAL_AGENT_PRIVATE_KEY) signs all transactions.
 *
 * ERC-7518 migration: Token is now ERC-1155 based with built-in compliance,
 * locking, freezing, and payouts. No separate compliance modules.
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
  type Hash,
  type Abi,
} from "viem";
import { polygon, polygonAmoy } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { keyManager } from "./key-manager.js";

// ── Minimal ABIs (only the functions we call) ─────────────────────────────────

const TOKEN_FACTORY_ABI = [
  {
    name: "deployToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "offeringId",          type: "string"  },
      { name: "offeringName",        type: "string"  },
      { name: "tokenName",           type: "string"  },
      { name: "tokenSymbol",         type: "string"  },
      { name: "maxBalancePerHolder", type: "uint256" },
      { name: "retailCap",           type: "uint256" },
    ],
    outputs: [
      { name: "tokenAddr", type: "address" },
    ],
  },
  {
    name: "getDeployedToken",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "offeringId", type: "string" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "tokenContract", type: "address" },
          { name: "offeringId",    type: "string"  },
          { name: "deployedAt",    type: "uint256" },
        ],
      },
    ],
  },
] as const satisfies Abi;

const ERC7518_TOKEN_ABI = [
  // ERC-1155 view
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id",      type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "balanceOfBatch",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "accounts", type: "address[]" },
      { name: "ids",      type: "uint256[]" },
    ],
    outputs: [{ name: "", type: "uint256[]" }],
  },
  // ERC-7518 view
  {
    name: "transferableBalance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id",      type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "lockedBalanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "id",      type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    name: "canTransfer",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "from",   type: "address" },
      { name: "to",     type: "address" },
      { name: "id",     type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data",   type: "bytes"   },
    ],
    outputs: [
      { name: "allowed", type: "bool"   },
      { name: "reason",  type: "string" },
    ],
  },
  // ERC-7518 write
  {
    name: "lockTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account",     type: "address" },
      { name: "id",          type: "uint256" },
      { name: "amount",      type: "uint256" },
      { name: "releaseTime", type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "unlockToken",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "id",      type: "uint256" },
    ],
    outputs: [],
  },
  {
    name: "freezeAddress",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "data",    type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "unFreeze",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "data",    type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "forceTransfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from",   type: "address" },
      { name: "to",     type: "address" },
      { name: "id",     type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data",   type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "restrictTransfer",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    name: "removeRestriction",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "id", type: "uint256" }],
    outputs: [],
  },
  {
    name: "batchPayout",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to",      type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [],
  },
  // Platform extensions
  {
    name: "batchMint",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "recipients",      type: "address[]" },
      { name: "amounts",         type: "uint256[]" },
      { name: "subscriptionIds", type: "string[]"  },
      { name: "id",              type: "uint256"   },
    ],
    outputs: [],
  },
  {
    name: "batchLockTokens",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "accounts",     type: "address[]" },
      { name: "ids",          type: "uint256[]" },
      { name: "amounts",      type: "uint256[]" },
      { name: "releaseTimes", type: "uint256[]" },
    ],
    outputs: [],
  },
  {
    name: "burn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from",   type: "address" },
      { name: "id",     type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "reason", type: "string"  },
    ],
    outputs: [],
  },
  {
    name: "whitelist",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "account", type: "address" }],
    outputs: [],
  },
  {
    name: "batchWhitelist",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "accounts", type: "address[]" }],
    outputs: [],
  },
  {
    name: "setInvestorTier",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "tier",    type: "uint8"   },
    ],
    outputs: [],
  },
  {
    name: "recoveryAddress",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "lostWallet", type: "address" },
      { name: "newWallet",  type: "address" },
      { name: "id",         type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const YIELD_DISTRIBUTOR_ABI = [
  {
    name: "declareDistribution",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "distributionId",   type: "string"  },
      { name: "offeringId",       type: "string"  },
      { name: "period",           type: "string"  },
      { name: "totalAmountNgn",   type: "uint256" },
      { name: "totalAmountUsdt",  type: "uint256" },
      { name: "tokenHolderCount", type: "uint256" },
    ],
    outputs: [],
  },
] as const satisfies Abi;

const IDENTITY_REGISTRY_ABI = [
  {
    name: "registerWallet",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "wallet",   type: "address" },
      { name: "identity", type: "address" },
    ],
    outputs: [],
  },
  {
    name: "isVerified",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "bool" }],
  },
] as const satisfies Abi;

// ── Client initialization ──────────────────────────────────────────────────────

function getChain() {
  return env.CHAIN_ID === 137 ? polygon : polygonAmoy;
}

function getRpcUrl() {
  return env.CHAIN_ID === 137 ? env.POLYGON_RPC_URL : env.POLYGON_AMOY_RPC_URL;
}

let _publicClient: PublicClient | null = null;
let _walletClient: WalletClient | null = null;

export function getPublicClient(): PublicClient {
  if (!_publicClient) {
    _publicClient = createPublicClient({
      chain: getChain(),
      transport: http(getRpcUrl()),
    });
  }
  return _publicClient;
}

export async function getWalletClient(): Promise<WalletClient> {
  if (!_walletClient) {
    const privateKey = await keyManager.getPrivateKey("fractal_agent");
    const account = privateKeyToAccount(privateKey);
    _walletClient = createWalletClient({
      account,
      chain: getChain(),
      transport: http(getRpcUrl()),
    });
  }
  return _walletClient;
}

// ── Contract calls ─────────────────────────────────────────────────────────────

export interface DeployTokenParams {
  offeringId: string;
  offeringName: string;
  tokenName: string;
  tokenSymbol: string;
  maxBalancePerHolder?: number;
  retailCap?: number;
}

export async function deployToken(params: DeployTokenParams): Promise<Hash> {
  if (!env.TOKEN_FACTORY_ADDRESS) {
    throw new Error("TOKEN_FACTORY_ADDRESS not configured");
  }
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  const hash = await walletClient.writeContract({
    address: env.TOKEN_FACTORY_ADDRESS as `0x${string}`,
    abi: TOKEN_FACTORY_ABI,
    functionName: "deployToken",
    args: [
      params.offeringId,
      params.offeringName,
      params.tokenName,
      params.tokenSymbol,
      BigInt(params.maxBalancePerHolder ?? 0),
      BigInt(params.retailCap ?? 0),
    ],
    account,
    chain: getChain(),
  });
  return hash;
}

export interface BatchMintEntry {
  wallet: `0x${string}`;
  tokenAmount: number;
  subscriptionId: string;
}

export async function batchMint(
  contractAddress: `0x${string}`,
  entries: BatchMintEntry[],
  tokenId: bigint = 1n,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  const hash = await walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "batchMint",
    args: [
      entries.map((e) => e.wallet),
      entries.map((e) => BigInt(e.tokenAmount)),
      entries.map((e) => e.subscriptionId),
      tokenId,
    ],
    account,
    chain: getChain(),
  });
  return hash;
}

export interface BatchLockEntry {
  wallet: `0x${string}`;
  tokenAmount: number;
}

export async function batchLockTokens(
  contractAddress: `0x${string}`,
  tokenId: bigint,
  entries: BatchLockEntry[],
  releaseTime: bigint,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "batchLockTokens",
    args: [
      entries.map((e) => e.wallet),
      entries.map(() => tokenId),
      entries.map((e) => BigInt(e.tokenAmount)),
      entries.map(() => releaseTime),
    ],
    account,
    chain: getChain(),
  });
}

export async function burnTokens(
  contractAddress: `0x${string}`,
  from: `0x${string}`,
  tokenId: bigint,
  amount: number,
  reason: string,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "burn",
    args: [from, tokenId, BigInt(amount), reason],
    account,
    chain: getChain(),
  });
}

export async function freezeTokens(
  contractAddress: `0x${string}`,
  investor: `0x${string}`,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "freezeAddress",
    args: [investor, "0x"],
    account,
    chain: getChain(),
  });
}

export async function unfreezeTokens(
  contractAddress: `0x${string}`,
  investor: `0x${string}`,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "unFreeze",
    args: [investor, "0x"],
    account,
    chain: getChain(),
  });
}

export async function forcedTransfer(
  contractAddress: `0x${string}`,
  from: `0x${string}`,
  to: `0x${string}`,
  tokenId: bigint,
  amount: number,
  data: `0x${string}` = "0x",
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "forceTransfer",
    args: [from, to, tokenId, BigInt(amount), data],
    account,
    chain: getChain(),
  });
}

export async function executePayout(
  contractAddress: `0x${string}`,
  recipients: `0x${string}`[],
  netAmounts: bigint[],
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "batchPayout",
    args: [recipients, netAmounts],
    account,
    chain: getChain(),
  });
}

export async function whitelistInvestor(
  contractAddress: `0x${string}`,
  wallet: `0x${string}`,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "whitelist",
    args: [wallet],
    account,
    chain: getChain(),
  });
}

export async function batchWhitelistInvestors(
  contractAddress: `0x${string}`,
  wallets: `0x${string}`[],
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "batchWhitelist",
    args: [wallets],
    account,
    chain: getChain(),
  });
}

export async function setInvestorTier(
  contractAddress: `0x${string}`,
  wallet: `0x${string}`,
  tier: number,
): Promise<Hash> {
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "setInvestorTier",
    args: [wallet, tier],
    account,
    chain: getChain(),
  });
}

export async function declareDistribution(params: {
  distributionId: string;
  offeringId: string;
  period: string;
  totalAmountNgn: bigint;
  totalAmountUsdt: bigint;
  tokenHolderCount: number;
}): Promise<Hash> {
  if (!env.DISTRIBUTION_AUDIT_ADDRESS) {
    throw new Error("DISTRIBUTION_AUDIT_ADDRESS not configured");
  }
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: env.DISTRIBUTION_AUDIT_ADDRESS as `0x${string}`,
    abi: YIELD_DISTRIBUTOR_ABI,
    functionName: "declareDistribution",
    args: [
      params.distributionId,
      params.offeringId,
      params.period,
      params.totalAmountNgn,
      params.totalAmountUsdt,
      BigInt(params.tokenHolderCount),
    ],
    account,
    chain: getChain(),
  });
}

export async function registerWallet(
  walletAddress: `0x${string}`,
  identityContractAddress: `0x${string}`,
): Promise<Hash> {
  if (!env.IDENTITY_REGISTRY_ADDRESS) {
    throw new Error("IDENTITY_REGISTRY_ADDRESS not configured");
  }
  const walletClient = await getWalletClient();
  const account = walletClient.account;
  if (!account) throw new Error("No account on wallet client");

  return walletClient.writeContract({
    address: env.IDENTITY_REGISTRY_ADDRESS as `0x${string}`,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "registerWallet",
    args: [walletAddress, identityContractAddress],
    account,
    chain: getChain(),
  });
}

export async function isWalletVerified(walletAddress: `0x${string}`): Promise<boolean> {
  if (!env.IDENTITY_REGISTRY_ADDRESS) return false;
  const publicClient = getPublicClient();
  return publicClient.readContract({
    address: env.IDENTITY_REGISTRY_ADDRESS as `0x${string}`,
    abi: IDENTITY_REGISTRY_ABI,
    functionName: "isVerified",
    args: [walletAddress],
  }) as Promise<boolean>;
}

export async function waitForTransaction(hash: Hash): Promise<{
  blockNumber: bigint;
  status: "success" | "reverted";
}> {
  const publicClient = getPublicClient();
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    confirmations: env.BLOCKCHAIN_CONFIRMATIONS,
  });
  return { blockNumber: receipt.blockNumber, status: receipt.status };
}

/**
 * Get ERC-1155 token balance for a wallet on a deployed security token contract.
 */
export async function getTokenBalance(
  contractAddress: `0x${string}`,
  wallet: `0x${string}`,
  tokenId: bigint = 1n,
): Promise<bigint> {
  const publicClient = getPublicClient();
  return publicClient.readContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "balanceOf",
    args: [wallet, tokenId],
  }) as Promise<bigint>;
}

/**
 * Get transferable (unlocked, unfrozen) balance.
 */
export async function getTransferableBalance(
  contractAddress: `0x${string}`,
  wallet: `0x${string}`,
  tokenId: bigint = 1n,
): Promise<bigint> {
  const publicClient = getPublicClient();
  return publicClient.readContract({
    address: contractAddress,
    abi: ERC7518_TOKEN_ABI,
    functionName: "transferableBalance",
    args: [wallet, tokenId],
  }) as Promise<bigint>;
}
