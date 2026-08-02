import type { PostgresMigration } from "./types.js";

/** Database-enforced semantic binding between the approved policy, case cycle, deadlines, and service events. */
export const strengthenSupportServiceEvidenceMigration: PostgresMigration = {
  version: "075-strengthen-support-service-evidence",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.require_exact_active_support_policy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      policy RECORD;
      support_case RECORD;
      target JSONB;
      source_event RECORD;
      expected_acknowledgement TIMESTAMPTZ;
      expected_resolution TIMESTAMPTZ;
      expected_escalation TIMESTAMPTZ;
    BEGIN
      SELECT version.version_number, version.value_sha256, version.proposed_value, projection.projection_version
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

      SELECT category, reported_impact INTO support_case
        FROM fractal.support_cases WHERE id = NEW.case_id;
      SELECT item->'target' INTO target
        FROM jsonb_array_elements(policy.proposed_value->'categoryOverrides') item
       WHERE item->>'category' = support_case.category
         AND item->>'reportedImpact' = support_case.reported_impact
       LIMIT 1;
      target := COALESCE(target, policy.proposed_value->'impactTargets'->support_case.reported_impact);
      IF target IS NULL THEN RAISE EXCEPTION 'support policy has no target for the case classification'; END IF;

      expected_acknowledgement := NEW.opened_at + ((target->>'acknowledgementMinutes')::integer * interval '1 minute');
      expected_resolution := NEW.opened_at + ((target->>'resolutionMinutes')::integer * interval '1 minute');
      expected_escalation := expected_resolution - ((target->>'escalationMinutesBeforeResolution')::integer * interval '1 minute');
      IF NEW.policy_reference <> policy.proposed_value->>'policyReference'
         OR NEW.policy_name <> policy.proposed_value->>'policyName'
         OR NEW.priority <> target->>'priority'
         OR NEW.acknowledgement_due_at <> expected_acknowledgement
         OR NEW.resolution_due_at <> expected_resolution
         OR NEW.escalation_due_at <> expected_escalation THEN
        RAISE EXCEPTION 'support obligation facts do not match the exact approved service policy';
      END IF;

      SELECT sequence, event_type, occurred_at INTO source_event
        FROM fractal.support_case_events
       WHERE case_id = NEW.case_id AND sequence = NEW.source_case_event_sequence;
      IF source_event IS NULL
         OR source_event.occurred_at <> NEW.opened_at
         OR (NEW.cycle_number = 1 AND (source_event.sequence <> 1 OR source_event.event_type <> 'opened'))
         OR (NEW.cycle_number > 1 AND source_event.event_type <> 'reopened') THEN
        RAISE EXCEPTION 'support obligation requires its exact opening or reopening event';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.require_exact_support_service_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      obligation RECORD;
      case_sequence INTEGER;
    BEGIN
      SELECT case_id, acknowledgement_due_at, escalation_due_at, resolution_due_at
        INTO obligation
        FROM fractal.support_case_service_obligations
       WHERE id = NEW.obligation_id;
      IF (NEW.event_type IN ('acknowledgement_met','acknowledgement_breached') AND NEW.due_at <> obligation.acknowledgement_due_at)
         OR (NEW.event_type = 'escalated' AND NEW.due_at <> obligation.escalation_due_at)
         OR (NEW.event_type IN ('resolution_met','resolution_breached') AND NEW.due_at <> obligation.resolution_due_at) THEN
        RAISE EXCEPTION 'support service event due time does not match its obligation';
      END IF;
      IF NEW.lateness_ms <> GREATEST(0, floor(extract(epoch FROM (NEW.occurred_at - NEW.due_at)) * 1000)::bigint) THEN
        RAISE EXCEPTION 'support service event lateness does not match its timestamps';
      END IF;
      IF (NEW.event_type IN ('acknowledgement_met','resolution_met') AND NEW.actor_type <> 'user')
         OR (NEW.event_type IN ('acknowledgement_breached','escalated','resolution_breached') AND NEW.actor_type <> 'system') THEN
        RAISE EXCEPTION 'support service event actor does not match its event type';
      END IF;
      IF NEW.actor_type = 'user' THEN
        BEGIN case_sequence := (NEW.evidence->>'caseEventSequence')::integer;
        EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'support service user event requires a case event sequence';
        END;
        IF NOT EXISTS (
          SELECT 1 FROM fractal.support_case_events event
           WHERE event.case_id = obligation.case_id
             AND event.sequence = case_sequence
             AND event.actor_identity_id = NEW.actor_identity_id
             AND event.occurred_at = NEW.occurred_at
             AND event.event_type = CASE NEW.event_type WHEN 'acknowledgement_met' THEN 'triaged' ELSE 'resolved' END
        ) THEN
          RAISE EXCEPTION 'support service user event requires its exact case event';
        END IF;
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS support_service_event_binding ON fractal.support_case_service_events;
    CREATE TRIGGER support_service_event_binding
      BEFORE INSERT ON fractal.support_case_service_events
      FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_support_service_event();
  `,
};
