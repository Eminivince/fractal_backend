/**
 * blockchain.worker.ts
 * Polls the BlockchainOp queue and executes pending on-chain operations.
 * Retries failed operations up to BLOCKCHAIN_MAX_RETRIES.
 *
 * ERC-7518 migration: Token operations now use ERC-1155 with built-in compliance.
 * New ops: lock_tokens, batch_payout, whitelist_investor, set_investor_tier.
 */
import { BlockchainOpModel } from "../db/models/index.js";
import { OfferingModel, SubscriptionModel, DistributionModel, InvestorProfileModel } from "../db/models/index.js";
import { env } from "../config/env.js";
import {
  deployToken,
  batchMint,
  batchLockTokens,
  burnTokens,
  freezeTokens,
  unfreezeTokens,
  executePayout,
  whitelistInvestor,
  setInvestorTier,
  waitForTransaction,
  type BatchMintEntry,
  type BatchLockEntry,
} from "../services/blockchain.service.js";
import { issueKycClaim } from "../services/onchainid.service.js";
import { declareDistribution } from "../services/blockchain.service.js";

let workerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Enqueue a new blockchain operation.
 */
export async function enqueueBlockchainOp(params: {
  opType: string;
  entityType: string;
  entityId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await BlockchainOpModel.create({
    opType: params.opType,
    entityType: params.entityType,
    entityId: params.entityId,
    payload: params.payload ?? {},
    chainId: env.CHAIN_ID,
    status: "pending",
    retryCount: 0,
  });
}

/**
 * Execute a single blockchain operation.
 */
async function executeOp(op: { _id: unknown; opType: string; entityType: string; entityId: string; payload: Record<string, unknown>; retryCount: number }): Promise<void> {
  let txHash: `0x${string}` | undefined;

  switch (op.opType) {
    case "deploy_token": {
      const offering = await OfferingModel.findById(op.entityId);
      if (!offering) throw new Error(`Offering ${op.entityId} not found`);
      txHash = await deployToken({
        offeringId: offering._id.toString(),
        offeringName: offering.name,
        tokenName: (op.payload.tokenName as string) ?? `Fractal ${offering.name}`,
        tokenSymbol: (op.payload.tokenSymbol as string) ?? `FRAC-${offering._id.toString().slice(-4).toUpperCase()}`,
        maxBalancePerHolder: op.payload.maxBalancePerHolder as number | undefined,
        retailCap: op.payload.retailCap as number | undefined,
      });

      await OfferingModel.findByIdAndUpdate(op.entityId, {
        "tokenDeployment.status": "deploying",
        "tokenDeployment.deployTxHash": txHash,
      });
      break;
    }

    case "mint": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const entries = op.payload.entries as BatchMintEntry[];
      const tokenId = BigInt((op.payload.tokenId as number) ?? 1);
      txHash = await batchMint(contractAddress, entries, tokenId);
      break;
    }

    case "lock_tokens": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const tokenId = BigInt((op.payload.tokenId as number) ?? 1);
      const entries = op.payload.entries as BatchLockEntry[];
      const releaseTime = BigInt(op.payload.releaseTime as number);
      txHash = await batchLockTokens(contractAddress, tokenId, entries, releaseTime);
      break;
    }

    case "burn": {
      const sub = await SubscriptionModel.findById(op.entityId);
      if (!sub) throw new Error(`Subscription ${op.entityId} not found`);
      const offering = await OfferingModel.findById(sub.offeringId);
      const contractAddress = offering?.tokenDeployment?.contractAddress as `0x${string}` | undefined;
      if (!contractAddress) throw new Error("No contract address for burn");
      const tokenId = BigInt((op.payload.tokenId as number) ?? 1);
      txHash = await burnTokens(
        contractAddress,
        (sub.walletAddress ?? op.payload.walletAddress) as `0x${string}`,
        tokenId,
        op.payload.tokenAmount as number,
        (op.payload.reason as string) ?? "refund",
      );
      break;
    }

    case "freeze": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const wallet = op.payload.walletAddress as `0x${string}`;
      txHash = await freezeTokens(contractAddress, wallet);
      break;
    }

    case "unfreeze": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const wallet = op.payload.walletAddress as `0x${string}`;
      txHash = await unfreezeTokens(contractAddress, wallet);
      break;
    }

    case "batch_payout": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const recipients = op.payload.recipients as `0x${string}`[];
      const netAmounts = (op.payload.netAmounts as string[]).map(BigInt);
      txHash = await executePayout(contractAddress, recipients, netAmounts);
      break;
    }

    case "whitelist_investor": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const wallet = op.payload.walletAddress as `0x${string}`;
      txHash = await whitelistInvestor(contractAddress, wallet);
      break;
    }

    case "set_investor_tier": {
      const contractAddress = op.payload.contractAddress as `0x${string}`;
      const wallet = op.payload.walletAddress as `0x${string}`;
      const tier = op.payload.tier as number;
      txHash = await setInvestorTier(contractAddress, wallet, tier);
      break;
    }

    case "declare_distribution": {
      const dist = await DistributionModel.findById(op.entityId);
      if (!dist) throw new Error(`Distribution ${op.entityId} not found`);
      const tokenHolderCount = await SubscriptionModel.countDocuments({
        offeringId: dist.offeringId,
        status: "allocation_confirmed",
        walletAddress: { $exists: true, $ne: null },
      });
      txHash = await declareDistribution({
        distributionId: dist._id.toString(),
        offeringId: (dist.offeringId as unknown as { toString: () => string }).toString(),
        period: (dist as { period?: string }).period ?? "N/A",
        totalAmountNgn: BigInt(Math.round(parseFloat(dist.amount.toString()) * 100)),
        totalAmountUsdt: 0n,
        tokenHolderCount,
      });
      break;
    }

    case "issue_kyc_claim": {
      const profile = await InvestorProfileModel.findById(op.entityId);
      if (!profile) throw new Error(`InvestorProfile ${op.entityId} not found`);
      const identityContractAddress = op.payload.identityContractAddress as `0x${string}`;
      const walletAddress = op.payload.walletAddress as `0x${string}`;
      txHash = await issueKycClaim({
        identityContractAddress,
        walletAddress,
        eligibility: (profile.eligibility as "retail" | "sophisticated" | "institutional") ?? "retail",
        countryCode: (op.payload.countryCode as number) ?? 566, // 566 = Nigeria
        approvedAt: Math.floor(Date.now() / 1000),
      });
      break;
    }

    default:
      throw new Error(`Unknown op type: ${op.opType}`);
  }

  if (!txHash) throw new Error("No tx hash returned from operation");

  // Mark as submitted
  await BlockchainOpModel.findByIdAndUpdate(op._id, {
    status: "submitted",
    txHash,
    submittedAt: new Date(),
  });

  // Wait for confirmation
  const receipt = await waitForTransaction(txHash);
  if (receipt.status === "reverted") {
    throw new Error(`Transaction reverted: ${txHash}`);
  }

  // Mark as confirmed
  await BlockchainOpModel.findByIdAndUpdate(op._id, {
    status: "confirmed",
    confirmedAt: new Date(),
  });

  // Post-confirmation hooks
  await handlePostConfirmation(op, txHash, receipt.blockNumber);
}

