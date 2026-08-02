/**
 * On-chain auto-wiring: bridges off-chain business events to the BlockchainOp queue.
 *
 * Every enqueue is GATED:
 *  - the blockchain worker must be enabled (BLOCKCHAIN_WORKER_ENABLED),
 *  - the relevant contracts/wallets must be configured/deployed.
 * When prerequisites are missing it is a clean no-op (never enqueues an op that
 * would just dead-letter). This makes payment→mint and KYC→whitelist code-complete
 * and ready the moment the on-chain stack is deployed, per the env-gated rollout.
 */
import { env } from "../config/env.js";
import { enqueueBlockchainOp } from "../workers/blockchain.worker.js";

/**
 * True only when the entire deployed contract graph and its signing authority
 * are configured. A lone factory address is insufficient: downstream KYC,
 * payout, and identity operations otherwise dead-letter after a business fact
 * has already been accepted.
 */
export function isOnchainEnabled(): boolean {
  return Boolean(
    env.BLOCKCHAIN_WORKER_ENABLED &&
      env.LEGACY_BLOCKCHAIN_AUTOMATION_ENABLED &&
      env.FRACTAL_AGENT_PRIVATE_KEY &&
      env.FRACTAL_AGENT_ADDRESS &&
      env.TOKEN_FACTORY_ADDRESS &&
      env.IDENTITY_REGISTRY_ADDRESS &&
      env.IDENTITY_FACTORY_ADDRESS &&
      env.CLAIM_ISSUER_ADDRESS &&
      env.AGENT_REGISTRY_ADDRESS &&
      env.DISTRIBUTION_AUDIT_ADDRESS &&
      env.USDT_ADDRESS,
  );
}

interface OfferingLike {
  _id: unknown;
  tokenDeployment?: { contractAddress?: string; status?: string };
}

function deployedTokenAddress(offering: OfferingLike): string | undefined {
  const td = offering.tokenDeployment;
  if (td?.contractAddress && td.status === "deployed") return td.contractAddress;
  return undefined;
}

/**
 * KYC approved → whitelist the investor's wallet on every offering token they hold,
 * so their tokens become transferable. No-op unless on-chain is enabled and the
 * investor has a linked wallet.
 */
export async function autowireKycWhitelist(args: {
  investorProfileId: string;
  walletAddress?: string | null;
  tokenContractAddresses: string[];
}): Promise<void> {
  if (!isOnchainEnabled() || !args.walletAddress || args.tokenContractAddresses.length === 0) {
    return;
  }
  for (const contractAddress of args.tokenContractAddresses) {
    await enqueueBlockchainOp({
      opType: "whitelist_investor",
      entityType: "investor_profile",
      entityId: args.investorProfileId,
      payload: { contractAddress, walletAddress: args.walletAddress },
    });
  }
}

/**
 * Allocation confirmed → mint the investor's tokens on the offering's token contract.
 * No-op unless on-chain is enabled, the offering's token is deployed, and the
 * investor has a linked wallet.
 */
export async function autowireAllocationMint(args: {
  offering: OfferingLike;
  entries: Array<{ subscriptionId: string; walletAddress?: string | null; amount: number }>;
}): Promise<void> {
  if (!isOnchainEnabled()) return;
  const contractAddress = deployedTokenAddress(args.offering);
  if (!contractAddress) return;

  const mintEntries = args.entries
    .filter((e) => e.walletAddress && e.amount > 0)
    .map((e) => ({
      to: e.walletAddress as string,
      amount: e.amount,
      subscriptionId: e.subscriptionId,
    }));
  if (mintEntries.length === 0) return;

  await enqueueBlockchainOp({
    opType: "mint",
    entityType: "offering",
    entityId: String(args.offering._id),
    payload: { contractAddress, entries: mintEntries },
  });
}
