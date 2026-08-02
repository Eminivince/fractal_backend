import type { PostgresMigration } from "./types.js";

/** Establishes the firm-bound, version-aware mandate boundary for professional diligence work. */
export const professionalWorkOrderFoundationMigration: PostgresMigration = {
  version: "035-professional-work-order-foundation",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_firm_profiles (
      organization_id UUID PRIMARY KEY REFERENCES fractal.organizations(id),
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
      credential_status TEXT NOT NULL CHECK (credential_status IN ('pending', 'verified', 'expired', 'rejected')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS fractal.professional_firm_memberships (
      id UUID PRIMARY KEY,
      firm_organization_id UUID NOT NULL REFERENCES fractal.professional_firm_profiles(organization_id),
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      role TEXT NOT NULL CHECK (role IN ('firm_administrator', 'engagement_lead', 'delivery_member')),
      status TEXT NOT NULL CHECK (status IN ('active', 'suspended', 'revoked')),
      granted_by_identity_id UUID REFERENCES fractal.identities(id),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
      UNIQUE (firm_organization_id, identity_id)
    );
    CREATE INDEX IF NOT EXISTS professional_firm_memberships_identity_active_idx
      ON fractal.professional_firm_memberships (identity_id, firm_organization_id)
      WHERE status = 'active';

    CREATE TABLE IF NOT EXISTS fractal.professional_work_orders (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (length(reference) BETWEEN 1 AND 200),
      issuer_organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      professional_firm_organization_id UUID NOT NULL REFERENCES fractal.professional_firm_profiles(organization_id),
      asset_application_request_id UUID NOT NULL REFERENCES fractal.asset_application_requests(id),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 240),
      scope TEXT NOT NULL CHECK (length(scope) BETWEEN 20 AND 5000),
      exclusions TEXT NOT NULL CHECK (length(exclusions) BETWEEN 2 AND 5000),
      confidentiality TEXT NOT NULL CHECK (confidentiality IN ('restricted', 'confidential')),
      response_due_at TIMESTAMPTZ NOT NULL,
      delivery_due_at TIMESTAMPTZ NOT NULL,
      fee_minor BIGINT NOT NULL CHECK (fee_minor >= 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      status TEXT NOT NULL CHECK (status IN ('invited', 'clarification_requested', 'accepted', 'declined', 'conflict_flagged', 'in_progress', 'cancelled')),
      invited_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      decided_by_identity_id UUID REFERENCES fractal.identities(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (issuer_organization_id <> professional_firm_organization_id),
      CHECK (response_due_at < delivery_due_at),
      CHECK ((status IN ('invited', 'clarification_requested') AND decided_by_identity_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
        OR (status IN ('accepted', 'declined', 'conflict_flagged', 'cancelled') AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL)
        OR (status = 'in_progress' AND decided_by_identity_id IS NOT NULL AND decided_at IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS professional_work_orders_issuer_idx ON fractal.professional_work_orders (issuer_organization_id, status, invited_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS professional_work_orders_firm_idx ON fractal.professional_work_orders (professional_firm_organization_id, status, delivery_due_at, id);
    CREATE INDEX IF NOT EXISTS professional_work_orders_application_idx ON fractal.professional_work_orders (asset_application_request_id, status, id);

    CREATE TABLE IF NOT EXISTS fractal.professional_work_order_assignments (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES fractal.professional_work_orders(id),
      firm_membership_id UUID NOT NULL REFERENCES fractal.professional_firm_memberships(id),
      assigned_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      UNIQUE (work_order_id, firm_membership_id)
    );
    CREATE INDEX IF NOT EXISTS professional_work_order_assignments_active_idx
      ON fractal.professional_work_order_assignments (firm_membership_id, work_order_id)
      WHERE revoked_at IS NULL;

    CREATE TABLE IF NOT EXISTS fractal.professional_work_order_conflicts (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL UNIQUE REFERENCES fractal.professional_work_orders(id),
      declared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      declaration TEXT NOT NULL CHECK (declaration IN ('no_conflict', 'conflict')),
      notes TEXT CHECK (notes IS NULL OR length(notes) BETWEEN 2 AND 2000),
      declared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((declaration = 'no_conflict' AND notes IS NULL) OR (declaration = 'conflict' AND notes IS NOT NULL))
    );

    CREATE TABLE IF NOT EXISTS fractal.professional_work_order_events (
      id UUID PRIMARY KEY,
      work_order_id UUID NOT NULL REFERENCES fractal.professional_work_orders(id),
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      event_type TEXT NOT NULL CHECK (length(event_type) BETWEEN 2 AND 120),
      reason TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS professional_work_order_events_order_idx ON fractal.professional_work_order_events (work_order_id, created_at, id);

    CREATE OR REPLACE FUNCTION fractal.validate_professional_work_order_context()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE application fractal.asset_application_requests%ROWTYPE;
    DECLARE firm fractal.professional_firm_profiles%ROWTYPE;
    BEGIN
      SELECT * INTO application FROM fractal.asset_application_requests WHERE id = NEW.asset_application_request_id;
      SELECT * INTO firm FROM fractal.professional_firm_profiles WHERE organization_id = NEW.professional_firm_organization_id;
      IF NOT FOUND OR firm.status <> 'active' OR firm.credential_status <> 'verified' THEN
        RAISE EXCEPTION 'professional firm must be active with verified credentials';
      END IF;
      IF application.id IS NULL OR application.organization_id <> NEW.issuer_organization_id OR application.status <> 'submitted' THEN
        RAISE EXCEPTION 'professional work order must target a submitted application in the issuer organization';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_work_orders_context_guard ON fractal.professional_work_orders;
    CREATE TRIGGER professional_work_orders_context_guard
      BEFORE INSERT ON fractal.professional_work_orders
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_work_order_context();

    CREATE OR REPLACE FUNCTION fractal.validate_professional_work_order_assignment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE work_order fractal.professional_work_orders%ROWTYPE;
    DECLARE membership fractal.professional_firm_memberships%ROWTYPE;
    BEGIN
      SELECT * INTO work_order FROM fractal.professional_work_orders WHERE id = NEW.work_order_id;
      SELECT * INTO membership FROM fractal.professional_firm_memberships WHERE id = NEW.firm_membership_id;
      IF NOT FOUND OR membership.firm_organization_id <> work_order.professional_firm_organization_id OR membership.status <> 'active' THEN
        RAISE EXCEPTION 'work order assignment requires an active member of the assigned professional firm';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_work_order_assignments_guard ON fractal.professional_work_order_assignments;
    CREATE TRIGGER professional_work_order_assignments_guard
      BEFORE INSERT ON fractal.professional_work_order_assignments
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_professional_work_order_assignment();

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_work_order_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.reference IS DISTINCT FROM OLD.reference
        OR NEW.issuer_organization_id IS DISTINCT FROM OLD.issuer_organization_id OR NEW.professional_firm_organization_id IS DISTINCT FROM OLD.professional_firm_organization_id
        OR NEW.asset_application_request_id IS DISTINCT FROM OLD.asset_application_request_id OR NEW.title IS DISTINCT FROM OLD.title
        OR NEW.scope IS DISTINCT FROM OLD.scope OR NEW.exclusions IS DISTINCT FROM OLD.exclusions OR NEW.confidentiality IS DISTINCT FROM OLD.confidentiality
        OR NEW.response_due_at IS DISTINCT FROM OLD.response_due_at OR NEW.delivery_due_at IS DISTINCT FROM OLD.delivery_due_at
        OR NEW.fee_minor IS DISTINCT FROM OLD.fee_minor OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.invited_by_identity_id IS DISTINCT FROM OLD.invited_by_identity_id OR NEW.invited_at IS DISTINCT FROM OLD.invited_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional work order facts are immutable';
      END IF;
      IF (OLD.status = 'invited' AND NEW.status IN ('clarification_requested', 'accepted', 'declined', 'conflict_flagged', 'cancelled'))
        OR (OLD.status = 'clarification_requested' AND NEW.status IN ('invited', 'accepted', 'declined', 'conflict_flagged', 'cancelled'))
        OR (OLD.status = 'accepted' AND NEW.status IN ('in_progress', 'cancelled'))
        OR (OLD.status = 'in_progress' AND NEW.status = 'cancelled') THEN
        IF NEW.status = 'accepted' AND NOT EXISTS (SELECT 1 FROM fractal.professional_work_order_conflicts WHERE work_order_id = NEW.id AND declaration = 'no_conflict') THEN
          RAISE EXCEPTION 'professional work order acceptance requires a no-conflict declaration';
        END IF;
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid professional work order transition';
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_work_orders_transition ON fractal.professional_work_orders;
    CREATE TRIGGER professional_work_orders_transition
      BEFORE UPDATE OR DELETE ON fractal.professional_work_orders
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_work_order_transition();

    CREATE OR REPLACE FUNCTION fractal.protect_professional_work_order_record()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'professional work order record is immutable'; END;
    $$;
    DROP TRIGGER IF EXISTS professional_work_order_conflicts_immutable ON fractal.professional_work_order_conflicts;
    CREATE TRIGGER professional_work_order_conflicts_immutable BEFORE UPDATE OR DELETE ON fractal.professional_work_order_conflicts FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_work_order_record();
    DROP TRIGGER IF EXISTS professional_work_order_events_immutable ON fractal.professional_work_order_events;
    CREATE TRIGGER professional_work_order_events_immutable BEFORE UPDATE OR DELETE ON fractal.professional_work_order_events FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_work_order_record();
  `,
};