/**
 * Update application state after a transaction is confirmed.
 */
async function handlePostConfirmation(
  op: { opType: string; entityId: string; payload: Record<string, unknown> },
  txHash: `0x${string}`,
  blockNumber: bigint,
): Promise<void> {
  const now = new Date();

  switch (op.opType) {
    case "deploy_token": {
      await OfferingModel.findByIdAndUpdate(op.entityId, {
        "tokenDeployment.status": "deployed",
        "tokenDeployment.deployedAt": now,
        "tokenDeployment.deployTxHash": txHash,
      });
      break;
    }

    case "mint": {
      const entries = op.payload.entries as Array<{ subscriptionId: string; tokenAmount: number; wallet: string }>;
      const tokenId = (op.payload.tokenId as number) ?? 1;
      for (const entry of entries) {
        await SubscriptionModel.findByIdAndUpdate(entry.subscriptionId, {
          "tokenMint.txHash": txHash,
          "tokenMint.mintedAt": now,
          "tokenMint.tokenAmount": entry.tokenAmount,
          "tokenMint.contractAddress": op.payload.contractAddress,
          "tokenMint.blockNumber": Number(blockNumber),
          "tokenMint.tokenId": tokenId,
        });
      }

      // If offering has lockupDays > 0, enqueue lock_tokens
      const lockupDays = op.payload.lockupDays as number | undefined;
      if (lockupDays && lockupDays > 0) {
        const releaseTime = Math.floor(Date.now() / 1000) + lockupDays * 86400;
        const lockEntries = entries.map((e) => ({
          wallet: e.wallet as `0x${string}`,
          tokenAmount: e.tokenAmount,
        }));
        await enqueueBlockchainOp({
          opType: "lock_tokens",
          entityType: "offering",
          entityId: op.entityId,
          payload: {
            contractAddress: op.payload.contractAddress,
            tokenId,
            entries: lockEntries,
            releaseTime,
          },
        });
      }
      break;
    }

    case "lock_tokens": {
      // Update subscriptions with lock release time
      const entries = op.payload.entries as Array<{ wallet: string; tokenAmount: number }>;
      const releaseTime = op.payload.releaseTime as number;
      const releaseDate = new Date(releaseTime * 1000).toISOString();
      for (const entry of entries) {
        await SubscriptionModel.findOneAndUpdate(
          { walletAddress: entry.wallet, offeringId: op.entityId },
          { "tokenMint.lockReleaseTime": releaseDate },
        );
      }
      break;
    }

    case "burn": {
      await SubscriptionModel.findByIdAndUpdate(op.entityId, {
        "tokenBurn.txHash": txHash,
        "tokenBurn.burnedAt": now,
        "tokenBurn.reason": op.payload.reason ?? "refund",
        "tokenBurn.tokenId": (op.payload.tokenId as number) ?? 1,
      });
      break;
    }

    case "freeze": {
      await SubscriptionModel.findOneAndUpdate(
        { offeringId: op.payload.offeringId, walletAddress: op.payload.walletAddress },
        { onchainFrozen: true },
      );
      break;
    }

    case "unfreeze": {
      await SubscriptionModel.findOneAndUpdate(
        { offeringId: op.payload.offeringId, walletAddress: op.payload.walletAddress },
        { onchainFrozen: false },
      );
      break;
    }

    case "batch_payout": {
      if (op.payload.distributionEntityId) {
        await DistributionModel.findByIdAndUpdate(
          op.payload.distributionEntityId,
          {
            "onchainExecution.txHash": txHash,
            "onchainExecution.executedAt": now.toISOString(),
          },
        );
      }
      break;
    }

    case "declare_distribution": {
      await DistributionModel.findByIdAndUpdate(op.entityId, {
        "onchainDeclaration.txHash": txHash,
        "onchainDeclaration.declaredAt": now.toISOString(),
        "onchainDeclaration.blockNumber": Number(blockNumber),
      });
      break;
    }

    case "issue_kyc_claim": {
      await InvestorProfileModel.findByIdAndUpdate(op.entityId, {
        "onchainIdentity.claimIssued": true,
        "onchainIdentity.kycClaimTxHash": txHash,
      });
      break;
    }

    case "whitelist_investor":
    case "set_investor_tier":
      // No app-state update needed beyond the confirmed op record
      break;
  }
}

