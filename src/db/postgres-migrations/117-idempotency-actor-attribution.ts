import type { PostgresMigration } from "./types.js";

/** Binds every new idempotent command to an immutable actor and preserves unverifiable legacy rows explicitly. */
export const idempotencyActorAttributionMigration: PostgresMigration = {
  version: "117-idempotency-actor-attribution",
  sql: `
    ALTER TABLE fractal.idempotency_commands
      ADD COLUMN actor_identity_id UUID REFERENCES fractal.identities(id) ON DELETE RESTRICT,
      ADD COLUMN attribution_status TEXT NOT NULL DEFAULT 'legacy_unattributed';

    WITH parsed AS (
      SELECT command.id,
             substring(command.scope_key FROM '([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$')::uuid AS actor_identity_id
        FROM fractal.idempotency_commands command
       WHERE command.scope_key ~ '^(identity|administrator-provider-incident|administrator-audit-export|administrator-capability|platform-content|support-case|administrator-support-case|platform-configuration):[0-9a-f-]{36}$'
    )
    UPDATE fractal.idempotency_commands command
       SET actor_identity_id=parsed.actor_identity_id,attribution_status='attributed'
      FROM parsed
      JOIN fractal.identities identity ON identity.id=parsed.actor_identity_id
     WHERE command.id=parsed.id;

    WITH candidates AS (
      SELECT DISTINCT ON (command.id) command.id,event.actor_id
        FROM fractal.idempotency_commands command
        JOIN fractal.audit_events event
          ON event.actor_id IS NOT NULL
         AND event.occurred_at BETWEEN command.created_at - interval '1 second' AND command.created_at + interval '5 minutes'
         AND (
           (command.route IN ('organization.invitation.issue','organization.invitation.resend')
             AND event.entity_type='organization_invitation' AND event.entity_id=command.response_body->>'invitationId')
           OR (command.route='organization.verification.submit'
             AND event.entity_type='organization_verification_request' AND event.entity_id=command.response_body->>'requestId')
           OR (command.route LIKE 'organization.ownership-transfer.%'
             AND event.entity_type='organization_ownership_transfer' AND event.entity_id=command.response_body->>'transferId')
         )
        JOIN fractal.identities identity ON identity.id=event.actor_id
       WHERE command.attribution_status='legacy_unattributed'
       ORDER BY command.id,event.occurred_at,event.sequence
    )
    UPDATE fractal.idempotency_commands command
       SET actor_identity_id=candidates.actor_id,attribution_status='attributed'
      FROM candidates
     WHERE command.id=candidates.id;

    ALTER TABLE fractal.idempotency_commands
      ALTER COLUMN attribution_status SET DEFAULT 'attributed',
      ADD CONSTRAINT idempotency_commands_attribution_status_check CHECK (attribution_status IN ('attributed','legacy_unattributed')),
      ADD CONSTRAINT idempotency_commands_attribution_shape CHECK (
        (attribution_status='attributed' AND actor_identity_id IS NOT NULL)
        OR (attribution_status='legacy_unattributed' AND actor_identity_id IS NULL)
      );
    CREATE INDEX idempotency_commands_actor_created_idx
      ON fractal.idempotency_commands (actor_identity_id,created_at,id)
      WHERE actor_identity_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION fractal.guard_idempotency_command_attribution()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='INSERT' AND (NEW.attribution_status<>'attributed' OR NEW.actor_identity_id IS NULL) THEN
        RAISE EXCEPTION 'new idempotency commands require an attributed actor';
      END IF;
      IF TG_OP='UPDATE' AND (
        NEW.actor_identity_id IS DISTINCT FROM OLD.actor_identity_id
        OR NEW.attribution_status IS DISTINCT FROM OLD.attribution_status
      ) THEN
        RAISE EXCEPTION 'idempotency command attribution is immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER idempotency_commands_attribution_guard
      BEFORE INSERT OR UPDATE ON fractal.idempotency_commands
      FOR EACH ROW EXECUTE FUNCTION fractal.guard_idempotency_command_attribution();

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    UPDATE fractal.privacy_data_sources
       SET blocker='Every new idempotent command is now bound to an immutable actor and cross-actor replay is rejected. Access collection remains unavailable until all explicitly legacy-unattributed replay rows have expired, been removed through an approved retention operation, and a bounded collector is activated.'
     WHERE source_key='postgres.fractal.idempotency_commands';
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
