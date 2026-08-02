import type { PostgresMigration } from "./types.js";

/** Approved response-policy versions and exact immutable request deadline bindings. */
export const privacyRightsResponsePolicyMigration: PostgresMigration = {
  version: "080-privacy-rights-response-policy",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding,status)
    VALUES (
      'privacy.rights.response_policy',
      'Privacy rights response policy',
      'Approved jurisdiction, controller, identity-assurance, communication-channel, and response-clock rules bound to authenticated privacy-rights requests.',
      'json',
      '{"type":"object","required":["policyReference","policyName","jurisdiction","controllerName","identityAssurance","communicationChannel","deadlineBasis","responseCalendarDays"],"operationalValidator":"privacy_rights_response_policy_v1"}'::jsonb,
      'next_request',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE
      SET label=EXCLUDED.label,description=EXCLUDED.description,value_type=EXCLUDED.value_type,
          validation_schema=EXCLUDED.validation_schema,consumer_binding=EXCLUDED.consumer_binding,status='active';

    CREATE TABLE IF NOT EXISTS fractal.privacy_rights_policy_bindings (
      privacy_request_id UUID PRIMARY KEY REFERENCES fractal.privacy_rights_requests(id) ON DELETE RESTRICT,
      configuration_key TEXT NOT NULL DEFAULT 'privacy.rights.response_policy'
        CHECK (configuration_key='privacy.rights.response_policy'),
      policy_version_id UUID NOT NULL,
      policy_version_number INTEGER NOT NULL CHECK (policy_version_number > 0),
      policy_projection_version INTEGER NOT NULL CHECK (policy_projection_version > 0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK (policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      policy_reference TEXT NOT NULL CHECK (length(policy_reference) BETWEEN 3 AND 120),
      policy_name TEXT NOT NULL CHECK (length(policy_name) BETWEEN 10 AND 160),
      jurisdiction TEXT NOT NULL CHECK (length(jurisdiction) BETWEEN 2 AND 120),
      controller_name TEXT NOT NULL CHECK (length(controller_name) BETWEEN 3 AND 200),
      identity_assurance TEXT NOT NULL CHECK (identity_assurance='authenticated_verified_email_session'),
      communication_channel TEXT NOT NULL CHECK (communication_channel='authenticated_register'),
      deadline_basis TEXT NOT NULL CHECK (deadline_basis='calendar_days_from_authenticated_intake'),
      response_calendar_days INTEGER NOT NULL CHECK (response_calendar_days BETWEEN 1 AND 365),
      request_created_at TIMESTAMPTZ NOT NULL,
      due_at TIMESTAMPTZ NOT NULL,
      bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT privacy_policy_binding_exact_version FOREIGN KEY (configuration_key,policy_version_id)
        REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      CONSTRAINT privacy_policy_binding_exact_deadline CHECK (
        due_at = request_created_at + response_calendar_days * interval '1 day'
      )
    );
    CREATE INDEX IF NOT EXISTS privacy_policy_binding_due_queue_idx
      ON fractal.privacy_rights_policy_bindings (due_at,privacy_request_id);

    CREATE OR REPLACE FUNCTION fractal.require_exact_active_privacy_response_policy()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_policy RECORD;
    BEGIN
      SELECT request.created_at,request.request_type,request.identity_assurance,
             version.version_number,version.value_sha256,version.proposed_value,projection.projection_version
        INTO exact_policy
        FROM fractal.privacy_rights_requests request
        JOIN fractal.platform_configuration_active_versions projection
          ON projection.configuration_key=NEW.configuration_key
        JOIN fractal.platform_configuration_versions version
          ON version.id=projection.active_version_id AND version.status='active'
       WHERE request.id=NEW.privacy_request_id AND version.id=NEW.policy_version_id;
      IF exact_policy IS NULL
         OR NEW.request_created_at <> exact_policy.created_at
         OR NEW.policy_version_number <> exact_policy.version_number
         OR NEW.policy_projection_version <> exact_policy.projection_version
         OR NEW.policy_value_sha256 <> exact_policy.value_sha256
         OR NEW.policy_reference <> exact_policy.proposed_value->>'policyReference'
         OR NEW.policy_name <> exact_policy.proposed_value->>'policyName'
         OR NEW.jurisdiction <> exact_policy.proposed_value->>'jurisdiction'
         OR NEW.controller_name <> exact_policy.proposed_value->>'controllerName'
         OR NEW.identity_assurance <> exact_policy.identity_assurance
         OR NEW.identity_assurance <> exact_policy.proposed_value->>'identityAssurance'
         OR NEW.communication_channel <> exact_policy.proposed_value->>'communicationChannel'
         OR NEW.deadline_basis <> exact_policy.proposed_value->>'deadlineBasis'
         OR NEW.response_calendar_days <> (exact_policy.proposed_value->'responseCalendarDays'->>exact_policy.request_type)::integer
      THEN RAISE EXCEPTION 'privacy request requires the exact active response-policy version'; END IF;
      RETURN NEW;
    END; $$;
    DROP TRIGGER IF EXISTS privacy_policy_binding_exact_active ON fractal.privacy_rights_policy_bindings;
    CREATE TRIGGER privacy_policy_binding_exact_active BEFORE INSERT ON fractal.privacy_rights_policy_bindings
      FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_active_privacy_response_policy();

    CREATE OR REPLACE FUNCTION fractal.reject_privacy_policy_binding_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'privacy response-policy binding evidence is immutable'; END; $$;
    DROP TRIGGER IF EXISTS privacy_policy_bindings_immutable ON fractal.privacy_rights_policy_bindings;
    CREATE TRIGGER privacy_policy_bindings_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_rights_policy_bindings
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_policy_binding_mutation();
  `,
};
