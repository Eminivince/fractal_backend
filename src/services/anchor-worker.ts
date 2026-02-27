import { type Address, type Hex, createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AnchorModel } from "../db/models.js";
import { env } from "../config/env.js";
import { keyManager } from "./key-manager.js";

const anchorRegistryAbi = [
  {
    type: "function",
    name: "anchor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "canonicalHash", type: "bytes32" },
      { name: "entityType", type: "string" },
      { name: "entityId", type: "string" },
      { name: "eventType", type: "string" },
    ],
    outputs: [],
  },
] as const;

interface LoggerLike {
  info: (msg: string, ...args: unknown[]) => void;
  warn: (msg: string, ...args: unknown[]) => void;
  error: (msg: string, ...args: unknown[]) => void;
}

export interface AnchorWorkerHandle {
  stop: () => void;
  triggerNow: () => Promise<void>;
}

function toBytes32(hexOrRaw: string): Hex {
  const raw = hexOrRaw.startsWith("0x") ? hexOrRaw.slice(2) : hexOrRaw;
  if (!/^[a-fA-F0-9]{64}$/.test(raw)) {
    throw new Error("canonicalHash must be 32-byte hex");
  }
  return `0x${raw}` as Hex;
}

function anchorWorkerConfigured(): boolean {
  return Boolean(
    env.ANCHOR_WORKER_ENABLED &&
      env.ANCHOR_RPC_URL &&
      env.ANCHOR_CONTRACT_ADDRESS &&
      env.ANCHOR_PRIVATE_KEY,
  );
}

export async function startAnchorWorker(log: LoggerLike): Promise<AnchorWorkerHandle> {
  if (!anchorWorkerConfigured()) {
    log.info("Anchor worker disabled: missing env configuration or ANCHOR_WORKER_ENABLED=false");
    return {
      stop: () => undefined,
      triggerNow: async () => undefined,
    };
  }

  const chain = defineChain({
    id: env.ANCHOR_CHAIN_ID,
    name: `chain-${env.ANCHOR_CHAIN_ID}`,
    nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
    rpcUrls: {
      default: {
        http: [env.ANCHOR_RPC_URL!],
      },
    },
  });

  const anchorKey = await keyManager.getPrivateKey("anchor");
  const account = privateKeyToAccount(anchorKey);
  const publicClient = createPublicClient({
    chain,
    transport: http(env.ANCHOR_RPC_URL),
  });
  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(env.ANCHOR_RPC_URL),
  });

  let running = false;

  const processBatch = async () => {
    if (running) return;
    running = true;
    try {
      const pendingRows = await AnchorModel.find({ anchorStatus: "pending" }).sort({ createdAt: 1 }).limit(20).lean();
      for (const row of pendingRows) {
        const claimed = await AnchorModel.findOneAndUpdate(
          { _id: row._id, anchorStatus: "pending" },
          {
            $set: { anchorStatus: "processing", lastError: undefined },
            $inc: { attempts: 1 },
          },
          { new: true },
        );

        if (!claimed) continue;

        try {
          const txHash = await walletClient.writeContract({
            address: env.ANCHOR_CONTRACT_ADDRESS as Address,
            abi: anchorRegistryAbi,
            functionName: "anchor",
            args: [toBytes32(claimed.canonicalHash), claimed.entityType, claimed.entityId, claimed.eventType],
          });

          await publicClient.waitForTransactionReceipt({
            hash: txHash,
            confirmations: env.ANCHOR_CONFIRMATIONS,
          });

          await AnchorModel.findByIdAndUpdate(claimed._id, {
            anchorStatus: "anchored",
            txHash,
            chainRef: `eip155:${env.ANCHOR_CHAIN_ID}`,
            anchoredAt: new Date(),
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown anchor worker error";
          await AnchorModel.findByIdAndUpdate(claimed._id, {
            anchorStatus: "failed",
            lastError: message.slice(0, 900),
          });
          log.error(`Anchor submission failed for ${String(claimed._id)}: ${message}`);
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void processBatch();
  }, env.ANCHOR_POLL_INTERVAL_MS);

  log.info(`Anchor worker started (interval=${env.ANCHOR_POLL_INTERVAL_MS}ms, chain=${env.ANCHOR_CHAIN_ID})`);

  return {
    stop: () => clearInterval(timer),
    triggerNow: processBatch,
  };
}
