import type { PostgresMigration } from "./types.js";

/**
 * A holder cap is not an issuance cap. New governed deployments must carry the
 * immutable maximum outstanding token units accepted by the product approver.
 * Existing pre-cap requests retain zero and are deliberately non-dispatchable.
 */
export const offeringIssuanceCapMigration: PostgresMigration = {
  version: "024-offering-issuance-cap",
  sql: `
    ALTER TABLE fractal.offering_chain_deployment_requests
      ADD COLUMN IF NOT EXISTS max_total_supply NUMERIC(78, 0) NOT NULL DEFAULT 0
      CHECK (max_total_supply >= 0);

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
         OR NEW.max_total_supply <> OLD.max_total_supply
         OR NEW.submitted_by_identity_id <> OLD.submitted_by_identity_id
         OR NEW.submitted_at <> OLD.submitted_at THEN
        RAISE EXCEPTION 'fractal.offering_chain_deployment_request facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
