import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { assertTokenFactoryOwner, assertTokenFactorySupportsImmutableIssuanceCap, deployToken, getDeployedToken, waitForTransaction } from "./blockchain.service.js";
import { appendPostgresAuditEvent } from "../platform/postgres-audit.js";
import { appendOutboxEvent } from "../platform/postgres-outbox.js";

export interface OfferingChainExecutorLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

type Deployment = {
  operationId: string;
  organizationId: string;
  offeringId: string;
  issuanceTermsRequestId: string | null;
  chainId: number;
  factoryAddress: string;
  offeringName: string;
  tokenName: string;
  tokenSymbol: string;
  maxBalancePerHolder: string;
  retailCap: string;
  maxTotalSupply: string;
  transactionHash: `0x${string}` | null;
  claimId: string;
};
type SubmittedDeployment = Deployment & { transactionHash: `0x${string}` };

function shortError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 2_000);
}

function assertConfiguredTarget(deployment: Deployment) {
  if (!env.TOKEN_FACTORY_ADDRESS) throw new Error("TOKEN_FACTORY_ADDRESS is not configured");
  if (deployment.chainId !== env.CHAIN_ID) throw new Error(`Operation chain ${deployment.chainId} does not match configured chain ${env.CHAIN_ID}`);
  if (deployment.factoryAddress.toLowerCase() !== env.TOKEN_FACTORY_ADDRESS.toLowerCase()) throw new Error("Operation factory does not match configured TOKEN_FACTORY_ADDRESS");
  if (deployment.offeringName === "legacy-unavailable") throw new Error("Operation was created before the immutable offering name was captured and requires manual remediation");
  if (!deployment.issuanceTermsRequestId) throw new Error("Operation is not bound to approved issuance terms and requires manual remediation");
  if (BigInt(deployment.maxTotalSupply) <= 0n) throw new Error("Operation has no immutable max total supply and requires manual remediation");
}

async function recordAudit(client: Parameters<typeof appendPostgresAuditEvent>[0], deployment: Deployment, action: string, payload: Record<string, unknown>) {
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `organization:${deployment.organizationId}`, organizationId: deployment.organizationId,
    actorType: "system", action, entityType: "offering_chain_operation", entityId: deployment.operationId,
    payload: { offeringId: deployment.offeringId, chainId: deployment.chainId, factoryAddress: deployment.factoryAddress, ...payload },
  });
  await appendOutboxEvent(client, { aggregateType: "offering_chain_operation", aggregateId: deployment.operationId, eventType: action, payload: { organizationId: deployment.organizationId, auditEventId: audit.id } });
}

async function claimApprovedDeployment(workerId: string): Promise<Deployment | null> {
  return withPostgresTransaction(async (client) => {
    const candidate = await client.query<{
      id: string; organization_id: string; offering_id: string; issuance_terms_request_id: string | null; chain_id: number; token_factory_address: string;
      offering_name: string; token_name: string; token_symbol: string; max_balance_per_holder: string; retail_cap: string; max_total_supply: string;
    }>(
      `SELECT operation.id, operation.organization_id, operation.offering_id, request.issuance_terms_request_id, operation.chain_id, operation.token_factory_address,
              request.offering_name, request.token_name, request.token_symbol, request.max_balance_per_holder, request.retail_cap, request.max_total_supply
         FROM fractal.offering_chain_operations operation
         JOIN fractal.offering_chain_deployment_requests request ON request.id = operation.request_id
        WHERE operation.status = 'approved'
          AND NOT EXISTS (
            SELECT 1 FROM fractal.offering_chain_operation_dispatch_claims claim
             WHERE claim.operation_id = operation.id AND claim.status IN ('claimed', 'submitted', 'uncertain')
          )
        ORDER BY operation.created_at, operation.id
        FOR UPDATE OF operation SKIP LOCKED
        LIMIT 1`,
    );
    const operation = candidate.rows[0];
    if (!operation) return null;
    const claimId = randomUUID();
    await client.query(
      `INSERT INTO fractal.offering_chain_operation_dispatch_claims (id, operation_id, worker_id, status)
       VALUES ($1, $2, $3, 'claimed')`,
      [claimId, operation.id, workerId],
    );
    return {
      operationId: operation.id, organizationId: operation.organization_id, offeringId: operation.offering_id, issuanceTermsRequestId: operation.issuance_terms_request_id,
      chainId: operation.chain_id, factoryAddress: operation.token_factory_address, offeringName: operation.offering_name,
      tokenName: operation.token_name, tokenSymbol: operation.token_symbol, maxBalancePerHolder: operation.max_balance_per_holder,
      retailCap: operation.retail_cap, maxTotalSupply: operation.max_total_supply, transactionHash: null, claimId,
    };
  });
}

