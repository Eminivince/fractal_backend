import type { PostgresMigration } from "./types.js";

/** Authenticated support and complaint cases with an immutable communication and decision register. */
export const supportCasesMigration: PostgresMigration = {
  version: "066-support-cases",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('support_case_manage', 'Support case management', 'Inspect and manage authenticated support, security, privacy, and complaint cases with attributable internal decisions.')
    ON CONFLICT (capability_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.support_cases (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^SUP-[0-9]{8}-[A-Z0-9]{8}$'),
      requester_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      requester_role TEXT NOT NULL CHECK (requester_role IN ('investor', 'issuer', 'professional', 'operator', 'admin')),
      category TEXT NOT NULL CHECK (category IN ('account_access', 'identity_verification', 'investment_record', 'payment_status', 'organization', 'professional_work', 'security_concern', 'privacy_request', 'formal_complaint', 'other')),
      reported_impact TEXT NOT NULL CHECK (reported_impact IN ('question', 'blocked', 'financial_or_legal_risk', 'security_or_privacy_concern')),
      subject TEXT NOT NULL CHECK (length(subject) BETWEEN 10 AND 200),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 20 AND 5000),
      related_reference TEXT CHECK (related_reference IS NULL OR length(related_reference) BETWEEN 3 AND 200),
      occurred_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'triaged', 'in_progress', 'waiting_requester', 'resolved', 'closed')),
      assigned_to_identity_id UUID REFERENCES fractal.identities(id),
      resolution_summary TEXT CHECK (resolution_summary IS NULL OR length(resolution_summary) BETWEEN 10 AND 5000),
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT support_case_resolution_shape CHECK (
        (status IN ('resolved', 'closed') AND resolution_summary IS NOT NULL)
        OR (status NOT IN ('resolved', 'closed') AND resolution_summary IS NULL)
      ),
      CONSTRAINT support_case_occurred_time CHECK (occurred_at <= created_at + interval '1 minute')
    );
    CREATE INDEX IF NOT EXISTS support_cases_requester_idx
      ON fractal.support_cases (requester_identity_id, last_activity_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS support_cases_active_queue_idx
      ON fractal.support_cases (reported_impact, created_at, id)
      WHERE status NOT IN ('resolved', 'closed');
    CREATE INDEX IF NOT EXISTS support_cases_assignee_idx
      ON fractal.support_cases (assigned_to_identity_id, status, last_activity_at DESC)
      WHERE assigned_to_identity_id IS NOT NULL;

    CREATE TABLE IF NOT EXISTS fractal.support_case_events (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.support_cases(id),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('opened', 'requester_message', 'staff_message', 'staff_note', 'assigned', 'triaged', 'status_changed', 'resolved', 'closed', 'reopened')),
      from_status TEXT CHECK (from_status IS NULL OR from_status IN ('new', 'triaged', 'in_progress', 'waiting_requester', 'resolved', 'closed')),
      to_status TEXT NOT NULL CHECK (to_status IN ('new', 'triaged', 'in_progress', 'waiting_requester', 'resolved', 'closed')),
      from_assignee_identity_id UUID REFERENCES fractal.identities(id),
      assignee_identity_id UUID REFERENCES fractal.identities(id),
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      visibility TEXT NOT NULL CHECK (visibility IN ('requester', 'internal')),
      message TEXT NOT NULL CHECK (length(message) BETWEEN 2 AND 5000),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (case_id, sequence),
      CONSTRAINT support_case_event_shape CHECK (
        (event_type = 'opened' AND sequence = 1 AND from_status IS NULL AND to_status = 'new'
          AND from_assignee_identity_id IS NULL AND assignee_identity_id IS NULL AND visibility = 'requester')
        OR (event_type IN ('requester_message', 'staff_message', 'staff_note') AND sequence > 1 AND from_status = to_status
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id
          AND ((event_type IN ('requester_message', 'staff_message') AND visibility = 'requester') OR event_type = 'staff_note'))
        OR (event_type = 'assigned' AND sequence > 1 AND from_status = to_status AND to_status <> 'closed'
          AND from_assignee_identity_id IS DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'internal')
        OR (event_type = 'triaged' AND sequence > 1 AND from_status = 'new' AND to_status = 'triaged'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'internal')
        OR (event_type = 'status_changed' AND sequence > 1
          AND ((from_status = 'triaged' AND to_status IN ('in_progress', 'waiting_requester'))
            OR (from_status = 'in_progress' AND to_status = 'waiting_requester')
            OR (from_status = 'waiting_requester' AND to_status = 'in_progress'))
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL)
        OR (event_type = 'resolved' AND sequence > 1 AND from_status IN ('triaged', 'in_progress', 'waiting_requester') AND to_status = 'resolved'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'requester')
        OR (event_type = 'closed' AND sequence > 1 AND from_status = 'resolved' AND to_status = 'closed'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND visibility = 'requester')
        OR (event_type = 'reopened' AND sequence > 1 AND from_status IN ('resolved', 'closed') AND to_status = 'in_progress'
          AND from_assignee_identity_id IS NOT DISTINCT FROM assignee_identity_id AND assignee_identity_id IS NOT NULL AND visibility = 'requester')
      )
    );
    CREATE INDEX IF NOT EXISTS support_case_events_requester_timeline_idx
      ON fractal.support_case_events (case_id, sequence)
      WHERE visibility = 'requester';
    CREATE INDEX IF NOT EXISTS support_case_events_full_timeline_idx
      ON fractal.support_case_events (case_id, sequence);

    CREATE OR REPLACE FUNCTION fractal.protect_support_case_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'support case events are immutable';
    END;
    $$;
    DROP TRIGGER IF EXISTS support_case_events_immutable ON fractal.support_case_events;
    CREATE TRIGGER support_case_events_immutable
      BEFORE UPDATE OR DELETE ON fractal.support_case_events
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_support_case_event();

    CREATE OR REPLACE FUNCTION fractal.require_support_case_initial_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM fractal.support_case_events event
         WHERE event.case_id = NEW.id AND event.sequence = 1 AND event.event_type = 'opened'
           AND event.from_status IS NULL AND event.to_status = 'new'
           AND event.actor_identity_id = NEW.requester_identity_id
           AND event.message = NEW.description
           AND event.occurred_at = NEW.created_at
      ) THEN
        RAISE EXCEPTION 'support case requires its immutable opening event';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS support_cases_initial_event ON fractal.support_cases;
    CREATE CONSTRAINT TRIGGER support_cases_initial_event
      AFTER INSERT ON fractal.support_cases
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_support_case_initial_event();

    CREATE OR REPLACE FUNCTION fractal.protect_support_case_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'support cases are retained'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.requester_identity_id IS DISTINCT FROM OLD.requester_identity_id
         OR NEW.requester_role IS DISTINCT FROM OLD.requester_role
         OR NEW.category IS DISTINCT FROM OLD.category
         OR NEW.reported_impact IS DISTINCT FROM OLD.reported_impact
         OR NEW.subject IS DISTINCT FROM OLD.subject
         OR NEW.description IS DISTINCT FROM OLD.description
         OR NEW.related_reference IS DISTINCT FROM OLD.related_reference
         OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.version <> OLD.version + 1
         OR NEW.last_activity_at <= OLD.last_activity_at THEN
        RAISE EXCEPTION 'support case source facts are immutable';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM fractal.support_case_events event
         WHERE event.case_id = OLD.id AND event.sequence = NEW.version
           AND event.from_status = OLD.status AND event.to_status = NEW.status
           AND event.from_assignee_identity_id IS NOT DISTINCT FROM OLD.assigned_to_identity_id
           AND event.assignee_identity_id IS NOT DISTINCT FROM NEW.assigned_to_identity_id
           AND event.occurred_at = NEW.last_activity_at
           AND (
             (NEW.status IN ('resolved', 'closed') AND event.message = NEW.resolution_summary)
             OR (NEW.status NOT IN ('resolved', 'closed') AND NEW.resolution_summary IS NULL)
             OR (NEW.status = OLD.status AND NEW.resolution_summary IS NOT DISTINCT FROM OLD.resolution_summary)
           )
      ) THEN
        RAISE EXCEPTION 'support case projection requires its immutable event';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS support_cases_guard ON fractal.support_cases;
    CREATE TRIGGER support_cases_guard
      BEFORE UPDATE OR DELETE ON fractal.support_cases
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_support_case_projection();
  `,
};
