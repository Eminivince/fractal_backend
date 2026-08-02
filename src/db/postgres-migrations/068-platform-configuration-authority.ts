import type { PostgresMigration } from "./types.js";

/**
 * Establishes a non-secret, typed and versioned platform-configuration
 * authority. Configuration values are immutable proposals; approval and
 * activation are separate state transitions, and consumers resolve the exact
 * active version through a projection rather than reading mutable columns.
 */
export const platformConfigurationAuthorityMigration: PostgresMigration = {
  version: "068-platform-configuration-authority",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('platform_configuration_manage', 'Platform configuration management', 'Read, propose, independently approve, schedule, activate, and roll back governed non-secret platform configuration versions.')
    ON CONFLICT (capability_key) DO NOTHING;

    INSERT INTO fractal.administrator_capability_assignments
      (id, identity_id, capability_key)
    SELECT md5(assignment.identity_id::text || ':platform_configuration_manage')::uuid,
           assignment.identity_id,
           'platform_configuration_manage'
      FROM fractal.identity_role_assignments assignment
      JOIN fractal.identities identity ON identity.id = assignment.identity_id
     WHERE assignment.role = 'admin'
       AND assignment.scope_type = 'global'
       AND assignment.revoked_at IS NULL
       AND identity.status = 'active'
    ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.platform_configuration_definitions (
      configuration_key TEXT PRIMARY KEY CHECK (configuration_key ~ '^[a-z][a-z0-9_.]{2,119}$'),
      label TEXT NOT NULL CHECK (length(label) BETWEEN 3 AND 120),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 1000),
      value_type TEXT NOT NULL CHECK (value_type IN ('boolean', 'integer', 'decimal', 'string', 'json')),
      validation_schema JSONB NOT NULL CHECK (jsonb_typeof(validation_schema) = 'object'),
      consumer_binding TEXT NOT NULL CHECK (consumer_binding IN ('next_request', 'new_session', 'new_case', 'new_agreement', 'new_calculation')),
      sensitive BOOLEAN NOT NULL DEFAULT FALSE CHECK (sensitive = FALSE),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key, label, description, value_type, validation_schema, consumer_binding)
    VALUES
      ('auth.session.absolute_lifetime_minutes', 'Session absolute lifetime', 'Maximum lifetime of a newly created browser session before re-authentication is mandatory.', 'integer', '{"minimum":60,"maximum":10080,"unit":"minutes"}'::jsonb, 'new_session'),
      ('public.catalogue.default_page_size', 'Public catalogue page size', 'Default number of governed public offerings returned when a caller does not request a smaller page.', 'integer', '{"minimum":6,"maximum":100,"unit":"records"}'::jsonb, 'next_request'),
      ('support.case.default_priority', 'Support case default priority', 'Priority assigned to a newly opened support case when no stricter product policy selects another priority.', 'string', '{"enum":["low","normal","high","urgent"]}'::jsonb, 'new_case')
    ON CONFLICT (configuration_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.platform_configuration_versions (
      id UUID PRIMARY KEY,
      configuration_key TEXT NOT NULL REFERENCES fractal.platform_configuration_definitions(configuration_key),
      version_number INTEGER NOT NULL CHECK (version_number > 0),
      state_version INTEGER NOT NULL DEFAULT 1 CHECK (state_version > 0),
      status TEXT NOT NULL CHECK (status IN ('validation_failed', 'pending', 'rejected', 'scheduled', 'active', 'superseded', 'failed')),
      proposed_value JSONB NOT NULL,
      value_sha256 CHAR(64) NOT NULL CHECK (value_sha256 ~ '^[0-9a-f]{64}$'),
      validation_output JSONB NOT NULL CHECK (jsonb_typeof(validation_output) = 'object'),
      impact_preview JSONB NOT NULL CHECK (jsonb_typeof(impact_preview) = 'object'),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
      proposed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 2000),
      effective_at TIMESTAMPTZ NOT NULL,
      proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      supersedes_version_id UUID REFERENCES fractal.platform_configuration_versions(id),
      rollback_of_version_id UUID REFERENCES fractal.platform_configuration_versions(id),
      failure_code TEXT CHECK (failure_code IS NULL OR length(failure_code) BETWEEN 3 AND 120),
      failure_detail TEXT CHECK (failure_detail IS NULL OR length(failure_detail) BETWEEN 3 AND 1000),
      UNIQUE (configuration_key, version_number),
      UNIQUE (configuration_key, id),
      CONSTRAINT platform_configuration_version_independent_reviewer CHECK (
        reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> proposed_by_identity_id
      ),
      CONSTRAINT platform_configuration_version_review_shape CHECK (
        (status IN ('validation_failed', 'pending') AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND activated_at IS NULL)
        OR (status = 'rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND activated_at IS NULL)
        OR (status IN ('scheduled', 'active', 'superseded') AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL)
        OR (status = 'failed' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND failure_code IS NOT NULL AND failure_detail IS NOT NULL)
      ),
      CONSTRAINT platform_configuration_version_activation_shape CHECK (
        (status IN ('validation_failed', 'pending', 'rejected', 'scheduled', 'failed') AND activated_at IS NULL AND superseded_at IS NULL)
        OR (status = 'active' AND activated_at IS NOT NULL AND superseded_at IS NULL)
        OR (status = 'superseded' AND activated_at IS NOT NULL AND superseded_at IS NOT NULL)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS platform_configuration_one_open_version_idx
      ON fractal.platform_configuration_versions (configuration_key)
      WHERE status IN ('pending', 'scheduled');
    CREATE UNIQUE INDEX IF NOT EXISTS platform_configuration_one_active_version_idx
      ON fractal.platform_configuration_versions (configuration_key)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS platform_configuration_activation_queue_idx
      ON fractal.platform_configuration_versions (effective_at, configuration_key, version_number)
      WHERE status = 'scheduled';
    CREATE INDEX IF NOT EXISTS platform_configuration_history_idx
      ON fractal.platform_configuration_versions (configuration_key, version_number DESC);

    CREATE TABLE IF NOT EXISTS fractal.platform_configuration_active_versions (
      configuration_key TEXT PRIMARY KEY REFERENCES fractal.platform_configuration_definitions(configuration_key),
      active_version_id UUID NOT NULL UNIQUE,
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      bound_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT platform_configuration_active_version_same_definition
        FOREIGN KEY (configuration_key, active_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key, id)
    );

    CREATE TABLE IF NOT EXISTS fractal.platform_configuration_events (
      id UUID PRIMARY KEY,
      configuration_version_id UUID NOT NULL REFERENCES fractal.platform_configuration_versions(id),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('proposed', 'validation_failed', 'approved', 'rejected', 'activated', 'superseded', 'activation_failed')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
      actor_identity_id UUID REFERENCES fractal.identities(id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
      evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (configuration_version_id, sequence),
      CONSTRAINT platform_configuration_event_actor_shape CHECK (
        (actor_type = 'user' AND actor_identity_id IS NOT NULL)
        OR (actor_type = 'system' AND actor_identity_id IS NULL)
      )
    );

    CREATE TABLE IF NOT EXISTS fractal.platform_configuration_activation_attempts (
      id UUID PRIMARY KEY,
      configuration_version_id UUID NOT NULL REFERENCES fractal.platform_configuration_versions(id),
      outcome TEXT NOT NULL CHECK (outcome IN ('activated', 'failed', 'already_terminal')),
      due_at TIMESTAMPTZ NOT NULL,
      attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      lateness_ms BIGINT NOT NULL CHECK (lateness_ms >= 0),
      failure_code TEXT,
      failure_detail TEXT,
      CONSTRAINT platform_configuration_attempt_failure_shape CHECK (
        (outcome = 'failed' AND failure_code IS NOT NULL AND failure_detail IS NOT NULL)
        OR (outcome <> 'failed' AND failure_code IS NULL AND failure_detail IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS platform_configuration_activation_attempt_version_idx
      ON fractal.platform_configuration_activation_attempts (configuration_version_id, attempted_at DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_platform_configuration_version_facts()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'platform configuration version history is immutable';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.configuration_key <> OLD.configuration_key
         OR NEW.version_number <> OLD.version_number
         OR NEW.proposed_value <> OLD.proposed_value
         OR NEW.value_sha256 <> OLD.value_sha256
         OR NEW.validation_output <> OLD.validation_output
         OR NEW.impact_preview <> OLD.impact_preview
         OR NEW.reason <> OLD.reason
         OR NEW.proposed_by_identity_id <> OLD.proposed_by_identity_id
         OR NEW.effective_at <> OLD.effective_at
         OR NEW.proposed_at <> OLD.proposed_at
         OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id
         OR NEW.rollback_of_version_id IS DISTINCT FROM OLD.rollback_of_version_id THEN
        RAISE EXCEPTION 'proposed platform configuration facts are immutable';
      END IF;
      IF OLD.status NOT IN ('pending', 'scheduled', 'active') THEN
        RAISE EXCEPTION 'terminal platform configuration versions are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS platform_configuration_version_guard ON fractal.platform_configuration_versions;
    CREATE TRIGGER platform_configuration_version_guard
      BEFORE UPDATE OR DELETE ON fractal.platform_configuration_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_platform_configuration_version_facts();

    CREATE OR REPLACE FUNCTION fractal.reject_platform_configuration_evidence_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'platform configuration evidence is immutable';
    END;
    $$;

    DROP TRIGGER IF EXISTS platform_configuration_events_immutable ON fractal.platform_configuration_events;
    CREATE TRIGGER platform_configuration_events_immutable
      BEFORE UPDATE OR DELETE ON fractal.platform_configuration_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_platform_configuration_evidence_mutation();
    DROP TRIGGER IF EXISTS platform_configuration_attempts_immutable ON fractal.platform_configuration_activation_attempts;
    CREATE TRIGGER platform_configuration_attempts_immutable
      BEFORE UPDATE OR DELETE ON fractal.platform_configuration_activation_attempts
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_platform_configuration_evidence_mutation();
  `,
};
