import type { PostgresMigration } from "./types.js";

/** Classified, policy-bound, malware-screened support evidence and download evidence. */
export const supportCaseAttachmentsMigration: PostgresMigration = {
  version: "077-support-case-attachments",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key, label, description, value_type, validation_schema, consumer_binding, status)
    VALUES (
      'support.case.data_policy',
      'Support case data policy',
      'Approved file types, size ceiling, classification-specific retention periods, and evidence rules bound to each support attachment.',
      'json',
      '{"type":"object","required":["policyReference","policyName","maximumBytes","allowedMimeTypes","classifications"],"operationalValidator":"support_case_data_policy_v1"}'::jsonb,
      'next_request',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE
      SET label=EXCLUDED.label, description=EXCLUDED.description, value_type=EXCLUDED.value_type,
          validation_schema=EXCLUDED.validation_schema, consumer_binding=EXCLUDED.consumer_binding, status='active';

    CREATE TABLE IF NOT EXISTS fractal.support_case_attachments (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.support_cases(id),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      command_key TEXT NOT NULL CHECK (length(command_key) BETWEEN 1 AND 200),
      visibility TEXT NOT NULL CHECK (visibility IN ('requester','internal')),
      classification TEXT NOT NULL CHECK (classification IN ('general','personal_data','financial_record','identity_document','security_sensitive')),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240 AND filename !~ '[\\x00-\\x1f\\x7f]'),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 120),
      bytes INTEGER NOT NULL CHECK (bytes > 0 AND bytes <= 15728640),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      storage_key TEXT NOT NULL UNIQUE CHECK (length(storage_key) BETWEEN 10 AND 2000),
      scan_status TEXT NOT NULL CHECK (scan_status = 'clean'),
      scanner TEXT NOT NULL CHECK (scanner = 'clamav_instream'),
      scanned_at TIMESTAMPTZ NOT NULL,
      configuration_key TEXT NOT NULL DEFAULT 'support.case.data_policy' CHECK (configuration_key='support.case.data_policy'),
      policy_version_id UUID NOT NULL,
      policy_version_number INTEGER NOT NULL CHECK (policy_version_number > 0),
      policy_projection_version INTEGER NOT NULL CHECK (policy_projection_version > 0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK (policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      policy_reference TEXT NOT NULL CHECK (length(policy_reference) BETWEEN 3 AND 120),
      policy_name TEXT NOT NULL CHECK (length(policy_name) BETWEEN 10 AND 160),
      retention_days INTEGER NOT NULL CHECK (retention_days BETWEEN 1 AND 3650),
      uploaded_at TIMESTAMPTZ NOT NULL,
      retention_due_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT support_attachment_scan_order CHECK (scanned_at <= uploaded_at),
      CONSTRAINT support_attachment_retention_order CHECK (retention_due_at > uploaded_at),
      CONSTRAINT support_attachment_exact_policy_version FOREIGN KEY (configuration_key, policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id)
      ,UNIQUE (case_id, uploaded_by_identity_id, command_key)
    );
    CREATE INDEX IF NOT EXISTS support_case_attachments_case_idx
      ON fractal.support_case_attachments (case_id, uploaded_at, id);
    CREATE INDEX IF NOT EXISTS support_case_attachments_retention_idx
      ON fractal.support_case_attachments (retention_due_at, id);

    CREATE TABLE IF NOT EXISTS fractal.support_case_attachment_access_events (
      id UUID PRIMARY KEY,
      attachment_id UUID NOT NULL REFERENCES fractal.support_case_attachments(id),
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      access_type TEXT NOT NULL CHECK (access_type='downloaded'),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      integrity_verified BOOLEAN NOT NULL CHECK (integrity_verified),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS support_attachment_access_timeline_idx
      ON fractal.support_case_attachment_access_events (attachment_id, occurred_at, id);

    CREATE OR REPLACE FUNCTION fractal.validate_support_case_attachment()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE policy RECORD; support_case RECORD; expected_retention INTEGER;
    BEGIN
      SELECT version.version_number, version.value_sha256, version.proposed_value, projection.projection_version
        INTO policy
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version ON version.id=projection.active_version_id
       WHERE projection.configuration_key=NEW.configuration_key
         AND projection.active_version_id=NEW.policy_version_id AND version.status='active';
      IF policy IS NULL OR policy.version_number<>NEW.policy_version_number
         OR policy.value_sha256<>NEW.policy_value_sha256
         OR policy.projection_version<>NEW.policy_projection_version THEN
        RAISE EXCEPTION 'support attachment requires the exact active data-policy version';
      END IF;
      expected_retention := (policy.proposed_value->'classifications'->NEW.classification->>'retentionDays')::integer;
      IF policy.proposed_value->>'policyReference' <> NEW.policy_reference
         OR policy.proposed_value->>'policyName' <> NEW.policy_name
         OR expected_retention IS NULL OR expected_retention <> NEW.retention_days
         OR NEW.retention_due_at <> NEW.uploaded_at + make_interval(days=>expected_retention)
         OR NEW.bytes > (policy.proposed_value->>'maximumBytes')::integer
         OR NOT (policy.proposed_value->'allowedMimeTypes' ? NEW.mime_type) THEN
        RAISE EXCEPTION 'support attachment facts do not match the exact approved data policy';
      END IF;
      SELECT requester_identity_id INTO support_case FROM fractal.support_cases WHERE id=NEW.case_id;
      IF support_case IS NULL THEN RAISE EXCEPTION 'support attachment case does not exist'; END IF;
      IF support_case.requester_identity_id=NEW.uploaded_by_identity_id AND NEW.visibility<>'requester' THEN
        RAISE EXCEPTION 'requesters cannot create internal support attachments';
      END IF;
      IF support_case.requester_identity_id<>NEW.uploaded_by_identity_id AND NOT EXISTS (
        SELECT 1 FROM fractal.administrator_capability_assignments assignment
         JOIN fractal.identities identity ON identity.id=assignment.identity_id
        WHERE assignment.identity_id=NEW.uploaded_by_identity_id AND assignment.capability_key='support_case_manage'
          AND assignment.revoked_at IS NULL AND identity.status='active'
      ) THEN RAISE EXCEPTION 'support attachment uploader lacks support capability'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS support_case_attachment_validate ON fractal.support_case_attachments;
    CREATE TRIGGER support_case_attachment_validate BEFORE INSERT ON fractal.support_case_attachments
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_support_case_attachment();

    CREATE OR REPLACE FUNCTION fractal.reject_support_attachment_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'support attachment evidence is immutable'; END; $$;
    DROP TRIGGER IF EXISTS support_case_attachments_immutable ON fractal.support_case_attachments;
    CREATE TRIGGER support_case_attachments_immutable BEFORE UPDATE OR DELETE ON fractal.support_case_attachments
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_support_attachment_mutation();
    DROP TRIGGER IF EXISTS support_case_attachment_access_immutable ON fractal.support_case_attachment_access_events;
    CREATE TRIGGER support_case_attachment_access_immutable BEFORE UPDATE OR DELETE ON fractal.support_case_attachment_access_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_support_attachment_mutation();
  `,
};
