import type { PostgresMigration } from "./types.js";

/** Finance execution is fail-closed: no correction or replacement authorization is valid without a separately approved limit policy. */
export const professionalFinanceApprovalPoliciesMigration: PostgresMigration = {
  version: "048-professional-finance-approval-policies",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_finance_approval_policies (
      id UUID PRIMARY KEY,
      issuer_organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      version INTEGER NOT NULL CHECK (version > 0),
      resolution_type TEXT NOT NULL CHECK (resolution_type IN ('credit_note', 'replacement_payout', 'manual_settlement', 'recipient_deactivation_review')),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      maximum_amount_minor BIGINT NOT NULL CHECK (maximum_amount_minor > 0),
      effective_from TIMESTAMPTZ NOT NULL,
      effective_until TIMESTAMPTZ,
      policy_reference TEXT NOT NULL CHECK (length(policy_reference) BETWEEN 4 AND 1000),
      status TEXT NOT NULL CHECK (status IN ('draft', 'active', 'superseded')),
      prepared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      approved_by_identity_id UUID REFERENCES fractal.identities(id),
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (issuer_organization_id, version),
      CHECK (effective_until IS NULL OR effective_until > effective_from),
      CHECK ((status = 'draft' AND approved_by_identity_id IS NULL AND approved_at IS NULL)
        OR (status IN ('active', 'superseded') AND approved_by_identity_id IS NOT NULL AND approved_at IS NOT NULL)),
      CHECK (approved_by_identity_id IS NULL OR approved_by_identity_id <> prepared_by_identity_id)
    );
    CREATE INDEX IF NOT EXISTS professional_finance_approval_policies_active_idx
      ON fractal.professional_finance_approval_policies (issuer_organization_id, resolution_type, currency, effective_from DESC, id)
      WHERE status = 'active';

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_finance_approval_policy_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.issuer_organization_id IS DISTINCT FROM OLD.issuer_organization_id
        OR NEW.version IS DISTINCT FROM OLD.version OR NEW.resolution_type IS DISTINCT FROM OLD.resolution_type
        OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.maximum_amount_minor IS DISTINCT FROM OLD.maximum_amount_minor
        OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until
        OR NEW.policy_reference IS DISTINCT FROM OLD.policy_reference
        OR NEW.prepared_by_identity_id IS DISTINCT FROM OLD.prepared_by_identity_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional finance approval-policy facts are immutable';
      END IF;
      IF OLD.status = 'draft' AND NEW.status = 'active' AND NEW.approved_by_identity_id IS NOT NULL
        AND NEW.approved_by_identity_id <> OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status = 'active' AND NEW.status = 'superseded' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional finance approval-policy transition';
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_finance_approval_policies_transition ON fractal.professional_finance_approval_policies;
    CREATE TRIGGER professional_finance_approval_policies_transition BEFORE UPDATE OR DELETE ON fractal.professional_finance_approval_policies
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_finance_approval_policy_transition();
  `,
};
