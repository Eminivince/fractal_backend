import type { PostgresMigration } from "./types.js";

/** Immutable economic terms used to derive, never manually type, token allocations. */
export const offeringIssuanceTermsMigration: PostgresMigration = {
  version: "025-offering-issuance-terms",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.offering_issuance_term_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      offering_version_id UUID NOT NULL REFERENCES fractal.offering_publication_versions(id),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      token_unit_price_minor BIGINT NOT NULL CHECK (token_unit_price_minor > 0),
      max_total_supply NUMERIC(78, 0) NOT NULL CHECK (max_total_supply > 0),
      allocation_policy_hash CHAR(64) NOT NULL CHECK (allocation_policy_hash ~ '^[a-f0-9]{64}$'),
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
    CREATE UNIQUE INDEX IF NOT EXISTS offering_issuance_terms_one_active_idx
      ON fractal.offering_issuance_term_requests (offering_id)
      WHERE status IN ('submitted', 'approved');
    CREATE INDEX IF NOT EXISTS offering_issuance_terms_org_idx
      ON fractal.offering_issuance_term_requests (organization_id, submitted_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_offering_issuance_term_request()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'fractal.offering_issuance_term_requests are not deletable';
      END IF;
      IF OLD.status <> 'submitted' THEN
        RAISE EXCEPTION 'fractal.offering_issuance_term_requests may only be decided once';
      END IF;
      IF NEW.status NOT IN ('approved', 'rejected')
         OR NEW.id <> OLD.id
         OR NEW.organization_id <> OLD.organization_id
         OR NEW.offering_id <> OLD.offering_id
         OR NEW.offering_version_id <> OLD.offering_version_id
         OR NEW.currency <> OLD.currency
         OR NEW.token_unit_price_minor <> OLD.token_unit_price_minor
         OR NEW.max_total_supply <> OLD.max_total_supply
         OR NEW.allocation_policy_hash <> OLD.allocation_policy_hash
         OR NEW.submitted_by_identity_id <> OLD.submitted_by_identity_id
         OR NEW.submitted_at <> OLD.submitted_at THEN
        RAISE EXCEPTION 'fractal.offering_issuance_term_request facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER offering_issuance_term_request_guard
      BEFORE UPDATE OR DELETE ON fractal.offering_issuance_term_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_issuance_term_request();
  `,
};
