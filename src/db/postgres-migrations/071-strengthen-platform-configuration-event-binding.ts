import type { PostgresMigration } from "./types.js";

/** Tightens event-to-projection field binding and permits equal clock ticks. */
export const strengthenPlatformConfigurationEventBindingMigration: PostgresMigration = {
  version: "071-strengthen-platform-configuration-event-binding",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.require_platform_configuration_version_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      expected_event_type TEXT;
    BEGIN
      expected_event_type := CASE NEW.status
        WHEN 'pending' THEN 'proposed'
        WHEN 'validation_failed' THEN 'validation_failed'
        WHEN 'rejected' THEN 'rejected'
        WHEN 'scheduled' THEN 'approved'
        WHEN 'active' THEN 'activated'
        WHEN 'superseded' THEN 'superseded'
        WHEN 'failed' THEN 'activation_failed'
      END;

      IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('pending', 'validation_failed') THEN
          RAISE EXCEPTION 'platform configuration version must begin as pending or validation_failed';
        END IF;
      ELSE
        IF NEW.state_version <> OLD.state_version + 1 THEN
          RAISE EXCEPTION 'platform configuration state version must advance exactly once';
        END IF;
        IF NOT (
          (OLD.status = 'pending' AND NEW.status IN ('scheduled', 'rejected'))
          OR (OLD.status = 'scheduled' AND NEW.status IN ('active', 'failed'))
          OR (OLD.status = 'active' AND NEW.status = 'superseded')
        ) THEN
          RAISE EXCEPTION 'invalid platform configuration status transition from % to %', OLD.status, NEW.status;
        END IF;
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM fractal.platform_configuration_events event
         WHERE event.configuration_version_id = NEW.id
           AND event.sequence = NEW.state_version
           AND event.event_type = expected_event_type
           AND event.to_status = NEW.status
           AND (
             (TG_OP = 'INSERT' AND NEW.status = 'pending' AND event.from_status IS NULL)
             OR (TG_OP = 'INSERT' AND NEW.status = 'validation_failed' AND event.from_status = 'pending')
             OR (TG_OP = 'UPDATE' AND event.from_status = OLD.status)
           )
           AND (
             (NEW.status = 'pending'
               AND event.actor_type = 'user'
               AND event.actor_identity_id = NEW.proposed_by_identity_id
               AND event.reason = NEW.reason)
             OR (NEW.status = 'validation_failed'
               AND event.actor_type = 'user'
               AND event.actor_identity_id = NEW.proposed_by_identity_id
               AND event.evidence -> 'errors' = NEW.validation_output -> 'errors')
             OR (NEW.status IN ('scheduled', 'rejected')
               AND event.actor_type = 'user'
               AND event.actor_identity_id = NEW.reviewed_by_identity_id
               AND event.reason = NEW.decision_reason)
             OR (NEW.status IN ('active', 'superseded', 'failed')
               AND event.actor_type = 'system'
               AND event.actor_identity_id IS NULL)
           )
      ) THEN
        RAISE EXCEPTION 'platform configuration projection requires its matching immutable event';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.protect_platform_configuration_active_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'active platform configuration projections are retained';
      END IF;
      IF NEW.configuration_key IS DISTINCT FROM OLD.configuration_key
         OR NEW.projection_version <> OLD.projection_version + 1
         OR NEW.active_version_id = OLD.active_version_id
         OR NEW.bound_at < OLD.bound_at THEN
        RAISE EXCEPTION 'invalid active platform configuration projection transition';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
