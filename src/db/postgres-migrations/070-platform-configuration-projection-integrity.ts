import type { PostgresMigration } from "./types.js";

/**
 * Makes the immutable event stream a database-enforced prerequisite for every
 * configuration status and active-projection transition. The application may
 * no longer update a projection and promise to append evidence later.
 */
export const platformConfigurationProjectionIntegrityMigration: PostgresMigration = {
  version: "070-platform-configuration-projection-integrity",
  sql: `
    -- Migration 068 recorded validation failure as the second immutable event,
    -- so align any already-created rows with that event sequence before the
    -- deferred invariant is installed.
    ALTER TABLE fractal.platform_configuration_versions
      DISABLE TRIGGER platform_configuration_version_guard;
    UPDATE fractal.platform_configuration_versions
       SET state_version = 2
     WHERE status = 'validation_failed' AND state_version = 1;
    ALTER TABLE fractal.platform_configuration_versions
      ENABLE TRIGGER platform_configuration_version_guard;

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
      ) THEN
        RAISE EXCEPTION 'platform configuration projection requires its matching immutable event';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS platform_configuration_version_event ON fractal.platform_configuration_versions;
    CREATE CONSTRAINT TRIGGER platform_configuration_version_event
      AFTER INSERT OR UPDATE ON fractal.platform_configuration_versions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_platform_configuration_version_event();

    CREATE OR REPLACE FUNCTION fractal.protect_platform_configuration_active_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'active platform configuration projections are retained';
      END IF;
      IF NEW.configuration_key IS DISTINCT FROM OLD.configuration_key
         OR NEW.projection_version <> OLD.projection_version + 1
         OR NEW.active_version_id = OLD.active_version_id
         OR NEW.bound_at <= OLD.bound_at THEN
        RAISE EXCEPTION 'invalid active platform configuration projection transition';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS platform_configuration_active_projection_guard ON fractal.platform_configuration_active_versions;
    CREATE TRIGGER platform_configuration_active_projection_guard
      BEFORE UPDATE OR DELETE ON fractal.platform_configuration_active_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_platform_configuration_active_projection();

    CREATE OR REPLACE FUNCTION fractal.require_platform_configuration_active_projection_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
          FROM fractal.platform_configuration_versions version
          JOIN fractal.platform_configuration_events event
            ON event.configuration_version_id = version.id
         WHERE version.id = NEW.active_version_id
           AND version.configuration_key = NEW.configuration_key
           AND version.status = 'active'
           AND event.sequence = version.state_version
           AND event.event_type = 'activated'
           AND event.to_status = 'active'
           AND event.evidence ->> 'projectionVersion' = NEW.projection_version::text
      ) THEN
        RAISE EXCEPTION 'active platform configuration projection requires its exact activation event';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS platform_configuration_active_projection_event ON fractal.platform_configuration_active_versions;
    CREATE CONSTRAINT TRIGGER platform_configuration_active_projection_event
      AFTER INSERT OR UPDATE ON fractal.platform_configuration_active_versions
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_platform_configuration_active_projection_event();
  `,
};
