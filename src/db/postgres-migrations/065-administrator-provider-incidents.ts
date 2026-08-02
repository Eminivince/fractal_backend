import type { PostgresMigration } from "./types.js";

/** Durable provider incidents with an immutable, sequenced transition register. */
export const administratorProviderIncidentsMigration: PostgresMigration = {
  version: "065-administrator-provider-incidents",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('provider_incident_manage', 'Provider incident control', 'Inspect controlled provider-incident evidence and perform attributable acknowledgement, assignment, containment, escalation, resolution, and reopen commands.')
    ON CONFLICT (capability_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.administrator_provider_incidents (
      id UUID PRIMARY KEY,
      provider_key TEXT NOT NULL CHECK (provider_key ~ '^[a-z][a-z0-9_]{1,79}$'),
      source TEXT NOT NULL CHECK (source IN ('manual', 'system_health', 'provider_webhook', 'queue_monitor', 'external_alert')),
      external_reference TEXT CHECK (external_reference IS NULL OR length(external_reference) BETWEEN 3 AND 200),
      severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'contained', 'resolved')),
      summary TEXT NOT NULL CHECK (length(summary) BETWEEN 10 AND 300),
      user_impact TEXT NOT NULL CHECK (length(user_impact) BETWEEN 10 AND 2000),
      detection_evidence JSONB NOT NULL CHECK (jsonb_typeof(detection_evidence) = 'object'),
      detected_at TIMESTAMPTZ NOT NULL,
      acknowledgement_due_at TIMESTAMPTZ NOT NULL,
      resolution_due_at TIMESTAMPTZ NOT NULL,
      owner_identity_id UUID REFERENCES fractal.identities(id),
      created_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      acknowledged_at TIMESTAMPTZ,
      contained_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT administrator_provider_incident_time_shape CHECK (
        detected_at <= acknowledgement_due_at AND acknowledgement_due_at <= resolution_due_at
      ),
      CONSTRAINT administrator_provider_incident_status_shape CHECK (
        (status = 'open' AND acknowledged_at IS NULL AND contained_at IS NULL AND resolved_at IS NULL)
        OR (status = 'acknowledged' AND acknowledged_at IS NOT NULL AND contained_at IS NULL AND resolved_at IS NULL)
        OR (status = 'contained' AND acknowledged_at IS NOT NULL AND contained_at IS NOT NULL AND resolved_at IS NULL)
        OR (status = 'resolved' AND acknowledged_at IS NOT NULL AND resolved_at IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS administrator_provider_incidents_active_idx
      ON fractal.administrator_provider_incidents (severity, acknowledgement_due_at, detected_at, id)
      WHERE status <> 'resolved';
    CREATE INDEX IF NOT EXISTS administrator_provider_incidents_provider_idx
      ON fractal.administrator_provider_incidents (provider_key, detected_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS administrator_provider_incidents_external_unique_idx
      ON fractal.administrator_provider_incidents (provider_key, external_reference)
      WHERE external_reference IS NOT NULL;

    CREATE TABLE IF NOT EXISTS fractal.administrator_provider_incident_events (
      id UUID PRIMARY KEY,
      incident_id UUID NOT NULL REFERENCES fractal.administrator_provider_incidents(id),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('created', 'acknowledged', 'assigned', 'contained', 'escalated', 'resolved', 'reopened')),
      from_status TEXT CHECK (from_status IS NULL OR from_status IN ('open', 'acknowledged', 'contained', 'resolved')),
      to_status TEXT NOT NULL CHECK (to_status IN ('open', 'acknowledged', 'contained', 'resolved')),
      from_severity TEXT CHECK (from_severity IS NULL OR from_severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
      severity TEXT NOT NULL CHECK (severity IN ('sev1', 'sev2', 'sev3', 'sev4')),
      from_owner_identity_id UUID REFERENCES fractal.identities(id),
      owner_identity_id UUID REFERENCES fractal.identities(id),
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      acknowledgement_due_at TIMESTAMPTZ NOT NULL,
      resolution_due_at TIMESTAMPTZ NOT NULL,
      acknowledged_at TIMESTAMPTZ,
      contained_at TIMESTAMPTZ,
      resolved_at TIMESTAMPTZ,
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
      evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (incident_id, sequence),
      CONSTRAINT administrator_provider_incident_event_prior_shape CHECK (
        (event_type = 'created' AND from_status IS NULL AND from_severity IS NULL AND from_owner_identity_id IS NULL)
        OR (event_type <> 'created' AND from_status IS NOT NULL AND from_severity IS NOT NULL)
      ),
      CONSTRAINT administrator_provider_incident_event_shape CHECK (
        (event_type = 'created' AND sequence = 1 AND from_status IS NULL AND to_status = 'open'
          AND from_severity IS NULL AND from_owner_identity_id IS NULL
          AND acknowledged_at IS NULL AND contained_at IS NULL AND resolved_at IS NULL)
        OR (event_type = 'acknowledged' AND sequence > 1 AND from_status = 'open' AND to_status = 'acknowledged'
          AND from_severity = severity AND from_owner_identity_id IS NOT DISTINCT FROM owner_identity_id
          AND acknowledged_at IS NOT NULL AND contained_at IS NULL AND resolved_at IS NULL)
        OR (event_type = 'assigned' AND sequence > 1 AND from_status = to_status AND to_status <> 'resolved'
          AND from_severity = severity AND from_owner_identity_id IS DISTINCT FROM owner_identity_id)
        OR (event_type = 'contained' AND sequence > 1 AND from_status = 'acknowledged' AND to_status = 'contained'
          AND from_severity = severity AND from_owner_identity_id IS NOT DISTINCT FROM owner_identity_id
          AND acknowledged_at IS NOT NULL AND contained_at IS NOT NULL AND resolved_at IS NULL)
        OR (event_type = 'escalated' AND sequence > 1 AND from_status = to_status AND to_status <> 'resolved'
          AND CASE from_severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 WHEN 'sev4' THEN 4 ELSE 5 END
            > CASE severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 WHEN 'sev4' THEN 4 ELSE 5 END
          AND from_owner_identity_id IS NOT DISTINCT FROM owner_identity_id)
        OR (event_type = 'resolved' AND sequence > 1 AND from_status IN ('acknowledged', 'contained') AND to_status = 'resolved'
          AND from_severity = severity AND from_owner_identity_id IS NOT DISTINCT FROM owner_identity_id
          AND acknowledged_at IS NOT NULL AND resolved_at IS NOT NULL)
        OR (event_type = 'reopened' AND sequence > 1 AND from_status = 'resolved' AND to_status = 'open'
          AND from_severity = severity AND from_owner_identity_id IS NOT DISTINCT FROM owner_identity_id
          AND acknowledged_at IS NULL AND contained_at IS NULL AND resolved_at IS NULL)
      ),
      CONSTRAINT administrator_provider_incident_event_time_shape CHECK (
        acknowledgement_due_at <= resolution_due_at
      )
    );
    CREATE INDEX IF NOT EXISTS administrator_provider_incident_events_timeline_idx
      ON fractal.administrator_provider_incident_events (incident_id, sequence);

    CREATE OR REPLACE FUNCTION fractal.protect_administrator_provider_incident_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'administrator provider incident events are immutable';
    END;
    $$;
    DROP TRIGGER IF EXISTS administrator_provider_incident_events_immutable ON fractal.administrator_provider_incident_events;
    CREATE TRIGGER administrator_provider_incident_events_immutable
      BEFORE UPDATE OR DELETE ON fractal.administrator_provider_incident_events
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_administrator_provider_incident_event();

    CREATE OR REPLACE FUNCTION fractal.require_administrator_provider_incident_initial_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM fractal.administrator_provider_incident_events event
         WHERE event.incident_id = NEW.id AND event.sequence = 1 AND event.event_type = 'created'
           AND event.from_status IS NULL AND event.to_status = NEW.status
           AND event.from_severity IS NULL AND event.severity = NEW.severity
           AND event.from_owner_identity_id IS NULL
           AND event.owner_identity_id IS NOT DISTINCT FROM NEW.owner_identity_id
           AND event.actor_identity_id = NEW.created_by_identity_id
           AND event.acknowledgement_due_at = NEW.acknowledgement_due_at
           AND event.resolution_due_at = NEW.resolution_due_at
           AND event.acknowledged_at IS NOT DISTINCT FROM NEW.acknowledged_at
           AND event.contained_at IS NOT DISTINCT FROM NEW.contained_at
           AND event.resolved_at IS NOT DISTINCT FROM NEW.resolved_at
           AND event.occurred_at = NEW.created_at
      ) THEN
        RAISE EXCEPTION 'administrator provider incident requires its immutable initial event';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS administrator_provider_incidents_initial_event ON fractal.administrator_provider_incidents;
    CREATE CONSTRAINT TRIGGER administrator_provider_incidents_initial_event
      AFTER INSERT ON fractal.administrator_provider_incidents
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_administrator_provider_incident_initial_event();

    CREATE OR REPLACE FUNCTION fractal.protect_administrator_provider_incident_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'administrator provider incidents are retained';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.provider_key IS DISTINCT FROM OLD.provider_key
         OR NEW.source IS DISTINCT FROM OLD.source
         OR NEW.external_reference IS DISTINCT FROM OLD.external_reference
         OR NEW.summary IS DISTINCT FROM OLD.summary
         OR NEW.user_impact IS DISTINCT FROM OLD.user_impact
         OR NEW.detection_evidence IS DISTINCT FROM OLD.detection_evidence
         OR NEW.detected_at IS DISTINCT FROM OLD.detected_at
         OR NEW.created_by_identity_id IS DISTINCT FROM OLD.created_by_identity_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at
         OR NEW.version <> OLD.version + 1 THEN
        RAISE EXCEPTION 'administrator provider incident source facts are immutable';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM fractal.administrator_provider_incident_events event
         WHERE event.incident_id = OLD.id AND event.sequence = NEW.version
           AND event.from_status = OLD.status AND event.to_status = NEW.status
           AND event.from_severity = OLD.severity
           AND event.severity = NEW.severity
           AND event.from_owner_identity_id IS NOT DISTINCT FROM OLD.owner_identity_id
           AND event.owner_identity_id IS NOT DISTINCT FROM NEW.owner_identity_id
           AND event.acknowledgement_due_at = NEW.acknowledgement_due_at
           AND event.resolution_due_at = NEW.resolution_due_at
           AND event.acknowledged_at IS NOT DISTINCT FROM NEW.acknowledged_at
           AND event.contained_at IS NOT DISTINCT FROM NEW.contained_at
           AND event.resolved_at IS NOT DISTINCT FROM NEW.resolved_at
           AND event.occurred_at = NEW.updated_at
      ) THEN
        RAISE EXCEPTION 'administrator provider incident projection requires its immutable event';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS administrator_provider_incidents_guard ON fractal.administrator_provider_incidents;
    CREATE TRIGGER administrator_provider_incidents_guard
      BEFORE UPDATE OR DELETE ON fractal.administrator_provider_incidents
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_administrator_provider_incident_projection();
  `,
};
