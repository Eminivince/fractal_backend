import type { PostgresMigration } from "./types.js";

/** Preserve exact provider IDs for every durable email command. */
export const emailProviderCorrelationMigration: PostgresMigration = {
  version: "142-email-provider-correlation",
  sql: `
    ALTER TABLE fractal.auth_email_deliveries
      ADD COLUMN IF NOT EXISTS provider TEXT,
      ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

    ALTER TABLE fractal.support_case_notification_deliveries
      ADD COLUMN IF NOT EXISTS provider_message_id TEXT;

    ALTER TABLE fractal.organization_invitations
      ADD COLUMN IF NOT EXISTS delivery_generation INTEGER NOT NULL DEFAULT 1,
      ADD COLUMN IF NOT EXISTS delivery_provider TEXT,
      ADD COLUMN IF NOT EXISTS delivery_provider_message_id TEXT;

    ALTER TABLE fractal.auth_email_deliveries
      DROP CONSTRAINT IF EXISTS auth_email_deliveries_provider_shape,
      ADD CONSTRAINT auth_email_deliveries_provider_shape CHECK (
        (provider IS NULL AND provider_message_id IS NULL)
        OR
        (provider IN ('resend','nodemailer') AND length(provider_message_id) BETWEEN 3 AND 500)
      );
    ALTER TABLE fractal.support_case_notification_deliveries
      DROP CONSTRAINT IF EXISTS support_notification_provider_shape,
      ADD CONSTRAINT support_notification_provider_shape CHECK (
        (provider IS NULL AND provider_message_id IS NULL)
        OR
        (provider IN ('resend','nodemailer') AND length(provider_message_id) BETWEEN 3 AND 500)
        OR
        (status='sent' AND provider IN ('resend','nodemailer') AND provider_message_id IS NULL)
      );
    ALTER TABLE fractal.organization_invitations
      DROP CONSTRAINT IF EXISTS organization_invitation_delivery_generation_check,
      ADD CONSTRAINT organization_invitation_delivery_generation_check CHECK (delivery_generation > 0),
      DROP CONSTRAINT IF EXISTS organization_invitation_provider_shape,
      ADD CONSTRAINT organization_invitation_provider_shape CHECK (
        (delivery_provider IS NULL AND delivery_provider_message_id IS NULL)
        OR
        (delivery_provider IN ('resend','nodemailer') AND length(delivery_provider_message_id) BETWEEN 3 AND 500)
      );

    CREATE UNIQUE INDEX IF NOT EXISTS auth_email_delivery_provider_message_unique
      ON fractal.auth_email_deliveries(provider,provider_message_id)
      WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS support_notification_provider_message_unique
      ON fractal.support_case_notification_deliveries(provider,provider_message_id)
      WHERE provider_message_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS organization_invitation_provider_message_unique
      ON fractal.organization_invitations(delivery_provider,delivery_provider_message_id)
      WHERE delivery_provider_message_id IS NOT NULL;

    CREATE OR REPLACE FUNCTION fractal.reject_duplicate_email_provider_message(
      p_source TEXT,
      p_source_id UUID,
      p_provider TEXT,
      p_provider_message_id TEXT
    ) RETURNS void LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtextextended(
        'email-provider-message:' || p_provider || ':' || p_provider_message_id,
        0
      ));
      IF EXISTS (
        SELECT 1 FROM fractal.auth_email_deliveries delivery
         WHERE delivery.provider=p_provider AND delivery.provider_message_id=p_provider_message_id
           AND NOT (p_source='auth_email_delivery' AND delivery.id=p_source_id)
        UNION ALL
        SELECT 1 FROM fractal.support_case_notification_deliveries delivery
         WHERE delivery.provider=p_provider AND delivery.provider_message_id=p_provider_message_id
           AND NOT (p_source='support_notification' AND delivery.id=p_source_id)
        UNION ALL
        SELECT 1 FROM fractal.organization_invitations invitation
         WHERE invitation.delivery_provider=p_provider
           AND invitation.delivery_provider_message_id=p_provider_message_id
           AND NOT (p_source='organization_invitation' AND invitation.id=p_source_id)
      ) THEN
        RAISE EXCEPTION 'email provider message is already bound to another delivery command';
      END IF;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.validate_auth_email_provider_correlation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (
        OLD.provider IS NOT NULL
        AND (
          NEW.provider IS DISTINCT FROM OLD.provider
          OR (
            OLD.provider_message_id IS NOT NULL
            AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
          )
        )
      ) THEN
        RAISE EXCEPTION 'auth email provider correlation is immutable';
      END IF;
      IF TG_OP='UPDATE' AND OLD.provider IS NULL AND OLD.provider_message_id IS NULL
         AND NEW.status='sent'
         AND (NEW.provider IS NOT NULL OR NEW.provider_message_id IS NOT NULL)
         AND (NEW.provider IS NULL OR NEW.provider_message_id IS NULL) THEN
        RAISE EXCEPTION 'auth email provider correlation must be complete';
      END IF;
      IF TG_OP='INSERT' THEN
        IF NEW.status='sent' AND (NEW.provider IS NULL OR NEW.provider_message_id IS NULL) THEN
          RAISE EXCEPTION 'new sent auth email requires exact provider correlation';
        END IF;
      ELSIF OLD.status<>'sent' AND NEW.status='sent'
         AND (NEW.provider IS NULL OR NEW.provider_message_id IS NULL) THEN
          RAISE EXCEPTION 'new sent auth email requires exact provider correlation';
      END IF;
      IF NEW.status<>'sent' AND (NEW.provider IS NOT NULL OR NEW.provider_message_id IS NOT NULL) THEN
        RAISE EXCEPTION 'auth email provider correlation requires sent status';
      END IF;
      IF NEW.provider_message_id IS NOT NULL THEN
        PERFORM fractal.reject_duplicate_email_provider_message(
          'auth_email_delivery',NEW.id,NEW.provider,NEW.provider_message_id
        );
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS auth_email_provider_correlation_guard ON fractal.auth_email_deliveries;
    CREATE TRIGGER auth_email_provider_correlation_guard
      BEFORE INSERT OR UPDATE ON fractal.auth_email_deliveries
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_auth_email_provider_correlation();

    CREATE OR REPLACE FUNCTION fractal.validate_support_email_provider_correlation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND (
        OLD.provider IS NOT NULL
        AND (
          NEW.provider IS DISTINCT FROM OLD.provider
          OR (
            OLD.provider_message_id IS NOT NULL
            AND NEW.provider_message_id IS DISTINCT FROM OLD.provider_message_id
          )
        )
      ) THEN
        RAISE EXCEPTION 'support email provider correlation is immutable';
      END IF;
      IF TG_OP='UPDATE' AND OLD.provider IS NULL AND OLD.provider_message_id IS NULL
         AND NEW.status='sent'
         AND (NEW.provider IS NOT NULL OR NEW.provider_message_id IS NOT NULL)
         AND (NEW.provider IS NULL OR NEW.provider_message_id IS NULL) THEN
        RAISE EXCEPTION 'support email provider correlation must be complete';
      END IF;
      IF TG_OP='INSERT' THEN
        IF NEW.status='sent' AND (NEW.provider IS NULL OR NEW.provider_message_id IS NULL) THEN
          RAISE EXCEPTION 'new sent support email requires exact provider correlation';
        END IF;
      ELSIF OLD.status<>'sent' AND NEW.status='sent'
         AND (NEW.provider IS NULL OR NEW.provider_message_id IS NULL) THEN
          RAISE EXCEPTION 'new sent support email requires exact provider correlation';
      END IF;
      IF NEW.status<>'sent' AND (NEW.provider IS NOT NULL OR NEW.provider_message_id IS NOT NULL) THEN
        RAISE EXCEPTION 'support email provider correlation requires sent status';
      END IF;
      IF NEW.provider_message_id IS NOT NULL THEN
        PERFORM fractal.reject_duplicate_email_provider_message(
          'support_notification',NEW.id,NEW.provider,NEW.provider_message_id
        );
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_email_provider_correlation_guard ON fractal.support_case_notification_deliveries;
    CREATE TRIGGER support_email_provider_correlation_guard
      BEFORE INSERT OR UPDATE ON fractal.support_case_notification_deliveries
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_support_email_provider_correlation();

    CREATE OR REPLACE FUNCTION fractal.validate_invitation_email_provider_correlation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='UPDATE' AND NEW.delivery_generation<OLD.delivery_generation THEN
        RAISE EXCEPTION 'invitation delivery generation cannot decrease';
      END IF;
      IF TG_OP='UPDATE' AND OLD.delivery_provider_message_id IS NOT NULL
         AND NEW.delivery_generation=OLD.delivery_generation
         AND (
           NEW.delivery_provider IS DISTINCT FROM OLD.delivery_provider
           OR NEW.delivery_provider_message_id IS DISTINCT FROM OLD.delivery_provider_message_id
         ) THEN
        RAISE EXCEPTION 'invitation provider correlation is immutable within one delivery generation';
      END IF;
      IF TG_OP='INSERT' THEN
        IF NEW.delivery_status='sent'
           AND (NEW.delivery_provider IS NULL OR NEW.delivery_provider_message_id IS NULL) THEN
          RAISE EXCEPTION 'new sent invitation requires exact provider correlation';
        END IF;
      ELSIF OLD.delivery_status<>'sent' AND NEW.delivery_status='sent'
         AND (NEW.delivery_provider IS NULL OR NEW.delivery_provider_message_id IS NULL) THEN
          RAISE EXCEPTION 'new sent invitation requires exact provider correlation';
      END IF;
      IF NEW.delivery_status<>'sent'
         AND (NEW.delivery_provider IS NOT NULL OR NEW.delivery_provider_message_id IS NOT NULL) THEN
        IF NOT (
          TG_OP='UPDATE'
          AND NEW.delivery_status='cancelled'
          AND NEW.delivery_generation=OLD.delivery_generation
          AND NEW.delivery_provider IS NOT DISTINCT FROM OLD.delivery_provider
          AND NEW.delivery_provider_message_id IS NOT DISTINCT FROM OLD.delivery_provider_message_id
        ) THEN
          RAISE EXCEPTION 'invitation provider correlation requires sent or retained cancelled status';
        END IF;
      END IF;
      IF NEW.delivery_provider_message_id IS NOT NULL THEN
        PERFORM fractal.reject_duplicate_email_provider_message(
          'organization_invitation',NEW.id,NEW.delivery_provider,NEW.delivery_provider_message_id
        );
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS invitation_email_provider_correlation_guard ON fractal.organization_invitations;
    CREATE TRIGGER invitation_email_provider_correlation_guard
      BEFORE INSERT OR UPDATE ON fractal.organization_invitations
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_invitation_email_provider_correlation();
  `,
};
