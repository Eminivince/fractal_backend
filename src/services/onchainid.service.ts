/**
 * onchainid.service.ts
 * ONCHAINID identity management: deploy Identity contracts and issue KYC claims.
 *
 * Flow:
 * 1. Investor completes KYC (Sumsub GREEN)
 * 2. Privy provisions embedded wallet
 * 3. Backend deploys Identity.sol for that wallet → stores on-chain
 * 4. Backend signs KYC claim and calls ClaimIssuer.issueKycClaim()
 * 5. IdentityRegistry.registerWallet(wallet, identityContract)
 */
import {
  createPublicClient,
  createWalletClient,
  http,
  type Hash,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  nonceManager,
} from "viem";
import { polygon, polygonAmoy, sepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { env } from "../config/env.js";
import { registerWallet } from "./blockchain.service.js";
import { keyManager } from "./key-manager.js";

const CLAIM_ISSUER_ABI = [
  {
    name: "issueKycClaim",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "identityContract", type: "address" },
      { name: "wallet", type: "address" },
      { name: "claimData", type: "bytes" },
      { name: "signature", type: "bytes" },
      { name: "expiryTimestamp", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const IDENTITY_FACTORY_ABI = [
  {
    name: "deployIdentity",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "identityAddress", type: "address" }],
  },
  {
    name: "identityOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "wallet", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

// KYC claim validity window (matches operator policy; on-chain claim expiry).
const KYC_CLAIM_VALIDITY_SECONDS = 365 * 24 * 60 * 60;

function getChain() {
  if (env.CHAIN_ID === 137) return polygon;
  if (env.CHAIN_ID === 11155111) return sepolia;
  return polygonAmoy;
}

function getRpcUrl() {
  if (env.CHAIN_ID === 137) return env.POLYGON_RPC_URL;
  if (env.CHAIN_ID === 11155111) return env.SEPOLIA_RPC_URL;
  return env.POLYGON_AMOY_RPC_URL;
}

/**
 * Encode KYC claim data.
 * claimData = abi.encode(eligibility: uint8, countryCode: uint16, approvedAt: uint256)
 */
function encodeKycClaimData(
  eligibility: "retail" | "sophisticated" | "institutional",
  countryCode: number, // ISO 3166-1 numeric
  approvedAt: number, // Unix timestamp
): `0x${string}` {
  const tierMap = { retail: 0, sophisticated: 1, institutional: 2 };
  return encodeAbiParameters(
    [
      { name: "eligibility", type: "uint8" },
      { name: "countryCode", type: "uint16" },
      { name: "approvedAt", type: "uint256" },
    ],
    [tierMap[eligibility], countryCode, BigInt(approvedAt)],
  );
}

/**
 * Sign KYC claim data with the Fractal agent (claim signing) key.
 * MUST match ClaimIssuer.issueKycClaim:
 *   keccak256(abi.encodePacked(wallet, KYC_TOPIC, claimData, expiryTimestamp))
 * Note: abi.encodePacked (tight packing), NOT abi.encode.
 */
async function signKycClaim(
  walletAddress: `0x${string}`,
  claimData: `0x${string}`,
  expiryTimestamp: bigint,
): Promise<`0x${string}`> {
  const privateKey = await keyManager.getPrivateKey("fractal_agent");

  const KYC_TOPIC = 1n;
  const msgHash = keccak256(
    encodePacked(
      ["address", "uint256", "bytes", "uint256"],
      [walletAddress, KYC_TOPIC, claimData, expiryTimestamp],
    ),
  );

  const account = privateKeyToAccount(privateKey);
  return account.signMessage({ message: { raw: msgHash } });
}

/**
 * Issue a KYC claim to an investor's Identity contract.
 * Called after wallet is provisioned and Identity contract is deployed.
 */
export async function issueKycClaim(params: {
  identityContractAddress: `0x${string}`;
  walletAddress: `0x${string}`;
  eligibility: "retail" | "sophisticated" | "institutional";
  countryCode: number;
  approvedAt: number;
}): Promise<Hash> {
  if (!env.CLAIM_ISSUER_ADDRESS) {
    throw new Error("CLAIM_ISSUER_ADDRESS not configured");
  }

  const claimData = encodeKycClaimData(
    params.eligibility,
    params.countryCode,
    params.approvedAt,
  );
  const expiryTimestamp = BigInt(params.approvedAt + KYC_CLAIM_VALIDITY_SECONDS);
  const signature = await signKycClaim(params.walletAddress, claimData, expiryTimestamp);

  const privateKey = await keyManager.getPrivateKey("fractal_agent");
  // Shared nonce manager prevents nonce collisions with other operator-wallet ops.
  const account = privateKeyToAccount(privateKey, { nonceManager });
  const walletClient = createWalletClient({
    account,
    chain: getChain(),
    transport: http(getRpcUrl()),
  });

  const hash = await walletClient.writeContract({
    address: env.CLAIM_ISSUER_ADDRESS as `0x${string}`,
    abi: CLAIM_ISSUER_ABI,
    functionName: "issueKycClaim",
    args: [
      params.identityContractAddress,
      params.walletAddress,
      claimData,
      signature,
      expiryTimestamp,
    ],
    account,
    chain: getChain(),
  });

  return hash;
}

/**
 * Deploy an Identity.sol contract for a new investor wallet.
 *
 * IdentityFactory deploys an identity, authorizes the ClaimIssuer, and transfers
 * ownership to the investor wallet atomically. There is no mock fallback.
 */
export async function deployIdentityContract(
  walletAddress: `0x${string}`,
): Promise<{ identityContractAddress: `0x${string}`; deployTxHash: Hash }> {
  if (!env.IDENTITY_FACTORY_ADDRESS) {
    throw new Error("IDENTITY_FACTORY_ADDRESS not configured");
  }

  const privateKey = await keyManager.getPrivateKey("fractal_agent");
  const account = privateKeyToAccount(privateKey, { nonceManager });
  const chain = getChain();
  const publicClient = createPublicClient({
    chain,
    transport: http(getRpcUrl()),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(getRpcUrl()),
  });

  const deployTxHash = await walletClient.writeContract({
    address: env.IDENTITY_FACTORY_ADDRESS as `0x${string}`,
    abi: IDENTITY_FACTORY_ABI,
    functionName: "deployIdentity",
    args: [walletAddress],
    account,
    chain,
  });

  await publicClient.waitForTransactionReceipt({
    hash: deployTxHash,
    confirmations: env.BLOCKCHAIN_CONFIRMATIONS,
  });

  const identityContractAddress = await publicClient.readContract({
    address: env.IDENTITY_FACTORY_ADDRESS as `0x${string}`,
    abi: IDENTITY_FACTORY_ABI,
    functionName: "identityOf",
    args: [walletAddress],
  });
  if (identityContractAddress === "0x0000000000000000000000000000000000000000") {
    throw new Error("IdentityFactory deployment confirmed without an identity address");
  }

  return { identityContractAddress, deployTxHash };
}

/**
 * Full wallet + identity provisioning flow.
 * Called on KYC approval.
 */
export async function provisionInvestorOnChainIdentity(params: {
  walletAddress: `0x${string}`;
  eligibility: "retail" | "sophisticated" | "institutional";
  countryCode: number;
  approvedAt: number;
}): Promise<{
  identityContractAddress: `0x${string}`;
  deployTxHash: Hash;
  kycClaimTxHash: Hash;
}> {
  // 1. Deploy Identity contract
  const { identityContractAddress, deployTxHash } =
    await deployIdentityContract(params.walletAddress);

  // 2. Register wallet → identity in IdentityRegistry
  await registerWallet(params.walletAddress, identityContractAddress);

  // 3. Issue KYC claim
  const kycClaimTxHash = await issueKycClaim({
    identityContractAddress,
    walletAddress: params.walletAddress,
    eligibility: params.eligibility,
    countryCode: params.countryCode,
    approvedAt: params.approvedAt,
  });

  return { identityContractAddress, deployTxHash, kycClaimTxHash };
}
