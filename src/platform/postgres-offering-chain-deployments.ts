import { randomUUID } from "node:crypto";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export class OfferingChainDeploymentError extends Error {}

type RequestRow = {
  id: string;
  organization_id: string;
  offering_id: string;
  offering_version_id: string;
  issuance_terms_request_id: string | null;
  chain_id: number;
  token_factory_address: string;
  offering_name: string;
  token_name: string;
  token_symbol: string;
  max_balance_per_holder: string;
  retail_cap: string;
  max_total_supply: string;
  status: "submitted" | "approved" | "rejected";
  submitted_by_identity_id: string;
  submitted_at: Date;
  decided_by_identity_id: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
};

type OperationRow = {
  id: string;
  request_id: string;
  organization_id: string;
  offering_id: string;
  chain_id: number;
  token_factory_address: string;
  operation_type: "deploy_token";
  status: "approved" | "submitted" | "confirmed" | "failed" | "cancelled";
  transaction_hash: string | null;
  token_contract_address: string | null;
  block_number: string | null;
  submitted_at: Date | null;
  confirmed_at: Date | null;
  failure_reason: string | null;
  created_at: Date;
  updated_at: Date;
};

function required(value: string, field: string, max: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new OfferingChainDeploymentError(`${field} is required and must be at most ${max} characters`);
  return normalized;
}

function address(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(normalized)) throw new OfferingChainDeploymentError(`${field} must be an EVM address`);
  return normalized;
}

function wholeTokenAmount(value: bigint | number | undefined, field: string): bigint {
  if (value === undefined) return 0n;
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new OfferingChainDeploymentError(`${field} must be a safe integer`);
  const normalized = typeof value === "bigint" ? value : BigInt(value);
  if (normalized < 0n) throw new OfferingChainDeploymentError(`${field} must not be negative`);
  return normalized;
}

function symbol(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z0-9-]{2,12}$/.test(normalized)) throw new OfferingChainDeploymentError("tokenSymbol must contain 2–12 uppercase letters, digits, or hyphens");
  return normalized;
}

function mapRequest(row: RequestRow) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    offeringId: row.offering_id,
    offeringVersionId: row.offering_version_id,
    issuanceTermsRequestId: row.issuance_terms_request_id,
    chainId: row.chain_id,
    tokenFactoryAddress: row.token_factory_address,
    offeringName: row.offering_name,
    tokenName: row.token_name,
    tokenSymbol: row.token_symbol,
    maxBalancePerHolder: row.max_balance_per_holder,
    retailCap: row.retail_cap,
    maxTotalSupply: row.max_total_supply,
    status: row.status,
    submittedByIdentityId: row.submitted_by_identity_id,
    submittedAt: row.submitted_at.toISOString(),
    decidedByIdentityId: row.decided_by_identity_id,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
  };
}

