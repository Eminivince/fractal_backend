import type { PostgresMigration } from "./types.js";

/**
 * Adds a two-party ownership handover. The target must already be an active
 * organization member, must explicitly accept, and the role swap is checked
 * against the membership rows before the transfer can become terminal.
 */
export const organizationOwnershipTransfersMigration: PostgresMigration = {
  version: "062-organization-ownership-transfers",
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_id_organization_unique_idx
      ON fractal.organization_memberships (id, organization_id);

    CREATE TABLE IF NOT EXISTS fractal.organization_ownership_transfer_requests (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      source_membership_id UUID NOT NULL,
      target_membership_id UUID NOT NULL,
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'cancelled', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      accepted_by_identity_id UUID REFERENCES fractal.identities(id),
      decided_at TIMESTAMPTZ,
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 5 AND 2000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT organization_ownership_transfer_source_fk
        FOREIGN KEY (source_membership_id, organization_id)
        REFERENCES fractal.organization_memberships (id, organization_id),
      CONSTRAINT organization_ownership_transfer_target_fk
        FOREIGN KEY (target_membership_id, organization_id)
        REFERENCES fractal.organization_memberships (id, organization_id),
      CONSTRAINT organization_ownership_transfer_distinct_memberships
        CHECK (source_membership_id <> target_membership_id),
      CONSTRAINT organization_ownership_transfer_expiry
        CHECK (expires_at > created_at),
      CONSTRAINT organization_ownership_transfer_terminal_shape CHECK (
        (status = 'pending' AND accepted_by_identity_id IS NULL AND decided_at IS NULL AND decision_reason IS NULL)
        OR (status = 'accepted' AND accepted_by_identity_id IS NOT NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
        OR (status IN ('rejected', 'cancelled', 'expired') AND accepted_by_identity_id IS NULL AND decided_at IS NOT NULL AND decision_reason IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS organization_ownership_transfer_pending_unique_idx
      ON fractal.organization_ownership_transfer_requests (organization_id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS organization_ownership_transfer_target_pending_idx
      ON fractal.organization_ownership_transfer_requests (target_membership_id, expires_at, id)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS organization_ownership_transfer_history_idx
      ON fractal.organization_ownership_transfer_requests (organization_id, created_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.validate_organization_ownership_transfer()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      source_row fractal.organization_memberships%ROWTYPE;
      target_row fractal.organization_memberships%ROWTYPE;
    BEGIN
      SELECT * INTO source_row FROM fractal.organization_memberships WHERE id = NEW.source_membership_id;
      SELECT * INTO target_row FROM fractal.organization_memberships WHERE id = NEW.target_membership_id;
      IF source_row.organization_id IS DISTINCT FROM NEW.organization_id
         OR target_row.organization_id IS DISTINCT FROM NEW.organization_id THEN
        RAISE EXCEPTION 'ownership transfer memberships must belong to the organization';
      END IF;
      IF NEW.status = 'pending' THEN
        IF source_row.role <> 'owner' OR source_row.status <> 'active'
           OR target_row.role = 'owner' OR target_row.status <> 'active' THEN
          RAISE EXCEPTION 'ownership transfer requires an active owner and active non-owner target';
        END IF;
        IF source_row.identity_id <> NEW.requested_by_identity_id THEN
          RAISE EXCEPTION 'ownership transfer requester must be the source owner';
        END IF;
      ELSIF NEW.status = 'accepted' THEN
        IF target_row.identity_id <> NEW.accepted_by_identity_id
           OR target_row.role <> 'owner' OR target_row.status <> 'active'
           OR source_row.role <> 'administrator' OR source_row.status <> 'active' THEN
          RAISE EXCEPTION 'accepted ownership transfer must match the atomic membership role swap';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS organization_ownership_transfer_validation ON fractal.organization_ownership_transfer_requests;
    CREATE TRIGGER organization_ownership_transfer_validation
      BEFORE INSERT OR UPDATE ON fractal.organization_ownership_transfer_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_organization_ownership_transfer();

    CREATE OR REPLACE FUNCTION fractal.reject_terminal_organization_ownership_transfer_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'terminal organization ownership transfer is immutable';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS organization_ownership_transfer_terminal_immutable ON fractal.organization_ownership_transfer_requests;
    CREATE TRIGGER organization_ownership_transfer_terminal_immutable
      BEFORE UPDATE OR DELETE ON fractal.organization_ownership_transfer_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_terminal_organization_ownership_transfer_mutation();
  `,
};
