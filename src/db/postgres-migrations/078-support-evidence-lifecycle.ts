import type { PostgresMigration } from "./types.js";

/** Maker-checker legal holds and retention-gated deletion for classified support evidence. */
export const supportEvidenceLifecycleMigration: PostgresMigration = {
  version: "078-support-evidence-lifecycle",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('data_lifecycle_manage', 'Data lifecycle management', 'Propose and independently decide legal holds, releases, and retention-gated evidence disposition.')
    ON CONFLICT (capability_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.data_legal_hold_change_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^HLD-[0-9]{8}-[A-Z0-9]{8}$'),
      target_type TEXT NOT NULL CHECK (target_type IN ('identity','support_case','support_attachment')),
      target_id UUID NOT NULL,
      change_type TEXT NOT NULL CHECK (change_type IN ('impose','release')),
      reason_category TEXT NOT NULL CHECK (reason_category IN ('litigation','regulatory_request','audit','investigation','complaint','security_incident')),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 20 AND 2000),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 20 AND 2000),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT data_hold_change_independent_reviewer CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> requested_by_identity_id),
      CONSTRAINT data_hold_change_status_shape CHECK (
        (status='pending' AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
        OR (status='applied' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      UNIQUE (requested_by_identity_id,command_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS data_hold_change_pending_target_idx
      ON fractal.data_legal_hold_change_requests (target_type,target_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS data_hold_change_queue_idx
      ON fractal.data_legal_hold_change_requests (requested_at,id) WHERE status='pending';

    CREATE TABLE IF NOT EXISTS fractal.data_legal_holds (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^HLDA-[0-9]{8}-[A-Z0-9]{8}$'),
      target_type TEXT NOT NULL CHECK (target_type IN ('identity','support_case','support_attachment')),
      target_id UUID NOT NULL,
      imposed_by_change_request_id UUID NOT NULL UNIQUE REFERENCES fractal.data_legal_hold_change_requests(id),
      released_by_change_request_id UUID UNIQUE REFERENCES fractal.data_legal_hold_change_requests(id),
      imposed_at TIMESTAMPTZ NOT NULL,
      released_at TIMESTAMPTZ,
      CONSTRAINT data_legal_hold_release_shape CHECK (
        (released_at IS NULL AND released_by_change_request_id IS NULL)
        OR (released_at IS NOT NULL AND released_by_change_request_id IS NOT NULL AND released_at >= imposed_at)
      )
    );
    CREATE UNIQUE INDEX IF NOT EXISTS data_legal_holds_active_target_idx
      ON fractal.data_legal_holds (target_type,target_id) WHERE released_at IS NULL;
    CREATE INDEX IF NOT EXISTS data_legal_holds_history_idx
      ON fractal.data_legal_holds (target_type,target_id,imposed_at,id);

    CREATE TABLE IF NOT EXISTS fractal.support_attachment_disposition_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK (reference ~ '^DSP-[0-9]{8}-[A-Z0-9]{8}$'),
      attachment_id UUID NOT NULL REFERENCES fractal.support_case_attachments(id),
      action TEXT NOT NULL CHECK (action='delete_object'),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 20 AND 2000),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      retention_due_at_snapshot TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected')),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 20 AND 2000),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT support_disposition_independent_reviewer CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> requested_by_identity_id),
      CONSTRAINT support_disposition_status_shape CHECK (
        (status='pending' AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
        OR (status='applied' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
      ),
      UNIQUE (requested_by_identity_id,command_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS support_disposition_pending_attachment_idx
      ON fractal.support_attachment_disposition_requests (attachment_id) WHERE status='pending';
    CREATE INDEX IF NOT EXISTS support_disposition_queue_idx
      ON fractal.support_attachment_disposition_requests (requested_at,id) WHERE status='pending';

    CREATE TABLE IF NOT EXISTS fractal.support_attachment_dispositions (
      id UUID PRIMARY KEY,
      attachment_id UUID NOT NULL UNIQUE REFERENCES fractal.support_case_attachments(id),
      disposition_request_id UUID NOT NULL UNIQUE REFERENCES fractal.support_attachment_disposition_requests(id),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      status TEXT NOT NULL CHECK (status IN ('cleanup_requested','completed','failed')),
      approved_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      CONSTRAINT support_attachment_disposition_status_shape CHECK (
        (status='cleanup_requested' AND completed_at IS NULL AND failed_at IS NULL)
        OR (status='completed' AND completed_at IS NOT NULL AND failed_at IS NULL)
        OR (status='failed' AND completed_at IS NULL AND failed_at IS NOT NULL)
      )
    );

    ALTER TABLE fractal.storage_cleanup_tasks
      ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'orphan_cleanup'
        CHECK (purpose IN ('orphan_cleanup','governed_disposition')),
      ADD COLUMN IF NOT EXISTS governed_disposition_id UUID REFERENCES fractal.support_attachment_dispositions(id);
    CREATE UNIQUE INDEX IF NOT EXISTS storage_cleanup_governed_disposition_idx
      ON fractal.storage_cleanup_tasks (governed_disposition_id) WHERE governed_disposition_id IS NOT NULL;
    ALTER TABLE fractal.storage_cleanup_tasks DROP CONSTRAINT IF EXISTS storage_cleanup_governed_purpose_shape;
    ALTER TABLE fractal.storage_cleanup_tasks ADD CONSTRAINT storage_cleanup_governed_purpose_shape CHECK (
      (purpose='orphan_cleanup' AND governed_disposition_id IS NULL)
      OR (purpose='governed_disposition' AND governed_disposition_id IS NOT NULL)
    );

    CREATE OR REPLACE FUNCTION fractal.data_lifecycle_target_exists(target_type TEXT,target_id UUID)
    RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF target_type='identity' THEN RETURN EXISTS (SELECT 1 FROM fractal.identities WHERE id=target_id); END IF;
      IF target_type='support_case' THEN RETURN EXISTS (SELECT 1 FROM fractal.support_cases WHERE id=target_id); END IF;
      IF target_type='support_attachment' THEN RETURN EXISTS (SELECT 1 FROM fractal.support_case_attachments WHERE id=target_id); END IF;
      RETURN FALSE;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.identity_has_data_lifecycle_capability(identity_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM fractal.administrator_capability_assignments assignment
        JOIN fractal.identities identity ON identity.id=assignment.identity_id
        WHERE assignment.identity_id=$1 AND assignment.capability_key='data_lifecycle_manage'
          AND assignment.revoked_at IS NULL AND identity.status='active'
      );
    $$;

    CREATE OR REPLACE FUNCTION fractal.data_lifecycle_target_has_disposition(target_type TEXT,target_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM fractal.support_attachment_dispositions disposition
        JOIN fractal.support_case_attachments attachment ON attachment.id=disposition.attachment_id
        JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id
        WHERE (target_type='support_attachment' AND attachment.id=target_id)
           OR (target_type='support_case' AND support_case.id=target_id)
           OR (target_type='identity' AND support_case.requester_identity_id=target_id)
      );
    $$;

    CREATE OR REPLACE FUNCTION fractal.validate_data_hold_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE active_hold RECORD;
    BEGIN
      IF NOT fractal.data_lifecycle_target_exists(NEW.target_type,NEW.target_id) THEN RAISE EXCEPTION 'legal hold target does not exist'; END IF;
      IF NOT fractal.identity_has_data_lifecycle_capability(NEW.requested_by_identity_id) THEN RAISE EXCEPTION 'legal hold requester lacks data lifecycle capability'; END IF;
      SELECT * INTO active_hold FROM fractal.data_legal_holds hold_record
       WHERE hold_record.target_type=NEW.target_type AND hold_record.target_id=NEW.target_id AND hold_record.released_at IS NULL;
      IF NEW.change_type='impose' AND active_hold IS NOT NULL THEN RAISE EXCEPTION 'an active legal hold already exists for this target'; END IF;
      IF NEW.change_type='release' AND active_hold IS NULL THEN RAISE EXCEPTION 'no active legal hold exists for this target'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS data_hold_change_validate ON fractal.data_legal_hold_change_requests;
    CREATE TRIGGER data_hold_change_validate BEFORE INSERT ON fractal.data_legal_hold_change_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_data_hold_change();

    CREATE OR REPLACE FUNCTION fractal.protect_data_hold_change()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'legal hold change evidence is immutable'; END IF;
      IF OLD.status<>'pending' THEN RAISE EXCEPTION 'terminal legal hold change evidence is immutable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.target_type<>OLD.target_type OR NEW.target_id<>OLD.target_id
         OR NEW.change_type<>OLD.change_type OR NEW.reason_category<>OLD.reason_category OR NEW.reason<>OLD.reason
         OR NEW.command_key<>OLD.command_key
         OR NEW.requested_by_identity_id<>OLD.requested_by_identity_id OR NEW.requested_at<>OLD.requested_at THEN
        RAISE EXCEPTION 'submitted legal hold change facts are immutable';
      END IF;
      IF NOT fractal.identity_has_data_lifecycle_capability(NEW.reviewed_by_identity_id) THEN RAISE EXCEPTION 'legal hold reviewer lacks data lifecycle capability'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS data_hold_change_guard ON fractal.data_legal_hold_change_requests;
    CREATE TRIGGER data_hold_change_guard BEFORE UPDATE OR DELETE ON fractal.data_legal_hold_change_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_data_hold_change();

    CREATE OR REPLACE FUNCTION fractal.protect_data_legal_hold()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'legal hold history is immutable'; END IF;
      IF OLD.released_at IS NOT NULL THEN RAISE EXCEPTION 'released legal hold history is immutable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.target_type<>OLD.target_type OR NEW.target_id<>OLD.target_id
         OR NEW.imposed_by_change_request_id<>OLD.imposed_by_change_request_id OR NEW.imposed_at<>OLD.imposed_at
         OR NEW.released_at IS NULL OR NEW.released_by_change_request_id IS NULL THEN RAISE EXCEPTION 'legal hold facts are immutable'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS data_legal_hold_guard ON fractal.data_legal_holds;
    CREATE TRIGGER data_legal_hold_guard BEFORE UPDATE OR DELETE ON fractal.data_legal_holds
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_data_legal_hold();

    CREATE OR REPLACE FUNCTION fractal.protect_support_disposition_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'support disposition evidence is immutable'; END IF;
      IF OLD.status<>'pending' THEN RAISE EXCEPTION 'terminal support disposition evidence is immutable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.attachment_id<>OLD.attachment_id OR NEW.action<>OLD.action
         OR NEW.reason<>OLD.reason OR NEW.retention_due_at_snapshot<>OLD.retention_due_at_snapshot
         OR NEW.command_key<>OLD.command_key
         OR NEW.requested_by_identity_id<>OLD.requested_by_identity_id OR NEW.requested_at<>OLD.requested_at THEN
        RAISE EXCEPTION 'submitted support disposition facts are immutable';
      END IF;
      IF NOT fractal.identity_has_data_lifecycle_capability(NEW.reviewed_by_identity_id) THEN RAISE EXCEPTION 'support disposition reviewer lacks data lifecycle capability'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_disposition_request_guard ON fractal.support_attachment_disposition_requests;
    CREATE TRIGGER support_disposition_request_guard BEFORE UPDATE OR DELETE ON fractal.support_attachment_disposition_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_support_disposition_request();

    CREATE OR REPLACE FUNCTION fractal.validate_support_disposition_request_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE attachment RECORD;
    BEGIN
      IF NOT fractal.identity_has_data_lifecycle_capability(NEW.requested_by_identity_id) THEN RAISE EXCEPTION 'support disposition requester lacks data lifecycle capability'; END IF;
      SELECT support_attachment.retention_due_at,support_attachment.case_id,support_case.requester_identity_id
        INTO attachment FROM fractal.support_case_attachments support_attachment
        JOIN fractal.support_cases support_case ON support_case.id=support_attachment.case_id
       WHERE support_attachment.id=NEW.attachment_id;
      IF attachment IS NULL OR NEW.retention_due_at_snapshot<>attachment.retention_due_at THEN RAISE EXCEPTION 'support disposition requires the exact attachment retention deadline'; END IF;
      IF attachment.retention_due_at>now() THEN RAISE EXCEPTION 'support attachment retention period has not elapsed'; END IF;
      IF EXISTS (SELECT 1 FROM fractal.support_attachment_dispositions WHERE attachment_id=NEW.attachment_id) THEN RAISE EXCEPTION 'support attachment already has a disposition'; END IF;
      IF EXISTS (
        SELECT 1 FROM fractal.data_legal_holds hold_record WHERE hold_record.released_at IS NULL AND (
          (hold_record.target_type='support_attachment' AND hold_record.target_id=NEW.attachment_id)
          OR (hold_record.target_type='support_case' AND hold_record.target_id=attachment.case_id)
          OR (hold_record.target_type='identity' AND hold_record.target_id=attachment.requester_identity_id)
        )
      ) THEN RAISE EXCEPTION 'support attachment is protected by an active legal hold'; END IF;
      IF EXISTS (
        SELECT 1 FROM fractal.data_legal_hold_change_requests hold_request WHERE hold_request.status='pending' AND hold_request.change_type='impose' AND (
          (hold_request.target_type='support_attachment' AND hold_request.target_id=NEW.attachment_id)
          OR (hold_request.target_type='support_case' AND hold_request.target_id=attachment.case_id)
          OR (hold_request.target_type='identity' AND hold_request.target_id=attachment.requester_identity_id)
        )
      ) THEN RAISE EXCEPTION 'support attachment is protected by a pending legal hold request'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_disposition_request_validate ON fractal.support_attachment_disposition_requests;
    CREATE TRIGGER support_disposition_request_validate BEFORE INSERT ON fractal.support_attachment_disposition_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_support_disposition_request_insert();

    CREATE OR REPLACE FUNCTION fractal.validate_data_legal_hold_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE change_request RECORD;
    BEGIN
      IF TG_OP='INSERT' THEN
        SELECT * INTO change_request FROM fractal.data_legal_hold_change_requests WHERE id=NEW.imposed_by_change_request_id;
        IF change_request IS NULL OR change_request.status<>'applied' OR change_request.change_type<>'impose'
           OR change_request.target_type<>NEW.target_type OR change_request.target_id<>NEW.target_id OR change_request.applied_at<>NEW.imposed_at THEN
          RAISE EXCEPTION 'legal hold requires its exact applied impose request';
        END IF;
        IF fractal.data_lifecycle_target_has_disposition(NEW.target_type,NEW.target_id) THEN
          RAISE EXCEPTION 'a legal hold cannot be imposed after governed disposition began';
        END IF;
      ELSE
        SELECT * INTO change_request FROM fractal.data_legal_hold_change_requests WHERE id=NEW.released_by_change_request_id;
        IF change_request IS NULL OR change_request.status<>'applied' OR change_request.change_type<>'release'
           OR change_request.target_type<>NEW.target_type OR change_request.target_id<>NEW.target_id OR change_request.applied_at<>NEW.released_at THEN
          RAISE EXCEPTION 'legal hold release requires its exact applied release request';
        END IF;
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS data_legal_hold_projection_validate ON fractal.data_legal_holds;
    CREATE TRIGGER data_legal_hold_projection_validate BEFORE INSERT OR UPDATE ON fractal.data_legal_holds
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_data_legal_hold_projection();

    CREATE OR REPLACE FUNCTION fractal.require_data_hold_change_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status='applied' AND (
        (NEW.change_type='impose' AND NOT EXISTS (SELECT 1 FROM fractal.data_legal_holds WHERE imposed_by_change_request_id=NEW.id))
        OR (NEW.change_type='release' AND NOT EXISTS (SELECT 1 FROM fractal.data_legal_holds WHERE released_by_change_request_id=NEW.id))
      ) THEN RAISE EXCEPTION 'applied legal hold change requires its projection'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS data_hold_change_projection_required ON fractal.data_legal_hold_change_requests;
    CREATE CONSTRAINT TRIGGER data_hold_change_projection_required AFTER UPDATE ON fractal.data_legal_hold_change_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_data_hold_change_projection();

    CREATE OR REPLACE FUNCTION fractal.validate_support_attachment_disposition_insert()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE request_record RECORD; attachment_digest CHAR(64);
    BEGIN
      SELECT * INTO request_record FROM fractal.support_attachment_disposition_requests WHERE id=NEW.disposition_request_id;
      SELECT content_sha256 INTO attachment_digest FROM fractal.support_case_attachments WHERE id=NEW.attachment_id;
      IF request_record IS NULL OR request_record.status<>'applied' OR request_record.attachment_id<>NEW.attachment_id
         OR request_record.applied_at<>NEW.approved_at OR attachment_digest<>NEW.content_sha256 THEN
        RAISE EXCEPTION 'support attachment disposition requires its exact applied request and digest';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_attachment_disposition_validate ON fractal.support_attachment_dispositions;
    CREATE TRIGGER support_attachment_disposition_validate BEFORE INSERT ON fractal.support_attachment_dispositions
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_support_attachment_disposition_insert();

    CREATE OR REPLACE FUNCTION fractal.require_support_disposition_projection()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status='applied' AND NOT EXISTS (SELECT 1 FROM fractal.support_attachment_dispositions WHERE disposition_request_id=NEW.id) THEN
        RAISE EXCEPTION 'applied support disposition request requires its projection';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_disposition_projection_required ON fractal.support_attachment_disposition_requests;
    CREATE CONSTRAINT TRIGGER support_disposition_projection_required AFTER UPDATE ON fractal.support_attachment_disposition_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_support_disposition_projection();

    CREATE OR REPLACE FUNCTION fractal.protect_support_attachment_disposition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'support attachment disposition evidence is immutable'; END IF;
      IF OLD.status<>'cleanup_requested' OR NEW.status NOT IN ('completed','failed')
         OR NEW.id<>OLD.id OR NEW.attachment_id<>OLD.attachment_id OR NEW.disposition_request_id<>OLD.disposition_request_id
         OR NEW.content_sha256<>OLD.content_sha256 OR NEW.approved_at<>OLD.approved_at THEN
        RAISE EXCEPTION 'support attachment disposition facts are immutable';
      END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_attachment_disposition_guard ON fractal.support_attachment_dispositions;
    CREATE TRIGGER support_attachment_disposition_guard BEFORE UPDATE OR DELETE ON fractal.support_attachment_dispositions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_support_attachment_disposition();
  `,
};
