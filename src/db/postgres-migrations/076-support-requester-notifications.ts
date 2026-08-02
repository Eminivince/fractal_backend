import type { PostgresMigration } from "./types.js";

/** Content-free requester notification commands with durable delivery evidence. */
export const supportRequesterNotificationsMigration: PostgresMigration = {
  version: "076-support-requester-notifications",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.support_case_notification_deliveries (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.support_cases(id),
      case_event_sequence INTEGER NOT NULL CHECK (case_event_sequence > 0),
      recipient_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      notification_type TEXT NOT NULL CHECK (notification_type IN ('opened','staff_reply','waiting_requester','resolved','closed','reopened')),
      channel TEXT NOT NULL DEFAULT 'email' CHECK (channel = 'email'),
      status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','failed','sent','terminal','cancelled')),
      attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      claimed_at TIMESTAMPTZ,
      claimed_by TEXT,
      next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      provider TEXT CHECK (provider IS NULL OR provider IN ('resend','nodemailer')),
      sent_at TIMESTAMPTZ,
      terminal_at TIMESTAMPTZ,
      cancelled_at TIMESTAMPTZ,
      last_error_code TEXT,
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (case_id, case_event_sequence, recipient_identity_id, channel),
      CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
      CHECK ((status = 'terminal') = (terminal_at IS NOT NULL)),
      CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
      CHECK (status NOT IN ('sent','terminal','cancelled') OR claimed_at IS NULL)
    );
    CREATE INDEX IF NOT EXISTS support_notification_claimable_idx ON fractal.support_case_notification_deliveries (next_attempt_at,requested_at,id) WHERE status IN ('requested','failed');
    CREATE INDEX IF NOT EXISTS support_notification_case_idx ON fractal.support_case_notification_deliveries (case_id,case_event_sequence,id);

    CREATE OR REPLACE FUNCTION fractal.require_exact_support_notification()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE event RECORD; support_case RECORD; expected_type TEXT;
    BEGIN
      SELECT event_type,visibility,actor_identity_id INTO event FROM fractal.support_case_events WHERE case_id=NEW.case_id AND sequence=NEW.case_event_sequence;
      SELECT requester_identity_id INTO support_case FROM fractal.support_cases WHERE id=NEW.case_id;
      expected_type := CASE event.event_type
        WHEN 'opened' THEN 'opened' WHEN 'staff_message' THEN 'staff_reply'
        WHEN 'resolved' THEN 'resolved' WHEN 'closed' THEN 'closed' WHEN 'reopened' THEN 'reopened'
        WHEN 'status_changed' THEN 'waiting_requester' ELSE NULL END;
      IF event IS NULL OR event.visibility <> 'requester' OR NEW.recipient_identity_id <> support_case.requester_identity_id
         OR NEW.notification_type <> expected_type THEN
        RAISE EXCEPTION 'support notification requires its exact requester-visible case event';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_notification_binding ON fractal.support_case_notification_deliveries;
    CREATE TRIGGER support_notification_binding BEFORE INSERT ON fractal.support_case_notification_deliveries FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_support_notification();

    CREATE OR REPLACE FUNCTION fractal.protect_support_notification_facts()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'support notification evidence is retained'; END IF;
      IF NEW.id<>OLD.id OR NEW.case_id<>OLD.case_id OR NEW.case_event_sequence<>OLD.case_event_sequence
         OR NEW.recipient_identity_id<>OLD.recipient_identity_id OR NEW.notification_type<>OLD.notification_type
         OR NEW.channel<>OLD.channel OR NEW.requested_at<>OLD.requested_at OR NEW.attempts<OLD.attempts
         OR OLD.status IN ('sent','terminal','cancelled') THEN
        RAISE EXCEPTION 'support notification source or terminal evidence is immutable';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_notifications_guard ON fractal.support_case_notification_deliveries;
    CREATE TRIGGER support_notifications_guard BEFORE UPDATE OR DELETE ON fractal.support_case_notification_deliveries FOR EACH ROW EXECUTE FUNCTION fractal.protect_support_notification_facts();
  `,
};
