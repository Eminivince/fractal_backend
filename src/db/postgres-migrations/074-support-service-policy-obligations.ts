import type { PostgresMigration } from "./types.js";

/** Exact governed support-policy bindings, service obligations, and immutable deadline evidence. */
export const supportServicePolicyObligationsMigration: PostgresMigration = {
  version: "074-support-service-policy-obligations",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key, label, description, value_type, validation_schema, consumer_binding, status)
    VALUES (
      'support.case.service_policy',
      'Support case service policy',
      'Approved priority, acknowledgement, resolution-target, and escalation rules bound immutably to each new support-case service obligation.',
      'json',
      '{"type":"object","required":["policyReference","policyName","impactTargets","categoryOverrides"],"operationalValidator":"support_case_service_policy_v1"}'::jsonb,
      'new_case',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE
      SET label = EXCLUDED.label,
          description = EXCLUDED.description,
          value_type = EXCLUDED.value_type,
          validation_schema = EXCLUDED.validation_schema,
          consumer_binding = EXCLUDED.consumer_binding,
          status = 'active';

    CREATE TABLE IF NOT EXISTS fractal.support_case_service_obligations (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.support_cases(id),
      cycle_number INTEGER NOT NULL CHECK (cycle_number > 0),
      source_case_event_sequence INTEGER NOT NULL CHECK (source_case_event_sequence > 0),
      configuration_key TEXT NOT NULL DEFAULT 'support.case.service_policy'
        CHECK (configuration_key = 'support.case.service_policy'),
      policy_version_id UUID NOT NULL,
      policy_version_number INTEGER NOT NULL CHECK (policy_version_number > 0),
      policy_projection_version INTEGER NOT NULL CHECK (policy_projection_version > 0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK (policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      policy_reference TEXT NOT NULL CHECK (length(policy_reference) BETWEEN 3 AND 120),
      policy_name TEXT NOT NULL CHECK (length(policy_name) BETWEEN 10 AND 160),
      priority TEXT NOT NULL CHECK (priority IN ('p1','p2','p3','p4')),
      acknowledgement_due_at TIMESTAMPTZ NOT NULL,
      escalation_due_at TIMESTAMPTZ NOT NULL,
      resolution_due_at TIMESTAMPTZ NOT NULL,
      opened_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (case_id, cycle_number),
      UNIQUE (case_id, source_case_event_sequence),
      CONSTRAINT support_obligation_deadline_order CHECK (
        opened_at < acknowledgement_due_at
        AND opened_at < escalation_due_at
        AND escalation_due_at < resolution_due_at
      ),
      CONSTRAINT support_obligation_exact_policy_version FOREIGN KEY (configuration_key, policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key, id)
    );
    CREATE INDEX IF NOT EXISTS support_obligation_ack_queue_idx
      ON fractal.support_case_service_obligations (acknowledgement_due_at, id);
    CREATE INDEX IF NOT EXISTS support_obligation_escalation_queue_idx
      ON fractal.support_case_service_obligations (escalation_due_at, id);
    CREATE INDEX IF NOT EXISTS support_obligation_resolution_queue_idx
      ON fractal.support_case_service_obligations (resolution_due_at, id);

    CREATE TABLE IF NOT EXISTS fractal.support_case_service_events (
      id UUID PRIMARY KEY,
      obligation_id UUID NOT NULL REFERENCES fractal.support_case_service_obligations(id),
      event_type TEXT NOT NULL CHECK (event_type IN (
        'acknowledgement_met','acknowledgement_breached','escalated','resolution_met','resolution_breached'
      )),
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user','system')),
      actor_identity_id UUID REFERENCES fractal.identities(id),
      due_at TIMESTAMPTZ NOT NULL,
      occurred_at TIMESTAMPTZ NOT NULL,
      lateness_ms BIGINT NOT NULL CHECK (lateness_ms >= 0),
      evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      UNIQUE (obligation_id, event_type),
      CONSTRAINT support_service_event_actor_shape CHECK (
        (actor_type = 'user' AND actor_identity_id IS NOT NULL)
        OR (actor_type = 'system' AND actor_identity_id IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS support_service_event_timeline_idx
      ON fractal.support_case_service_events (obligation_id, occurred_at, id);

    CREATE TABLE IF NOT EXISTS fractal.support_case_service_sweeps (
      id UUID PRIMARY KEY,
      worker_id TEXT NOT NULL CHECK (length(worker_id) BETWEEN 3 AND 200),
      outcome TEXT NOT NULL CHECK (outcome IN ('completed','failed')),
      started_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
      acknowledgement_breaches INTEGER NOT NULL DEFAULT 0 CHECK (acknowledgement_breaches >= 0),
      escalations INTEGER NOT NULL DEFAULT 0 CHECK (escalations >= 0),
      resolution_breaches INTEGER NOT NULL DEFAULT 0 CHECK (resolution_breaches >= 0),
      failure_code TEXT,
      failure_detail TEXT,
      CONSTRAINT support_sweep_time_order CHECK (completed_at >= started_at),
      CONSTRAINT support_sweep_failure_shape CHECK (
        (outcome = 'completed' AND failure_code IS NULL AND failure_detail IS NULL)
        OR (outcome = 'failed' AND failure_code IS NOT NULL AND failure_detail IS NOT NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS support_service_sweep_monitor_idx
      ON fractal.support_case_service_sweeps (started_at DESC);

    CREATE OR REPLACE FUNCTION fractal.require_exact_active_support_policy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      policy RECORD;
    BEGIN
      SELECT version.version_number, version.value_sha256, projection.projection_version
        INTO policy
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version ON version.id = projection.active_version_id
       WHERE projection.configuration_key = NEW.configuration_key
         AND projection.active_version_id = NEW.policy_version_id
         AND version.status = 'active';
      IF policy IS NULL
         OR policy.version_number <> NEW.policy_version_number
         OR policy.value_sha256 <> NEW.policy_value_sha256
         OR policy.projection_version <> NEW.policy_projection_version THEN
        RAISE EXCEPTION 'support obligation requires the exact active service-policy version';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS support_obligation_policy_binding ON fractal.support_case_service_obligations;
    CREATE TRIGGER support_obligation_policy_binding
      BEFORE INSERT ON fractal.support_case_service_obligations
      FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_active_support_policy();

    CREATE OR REPLACE FUNCTION fractal.reject_support_service_evidence_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'support service evidence is immutable';
    END;
    $$;
    DROP TRIGGER IF EXISTS support_obligations_immutable ON fractal.support_case_service_obligations;
    CREATE TRIGGER support_obligations_immutable
      BEFORE UPDATE OR DELETE ON fractal.support_case_service_obligations
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_support_service_evidence_mutation();
    DROP TRIGGER IF EXISTS support_service_events_immutable ON fractal.support_case_service_events;
    CREATE TRIGGER support_service_events_immutable
      BEFORE UPDATE OR DELETE ON fractal.support_case_service_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_support_service_evidence_mutation();
    DROP TRIGGER IF EXISTS support_service_sweeps_immutable ON fractal.support_case_service_sweeps;
    CREATE TRIGGER support_service_sweeps_immutable
      BEFORE UPDATE OR DELETE ON fractal.support_case_service_sweeps
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_support_service_evidence_mutation();
  `,
};
