import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

type OperationRow = {
  id: string; allocation_request_id: string; organization_id: string; offering_id: string; chain_id: number;
  token_contract_address: string; wallet_address: string; token_amount: string; operation_type: "whitelist" | "mint"; status: string;
  transaction_hash: string | null; submitted_at: Date | null; confirmed_at: Date | null; failure_reason: string | null; requires_manual_reconciliation: boolean; created_at: Date; updated_at: Date;
};

function map(row: OperationRow) {
  return { id: row.id, allocationRequestId: row.allocation_request_id, organizationId: row.organization_id, offeringId: row.offering_id,
    chainId: row.chain_id, tokenContractAddress: row.token_contract_address, walletAddress: row.wallet_address, tokenAmount: row.token_amount,
    operationType: row.operation_type, status: row.status, transactionHash: row.transaction_hash, submittedAt: row.submitted_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null, failureReason: row.failure_reason, requiresManualReconciliation: row.requires_manual_reconciliation,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString() };
}

async function record(client: Parameters<typeof appendPostgresAuditEvent>[0], operation: { id: string; organizationId: string; offeringId: string; allocationId: string }, action: string, payload: Record<string, unknown>) {
  const audit = await appendPostgresAuditEvent(client, { scopeKey: `organization:${operation.organizationId}`, organizationId: operation.organizationId, actorType: "system", action, entityType: "investment_allocation_chain_operation", entityId: operation.id, payload: { offeringId: operation.offeringId, allocationRequestId: operation.allocationId, ...payload } });
  await appendOutboxEvent(client, { aggregateType: "investment_allocation_chain_operation", aggregateId: operation.id, eventType: action, payload: { organizationId: operation.organizationId, auditEventId: audit.id } });
}

/**
 * Creates whitelist operations only after a deployment for the exact approved
 * terms is confirmed. It never creates a mint before a whitelist confirmation.
 */
export async function materializeAllocationChainOperations(limit = 100): Promise<number> {
  return withPostgresTransaction(async (client) => {
    const allocations = await client.query<{
      allocation_id: string; organization_id: string; offering_id: string; chain_id: number; wallet_address: string; token_amount: string; token_contract_address: string;
    }>(
      `SELECT allocation.id AS allocation_id, allocation.organization_id, allocation.offering_id, allocation.chain_id, allocation.wallet_address, allocation.token_amount, deployment.token_contract_address
         FROM fractal.investment_allocation_requests allocation
         JOIN fractal.offering_chain_operations deployment ON deployment.offering_id = allocation.offering_id AND deployment.status = 'confirmed'
         JOIN fractal.offering_chain_deployment_requests request ON request.id = deployment.request_id
        WHERE allocation.status = 'approved' AND request.issuance_terms_request_id = allocation.issuance_terms_request_id
          AND deployment.chain_id = allocation.chain_id AND deployment.token_contract_address IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM fractal.investment_allocation_chain_operations operation WHERE operation.allocation_request_id = allocation.id AND operation.operation_type = 'whitelist')
        ORDER BY allocation.decided_at, allocation.id FOR UPDATE OF allocation SKIP LOCKED LIMIT $1`,
      [limit],
    );
    for (const allocation of allocations.rows) {
      const operationId = randomUUID();
      await client.query(
        `INSERT INTO fractal.investment_allocation_chain_operations
         (id, allocation_request_id, organization_id, offering_id, chain_id, token_contract_address, wallet_address, token_amount, operation_type, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'whitelist','approved')`,
        [operationId, allocation.allocation_id, allocation.organization_id, allocation.offering_id, allocation.chain_id, allocation.token_contract_address, allocation.wallet_address, allocation.token_amount],
      );
      await record(client, { id: operationId, organizationId: allocation.organization_id, offeringId: allocation.offering_id, allocationId: allocation.allocation_id }, "investment.allocation.whitelist_approved", { chainId: allocation.chain_id, tokenContractAddress: allocation.token_contract_address, walletAddress: allocation.wallet_address });
    }
    return allocations.rowCount ?? 0;
  });
}

/** Called only after the whitelist receipt is confirmed by the chain executor. */
export async function releaseMintOperation(input: { whitelistOperationId: string }): Promise<string> {
  return withPostgresTransaction(async (client) => {
    const whitelist = await client.query<OperationRow>("SELECT * FROM fractal.investment_allocation_chain_operations WHERE id = $1 FOR UPDATE", [input.whitelistOperationId]);
    const operation = whitelist.rows[0];
    if (!operation || operation.operation_type !== "whitelist" || operation.status !== "confirmed") throw new Error("Mint may be released only after a confirmed whitelist operation");
    const existing = await client.query<{ id: string }>("SELECT id FROM fractal.investment_allocation_chain_operations WHERE allocation_request_id = $1 AND operation_type = 'mint' FOR UPDATE", [operation.allocation_request_id]);
    if (existing.rows[0]) return existing.rows[0].id;
    const mintId = randomUUID();
    await client.query(
      `INSERT INTO fractal.investment_allocation_chain_operations
       (id, allocation_request_id, organization_id, offering_id, chain_id, token_contract_address, wallet_address, token_amount, operation_type, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'mint','approved')`,
      [mintId, operation.allocation_request_id, operation.organization_id, operation.offering_id, operation.chain_id, operation.token_contract_address, operation.wallet_address, operation.token_amount],
    );
    await record(client, { id: mintId, organizationId: operation.organization_id, offeringId: operation.offering_id, allocationId: operation.allocation_request_id }, "investment.allocation.mint_approved", { whitelistOperationId: operation.id, tokenAmount: operation.token_amount, walletAddress: operation.wallet_address });
    return mintId;
  });
}

export async function listAllocationChainOperations(input: { organizationId: string; allocationRequestId?: string }) {
  const result = await requirePostgres().query<OperationRow>(
    `SELECT operation.*, EXISTS (
        SELECT 1 FROM fractal.investment_allocation_chain_dispatch_claims claim
         WHERE claim.operation_id = operation.id AND claim.status = 'uncertain'
      ) AS requires_manual_reconciliation
       FROM fractal.investment_allocation_chain_operations operation
      WHERE operation.organization_id = $1 AND ($2::uuid IS NULL OR operation.allocation_request_id = $2)
      ORDER BY operation.created_at DESC, operation.id DESC`,
    [input.organizationId, input.allocationRequestId ?? null],
  );
  return result.rows.map(map);
}
