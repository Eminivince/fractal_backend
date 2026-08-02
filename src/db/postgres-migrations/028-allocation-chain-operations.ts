import type { PostgresMigration } from "./types.js";

/** On-chain allocation actions are sequenced: whitelist confirmation unlocks mint. */
export const allocationChainOperationsMigration: PostgresMigration = {
  version: "028-allocation-chain-operations",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.investment_allocation_chain_operations (
      id UUID PRIMARY KEY,
      allocation_request_id UUID NOT NULL REFERENCES fractal.investment_allocation_requests(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      chain_id INTEGER NOT NULL CHECK (chain_id > 0),
      token_contract_address CHAR(42) NOT NULL CHECK (token_contract_address ~ '^0x[0-9a-f]{40}$'),
      wallet_address CHAR(42) NOT NULL CHECK (wallet_address ~ '^0x[0-9a-f]{40}$'),
      token_amount NUMERIC(78, 0) NOT NULL CHECK (token_amount > 0),
      operation_type TEXT NOT NULL CHECK (operation_type IN ('whitelist', 'mint')),
      status TEXT NOT NULL CHECK (status IN ('waiting', 'approved', 'submitted', 'confirmed', 'failed', 'cancelled', 'uncertain')),
      transaction_hash CHAR(66) CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
      submitted_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (allocation_request_id, operation_type),
      CHECK (
        (status IN ('waiting', 'approved') AND transaction_hash IS NULL AND submitted_at IS NULL AND confirmed_at IS NULL AND failure_reason IS NULL)
        OR (status = 'submitted' AND transaction_hash IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NULL AND failure_reason IS NULL)
        OR (status = 'confirmed' AND transaction_hash IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL AND failure_reason IS NULL)
        OR (status IN ('failed', 'uncertain') AND failure_reason IS NOT NULL)
        OR (status = 'cancelled' AND transaction_hash IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS allocation_chain_operations_status_idx
      ON fractal.investment_allocation_chain_operations (status, created_at, id);

    CREATE TABLE IF NOT EXISTS fractal.investment_allocation_chain_dispatch_claims (
      id UUID PRIMARY KEY,
      operation_id UUID NOT NULL REFERENCES fractal.investment_allocation_chain_operations(id),
      worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 200),
      status TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'confirmed', 'failed', 'uncertain')),
      transaction_hash CHAR(66) CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
      failure_reason TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CHECK ((status = 'claimed' AND transaction_hash IS NULL AND failure_reason IS NULL AND completed_at IS NULL)
        OR (status = 'submitted' AND transaction_hash IS NOT NULL AND failure_reason IS NULL AND completed_at IS NULL)
        OR (status = 'confirmed' AND transaction_hash IS NOT NULL AND failure_reason IS NULL AND completed_at IS NOT NULL)
        OR (status IN ('failed', 'uncertain') AND failure_reason IS NOT NULL AND completed_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS allocation_chain_operations_active_claim_idx
      ON fractal.investment_allocation_chain_dispatch_claims (operation_id)
      WHERE status IN ('claimed', 'submitted', 'uncertain');

    CREATE OR REPLACE FUNCTION fractal.protect_investment_allocation_chain_operation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.investment_allocation_chain_operations are not deletable'; END IF;
      IF NEW.id <> OLD.id OR NEW.allocation_request_id <> OLD.allocation_request_id OR NEW.organization_id <> OLD.organization_id
         OR NEW.offering_id <> OLD.offering_id OR NEW.chain_id <> OLD.chain_id OR NEW.token_contract_address <> OLD.token_contract_address
         OR NEW.wallet_address <> OLD.wallet_address OR NEW.token_amount <> OLD.token_amount OR NEW.operation_type <> OLD.operation_type OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'fractal.investment_allocation_chain_operation facts are immutable';
      END IF;
      IF NOT ((OLD.status = 'waiting' AND NEW.status IN ('approved', 'cancelled')) OR (OLD.status = 'approved' AND NEW.status IN ('submitted', 'cancelled')) OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed')) ) THEN
        RAISE EXCEPTION 'invalid investment allocation chain operation transition';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER investment_allocation_chain_operation_guard BEFORE UPDATE OR DELETE ON fractal.investment_allocation_chain_operations FOR EACH ROW EXECUTE FUNCTION fractal.protect_investment_allocation_chain_operation();

    CREATE OR REPLACE FUNCTION fractal.protect_investment_allocation_chain_dispatch_claim()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.investment_allocation_chain_dispatch_claims are not deletable'; END IF;
      IF NEW.id <> OLD.id OR NEW.operation_id <> OLD.operation_id OR NEW.worker_id <> OLD.worker_id OR NEW.claimed_at <> OLD.claimed_at THEN RAISE EXCEPTION 'fractal.investment_allocation_chain_dispatch_claim facts are immutable'; END IF;
      IF NOT ((OLD.status = 'claimed' AND NEW.status IN ('submitted', 'failed', 'uncertain')) OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'uncertain'))) THEN RAISE EXCEPTION 'invalid investment allocation chain dispatch claim transition'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER investment_allocation_chain_dispatch_claim_guard BEFORE UPDATE OR DELETE ON fractal.investment_allocation_chain_dispatch_claims FOR EACH ROW EXECUTE FUNCTION fractal.protect_investment_allocation_chain_dispatch_claim();
  `,
};
