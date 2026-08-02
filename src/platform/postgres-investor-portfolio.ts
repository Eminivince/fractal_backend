import { requirePostgres } from "../db/postgres.js";

type InvestorPortfolioRow = {
  allocation_request_id: string;
  public_reference: string;
  offering_name: string;
  currency: string;
  invested_minor: string;
  token_unit_price_minor: string;
  token_amount: string;
  allocation_status: "submitted" | "approved" | "rejected";
  submitted_at: Date;
  decided_at: Date | null;
  chain_id: number;
  wallet_address: string;
  mint_status: "waiting" | "approved" | "submitted" | "confirmed" | "failed" | "cancelled" | "uncertain" | null;
  mint_transaction_hash: string | null;
  mint_confirmed_at: Date | null;
  mint_failure_reason: string | null;
  token_contract_address: string | null;
};

/**
 * Investor-facing ownership data is deliberately derived only from the
 * allocation authority and its immutable chain-operation record. This is not
 * a valuation, cash balance, or distribution statement: those require their
 * own governed sources before they can be shown to an investor.
 */
export async function listInvestorPortfolioPositions(identityId: string) {
  const result = await requirePostgres().query<InvestorPortfolioRow>(
    `SELECT allocation.id AS allocation_request_id,
            product.public_reference,
            COALESCE(NULLIF(version.terms ->> 'name', ''), product.public_reference) AS offering_name,
            allocation.currency,
            allocation.invested_minor::text,
            allocation.token_unit_price_minor::text,
            allocation.token_amount::text,
            allocation.status AS allocation_status,
            allocation.submitted_at,
            allocation.decided_at,
            allocation.chain_id,
            allocation.wallet_address,
            mint.status AS mint_status,
            mint.transaction_hash AS mint_transaction_hash,
            mint.confirmed_at AS mint_confirmed_at,
            mint.failure_reason AS mint_failure_reason,
            mint.token_contract_address
       FROM fractal.investment_allocation_requests allocation
       JOIN fractal.offering_products product ON product.id = allocation.offering_id
       JOIN fractal.offering_issuance_term_requests terms ON terms.id = allocation.issuance_terms_request_id
       JOIN fractal.offering_publication_versions version ON version.id = terms.offering_version_id
       LEFT JOIN LATERAL (
         SELECT status, transaction_hash, confirmed_at, failure_reason, token_contract_address
           FROM fractal.investment_allocation_chain_operations
          WHERE allocation_request_id = allocation.id
            AND operation_type = 'mint'
          ORDER BY created_at DESC, id DESC
          LIMIT 1
       ) mint ON true
      WHERE allocation.investor_identity_id = $1
      ORDER BY allocation.submitted_at DESC, allocation.id DESC`,
    [identityId],
  );

  return result.rows.map((row) => ({
    allocationRequestId: row.allocation_request_id,
    publicReference: row.public_reference,
    offeringName: row.offering_name,
    currency: row.currency,
    investedMinor: row.invested_minor,
    tokenUnitPriceMinor: row.token_unit_price_minor,
    tokenAmount: row.token_amount,
    allocationStatus: row.allocation_status,
    submittedAt: row.submitted_at.toISOString(),
    decidedAt: row.decided_at?.toISOString() ?? null,
    chainId: row.chain_id,
    walletAddress: row.wallet_address,
    mint: row.mint_status
      ? {
          status: row.mint_status,
          transactionHash: row.mint_transaction_hash,
          confirmedAt: row.mint_confirmed_at?.toISOString() ?? null,
          failureReason: row.mint_failure_reason,
          tokenContractAddress: row.token_contract_address,
        }
      : null,
  }));
}
