import type { PostgresMigration } from "./types.js";

/**
 * Actor-neutral privacy-rights intake and independently reviewed outcome
 * authority. This migration intentionally does not execute erasure or present
 * a partial export as complete: fulfillment remains blocked until every
 * affected data authority and approved retention rule is bound explicitly.
 */
export const privacyRightsAuthorityMigration: PostgresMigration = {
  version: "079-privacy-rights-authority",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('privacy_request_manage', 'Privacy rights management', 'Inspect authenticated privacy-rights requests and propose or independently decide structured outcomes without bypassing legal holds or retention controls.')
    ON CONFLICT (capability_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.privacy_rights_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^PRV-[0-9]{8}-[A-Z0-9]{8}$'),
      requester_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      requester_role TEXT NOT NULL CHECK (requester_role IN ('investor','issuer','professional','operator','admin')),
      request_type TEXT NOT NULL CHECK (request_type IN ('access','portability','correction','erasure','restriction','objection')),
      details TEXT NOT NULL CHECK (length(details) BETWEEN 20 AND 5000),
      identity_assurance TEXT NOT NULL CHECK (identity_assurance='authenticated_verified_email_session'),
      email_verified_at_snapshot TIMESTAMPTZ NOT NULL,
      policy_version_id UUID REFERENCES fractal.platform_configuration_versions(id),
      due_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','in_review','awaiting_requester','decision_pending','approved','partially_approved','refused','withdrawn')),
      assigned_to_identity_id UUID REFERENCES fractal.identities(id),
      current_decision_request_id UUID,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT privacy_rights_policy_deadline_shape CHECK (
        (policy_version_id IS NULL AND due_at IS NULL)
        OR (policy_version_id IS NOT NULL AND due_at IS NOT NULL AND due_at >= created_at)
      ),
      CONSTRAINT privacy_rights_assignment_shape CHECK (
        (status IN ('submitted','withdrawn') AND assigned_to_identity_id IS NULL)
        OR (status NOT IN ('submitted','withdrawn') AND assigned_to_identity_id IS NOT NULL)
      ),
      UNIQUE (requester_identity_id,command_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS privacy_rights_active_type_idx
      ON fractal.privacy_rights_requests (requester_identity_id,request_type)
      WHERE status NOT IN ('refused','withdrawn');
    CREATE INDEX IF NOT EXISTS privacy_rights_requester_idx
      ON fractal.privacy_rights_requests (requester_identity_id,last_activity_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS privacy_rights_queue_idx
      ON fractal.privacy_rights_requests (status,created_at,id)
      WHERE status NOT IN ('refused','withdrawn');

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_scope_outcomes(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value) <> 'array' OR jsonb_array_length(value) NOT BETWEEN 1 AND 100 THEN RETURN FALSE; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value) item
        WHERE jsonb_typeof(item) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 3
          OR jsonb_typeof(item->'category') <> 'string' OR length(item->>'category') NOT BETWEEN 2 AND 120
          OR btrim(item->>'category') <> item->>'category'
          OR jsonb_typeof(item->'action') <> 'string' OR item->>'action' NOT IN ('provide','correct','erase','restrict','retain','refuse','not_applicable')
          OR jsonb_typeof(item->'explanation') <> 'string' OR length(item->>'explanation') NOT BETWEEN 20 AND 2000
          OR btrim(item->>'explanation') <> item->>'explanation'
      ) AND (
        SELECT count(*)=count(DISTINCT lower(item->>'category')) FROM jsonb_array_elements(value) item
      );
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_outcome_scope(requested_outcome TEXT,value JSONB)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
      SELECT CASE requested_outcome
        WHEN 'approve' THEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(value) item WHERE item->>'action' IN ('retain','refuse')
        )
        WHEN 'refuse' THEN NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(value) item WHERE item->>'action' IN ('provide','correct','erase','restrict')
        )
        WHEN 'partially_approve' THEN
          EXISTS (SELECT 1 FROM jsonb_array_elements(value) item WHERE item->>'action' IN ('provide','correct','erase','restrict'))
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(value) item WHERE item->>'action' IN ('retain','refuse'))
        ELSE FALSE
      END
    $$;

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_fulfillment_coverage(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 6 THEN RETURN FALSE; END IF;
      IF value->>'schemaVersion' <> 'privacy-fulfillment-inventory-v1'
         OR jsonb_typeof(value->'complete') <> 'boolean' OR value->>'complete' <> 'false'
         OR jsonb_typeof(value->'executionAvailable') <> 'boolean' OR value->>'executionAvailable' <> 'false'
         OR jsonb_typeof(value->'coveredAuthorities') <> 'array'
         OR jsonb_typeof(value->'uncoveredAuthorities') <> 'array'
         OR jsonb_typeof(value->'legalHold') <> 'object'
         OR (SELECT count(*) FROM jsonb_object_keys(value->'legalHold')) <> 2
         OR jsonb_typeof(value->'legalHold'->'active') <> 'boolean'
         OR jsonb_typeof(value->'legalHold'->'pendingImposition') <> 'boolean' THEN RETURN FALSE; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value->'coveredAuthorities') item WHERE jsonb_typeof(item) <> 'string'
      ) AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value->'uncoveredAuthorities') item WHERE jsonb_typeof(item) <> 'string'
      );
    END; $$;

    CREATE TABLE IF NOT EXISTS fractal.privacy_rights_decision_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^PRD-[0-9]{8}-[A-Z0-9]{8}$'),
      privacy_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_requests(id),
      outcome TEXT NOT NULL CHECK (outcome IN ('approve','partially_approve','refuse')),
      decision_summary TEXT NOT NULL CHECK (length(decision_summary) BETWEEN 20 AND 5000),
      lawful_basis TEXT NOT NULL CHECK (length(lawful_basis) BETWEEN 20 AND 2000),
      scope_outcomes JSONB NOT NULL CHECK (fractal.valid_privacy_scope_outcomes(scope_outcomes)),
      fulfillment_coverage JSONB NOT NULL CHECK (fractal.valid_privacy_fulfillment_coverage(fulfillment_coverage)),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      review_reason TEXT CHECK (review_reason IS NULL OR length(review_reason) BETWEEN 20 AND 2000),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT privacy_decision_independent_reviewer CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> requested_by_identity_id),
      CONSTRAINT privacy_decision_outcome_scope_match CHECK (fractal.valid_privacy_outcome_scope(outcome,scope_outcomes)),
      CONSTRAINT privacy_decision_status_shape CHECK (
        (status='pending' AND reviewed_by_identity_id IS NULL AND review_reason IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
        OR (status='applied' AND reviewed_by_identity_id IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      UNIQUE (requested_by_identity_id,command_key)
    );
    ALTER TABLE fractal.privacy_rights_requests
      ADD CONSTRAINT privacy_rights_current_decision_fk
      FOREIGN KEY (current_decision_request_id) REFERENCES fractal.privacy_rights_decision_requests(id);
    CREATE UNIQUE INDEX IF NOT EXISTS privacy_decision_pending_request_idx
      ON fractal.privacy_rights_decision_requests (privacy_request_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS privacy_decision_history_idx
      ON fractal.privacy_rights_decision_requests (privacy_request_id,requested_at,id);

    CREATE TABLE IF NOT EXISTS fractal.privacy_rights_request_events (
      id UUID PRIMARY KEY,
      privacy_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_requests(id),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('opened','review_started','information_requested','requester_replied','staff_note','decision_proposed','decision_approved','decision_rejected','withdrawn')),
      from_status TEXT CHECK (from_status IS NULL OR from_status IN ('submitted','in_review','awaiting_requester','decision_pending','approved','partially_approved','refused','withdrawn')),
      to_status TEXT NOT NULL CHECK (to_status IN ('submitted','in_review','awaiting_requester','decision_pending','approved','partially_approved','refused','withdrawn')),
      from_assignee_identity_id UUID REFERENCES fractal.identities(id),
      assignee_identity_id UUID REFERENCES fractal.identities(id),
      decision_request_id UUID REFERENCES fractal.privacy_rights_decision_requests(id),
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      visibility TEXT NOT NULL CHECK (visibility IN ('requester','internal')),
      message TEXT NOT NULL CHECK (length(message) BETWEEN 2 AND 5000),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (privacy_request_id,sequence),
      CONSTRAINT privacy_rights_event_shape CHECK (
        (event_type='opened' AND sequence=1 AND from_status IS NULL AND to_status='submitted'
          AND from_assignee_identity_id IS NULL AND assignee_identity_id IS NULL AND decision_request_id IS NULL AND visibility='requester')
        OR (event_type='review_started' AND sequence>1 AND from_status='submitted' AND to_status='in_review'
          AND from_assignee_identity_id IS NULL AND assignee_identity_id IS NOT NULL AND decision_request_id IS NULL AND visibility='requester')
        OR (event_type='information_requested' AND sequence>1 AND from_status='in_review' AND to_status='awaiting_requester'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND decision_request_id IS NULL AND visibility='requester')
        OR (event_type='requester_replied' AND sequence>1 AND from_status='awaiting_requester' AND to_status='in_review'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND decision_request_id IS NULL AND visibility='requester')
        OR (event_type='staff_note' AND sequence>1 AND from_status=to_status
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND decision_request_id IS NULL AND visibility='internal')
        OR (event_type='decision_proposed' AND sequence>1 AND from_status='in_review' AND to_status='decision_pending'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND decision_request_id IS NOT NULL AND visibility='internal')
        OR (event_type='decision_rejected' AND sequence>1 AND from_status='decision_pending' AND to_status='in_review'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND decision_request_id IS NOT NULL AND visibility='requester')
        OR (event_type='decision_approved' AND sequence>1 AND from_status='decision_pending' AND to_status IN ('approved','partially_approved','refused')
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND decision_request_id IS NOT NULL AND visibility='requester')
        OR (event_type='withdrawn' AND sequence>1 AND from_status IN ('submitted','in_review','awaiting_requester') AND to_status='withdrawn'
          AND assignee_identity_id IS NULL AND decision_request_id IS NULL AND visibility='requester')
      )
    );
    CREATE INDEX IF NOT EXISTS privacy_rights_requester_timeline_idx
      ON fractal.privacy_rights_request_events (privacy_request_id,sequence) WHERE visibility='requester';
    CREATE INDEX IF NOT EXISTS privacy_rights_full_timeline_idx
      ON fractal.privacy_rights_request_events (privacy_request_id,sequence);

    CREATE OR REPLACE FUNCTION fractal.validate_privacy_event_decision_scope()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.decision_request_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM fractal.privacy_rights_decision_requests decision
        WHERE decision.id=NEW.decision_request_id AND decision.privacy_request_id=NEW.privacy_request_id
      ) THEN RAISE EXCEPTION 'privacy decision evidence belongs to a different request'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_rights_event_decision_scope ON fractal.privacy_rights_request_events;
    CREATE TRIGGER privacy_rights_event_decision_scope BEFORE INSERT ON fractal.privacy_rights_request_events
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_privacy_event_decision_scope();

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_privacy_rights_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'privacy rights evidence is immutable';
    END; $$;
    DROP TRIGGER IF EXISTS privacy_rights_events_immutable ON fractal.privacy_rights_request_events;
    CREATE TRIGGER privacy_rights_events_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_rights_request_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_privacy_rights_evidence();

    CREATE OR REPLACE FUNCTION fractal.protect_privacy_decision_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'privacy rights evidence is immutable'; END IF;
      IF OLD.status <> 'pending' THEN RAISE EXCEPTION 'terminal privacy decision evidence is immutable'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.privacy_request_id IS DISTINCT FROM OLD.privacy_request_id OR NEW.outcome IS DISTINCT FROM OLD.outcome
         OR NEW.decision_summary IS DISTINCT FROM OLD.decision_summary OR NEW.lawful_basis IS DISTINCT FROM OLD.lawful_basis
         OR NEW.scope_outcomes IS DISTINCT FROM OLD.scope_outcomes OR NEW.fulfillment_coverage IS DISTINCT FROM OLD.fulfillment_coverage
         OR NEW.command_key IS DISTINCT FROM OLD.command_key OR NEW.requested_by_identity_id IS DISTINCT FROM OLD.requested_by_identity_id
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at THEN
        RAISE EXCEPTION 'submitted privacy decision facts are immutable';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_decision_requests_guard ON fractal.privacy_rights_decision_requests;
    CREATE TRIGGER privacy_decision_requests_guard BEFORE UPDATE OR DELETE ON fractal.privacy_rights_decision_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_privacy_decision_request();

    CREATE OR REPLACE FUNCTION fractal.require_privacy_rights_initial_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM fractal.privacy_rights_request_events event
        WHERE event.privacy_request_id=NEW.id AND event.sequence=1 AND event.event_type='opened'
          AND event.actor_identity_id=NEW.requester_identity_id AND event.message=NEW.details
          AND event.occurred_at=NEW.created_at
      ) THEN RAISE EXCEPTION 'privacy request requires its immutable opening event'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_rights_initial_event ON fractal.privacy_rights_requests;
    CREATE CONSTRAINT TRIGGER privacy_rights_initial_event AFTER INSERT ON fractal.privacy_rights_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_privacy_rights_initial_event();

    CREATE OR REPLACE FUNCTION fractal.protect_privacy_rights_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'privacy rights requests are retained'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.requester_identity_id IS DISTINCT FROM OLD.requester_identity_id OR NEW.requester_role IS DISTINCT FROM OLD.requester_role
         OR NEW.request_type IS DISTINCT FROM OLD.request_type OR NEW.details IS DISTINCT FROM OLD.details
         OR NEW.identity_assurance IS DISTINCT FROM OLD.identity_assurance OR NEW.email_verified_at_snapshot IS DISTINCT FROM OLD.email_verified_at_snapshot
         OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id OR NEW.due_at IS DISTINCT FROM OLD.due_at
         OR NEW.command_key IS DISTINCT FROM OLD.command_key OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.version <> OLD.version + 1 OR NEW.last_activity_at <= OLD.last_activity_at THEN
        RAISE EXCEPTION 'privacy request source facts are immutable';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM fractal.privacy_rights_request_events event
        WHERE event.privacy_request_id=OLD.id AND event.sequence=NEW.version
          AND event.from_status=OLD.status AND event.to_status=NEW.status
          AND event.from_assignee_identity_id IS NOT DISTINCT FROM OLD.assigned_to_identity_id
          AND event.assignee_identity_id IS NOT DISTINCT FROM NEW.assigned_to_identity_id
          AND event.decision_request_id IS NOT DISTINCT FROM NEW.current_decision_request_id
          AND event.occurred_at=NEW.last_activity_at
          AND (NEW.current_decision_request_id IS NULL OR EXISTS (
            SELECT 1 FROM fractal.privacy_rights_decision_requests decision
            WHERE decision.id=NEW.current_decision_request_id AND decision.privacy_request_id=OLD.id
          ))
      ) THEN RAISE EXCEPTION 'privacy request projection requires its immutable event'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_rights_requests_guard ON fractal.privacy_rights_requests;
    CREATE TRIGGER privacy_rights_requests_guard BEFORE UPDATE OR DELETE ON fractal.privacy_rights_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_privacy_rights_projection();
  `,
};
