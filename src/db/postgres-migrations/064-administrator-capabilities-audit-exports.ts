import type { PostgresMigration } from "./types.js";

/**
 * Separates sensitive administrator evidence access from the coarse global
 * administrator role. Capability changes are maker-checker governed, while
 * audit exports are bounded immutable snapshots whose canonical JSON hash can
 * be verified independently after download.
 */
export const administratorCapabilitiesAuditExportsMigration: PostgresMigration = {
  version: "064-administrator-capabilities-audit-exports",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.administrator_capability_definitions (
      capability_key TEXT PRIMARY KEY,
      label TEXT NOT NULL CHECK (length(label) BETWEEN 3 AND 120),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 10 AND 1000),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('audit_export', 'Audit evidence export', 'Create and retrieve bounded immutable audit-event snapshots containing controlled evidence payloads.')
    ON CONFLICT (capability_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.administrator_capability_change_requests (
      id UUID PRIMARY KEY,
      target_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      capability_key TEXT NOT NULL REFERENCES fractal.administrator_capability_definitions(capability_key),
      change_type TEXT NOT NULL CHECK (change_type IN ('grant', 'revoke')),
      prior_enabled BOOLEAN NOT NULL,
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 2000),
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'applied', 'rejected', 'cancelled')),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 2000),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      applied_at TIMESTAMPTZ,
      CONSTRAINT administrator_capability_change_shape CHECK (
        (change_type = 'grant' AND prior_enabled = FALSE)
        OR (change_type = 'revoke' AND prior_enabled = TRUE)
      ),
      CONSTRAINT administrator_capability_change_status_shape CHECK (
        (status = 'pending' AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND applied_at IS NULL)
        OR (status = 'rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NULL)
        OR (status = 'applied' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND applied_at IS NOT NULL)
        OR (status = 'cancelled' AND reviewed_at IS NULL AND applied_at IS NULL)
      ),
      CONSTRAINT administrator_capability_change_independent_reviewer CHECK (
        reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> requested_by_identity_id
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS administrator_capability_change_pending_unique_idx
      ON fractal.administrator_capability_change_requests (target_identity_id, capability_key)
      WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS administrator_capability_change_queue_idx
      ON fractal.administrator_capability_change_requests (requested_at, id)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS fractal.administrator_capability_assignments (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      capability_key TEXT NOT NULL REFERENCES fractal.administrator_capability_definitions(capability_key),
      granted_by_request_id UUID REFERENCES fractal.administrator_capability_change_requests(id),
      revoked_by_capability_change_request_id UUID REFERENCES fractal.administrator_capability_change_requests(id),
      revoked_by_access_change_request_id UUID REFERENCES fractal.identity_access_change_requests(id),
      granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      CONSTRAINT administrator_capability_assignment_revocation_shape CHECK (
        (revoked_at IS NULL AND revoked_by_capability_change_request_id IS NULL AND revoked_by_access_change_request_id IS NULL)
        OR (revoked_at IS NOT NULL AND num_nonnulls(revoked_by_capability_change_request_id, revoked_by_access_change_request_id) = 1)
      )
    );

    CREATE UNIQUE INDEX IF NOT EXISTS administrator_capability_assignment_active_unique_idx
      ON fractal.administrator_capability_assignments (identity_id, capability_key)
      WHERE revoked_at IS NULL;
    CREATE INDEX IF NOT EXISTS administrator_capability_assignment_identity_history_idx
      ON fractal.administrator_capability_assignments (identity_id, granted_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_administrator_capability_assignment()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'administrator capability assignment history is immutable';
      END IF;
      IF OLD.revoked_at IS NOT NULL THEN
        RAISE EXCEPTION 'revoked administrator capability assignments are immutable';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.identity_id IS DISTINCT FROM OLD.identity_id
         OR NEW.capability_key IS DISTINCT FROM OLD.capability_key
         OR NEW.granted_by_request_id IS DISTINCT FROM OLD.granted_by_request_id
         OR NEW.granted_at IS DISTINCT FROM OLD.granted_at
         OR NEW.revoked_at IS NULL THEN
        RAISE EXCEPTION 'administrator capability assignment facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS administrator_capability_assignment_guard ON fractal.administrator_capability_assignments;
    CREATE TRIGGER administrator_capability_assignment_guard
      BEFORE UPDATE OR DELETE ON fractal.administrator_capability_assignments
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_administrator_capability_assignment();

    -- Establish the first controlled baseline for administrators that predate
    -- this capability model. Future grants and every revocation use the
    -- maker-checker request table above.
    INSERT INTO fractal.administrator_capability_assignments
      (id, identity_id, capability_key)
    SELECT md5(assignment.identity_id::text || ':audit_export')::uuid,
           assignment.identity_id,
           'audit_export'
      FROM fractal.identity_role_assignments assignment
      JOIN fractal.identities identity ON identity.id = assignment.identity_id
     WHERE assignment.role = 'admin'
       AND assignment.scope_type = 'global'
       AND assignment.revoked_at IS NULL
       AND identity.status = 'active'
    ON CONFLICT DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.administrator_audit_exports (
      id UUID PRIMARY KEY,
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      filters JSONB NOT NULL CHECK (jsonb_typeof(filters) = 'object'),
      sequence_high_watermark BIGINT NOT NULL CHECK (sequence_high_watermark >= 0),
      first_sequence BIGINT CHECK (first_sequence IS NULL OR first_sequence > 0),
      last_sequence BIGINT CHECK (last_sequence IS NULL OR last_sequence > 0),
      record_count INTEGER NOT NULL CHECK (record_count BETWEEN 0 AND 5000),
      content_sha256 CHAR(64) NOT NULL UNIQUE CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT administrator_audit_export_sequence_shape CHECK (
        (record_count = 0 AND first_sequence IS NULL AND last_sequence IS NULL)
        OR (record_count > 0 AND first_sequence IS NOT NULL AND last_sequence IS NOT NULL
            AND first_sequence <= last_sequence AND last_sequence <= sequence_high_watermark)
      )
    );
    CREATE INDEX IF NOT EXISTS administrator_audit_exports_requester_idx
      ON fractal.administrator_audit_exports (requested_by_identity_id, created_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_administrator_evidence_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'administrator evidence records are immutable';
    END;
    $$;

    DROP TRIGGER IF EXISTS administrator_audit_exports_immutable ON fractal.administrator_audit_exports;
    CREATE TRIGGER administrator_audit_exports_immutable
      BEFORE UPDATE OR DELETE ON fractal.administrator_audit_exports
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_administrator_evidence_mutation();

    CREATE OR REPLACE FUNCTION fractal.protect_administrator_capability_change()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'administrator capability change records are immutable';
      END IF;
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'terminal administrator capability change records are immutable';
      END IF;
      IF NEW.id <> OLD.id
         OR NEW.target_identity_id <> OLD.target_identity_id
         OR NEW.capability_key <> OLD.capability_key
         OR NEW.change_type <> OLD.change_type
         OR NEW.prior_enabled <> OLD.prior_enabled
         OR NEW.reason <> OLD.reason
         OR NEW.requested_by_identity_id <> OLD.requested_by_identity_id
         OR NEW.requested_at <> OLD.requested_at THEN
        RAISE EXCEPTION 'submitted administrator capability change facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    DROP TRIGGER IF EXISTS administrator_capability_change_guard ON fractal.administrator_capability_change_requests;
    CREATE TRIGGER administrator_capability_change_guard
      BEFORE UPDATE OR DELETE ON fractal.administrator_capability_change_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_administrator_capability_change();
  `,
};
