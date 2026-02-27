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
  keccak256,
} from "viem";
import { polygon, polygonAmoy } from "viem/chains";
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
    ],
    outputs: [],
  },
] as const;

function getChain() {
  return env.CHAIN_ID === 137 ? polygon : polygonAmoy;
}

function getRpcUrl() {
  return env.CHAIN_ID === 137 ? env.POLYGON_RPC_URL : env.POLYGON_AMOY_RPC_URL;
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
 * Sign KYC claim data with the Fractal agent key.
 * Signature = sign(keccak256(abi.encodePacked(wallet, KYC_TOPIC, claimData)))
 */
async function signKycClaim(
  walletAddress: `0x${string}`,
  claimData: `0x${string}`,
): Promise<`0x${string}`> {
  const privateKey = await keyManager.getPrivateKey("fractal_agent");

  const KYC_TOPIC = 1n;
  const msgHash = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "bytes" }],
      [walletAddress, KYC_TOPIC, claimData],
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
  const signature = await signKycClaim(params.walletAddress, claimData);

  const privateKey = await keyManager.getPrivateKey("fractal_agent");
  const account = privateKeyToAccount(privateKey);
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
    ],
    account,
    chain: getChain(),
  });

  return hash;
}

/**
 * Deploy an Identity.sol contract for a new investor wallet.
 * NOTE: In production, use a dedicated IdentityFactory to avoid deploying
 * the full bytecode repeatedly. The Identity bytecode is managed off-chain here.
 *
 * For now this function is a placeholder that returns a mock address in dev
 * and would be replaced with actual deployment logic using the compiled artifact.
 */
export async function deployIdentityContract(
  walletAddress: `0x${string}`,
): Promise<{ identityContractAddress: `0x${string}`; deployTxHash: Hash }> {
  // In production: load Identity.sol bytecode from artifacts and deploy
  // For now, return a deterministic mock address based on wallet (dev only)
  if (!env.PRIVY_ENABLED) {
    const mockIdentity = `0x${keccak256(walletAddress).slice(
      26,
    )}` as `0x${string}`;
    return {
      identityContractAddress: mockIdentity,
      deployTxHash: `0x${"0".repeat(64)}` as Hash,
    };
  }

  // Production: deploy Identity.sol bytecode
  // This would use: walletClient.deployContract({ abi: IDENTITY_ABI, bytecode: IDENTITY_BYTECODE, args: [walletAddress] })
  throw new Error(
    "Production Identity deployment requires compiled bytecode. Run: pnpm compile in packages/contracts/",
  );
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