async function markUncertain(deployment: Deployment, error: unknown): Promise<void> {
  const reason = shortError(error);
  await withPostgresTransaction(async (client) => {
    const claim = await client.query(
      `UPDATE fractal.offering_chain_operation_dispatch_claims
          SET status = 'uncertain', failure_reason = $2, completed_at = now()
        WHERE id = $1 AND status = 'claimed'`,
      [deployment.claimId, reason],
    );
    if (claim.rowCount !== 1) throw new Error("Deployment claim cannot be marked uncertain from its current state");
    await recordAudit(client, deployment, "offering.chain_deployment.uncertain", { reason });
  });
}

async function markSubmitted(deployment: Deployment, transactionHash: `0x${string}`): Promise<SubmittedDeployment> {
  return withPostgresTransaction(async (client) => {
    const operation = await client.query(
      `UPDATE fractal.offering_chain_operations
          SET status = 'submitted', transaction_hash = $2, submitted_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'approved'`,
      [deployment.operationId, transactionHash.toLowerCase()],
    );
    if (operation.rowCount !== 1) throw new Error("Deployment operation is no longer approved");
    const claim = await client.query(
      `UPDATE fractal.offering_chain_operation_dispatch_claims
          SET status = 'submitted', transaction_hash = $2
        WHERE id = $1 AND status = 'claimed'`,
      [deployment.claimId, transactionHash.toLowerCase()],
    );
    if (claim.rowCount !== 1) throw new Error("Deployment claim is no longer active");
    const submitted = { ...deployment, transactionHash };
    await recordAudit(client, submitted, "offering.chain_deployment.submitted", { transactionHash });
    return submitted;
  });
}

async function markConfirmed(deployment: SubmittedDeployment, blockNumber: bigint, tokenContractAddress: `0x${string}`): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const operation = await client.query(
      `UPDATE fractal.offering_chain_operations
          SET status = 'confirmed', token_contract_address = $2, block_number = $3, confirmed_at = now(), updated_at = now()
        WHERE id = $1 AND status = 'submitted' AND transaction_hash = $4`,
      [deployment.operationId, tokenContractAddress.toLowerCase(), blockNumber.toString(), deployment.transactionHash.toLowerCase()],
    );
    if (operation.rowCount !== 1) throw new Error("Deployment operation cannot be confirmed from its current state");
    const claim = await client.query(
      `UPDATE fractal.offering_chain_operation_dispatch_claims
          SET status = 'confirmed', completed_at = now()
        WHERE id = $1 AND status = 'submitted' AND transaction_hash = $2`,
      [deployment.claimId, deployment.transactionHash.toLowerCase()],
    );
    if (claim.rowCount !== 1) throw new Error("Deployment claim cannot be confirmed from its current state");
    await recordAudit(client, deployment, "offering.chain_deployment.confirmed", { transactionHash: deployment.transactionHash, blockNumber: blockNumber.toString(), tokenContractAddress });
  });
}

async function markFailed(deployment: Deployment, error: unknown): Promise<void> {
  const reason = shortError(error);
  if (!deployment.transactionHash) return markUncertain(deployment, error);
  const submitted = deployment as SubmittedDeployment;
  await withPostgresTransaction(async (client) => {
    const operation = await client.query(
      `UPDATE fractal.offering_chain_operations
          SET status = 'failed', failure_reason = $2, updated_at = now()
        WHERE id = $1 AND status = 'submitted' AND transaction_hash = $3`,
      [submitted.operationId, reason, submitted.transactionHash.toLowerCase()],
    );
    if (operation.rowCount !== 1) throw new Error("Deployment operation cannot be marked failed from its current state");
    const claim = await client.query(
      `UPDATE fractal.offering_chain_operation_dispatch_claims
          SET status = 'failed', failure_reason = $2, completed_at = now()
        WHERE id = $1 AND status = 'submitted' AND transaction_hash = $3`,
      [submitted.claimId, reason, submitted.transactionHash.toLowerCase()],
    );
    if (claim.rowCount !== 1) throw new Error("Deployment claim cannot be marked failed from its current state");
    await recordAudit(client, submitted, "offering.chain_deployment.failed", { transactionHash: submitted.transactionHash, reason });
  });
}

