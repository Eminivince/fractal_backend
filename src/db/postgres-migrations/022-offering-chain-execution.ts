import type { PostgresMigration } from "./types.js";

/**
 * Dispatch claims make a process crash an explicit reconciliation problem,
 * never a reason to send the same factory transaction again.
 */
export const offeringChainExecutionMigration: PostgresMigration = {
  version: "022-offering-chain-execution",
  sql: `
    ALTER TABLE fractal.offering_chain_deployment_requests
      ADD COLUMN IF NOT EXISTS offering_name TEXT NOT NULL DEFAULT 'legacy-unavailable';
    ALTER TABLE fractal.offering_chain_deployment_requests
      DROP CONSTRAINT IF EXISTS offering_chain_deployment_requests_offering_name_check;
    ALTER TABLE fractal.offering_chain_deployment_requests
      ADD CONSTRAINT offering_chain_deployment_requests_offering_name_check
      CHECK (length(offering_name) BETWEEN 2 AND 200);

    CREATE OR REPLACE FUNCTION fractal.protect_offering_chain_deployment_request()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fractal.offering_chain_deployment_requests are not deletable';
      END IF;
      IF OLD.status <> 'submitted' THEN
        RAISE EXCEPTION 'fractal.offering_chain_deployment_requests may only be decided once';
      END IF;
      IF NEW.status NOT IN ('approved', 'rejected')
         OR NEW.id <> OLD.id
         OR NEW.organization_id <> OLD.organization_id
         OR NEW.offering_id <> OLD.offering_id
         OR NEW.offering_version_id <> OLD.offering_version_id
         OR NEW.chain_id <> OLD.chain_id
         OR NEW.token_factory_address <> OLD.token_factory_address
         OR NEW.offering_name <> OLD.offering_name
         OR NEW.token_name <> OLD.token_name
         OR NEW.token_symbol <> OLD.token_symbol
         OR NEW.max_balance_per_holder <> OLD.max_balance_per_holder
         OR NEW.retail_cap <> OLD.retail_cap
         OR NEW.submitted_by_identity_id <> OLD.submitted_by_identity_id
         OR NEW.submitted_at <> OLD.submitted_at THEN
        RAISE EXCEPTION 'fractal.offering_chain_deployment_request facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TABLE IF NOT EXISTS fractal.offering_chain_operation_dispatch_claims (
      id UUID PRIMARY KEY,
      operation_id UUID NOT NULL REFERENCES fractal.offering_chain_operations(id),
      worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 1 AND 200),
      status TEXT NOT NULL CHECK (status IN ('claimed', 'submitted', 'confirmed', 'failed', 'uncertain')),
      transaction_hash CHAR(66) CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
      failure_reason TEXT,
      claimed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ,
      CHECK (
        (status = 'claimed' AND transaction_hash IS NULL AND failure_reason IS NULL AND completed_at IS NULL)
        OR (status = 'submitted' AND transaction_hash IS NOT NULL AND failure_reason IS NULL AND completed_at IS NULL)
        OR (status = 'confirmed' AND transaction_hash IS NOT NULL AND failure_reason IS NULL AND completed_at IS NOT NULL)
        OR (status IN ('failed', 'uncertain') AND failure_reason IS NOT NULL AND completed_at IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS offering_chain_operation_active_claim_idx
      ON fractal.offering_chain_operation_dispatch_claims (operation_id)
      WHERE status IN ('claimed', 'submitted', 'uncertain');
    CREATE INDEX IF NOT EXISTS offering_chain_operation_claim_lookup_idx
      ON fractal.offering_chain_operation_dispatch_claims (operation_id, claimed_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_offering_chain_operation_dispatch_claim()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fractal.offering_chain_operation_dispatch_claims are not deletable';
      END IF;
      IF NEW.id <> OLD.id OR NEW.operation_id <> OLD.operation_id OR NEW.worker_id <> OLD.worker_id OR NEW.claimed_at <> OLD.claimed_at THEN
        RAISE EXCEPTION 'fractal.offering_chain_operation_dispatch_claim facts are immutable';
      END IF;
      IF NOT (
        (OLD.status = 'claimed' AND NEW.status IN ('submitted', 'failed', 'uncertain'))
        OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed', 'uncertain'))
      ) THEN
        RAISE EXCEPTION 'invalid offering chain operation dispatch claim transition';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_chain_operation_dispatch_claim_guard ON fractal.offering_chain_operation_dispatch_claims;
    CREATE TRIGGER offering_chain_operation_dispatch_claim_guard
      BEFORE UPDATE OR DELETE ON fractal.offering_chain_operation_dispatch_claims
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_chain_operation_dispatch_claim();
  `,
};
