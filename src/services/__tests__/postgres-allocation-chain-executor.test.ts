import { beforeEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({
  ALLOCATION_CHAIN_EXECUTOR_ENABLED: false,
  ALLOCATION_CHAIN_DISPATCH_BATCH_SIZE: 1,
  ALLOCATION_CHAIN_DISPATCH_INTERVAL_MS: 60_000,
  CHAIN_ID: 11155111,
}));
const mocks = vi.hoisted(() => ({
  audit: vi.fn(), batchMint: vi.fn(), immutableCap: vi.fn(), materialize: vi.fn(), outbox: vi.fn(), owner: vi.fn(), postgres: vi.fn(), releaseMint: vi.fn(), transaction: vi.fn(), wait: vi.fn(), whitelist: vi.fn(),
}));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../../platform/postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../../platform/postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../../platform/postgres-allocation-chain-operations.js", () => ({ materializeAllocationChainOperations: mocks.materialize, releaseMintOperation: mocks.releaseMint }));
vi.mock("../blockchain.service.js", () => ({ assertTokenFactoryOwner: mocks.owner, assertTokenFactorySupportsImmutableIssuanceCap: mocks.immutableCap, batchMint: mocks.batchMint, waitForTransaction: mocks.wait, whitelistInvestor: mocks.whitelist }));

import { dispatchAllocationChainOperations, startAllocationChainExecutor } from "../postgres-allocation-chain-executor.js";

const logger = { info: vi.fn(), error: vi.fn() };
const operation = {
  id: "operation-1", allocation_request_id: "allocation-1", organization_id: "organization-1", offering_id: "offering-1", chain_id: 11155111,
  token_contract_address: "0x1111111111111111111111111111111111111111", wallet_address: "0x2222222222222222222222222222222222222222", token_amount: "25", operation_type: "whitelist" as const,
};

function transactionWith(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  return async (callback: (client: { query: typeof query }) => unknown) => callback({ query });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  env.ALLOCATION_CHAIN_EXECUTOR_ENABLED = false;
  env.ALLOCATION_CHAIN_DISPATCH_BATCH_SIZE = 1;
  mocks.postgres.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) });
  mocks.transaction.mockImplementation(async (callback: (client: { query: ReturnType<typeof vi.fn> }) => unknown) => callback({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
  mocks.materialize.mockResolvedValue(undefined); mocks.audit.mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockResolvedValue(undefined);
  mocks.owner.mockResolvedValue(undefined); mocks.immutableCap.mockResolvedValue(undefined); mocks.whitelist.mockResolvedValue("0xabc"); mocks.wait.mockResolvedValue({ status: "success", blockNumber: 321n }); mocks.releaseMint.mockResolvedValue(undefined);
  logger.info.mockReset(); logger.error.mockReset();
});

describe("allocation chain executor", () => {
  it("requires the explicit allocation executor switch", async () => {
    await expect(dispatchAllocationChainOperations({ logger })).rejects.toThrow("ALLOCATION_CHAIN_EXECUTOR_ENABLED");
  });

  it("claims, whitelists, confirms, and releases the paired mint operation", async () => {
    env.ALLOCATION_CHAIN_EXECUTOR_ENABLED = true;
    const postgresQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{
        operationId: "operation-1", allocationId: "allocation-1", organizationId: "organization-1", offeringId: "offering-1", chainId: 11155111,
        tokenContractAddress: operation.token_contract_address, walletAddress: operation.wallet_address, tokenAmount: "25", operationType: "whitelist", transaction_hash: "0xabc", claim_id: "claim-1",
      }], rowCount: 1 });
    mocks.postgres.mockReturnValue({ query: postgresQuery });
    mocks.transaction
      .mockImplementationOnce(transactionWith({ rows: [operation], rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWith({ rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWith({ rowCount: 1 }, { rowCount: 1 }));

    await expect(dispatchAllocationChainOperations({ workerId: "worker-1", logger })).resolves.toBe(1);

    expect(mocks.materialize).toHaveBeenCalledWith(1);
    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.immutableCap).toHaveBeenCalledOnce();
    expect(mocks.whitelist).toHaveBeenCalledWith(operation.token_contract_address, operation.wallet_address);
    expect(mocks.wait).toHaveBeenCalledWith("0xabc");
    expect(mocks.releaseMint).toHaveBeenCalledWith({ whitelistOperationId: "operation-1" });
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.outbox).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation-1", transactionHash: "0xabc" }), "Allocation chain operation submitted");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation-1", transactionHash: "0xabc" }), "Allocation chain operation confirmed");
  });

  it("marks an invalid allocation operation uncertain without a blockchain call", async () => {
    env.ALLOCATION_CHAIN_EXECUTOR_ENABLED = true;
    mocks.postgres.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) });
    mocks.transaction
      .mockImplementationOnce(transactionWith({ rows: [{ ...operation, token_amount: "0" }], rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWith({ rowCount: 1 }));

    await expect(dispatchAllocationChainOperations({ workerId: "worker-1", logger })).resolves.toBe(1);

    expect(mocks.whitelist).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "investment.allocation.chain_uncertain" }));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation-1" }), "Allocation chain operation was not broadcast or is uncertain");
  });

  it("starts a guarded poller and stops its timer", async () => {
    vi.useFakeTimers();
    env.ALLOCATION_CHAIN_EXECUTOR_ENABLED = true;
    const executor = startAllocationChainExecutor({ workerId: "worker-1", logger });
    await vi.advanceTimersByTimeAsync(0);
    executor.stop();
    vi.useRealTimers();
    expect(mocks.materialize).toHaveBeenCalled();
  });
});
