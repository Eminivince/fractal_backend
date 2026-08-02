import { beforeEach, describe, expect, it, vi } from "vitest";
const chainEnv = vi.hoisted(() => ({ CHAIN_DEPLOYMENT_EXECUTOR_ENABLED: false, CHAIN_DEPLOYMENT_DISPATCH_BATCH_SIZE: 1, CHAIN_ID: 11155111, TOKEN_FACTORY_ADDRESS: "0x1111111111111111111111111111111111111111" }));
const mocks = vi.hoisted(() => ({ postgres: vi.fn(), transaction: vi.fn(), owner: vi.fn(), immutableCap: vi.fn(), deploy: vi.fn(), deployed: vi.fn(), wait: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../config/env.js", () => ({ env: chainEnv }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../blockchain.service.js", () => ({ assertTokenFactoryOwner: mocks.owner, assertTokenFactorySupportsImmutableIssuanceCap: mocks.immutableCap, deployToken: mocks.deploy, getDeployedToken: mocks.deployed, waitForTransaction: mocks.wait }));
vi.mock("../../platform/postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit })); vi.mock("../../platform/postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
import { dispatchOfferingChainDeployments, startOfferingChainDeploymentExecutor } from "../postgres-offering-chain-executor.js";

const logger = { info: vi.fn(), error: vi.fn() };

const deploymentRow = {
  id: "operation-1", organization_id: "organization-1", offering_id: "offering-1", issuance_terms_request_id: "terms-1",
  chain_id: 11155111, token_factory_address: "0x1111111111111111111111111111111111111111", offering_name: "Harbour Apartments",
  token_name: "Harbour Token", token_symbol: "HBR", max_balance_per_holder: "1000", retail_cap: "500", max_total_supply: "100000",
};

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  return async (operation: (client: { query: typeof query }) => unknown) => operation({ query });
}

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = false;
  chainEnv.CHAIN_DEPLOYMENT_DISPATCH_BATCH_SIZE = 1;
  mocks.postgres.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) });
  mocks.transaction.mockImplementation(async (operation: (client: { query: ReturnType<typeof vi.fn> }) => unknown) => operation({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
  mocks.audit.mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockResolvedValue(undefined);
  logger.info.mockReset(); logger.error.mockReset();
});

describe("offering chain executor", () => {
  it("refuses dispatch unless the explicit executor switch is enabled", async () => {
    await expect(dispatchOfferingChainDeployments({ logger })).rejects.toThrow("CHAIN_DEPLOYMENT_EXECUTOR_ENABLED");
  });

  it("reconciles safely and exits when no approved deployment is available", async () => {
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    await expect(dispatchOfferingChainDeployments({ workerId: "worker-1", logger })).resolves.toBe(0);
    expect(mocks.postgres).toHaveBeenCalled();
    expect(mocks.transaction).toHaveBeenCalled();
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it("starts one guarded polling executor and can stop it", async () => {
    vi.useFakeTimers();
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    const executor = startOfferingChainDeploymentExecutor({ workerId: "worker-1", logger });
    await vi.advanceTimersByTimeAsync(0);
    executor.stop();
    vi.useRealTimers();
    expect(mocks.postgres).toHaveBeenCalled();
  });

  it("claims an approved immutable deployment, submits it, and confirms the deployed token", async () => {
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    const postgresQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ ...deploymentRow, transaction_hash: "0xabc", claim_id: "claim-1" }], rowCount: 1 });
    mocks.postgres.mockReturnValue({ query: postgresQuery });
    mocks.transaction
      .mockImplementationOnce(transactionWithResponses({ rows: [deploymentRow], rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWithResponses({ rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWithResponses({ rowCount: 1 }, { rowCount: 1 }));
    mocks.deployed
      .mockRejectedValueOnce(new Error("no confirmed deployment record"))
      .mockResolvedValueOnce({ tokenContract: "0x2222222222222222222222222222222222222222" });
    mocks.owner.mockResolvedValue(undefined);
    mocks.immutableCap.mockResolvedValue(undefined);
    mocks.deploy.mockResolvedValue("0xabc");
    mocks.wait.mockResolvedValue({ status: "success", blockNumber: 123n });

    await expect(dispatchOfferingChainDeployments({ workerId: "worker-1", logger })).resolves.toBe(1);

    expect(mocks.owner).toHaveBeenCalledOnce();
    expect(mocks.immutableCap).toHaveBeenCalledOnce();
    expect(mocks.deploy).toHaveBeenCalledWith({
      offeringId: "offering-1", offeringName: "Harbour Apartments", tokenName: "Harbour Token", tokenSymbol: "HBR",
      maxBalancePerHolder: 1000n, retailCap: 500n, maxTotalSupply: 100000n,
    });
    expect(mocks.wait).toHaveBeenCalledWith("0xabc");
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.outbox).toHaveBeenCalledTimes(2);
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation-1", transactionHash: "0xabc" }), "Offering chain deployment submitted");
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ tokenContractAddress: "0x2222222222222222222222222222222222222222" }), "Offering chain deployment confirmed");
  });

  it("records an unsafe deployment target as uncertain without broadcasting", async () => {
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    const postgresQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.postgres.mockReturnValue({ query: postgresQuery });
    mocks.transaction
      .mockImplementationOnce(transactionWithResponses({ rows: [{ ...deploymentRow, chain_id: 1 }], rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWithResponses({ rowCount: 1 }));

    await expect(dispatchOfferingChainDeployments({ workerId: "worker-1", logger })).resolves.toBe(1);

    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.chain_deployment.uncertain" }));
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation-1" }), "Offering chain deployment was not broadcast or is uncertain");
  });

  it("records an existing factory deployment as uncertain without sending a second transaction", async () => {
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    const postgresQuery = vi.fn().mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.postgres.mockReturnValue({ query: postgresQuery });
    mocks.transaction
      .mockImplementationOnce(transactionWithResponses({ rows: [deploymentRow], rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWithResponses({ rowCount: 1 }));
    mocks.deployed.mockResolvedValue({ tokenContract: "0x2222222222222222222222222222222222222222" });

    await expect(dispatchOfferingChainDeployments({ workerId: "worker-1", logger })).resolves.toBe(1);

    expect(mocks.deploy).not.toHaveBeenCalled();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "offering.chain_deployment.uncertain",
      payload: expect.objectContaining({ reason: expect.stringContaining("Factory already has a deployment record") }),
    }));
  });

  it("marks a submitted deployment failed when its transaction reverts during reconciliation", async () => {
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    const postgresQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...deploymentRow, transaction_hash: "0xabc", claim_id: "claim-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.postgres.mockReturnValue({ query: postgresQuery });
    mocks.transaction
      .mockImplementationOnce(transactionWithResponses({ rowCount: 1 }, { rowCount: 1 }))
      .mockImplementationOnce(transactionWithResponses({ rows: [], rowCount: 0 }));
    mocks.wait.mockResolvedValue({ status: "reverted", blockNumber: 123n });

    await expect(dispatchOfferingChainDeployments({ workerId: "worker-1", logger })).resolves.toBe(0);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "offering.chain_deployment.failed" }));
    expect(mocks.deploy).not.toHaveBeenCalled();
  });

  it("keeps a submitted deployment pending when receipt lookup fails", async () => {
    chainEnv.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED = true;
    const postgresQuery = vi.fn()
      .mockResolvedValueOnce({ rows: [{ ...deploymentRow, transaction_hash: "0xabc", claim_id: "claim-1" }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    mocks.postgres.mockReturnValue({ query: postgresQuery });
    mocks.wait.mockRejectedValue(new Error("provider is unavailable"));

    await expect(dispatchOfferingChainDeployments({ workerId: "worker-1", logger })).resolves.toBe(0);

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ transactionHash: "0xabc" }), "Offering chain deployment remains pending reconciliation");
    expect(mocks.transaction).toHaveBeenCalledOnce();
  });

  it("logs polling failures and keeps the executor stoppable", async () => {
    vi.useFakeTimers();
    const executor = startOfferingChainDeploymentExecutor({ workerId: "worker-1", logger });
    await vi.advanceTimersByTimeAsync(0);
    executor.stop();
    vi.useRealTimers();

    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), "Offering chain deployment executor polling failed");
  });
});
