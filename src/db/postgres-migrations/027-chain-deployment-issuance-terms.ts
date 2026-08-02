import type { PostgresMigration } from "./types.js";

/** A capped factory call must point to the approved economics that supplied its cap. */
export const chainDeploymentIssuanceTermsMigration: PostgresMigration = {
  version: "027-chain-deployment-issuance-terms",
  sql: `
    ALTER TABLE fractal.offering_chain_deployment_requests
      ADD COLUMN IF NOT EXISTS issuance_terms_request_id UUID REFERENCES fractal.offering_issuance_term_requests(id);
    CREATE INDEX IF NOT EXISTS offering_chain_deployment_issuance_terms_idx
      ON fractal.offering_chain_deployment_requests (issuance_terms_request_id);

    CREATE OR REPLACE FUNCTION fractal.protect_offering_chain_deployment_request()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'fractal.offering_chain_deployment_requests are not deletable'; END IF;
      IF OLD.status <> 'submitted' THEN RAISE EXCEPTION 'fractal.offering_chain_deployment_requests may only be decided once'; END IF;
      IF NEW.status NOT IN ('approved', 'rejected')
         OR NEW.id <> OLD.id OR NEW.organization_id <> OLD.organization_id OR NEW.offering_id <> OLD.offering_id
         OR NEW.offering_version_id <> OLD.offering_version_id OR NEW.issuance_terms_request_id IS DISTINCT FROM OLD.issuance_terms_request_id
         OR NEW.chain_id <> OLD.chain_id OR NEW.token_factory_address <> OLD.token_factory_address OR NEW.offering_name <> OLD.offering_name
         OR NEW.token_name <> OLD.token_name OR NEW.token_symbol <> OLD.token_symbol OR NEW.max_balance_per_holder <> OLD.max_balance_per_holder
         OR NEW.retail_cap <> OLD.retail_cap OR NEW.max_total_supply <> OLD.max_total_supply
         OR NEW.submitted_by_identity_id <> OLD.submitted_by_identity_id OR NEW.submitted_at <> OLD.submitted_at THEN
        RAISE EXCEPTION 'fractal.offering_chain_deployment_request facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
