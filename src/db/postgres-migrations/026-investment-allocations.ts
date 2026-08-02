import type { PostgresMigration } from "./types.js";

/** Payment-backed, wallet-bound allocation requests; token quantity is derived from immutable economics. */
export const investmentAllocationsMigration: PostgresMigration = {
  version: "026-investment-allocations",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.investment_allocation_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      issuance_terms_request_id UUID NOT NULL REFERENCES fractal.offering_issuance_term_requests(id),
      reservation_id UUID NOT NULL REFERENCES fractal.investment_reservations(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      wallet_id UUID NOT NULL REFERENCES fractal.investor_wallets(id),
      chain_id INTEGER NOT NULL CHECK (chain_id > 0),
      wallet_address CHAR(42) NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
      invested_minor BIGINT NOT NULL CHECK (invested_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      token_unit_price_minor BIGINT NOT NULL CHECK (token_unit_price_minor > 0),
      token_amount NUMERIC(78, 0) NOT NULL CHECK (token_amount > 0),
      allocation_policy_hash CHAR(64) NOT NULL CHECK (allocation_policy_hash ~ '^[a-f0-9]{64}$'),
      compliance_snapshot JSONB NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('submitted', 'approved', 'rejected')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL,
      decided_by_identity_id UUID REFERENCES fractal.identities(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      CHECK (
        (status = 'submitted' AND decided_by_identity_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
        OR (status = 'approved' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL)
        OR (status = 'rejected' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS investment_allocations_one_active_reservation_idx
      ON fractal.investment_allocation_requests (reservation_id)
      WHERE status IN ('submitted', 'approved');
    CREATE INDEX IF NOT EXISTS investment_allocations_offering_terms_idx
      ON fractal.investment_allocation_requests (offering_id, issuance_terms_request_id, status, id);
    CREATE INDEX IF NOT EXISTS investment_allocations_investor_idx
      ON fractal.investment_allocation_requests (investor_identity_id, submitted_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_investment_allocation_request()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.investment_allocation_requests are not deletable'; END IF;
      IF OLD.status <> 'submitted' THEN RAISE EXCEPTION 'fractal.investment_allocation_requests may only be decided once'; END IF;
      IF NEW.status NOT IN ('approved', 'rejected')
         OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.offering_id <> OLD.offering_id
         OR NEW.issuance_terms_request_id <> OLD.issuance_terms_request_id OR NEW.reservation_id <> OLD.reservation_id
         OR NEW.investor_identity_id <> OLD.investor_identity_id OR NEW.wallet_id <> OLD.wallet_id OR NEW.chain_id <> OLD.chain_id
         OR NEW.wallet_address <> OLD.wallet_address OR NEW.invested_minor <> OLD.invested_minor OR NEW.currency <> OLD.currency
         OR NEW.token_unit_price_minor <> OLD.token_unit_price_minor OR NEW.token_amount <> OLD.token_amount
         OR NEW.allocation_policy_hash <> OLD.allocation_policy_hash OR NEW.compliance_snapshot <> OLD.compliance_snapshot
         OR NEW.submitted_by_identity_id <> OLD.submitted_by_identity_id OR NEW.submitted_at <> OLD.submitted_at THEN
        RAISE EXCEPTION 'fractal.investment_allocation_request facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER investment_allocation_request_guard
      BEFORE UPDATE OR DELETE ON fractal.investment_allocation_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_investment_allocation_request();
  `,
};