async function reconcileSubmittedDeployments(logger: OfferingChainExecutorLogger): Promise<number> {
  const rows = await requirePostgres().query<{
    id: string; organization_id: string; offering_id: string; issuance_terms_request_id: string | null; chain_id: number; token_factory_address: string; transaction_hash: `0x${string}`;
    offering_name: string; token_name: string; token_symbol: string; max_balance_per_holder: string; retail_cap: string; max_total_supply: string; claim_id: string;
  }>(
    `SELECT operation.id, operation.organization_id, operation.offering_id, request.issuance_terms_request_id, operation.chain_id, operation.token_factory_address, operation.transaction_hash,
            request.offering_name, request.token_name, request.token_symbol, request.max_balance_per_holder, request.retail_cap, request.max_total_supply, claim.id AS claim_id
       FROM fractal.offering_chain_operations operation
       JOIN fractal.offering_chain_deployment_requests request ON request.id = operation.request_id
       JOIN LATERAL (
         SELECT id FROM fractal.offering_chain_operation_dispatch_claims
          WHERE operation_id = operation.id AND status = 'submitted' ORDER BY claimed_at DESC LIMIT 1
       ) claim ON true
      WHERE operation.status = 'submitted'
      ORDER BY operation.submitted_at, operation.id
      LIMIT $1`,
    [env.CHAIN_DEPLOYMENT_DISPATCH_BATCH_SIZE],
  );
  for (const row of rows.rows) {
    const deployment: SubmittedDeployment = {
      operationId: row.id, organizationId: row.organization_id, offeringId: row.offering_id, issuanceTermsRequestId: row.issuance_terms_request_id, chainId: row.chain_id,
      factoryAddress: row.token_factory_address, offeringName: row.offering_name, tokenName: row.token_name, tokenSymbol: row.token_symbol,
      maxBalancePerHolder: row.max_balance_per_holder, retailCap: row.retail_cap, maxTotalSupply: row.max_total_supply, transactionHash: row.transaction_hash, claimId: row.claim_id,
    };
    try {
      assertConfiguredTarget(deployment);
      const receipt = await waitForTransaction(deployment.transactionHash);
      if (receipt.status === "reverted") {
        await markFailed(deployment, new Error(`Transaction reverted: ${deployment.transactionHash}`));
        continue;
      }
      const record = await getDeployedToken(deployment.offeringId);
      await markConfirmed(deployment, receipt.blockNumber, record.tokenContract);
      logger.info({ operationId: deployment.operationId, transactionHash: deployment.transactionHash, tokenContractAddress: record.tokenContract }, "Offering chain deployment confirmed");
    } catch (error) {
      logger.error({ err: error, operationId: deployment.operationId, transactionHash: deployment.transactionHash }, "Offering chain deployment remains pending reconciliation");
    }
  }
  return rows.rowCount ?? 0;
}

async function dispatchOneApprovedDeployment(workerId: string, logger: OfferingChainExecutorLogger): Promise<boolean> {
  const deployment = await claimApprovedDeployment(workerId);
  if (!deployment) return false;
  let submitted: SubmittedDeployment | undefined;
  try {
    assertConfiguredTarget(deployment);
    // A factory record before this attempt means a previous process may have
    // broadcast and died before persisting its hash. Do not send another tx.
    try {
      await getDeployedToken(deployment.offeringId);
      await markUncertain(deployment, new Error("Factory already has a deployment record; transaction evidence must be reconciled manually"));
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("no confirmed deployment record")) throw error;
    }
    await assertTokenFactoryOwner();
    await assertTokenFactorySupportsImmutableIssuanceCap();
    const transactionHash = await deployToken({
      offeringId: deployment.offeringId, offeringName: deployment.offeringName, tokenName: deployment.tokenName,
      tokenSymbol: deployment.tokenSymbol, maxBalancePerHolder: BigInt(deployment.maxBalancePerHolder), retailCap: BigInt(deployment.retailCap), maxTotalSupply: BigInt(deployment.maxTotalSupply),
    });
    submitted = await markSubmitted(deployment, transactionHash);
    logger.info({ operationId: submitted.operationId, transactionHash }, "Offering chain deployment submitted");
  } catch (error) {
    if (!submitted) {
      await markUncertain(deployment, error).catch((markError) => logger.error({ err: markError, operationId: deployment.operationId }, "Failed to record uncertain offering chain deployment"));
    }
    logger.error({ err: error, operationId: deployment.operationId }, "Offering chain deployment was not broadcast or is uncertain");
  }
  if (submitted) await reconcileSubmittedDeployments(logger);
  return true;
}

export async function dispatchOfferingChainDeployments(options: { workerId?: string; logger: OfferingChainExecutorLogger }): Promise<number> {
  if (!env.CHAIN_DEPLOYMENT_EXECUTOR_ENABLED) throw new Error("CHAIN_DEPLOYMENT_EXECUTOR_ENABLED must be true to dispatch offering chain deployments");
  const workerId = options.workerId ?? randomUUID();
  await reconcileSubmittedDeployments(options.logger);
  let dispatched = 0;
  for (let index = 0; index < env.CHAIN_DEPLOYMENT_DISPATCH_BATCH_SIZE; index += 1) {
    if (!(await dispatchOneApprovedDeployment(workerId, options.logger))) break;
    dispatched += 1;
  }
  return dispatched;
}

export function startOfferingChainDeploymentExecutor(options: { logger: OfferingChainExecutorLogger; workerId?: string }): { stop: () => void } {
  const workerId = options.workerId ?? randomUUID();
  let running = false;
  let stopped = false;
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try { await dispatchOfferingChainDeployments({ ...options, workerId }); }
    catch (error) { options.logger.error({ err: error }, "Offering chain deployment executor polling failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void dispatch(), env.CHAIN_DEPLOYMENT_DISPATCH_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
