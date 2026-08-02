import type { PostgresMigration } from "./types.js";

/**
 * A governed bridge from an approved Postgres offering to a chain deployment.
 *
 * The request captures the exact immutable factory call input. A future worker
 * may submit the operation, but cannot manufacture a deployment from a Mongo
 * offering or change the approved call parameters.
 */
export const offeringChainDeploymentsMigration: PostgresMigration = {
  version: "021-offering-chain-deployments",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.offering_chain_deployment_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      offering_version_id UUID NOT NULL REFERENCES fractal.offering_publication_versions(id),
      chain_id INTEGER NOT NULL CHECK (chain_id > 0),
      token_factory_address CHAR(42) NOT NULL CHECK (token_factory_address ~ '^0x[0-9a-f]{40}$'),
      token_name TEXT NOT NULL CHECK (length(token_name) BETWEEN 2 AND 120),
      token_symbol TEXT NOT NULL CHECK (token_symbol ~ '^[A-Z0-9-]{2,12}$'),
      max_balance_per_holder NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (max_balance_per_holder >= 0),
      retail_cap NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (retail_cap >= 0),
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
    CREATE UNIQUE INDEX IF NOT EXISTS offering_chain_deployment_one_active_request_idx
      ON fractal.offering_chain_deployment_requests (offering_id)
      WHERE status IN ('submitted', 'approved');
    CREATE INDEX IF NOT EXISTS offering_chain_deployment_requests_org_idx
      ON fractal.offering_chain_deployment_requests (organization_id, submitted_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS fractal.offering_chain_operations (
      id UUID PRIMARY KEY,
      request_id UUID NOT NULL UNIQUE REFERENCES fractal.offering_chain_deployment_requests(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      chain_id INTEGER NOT NULL CHECK (chain_id > 0),
      token_factory_address CHAR(42) NOT NULL CHECK (token_factory_address ~ '^0x[0-9a-f]{40}$'),
      operation_type TEXT NOT NULL CHECK (operation_type = 'deploy_token'),
      status TEXT NOT NULL CHECK (status IN ('approved', 'submitted', 'confirmed', 'failed', 'cancelled')),
      transaction_hash CHAR(66) CHECK (transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'),
      token_contract_address CHAR(42) CHECK (token_contract_address IS NULL OR token_contract_address ~ '^0x[0-9a-f]{40}$'),
      block_number BIGINT CHECK (block_number IS NULL OR block_number >= 0),
      submitted_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      failure_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (
        (status = 'approved' AND transaction_hash IS NULL AND submitted_at IS NULL AND confirmed_at IS NULL AND failure_reason IS NULL)
        OR (status = 'submitted' AND transaction_hash IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NULL AND failure_reason IS NULL)
        OR (status = 'confirmed' AND transaction_hash IS NOT NULL AND token_contract_address IS NOT NULL AND block_number IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL AND failure_reason IS NULL)
        OR (status = 'failed' AND failure_reason IS NOT NULL)
        OR (status = 'cancelled' AND transaction_hash IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS offering_chain_operations_status_idx
      ON fractal.offering_chain_operations (status, created_at, id);

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
    DROP TRIGGER IF EXISTS offering_chain_deployment_request_guard ON fractal.offering_chain_deployment_requests;
    CREATE TRIGGER offering_chain_deployment_request_guard
      BEFORE UPDATE OR DELETE ON fractal.offering_chain_deployment_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_chain_deployment_request();

    CREATE OR REPLACE FUNCTION fractal.protect_offering_chain_operation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fractal.offering_chain_operations are not deletable';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.request_id <> OLD.request_id
         OR NEW.organization_id <> OLD.organization_id
         OR NEW.offering_id <> OLD.offering_id
         OR NEW.chain_id <> OLD.chain_id
         OR NEW.token_factory_address <> OLD.token_factory_address
         OR NEW.operation_type <> OLD.operation_type
         OR NEW.created_at <> OLD.created_at THEN
        RAISE EXCEPTION 'fractal.offering_chain_operation facts are immutable';
      END IF;
      IF NOT (
        (OLD.status = 'approved' AND NEW.status IN ('submitted', 'cancelled'))
        OR (OLD.status = 'submitted' AND NEW.status IN ('confirmed', 'failed'))
      ) THEN
        RAISE EXCEPTION 'invalid offering chain operation transition';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_chain_operation_guard ON fractal.offering_chain_operations;
    CREATE TRIGGER offering_chain_operation_guard
      BEFORE UPDATE OR DELETE ON fractal.offering_chain_operations
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_chain_operation();
  `,
};