// 5.6: Track in-flight operations for graceful shutdown
const inFlightOps = new Set<string>();

/**
 * Process one batch of pending operations.
 * 5.6: Added dead letter, exponential backoff, idempotency checks.
 */
async function processPendingOps(): Promise<void> {
  const now = new Date();
  const pending = await BlockchainOpModel.find({
    status: "pending",
    retryCount: { $lt: env.BLOCKCHAIN_MAX_RETRIES },
    // 5.6: Exponential backoff — only process ops whose nextRetryAt has passed
    $or: [
      { nextRetryAt: { $exists: false } },
      { nextRetryAt: { $lte: now } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(10)
    .lean();

  for (const op of pending) {
    const opId = String(op._id);
    inFlightOps.add(opId);
    try {
      // 5.6: Idempotency — if txHash already set and confirmed, skip re-execution
      if ((op as any).txHash) {
        try {
          const receipt = await waitForTransaction((op as any).txHash);
          if (receipt.status === "success") {
            await BlockchainOpModel.findByIdAndUpdate(op._id, {
              status: "confirmed",
              confirmedAt: new Date(),
            });
            await handlePostConfirmation(op as any, (op as any).txHash, receipt.blockNumber);
            continue;
          }
        } catch {
          // Transaction not found or failed — re-execute
        }
      }

      await BlockchainOpModel.findByIdAndUpdate(op._id, {
        status: "submitted",
      });
      await executeOp(op as { _id: unknown; opType: string; entityType: string; entityId: string; payload: Record<string, unknown>; retryCount: number });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const newRetryCount = (op.retryCount ?? 0) + 1;

      // 5.6: Dead letter for ops exceeding max retries
      if (newRetryCount >= env.BLOCKCHAIN_MAX_RETRIES) {
        await BlockchainOpModel.findByIdAndUpdate(op._id, {
          status: "dead_letter",
          $inc: { retryCount: 1 },
          error: errMsg,
        });
        console.error(`[blockchain.worker] Op ${opId} moved to dead_letter after ${newRetryCount} retries: ${errMsg}`);
      } else {
        // 5.6: Exponential backoff: 30s * 2^retryCount, max 30min
        const backoffMs = Math.min(30_000 * Math.pow(2, newRetryCount), 30 * 60 * 1000);
        const nextRetryAt = new Date(Date.now() + backoffMs);

        await BlockchainOpModel.findByIdAndUpdate(op._id, {
          status: "pending",
          $inc: { retryCount: 1 },
          error: errMsg,
          nextRetryAt,
        });
        console.error(`[blockchain.worker] Op ${opId} failed (retry ${newRetryCount}, next at ${nextRetryAt.toISOString()}): ${errMsg}`);
      }
    } finally {
      inFlightOps.delete(opId);
    }
  }
}

export function startBlockchainWorker(): void {
  if (workerInterval) return; // Already running

  console.log(`[blockchain.worker] Starting — interval ${env.BLOCKCHAIN_POLL_INTERVAL_MS}ms, chainId ${env.CHAIN_ID}`);

  workerInterval = setInterval(() => {
    processPendingOps().catch((err) => {
      console.error("[blockchain.worker] Error in processPendingOps:", err);
    });
  }, env.BLOCKCHAIN_POLL_INTERVAL_MS);

  // Run immediately on start
  processPendingOps().catch((err) => {
    console.error("[blockchain.worker] Initial run failed:", err);
  });
}

// 5.6: Graceful shutdown — wait for in-flight ops to complete
export async function stopBlockchainWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }

  if (inFlightOps.size > 0) {
    console.log(`[blockchain.worker] Waiting for ${inFlightOps.size} in-flight operations...`);
    const maxWait = 30_000;
    const start = Date.now();
    while (inFlightOps.size > 0 && Date.now() - start < maxWait) {
      await new Promise((r) => setTimeout(r, 500));
    }
    if (inFlightOps.size > 0) {
      console.warn(`[blockchain.worker] Shutdown timeout — ${inFlightOps.size} ops still in flight`);
    }
  }

  console.log("[blockchain.worker] Stopped.");
}
