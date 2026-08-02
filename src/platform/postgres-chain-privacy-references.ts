import { stableJsonStringify } from "../utils/idempotency.js";

export type ChainPrivacyRecord =
  | {
      recordType: "wallet";
      chainId: number;
      walletAddress: string;
    }
  | {
      recordType: "allocation_transaction";
      chainId: number;
      walletAddress: string;
      transactionHash: string;
      tokenContractAddress: string;
      operationType: "whitelist" | "mint";
    }
  | {
      recordType: "ownership_snapshot";
      chainId: number;
      walletAddress: string;
      tokenContractAddress: string;
      blockNumber: string;
      blockHash: string;
      balanceUnits: string;
    };

type Queryable = {
  query: <T extends Record<string, unknown>>(
    text: string,
    values: readonly unknown[],
  ) => Promise<{ rows: T[] }>;
};

function normalizedAddress(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Resolve public-chain facts only through exact identity-owned wallet links.
 * The query does not infer a person from an address, organization, or name.
 */
export async function queryChainPrivacyRecordsForIdentity(
  queryable: Queryable,
  identityId: string,
): Promise<ChainPrivacyRecord[]> {
  const wallets = await queryable.query<{
    chain_id: number;
    wallet_address: string;
  }>(
    `SELECT chain_id,wallet_address
       FROM fractal.investor_wallets
      WHERE investor_identity_id=$1
      ORDER BY chain_id,wallet_address`,
    [identityId],
  );
  const allocationTransactions = await queryable.query<{
    chain_id: number;
    wallet_address: string;
    transaction_hash: string;
    token_contract_address: string;
    operation_type: "whitelist" | "mint";
  }>(
    `SELECT operation.chain_id,operation.wallet_address,
            operation.transaction_hash,operation.token_contract_address,
            operation.operation_type
       FROM fractal.investment_allocation_chain_operations operation
       JOIN fractal.investment_allocation_requests allocation
         ON allocation.id=operation.allocation_request_id
      WHERE allocation.investor_identity_id=$1
        AND operation.transaction_hash IS NOT NULL
      ORDER BY operation.chain_id,operation.transaction_hash,operation.operation_type`,
    [identityId],
  );
  const ownershipSnapshots = await queryable.query<{
    chain_id: number;
    wallet_address: string;
    token_contract_address: string;
    block_number: string;
    block_hash: string;
    balance_units: string;
  }>(
    `SELECT snapshot.chain_id,holding.wallet_address,
            snapshot.token_contract_address,snapshot.block_number::text,
            snapshot.block_hash,holding.balance_units::text
       FROM fractal.ownership_snapshot_holdings holding
       JOIN fractal.ownership_snapshot_requests snapshot
         ON snapshot.id=holding.snapshot_request_id
      WHERE holding.investor_identity_id=$1
        AND snapshot.status='approved'
      ORDER BY snapshot.chain_id,snapshot.block_number,snapshot.block_hash,
               holding.wallet_address`,
    [identityId],
  );

  const records: ChainPrivacyRecord[] = [
    ...wallets.rows.map((row) => ({
      recordType: "wallet" as const,
      chainId: row.chain_id,
      walletAddress: normalizedAddress(row.wallet_address),
    })),
    ...allocationTransactions.rows.map((row) => ({
      recordType: "allocation_transaction" as const,
      chainId: row.chain_id,
      walletAddress: normalizedAddress(row.wallet_address),
      transactionHash: row.transaction_hash.trim().toLowerCase(),
      tokenContractAddress: normalizedAddress(row.token_contract_address),
      operationType: row.operation_type,
    })),
    ...ownershipSnapshots.rows.map((row) => ({
      recordType: "ownership_snapshot" as const,
      chainId: row.chain_id,
      walletAddress: normalizedAddress(row.wallet_address),
      tokenContractAddress: normalizedAddress(row.token_contract_address),
      blockNumber: row.block_number,
      blockHash: row.block_hash.trim().toLowerCase(),
      balanceUnits: row.balance_units,
    })),
  ];

  const unique = new Map(records.map((record) => [stableJsonStringify(record), record]));
  return [...unique.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, record]) => record);
}
