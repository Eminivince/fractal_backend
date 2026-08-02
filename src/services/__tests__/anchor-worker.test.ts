import { beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.hoisted(() => vi.fn());
const findOneAndUpdate = vi.hoisted(() => vi.fn());
const findByIdAndUpdate = vi.hoisted(() => vi.fn());
const getPrivateKey = vi.hoisted(() => vi.fn());
const writeContract = vi.hoisted(() => vi.fn());
const waitForTransactionReceipt = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({
  ANCHOR_WORKER_ENABLED: false,
  ANCHOR_RPC_URL: "https://rpc.test",
  ANCHOR_CONTRACT_ADDRESS: "0x0000000000000000000000000000000000000001",
  ANCHOR_PRIVATE_KEY: "0x" + "1".repeat(64),
  ANCHOR_CHAIN_ID: 11155111,
  ANCHOR_CONFIRMATIONS: 1,
  ANCHOR_POLL_INTERVAL_MS: 1_000,
}));

vi.mock("../../db/models.js", () => ({ AnchorModel: { find, findOneAndUpdate, findByIdAndUpdate } }));
vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../key-manager.js", () => ({ keyManager: { getPrivateKey } }));
vi.mock("viem", () => ({
  defineChain: vi.fn((chain) => chain),
  http: vi.fn((url) => ({ url })),
  createPublicClient: vi.fn(() => ({ waitForTransactionReceipt })),
  createWalletClient: vi.fn(() => ({ writeContract })),
}));
vi.mock("viem/accounts", () => ({ privateKeyToAccount: vi.fn((key) => ({ address: "0xaccount", key })) }));

import { startAnchorWorker } from "../anchor-worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  env.ANCHOR_WORKER_ENABLED = false;
  getPrivateKey.mockResolvedValue("0x" + "1".repeat(64));
  writeContract.mockResolvedValue("0xtx");
  waitForTransactionReceipt.mockResolvedValue({ status: "success" });
});

describe("anchor worker", () => {
  it("returns an inert handle when its chain configuration is incomplete", async () => {
    const worker = await startAnchorWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("Anchor worker disabled"));
    expect(find).not.toHaveBeenCalled();
  });

  it("claims and anchors a pending event on chain", async () => {
    env.ANCHOR_WORKER_ENABLED = true;
    const row = { _id: "anchor-1" };
    const claimed = { _id: "anchor-1", canonicalHash: "a".repeat(64), entityType: "offering", entityId: "offering-1", eventType: "Published" };
    find.mockReturnValue({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([row]) });
    findOneAndUpdate.mockResolvedValue(claimed);
    const worker = await startAnchorWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(writeContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: "anchor", args: ["0x" + "a".repeat(64), "offering", "offering-1", "Published"] }));
    expect(waitForTransactionReceipt).toHaveBeenCalledWith({ hash: "0xtx", confirmations: 1 });
    expect(findByIdAndUpdate).toHaveBeenCalledWith("anchor-1", expect.objectContaining({ anchorStatus: "anchored", txHash: "0xtx", chainRef: "eip155:11155111" }));
  });

  it("skips unclaimable rows and marks failed submissions with a bounded error", async () => {
    env.ANCHOR_WORKER_ENABLED = true;
    find.mockReturnValue({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([{ _id: "missing" }, { _id: "invalid" }]) });
    findOneAndUpdate.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: "invalid", canonicalHash: "bad", entityType: "offering", entityId: "offering-1", eventType: "Published" });
    const worker = await startAnchorWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(findByIdAndUpdate).toHaveBeenCalledWith("invalid", expect.objectContaining({ anchorStatus: "failed", lastError: "canonicalHash must be 32-byte hex" }));
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("Anchor submission failed for invalid"));
  });

  it("runs the scheduled poll callback", async () => {
    vi.useFakeTimers();
    try {
      env.ANCHOR_WORKER_ENABLED = true;
      find.mockReturnValue({ sort: vi.fn().mockReturnThis(), limit: vi.fn().mockReturnThis(), lean: vi.fn().mockResolvedValue([]) });
      const worker = await startAnchorWorker(log);
      await vi.advanceTimersByTimeAsync(1_000);
      worker.stop();
      expect(find).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