function mapOperation(row: OperationRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    organizationId: row.organization_id,
    offeringId: row.offering_id,
    chainId: row.chain_id,
    tokenFactoryAddress: row.token_factory_address,
    operationType: row.operation_type,
    status: row.status,
    transactionHash: row.transaction_hash,
    tokenContractAddress: row.token_contract_address,
    blockNumber: row.block_number,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    confirmedAt: row.confirmed_at?.toISOString() ?? null,
    failureReason: row.failure_reason,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export interface SubmitOfferingChainDeploymentRequestInput {
  organizationId: string;
  offeringId: string;
  issuanceTermsRequestId: string;
  submittedByIdentityId: string;
  chainId: number;
  tokenFactoryAddress: string;
  offeringName: string;
  tokenName: string;
  tokenSymbol: string;
  maxBalancePerHolder?: bigint | number;
  retailCap?: bigint | number;
}

/**
 * Capture the exact factory call only for a published offering and its current
 * immutable terms version. This function never sends a chain transaction.
 */
export async function submitOfferingChainDeploymentRequest(input: SubmitOfferingChainDeploymentRequestInput): Promise<{ requestId: string }> {
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0) throw new OfferingChainDeploymentError("chainId must be a positive safe integer");
  const tokenName = required(input.tokenName, "tokenName", 120);
  const offeringName = required(input.offeringName, "offeringName", 200);
  const tokenSymbol = symbol(input.tokenSymbol);
  const tokenFactoryAddress = address(input.tokenFactoryAddress, "tokenFactoryAddress");
  const maxBalancePerHolder = wholeTokenAmount(input.maxBalancePerHolder, "maxBalancePerHolder");
  const retailCap = wholeTokenAmount(input.retailCap, "retailCap");
  const requestId = randomUUID();

  await withPostgresTransaction(async (client) => {
    const offering = await client.query<{ id: string; current_version_id: string | null }>(
      `SELECT product.id, version.id AS current_version_id
         FROM fractal.offering_products product
         JOIN LATERAL (
           SELECT id FROM fractal.offering_publication_versions
            WHERE offering_id = product.id ORDER BY version DESC LIMIT 1
         ) version ON true
        WHERE product.id = $1 AND product.organization_id = $2 AND product.status = 'published'
        FOR SHARE`,
      [input.offeringId, input.organizationId],
    );
    const row = offering.rows[0];
    if (!row?.current_version_id) throw new OfferingChainDeploymentError("Only a published offering with immutable terms can be sent for chain deployment");
    const terms = await client.query<{ max_total_supply: string; status: string; offering_id: string; offering_version_id: string; organization_id: string }>(
      "SELECT max_total_supply, status, offering_id, offering_version_id, organization_id FROM fractal.offering_issuance_term_requests WHERE id = $1 FOR SHARE",
      [input.issuanceTermsRequestId],
    );
    const issuanceTerms = terms.rows[0];
    if (!issuanceTerms || issuanceTerms.status !== "approved" || issuanceTerms.organization_id !== input.organizationId || issuanceTerms.offering_id !== input.offeringId || issuanceTerms.offering_version_id !== row.current_version_id) {
      throw new OfferingChainDeploymentError("Chain deployment requires approved issuance terms for the offering's current immutable version");
    }
    const maxTotalSupply = BigInt(issuanceTerms.max_total_supply);

    await client.query(
      `INSERT INTO fractal.offering_chain_deployment_requests
         (id, organization_id, offering_id, offering_version_id, issuance_terms_request_id, chain_id, token_factory_address, offering_name, token_name, token_symbol,
          max_balance_per_holder, retail_cap, max_total_supply, status, submitted_by_identity_id, submitted_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, 'submitted', $14, now())`,
      [requestId, input.organizationId, input.offeringId, row.current_version_id, input.issuanceTermsRequestId, input.chainId, tokenFactoryAddress, offeringName, tokenName, tokenSymbol,
        maxBalancePerHolder.toString(), retailCap.toString(), maxTotalSupply.toString(), input.submittedByIdentityId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${input.organizationId}`, organizationId: input.organizationId, actorId: input.submittedByIdentityId,
      actorType: "user", action: "offering.chain_deployment.submitted", entityType: "offering_chain_deployment_request", entityId: requestId,
      payload: { offeringId: input.offeringId, offeringVersionId: row.current_version_id, issuanceTermsRequestId: input.issuanceTermsRequestId, chainId: input.chainId, tokenFactoryAddress, offeringName, tokenName, tokenSymbol, maxBalancePerHolder: maxBalancePerHolder.toString(), retailCap: retailCap.toString(), maxTotalSupply: maxTotalSupply.toString() },
    });
    await appendOutboxEvent(client, { aggregateType: "offering_chain_deployment_request", aggregateId: requestId, eventType: "offering.chain_deployment.submitted", payload: { organizationId: input.organizationId, offeringId: input.offeringId, auditEventId: audit.id } });
  });
  return { requestId };
}

export async function decideOfferingChainDeploymentRequest(input: {
  requestId: string;
  decidedByIdentityId: string;
  approve: boolean;
  reason?: string;
}): Promise<{ requestId: string; status: "approved" | "rejected"; operationId?: string }> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<RequestRow>("SELECT * FROM fractal.offering_chain_deployment_requests WHERE id = $1 FOR UPDATE", [input.requestId]);
    const request = result.rows[0];
    if (!request) throw new OfferingChainDeploymentError("Offering chain deployment request not found");
    if (request.status !== "submitted") throw new OfferingChainDeploymentError("Offering chain deployment request has already been decided");
    if (request.submitted_by_identity_id === input.decidedByIdentityId) throw new OfferingChainDeploymentError("A different person must approve or reject this request");
    const reason = input.reason?.trim();
    if (!input.approve && !reason) throw new OfferingChainDeploymentError("A rejection reason is required");

    const status = input.approve ? "approved" : "rejected";
    const operationId = input.approve ? randomUUID() : undefined;
    await client.query(
      `UPDATE fractal.offering_chain_deployment_requests
          SET status = $2, decided_by_identity_id = $3, decided_at = now(), decision_reason = $4
        WHERE id = $1`,
      [request.id, status, input.decidedByIdentityId, input.approve ? reason ?? null : required(reason!, "reason", 2_000)],
    );
    if (operationId) {
      await client.query(
        `INSERT INTO fractal.offering_chain_operations
           (id, request_id, organization_id, offering_id, chain_id, token_factory_address, operation_type, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'deploy_token', 'approved')`,
        [operationId, request.id, request.organization_id, request.offering_id, request.chain_id, request.token_factory_address],
      );
    }
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${request.organization_id}`, organizationId: request.organization_id, actorId: input.decidedByIdentityId,
      actorType: "user", action: `offering.chain_deployment.${status}`, entityType: "offering_chain_deployment_request", entityId: request.id,
      reason: reason ?? undefined, payload: { offeringId: request.offering_id, chainId: request.chain_id, operationId: operationId ?? null },
    });
    await appendOutboxEvent(client, {
      aggregateType: "offering_chain_deployment_request", aggregateId: request.id, eventType: `offering.chain_deployment.${status}`,
      payload: { organizationId: request.organization_id, offeringId: request.offering_id, operationId: operationId ?? null, auditEventId: audit.id },
    });
    return { requestId: request.id, status, ...(operationId ? { operationId } : {}) };
  });
}

export async function getOfferingChainDeploymentRequest(requestId: string) {
  const result = await requirePostgres().query<RequestRow>("SELECT * FROM fractal.offering_chain_deployment_requests WHERE id = $1", [requestId]);
  return result.rows[0] ? mapRequest(result.rows[0]) : null;
}

export async function listOfferingChainDeploymentRequests(input: { organizationId: string; offeringId?: string; status?: RequestRow["status"] }) {
  const result = await requirePostgres().query<RequestRow>(
    `SELECT * FROM fractal.offering_chain_deployment_requests
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR offering_id = $2) AND ($3::text IS NULL OR status = $3)
      ORDER BY submitted_at DESC, id DESC`,
    [input.organizationId, input.offeringId ?? null, input.status ?? null],
  );
  return result.rows.map(mapRequest);
}

export async function listOfferingChainOperations(input: { organizationId: string; offeringId?: string }) {
  const result = await requirePostgres().query<OperationRow>(
    `SELECT * FROM fractal.offering_chain_operations
      WHERE organization_id = $1 AND ($2::uuid IS NULL OR offering_id = $2)
      ORDER BY created_at DESC, id DESC`,
    [input.organizationId, input.offeringId ?? null],
  );
  return result.rows.map(mapOperation);
}
