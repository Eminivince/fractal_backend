import type { PostgresMigration } from "./types.js";

/** Target-specific, independently approved privacy treatment evidence for governed distribution anchors. */
export const distributionPrivacyTreatmentAuthorityMigration: PostgresMigration = {
  version: "133-distribution-privacy-treatment-authority",
  sql: `
    CREATE TABLE fractal.distribution_privacy_treatment_requests (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DPT-[0-9]{8}-[A-Z0-9]{8}$'),
      privacy_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_requests(id),
      privacy_decision_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_decision_requests(id),
      lifecycle_binding_id UUID NOT NULL REFERENCES fractal.distribution_lifecycle_policy_bindings(id),
      requester_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      target_type TEXT NOT NULL CHECK(target_type IN('ownership_snapshot','distribution_declaration','distribution_payout_exception','distribution_tax_remittance')),
      target_id UUID NOT NULL,
      treatment_type TEXT NOT NULL CHECK(treatment_type IN('correction','erasure','restriction','objection')),
      policy_treatment_mode TEXT NOT NULL CHECK(policy_treatment_mode IN(
        'append_only_domain_correction','retain_then_review_for_minimization_or_disposition',
        'mandatory_processing_only','documented_lawful_basis_review')),
      decision_scope_category TEXT NOT NULL CHECK(length(decision_scope_category) BETWEEN 2 AND 120),
      decision_scope_action TEXT NOT NULL CHECK(decision_scope_action IN('correct','retain','restrict','refuse')),
      treatment_statement TEXT NOT NULL CHECK(length(treatment_statement) BETWEEN 20 AND 2000),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN('pending','approved','rejected')),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      proposed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      review_reason TEXT CHECK(review_reason IS NULL OR length(review_reason) BETWEEN 20 AND 2000),
      requester_visible_summary TEXT CHECK(requester_visible_summary IS NULL OR length(requester_visible_summary) BETWEEN 20 AND 2000),
      proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      UNIQUE(proposed_by_identity_id,command_key),
      UNIQUE(privacy_request_id,lifecycle_binding_id),
      CHECK(reviewed_by_identity_id IS NULL OR reviewed_by_identity_id<>proposed_by_identity_id),
      CHECK(
        (status='pending' AND reviewed_by_identity_id IS NULL AND review_reason IS NULL AND requester_visible_summary IS NULL AND reviewed_at IS NULL)
        OR (status IN('approved','rejected') AND reviewed_by_identity_id IS NOT NULL AND review_reason IS NOT NULL AND requester_visible_summary IS NOT NULL AND reviewed_at IS NOT NULL))
    );
    CREATE INDEX distribution_privacy_treatment_queue_idx ON fractal.distribution_privacy_treatment_requests(status,proposed_at,id);
    CREATE INDEX distribution_privacy_treatment_subject_idx ON fractal.distribution_privacy_treatment_requests(requester_identity_id,proposed_at,id);

    CREATE TABLE fractal.distribution_privacy_treatment_executions (
      id UUID PRIMARY KEY,
      treatment_request_id UUID NOT NULL UNIQUE REFERENCES fractal.distribution_privacy_treatment_requests(id),
      execution_result TEXT NOT NULL CHECK(execution_result IN(
        'append_only_correction_recorded','lawful_retention_confirmed',
        'mandatory_processing_restriction_applied','objection_lawful_basis_review_recorded')),
      lawful_basis TEXT NOT NULL CHECK(length(lawful_basis) BETWEEN 20 AND 2000),
      policy_version_id UUID NOT NULL,
      policy_value_sha256 CHAR(64) NOT NULL CHECK(policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 120),
      retain_until TIMESTAMPTZ NOT NULL,
      legal_hold_active BOOLEAN NOT NULL,
      executed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_privacy_treatment_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source RECORD; scope_action TEXT; expected_mode TEXT;
    BEGIN
      SELECT request.requester_identity_id,request.request_type,decision.status AS decision_status,decision.requested_by_identity_id,
             decision.scope_outcomes,binding.organization_id,binding.target_type,binding.target_id,
             binding.correction_treatment,binding.erasure_treatment,binding.restriction_treatment,binding.objection_treatment
        INTO source
        FROM fractal.privacy_rights_requests request
        JOIN fractal.privacy_rights_policy_bindings response_binding ON response_binding.privacy_request_id=request.id
        JOIN fractal.privacy_rights_decision_requests decision
          ON decision.id=NEW.privacy_decision_request_id AND decision.privacy_request_id=request.id
        JOIN fractal.distribution_lifecycle_policy_bindings binding ON binding.id=NEW.lifecycle_binding_id
       WHERE request.id=NEW.privacy_request_id;
      SELECT item->>'action' INTO scope_action FROM jsonb_array_elements(source.scope_outcomes) item
       WHERE lower(item->>'category')=lower(NEW.decision_scope_category);
      expected_mode:=CASE NEW.treatment_type WHEN 'correction' THEN source.correction_treatment
        WHEN 'erasure' THEN source.erasure_treatment WHEN 'restriction' THEN source.restriction_treatment
        WHEN 'objection' THEN source.objection_treatment END;
      IF source IS NULL OR source.decision_status<>'applied' OR source.requested_by_identity_id<>NEW.proposed_by_identity_id OR source.requester_identity_id<>NEW.requester_identity_id
         OR source.request_type<>NEW.treatment_type OR source.organization_id<>NEW.organization_id
         OR source.target_type<>NEW.target_type OR source.target_id<>NEW.target_id
         OR NOT fractal.distribution_lifecycle_target_involves_identity(NEW.target_type,NEW.target_id,NEW.requester_identity_id)
         OR scope_action IS NULL OR scope_action<>NEW.decision_scope_action OR NEW.policy_treatment_mode<>expected_mode
         OR (NEW.treatment_type='correction' AND scope_action<>'correct')
         OR (NEW.treatment_type='erasure' AND scope_action NOT IN('retain','refuse'))
         OR (NEW.treatment_type='restriction' AND scope_action<>'restrict')
         OR (NEW.treatment_type='objection' AND scope_action NOT IN('retain','restrict','refuse')) THEN
        RAISE EXCEPTION 'distribution privacy treatment requires an exact applied decision, subject, scope, and policy binding';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_privacy_treatment_validate BEFORE INSERT ON fractal.distribution_privacy_treatment_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_privacy_treatment_request();

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_privacy_treatment_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR OLD.status<>'pending' THEN RAISE EXCEPTION 'distribution privacy treatment evidence is immutable'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.reference IS DISTINCT FROM OLD.reference
         OR NEW.privacy_request_id IS DISTINCT FROM OLD.privacy_request_id OR NEW.privacy_decision_request_id IS DISTINCT FROM OLD.privacy_decision_request_id
         OR NEW.lifecycle_binding_id IS DISTINCT FROM OLD.lifecycle_binding_id OR NEW.requester_identity_id IS DISTINCT FROM OLD.requester_identity_id
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.target_type IS DISTINCT FROM OLD.target_type OR NEW.target_id IS DISTINCT FROM OLD.target_id
         OR NEW.treatment_type IS DISTINCT FROM OLD.treatment_type OR NEW.policy_treatment_mode IS DISTINCT FROM OLD.policy_treatment_mode
         OR NEW.decision_scope_category IS DISTINCT FROM OLD.decision_scope_category OR NEW.decision_scope_action IS DISTINCT FROM OLD.decision_scope_action
         OR NEW.treatment_statement IS DISTINCT FROM OLD.treatment_statement OR NEW.command_key IS DISTINCT FROM OLD.command_key
         OR NEW.proposed_by_identity_id IS DISTINCT FROM OLD.proposed_by_identity_id OR NEW.proposed_at IS DISTINCT FROM OLD.proposed_at THEN
        RAISE EXCEPTION 'submitted distribution privacy treatment facts are immutable';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_privacy_treatment_guard BEFORE UPDATE OR DELETE ON fractal.distribution_privacy_treatment_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_privacy_treatment_request();

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_privacy_treatment_execution()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE source RECORD; expected_result TEXT; active_hold BOOLEAN;
    BEGIN
      SELECT treatment.status,treatment.treatment_type,treatment.reviewed_by_identity_id,decision.lawful_basis,
             binding.policy_version_id,binding.policy_value_sha256,binding.policy_reference,binding.retain_until,
             treatment.target_type,treatment.target_id INTO source
        FROM fractal.distribution_privacy_treatment_requests treatment
        JOIN fractal.privacy_rights_decision_requests decision ON decision.id=treatment.privacy_decision_request_id
        JOIN fractal.distribution_lifecycle_policy_bindings binding ON binding.id=treatment.lifecycle_binding_id
       WHERE treatment.id=NEW.treatment_request_id;
      expected_result:=CASE source.treatment_type WHEN 'correction' THEN 'append_only_correction_recorded'
        WHEN 'erasure' THEN 'lawful_retention_confirmed' WHEN 'restriction' THEN 'mandatory_processing_restriction_applied'
        WHEN 'objection' THEN 'objection_lawful_basis_review_recorded' END;
      SELECT EXISTS(SELECT 1 FROM fractal.data_legal_holds hold_record
        WHERE hold_record.target_type=source.target_type AND hold_record.target_id=source.target_id AND hold_record.released_at IS NULL) INTO active_hold;
      IF source IS NULL OR source.status<>'approved' OR NEW.executed_by_identity_id<>source.reviewed_by_identity_id
         OR NEW.execution_result<>expected_result OR NEW.lawful_basis<>source.lawful_basis
         OR NEW.policy_version_id<>source.policy_version_id OR NEW.policy_value_sha256<>source.policy_value_sha256
         OR NEW.policy_reference<>source.policy_reference OR NEW.retain_until<>source.retain_until
         OR NEW.legal_hold_active<>active_hold THEN RAISE EXCEPTION 'distribution privacy treatment execution does not match its approved authority'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_privacy_treatment_execution_validate BEFORE INSERT ON fractal.distribution_privacy_treatment_executions
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_privacy_treatment_execution();
    CREATE TRIGGER distribution_privacy_treatment_execution_immutable BEFORE UPDATE OR DELETE ON fractal.distribution_privacy_treatment_executions
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_privacy_rights_evidence();

    CREATE OR REPLACE FUNCTION fractal.require_distribution_privacy_treatment_execution()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status='approved' AND NOT EXISTS(SELECT 1 FROM fractal.distribution_privacy_treatment_executions execution WHERE execution.treatment_request_id=NEW.id)
        THEN RAISE EXCEPTION 'approved distribution privacy treatment requires immutable execution evidence'; END IF;
      IF NEW.status<>'approved' AND EXISTS(SELECT 1 FROM fractal.distribution_privacy_treatment_executions execution WHERE execution.treatment_request_id=NEW.id)
        THEN RAISE EXCEPTION 'only an approved distribution privacy treatment may have execution evidence'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER distribution_privacy_treatment_execution_required
      AFTER INSERT OR UPDATE ON fractal.distribution_privacy_treatment_requests DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.require_distribution_privacy_treatment_execution();

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    ALTER TABLE fractal.privacy_data_sources
      DROP CONSTRAINT privacy_data_sources_correction_status_check,
      DROP CONSTRAINT privacy_data_sources_erasure_status_check,
      DROP CONSTRAINT privacy_data_sources_restriction_status_check,
      DROP CONSTRAINT privacy_data_sources_objection_status_check,
      ADD CONSTRAINT privacy_data_sources_correction_status_check CHECK(correction_status IN('available','unavailable','not_applicable')),
      ADD CONSTRAINT privacy_data_sources_erasure_status_check CHECK(erasure_status IN('available','unavailable','not_applicable')),
      ADD CONSTRAINT privacy_data_sources_restriction_status_check CHECK(restriction_status IN('available','unavailable','not_applicable')),
      ADD CONSTRAINT privacy_data_sources_objection_status_check CHECK(objection_status IN('available','unavailable','not_applicable'));
    ALTER TABLE fractal.privacy_data_sources DROP CONSTRAINT privacy_data_source_execution_shape;
    ALTER TABLE fractal.privacy_data_sources ADD CONSTRAINT privacy_data_source_execution_shape CHECK(
      (contains_personal_data AND access_status IN('available','unavailable') AND portability_status IN('available','unavailable')
        AND correction_status IN('available','unavailable') AND erasure_status IN('available','unavailable')
        AND restriction_status IN('available','unavailable') AND objection_status IN('available','unavailable')
        AND retention_policy_status IN('unapproved','partial','approved') AND hold_coverage_status IN('absent','partial')
        AND blocker IS NOT NULL AND length(blocker) BETWEEN 20 AND 1000)
      OR (NOT contains_personal_data AND subject_linkage='technical_no_subject'
        AND access_status='not_applicable' AND portability_status='not_applicable' AND correction_status='not_applicable'
        AND erasure_status='not_applicable' AND restriction_status='not_applicable' AND objection_status='not_applicable'
        AND retention_policy_status='not_applicable' AND hold_coverage_status='not_applicable' AND blocker IS NULL));
    UPDATE fractal.privacy_data_sources SET
      correction_status=CASE WHEN source_key IN('postgres.fractal.ownership_snapshot_requests','postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_tax_remittance_requests') THEN 'available' ELSE correction_status END,
      erasure_status=CASE WHEN source_key IN('postgres.fractal.ownership_snapshot_requests','postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_tax_remittance_requests') THEN 'available' ELSE erasure_status END,
      restriction_status=CASE WHEN source_key IN('postgres.fractal.ownership_snapshot_requests','postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_tax_remittance_requests') THEN 'available' ELSE restriction_status END,
      objection_status=CASE WHEN source_key IN('postgres.fractal.ownership_snapshot_requests','postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_tax_remittance_requests') THEN 'available' ELSE objection_status END,
      blocker='Target-specific treatment is available only for new organization-scoped lifecycle anchors with an exact policy binding and independently approved privacy decision. Dependent, legacy, standalone payout-profile/recovery, delivery, and physical-disposition coverage remains incomplete.'
      WHERE source_key=ANY(ARRAY['postgres.fractal.ownership_snapshot_requests','postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_tax_remittance_requests']);
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    VALUES
      ('postgres.fractal.distribution_privacy_treatment_requests','postgres_relation','fractal.distribution_privacy_treatment_requests','investor_finance_ownership',true,'relational_identity',ARRAY['privacy_treatment_authorization'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','approved','partial','Treatment request access collection, complete distribution coverage, and production delivery remain unavailable.'),
      ('postgres.fractal.distribution_privacy_treatment_executions','postgres_relation','fractal.distribution_privacy_treatment_executions','investor_finance_ownership',true,'relational_identity',ARRAY['privacy_treatment_execution_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','approved','partial','Treatment execution access collection, complete distribution coverage, and production delivery remain unavailable.');
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
