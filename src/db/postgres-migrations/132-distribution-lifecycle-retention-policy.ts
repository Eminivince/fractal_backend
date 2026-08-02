import type { PostgresMigration } from "./types.js";

/** Exact policy bindings for newly created organization-scoped distribution record chains. */
export const distributionLifecycleRetentionPolicyMigration: PostgresMigration = {
  version: "132-distribution-lifecycle-retention-policy",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions
      (configuration_key,label,description,value_type,validation_schema,consumer_binding,status)
    VALUES (
      'privacy.distribution.lifecycle_policy',
      'Distribution lifecycle and privacy treatment policy',
      'Approved jurisdictional retention and lawful rights-treatment rules bound to each new ownership, declaration, payout-exception, and tax-remittance record chain.',
      'json',
      '{"type":"object","required":["policyReference","policyName","schemaVersion","jurisdictions"],"operationalValidator":"distribution_lifecycle_policy_v1"}'::jsonb,
      'next_request',
      'active'
    )
    ON CONFLICT (configuration_key) DO UPDATE SET
      label=EXCLUDED.label,description=EXCLUDED.description,value_type=EXCLUDED.value_type,
      validation_schema=EXCLUDED.validation_schema,consumer_binding=EXCLUDED.consumer_binding,status='active';

    CREATE TABLE fractal.distribution_lifecycle_policy_bindings (
      id UUID PRIMARY KEY,
      target_type TEXT NOT NULL CHECK(target_type IN('ownership_snapshot','distribution_declaration','distribution_payout_exception','distribution_tax_remittance')),
      target_id UUID NOT NULL,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      record_class TEXT NOT NULL CHECK(record_class IN('ownership_snapshot','distribution_declaration','payout_exception','tax_remittance')),
      configuration_key TEXT NOT NULL CHECK(configuration_key='privacy.distribution.lifecycle_policy'),
      policy_version_id UUID NOT NULL,
      policy_version_number INTEGER NOT NULL CHECK(policy_version_number>0),
      policy_projection_version INTEGER NOT NULL CHECK(policy_projection_version>0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK(policy_value_sha256 ~ '^[0-9a-f]{64}$'),
      policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 3 AND 120),
      policy_name TEXT NOT NULL CHECK(length(policy_name) BETWEEN 10 AND 160),
      policy_schema_version TEXT NOT NULL CHECK(policy_schema_version='distribution-lifecycle-policy-v1'),
      jurisdiction_code CHAR(2) NOT NULL CHECK(jurisdiction_code ~ '^[A-Z]{2}$'),
      legal_basis_reference TEXT NOT NULL CHECK(length(legal_basis_reference) BETWEEN 10 AND 500),
      retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 9131),
      correction_treatment TEXT NOT NULL CHECK(correction_treatment='append_only_domain_correction'),
      erasure_treatment TEXT NOT NULL CHECK(erasure_treatment='retain_then_review_for_minimization_or_disposition'),
      restriction_treatment TEXT NOT NULL CHECK(restriction_treatment='mandatory_processing_only'),
      objection_treatment TEXT NOT NULL CHECK(objection_treatment='documented_lawful_basis_review'),
      retention_started_at TIMESTAMPTZ NOT NULL,
      retain_until TIMESTAMPTZ NOT NULL,
      bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      FOREIGN KEY(configuration_key,policy_version_id) REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      UNIQUE(target_type,target_id),
      CHECK(record_class=target_type OR (target_type='distribution_payout_exception' AND record_class='payout_exception') OR (target_type='distribution_tax_remittance' AND record_class='tax_remittance')),
      CHECK(retain_until=retention_started_at+retention_days*interval '24 hours')
    );
    CREATE INDEX distribution_lifecycle_bindings_org_idx ON fractal.distribution_lifecycle_policy_bindings(organization_id,retain_until,target_type,target_id);
    CREATE INDEX distribution_lifecycle_bindings_retention_idx ON fractal.distribution_lifecycle_policy_bindings(retain_until,target_type,target_id);

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_lifecycle_policy_binding()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE target RECORD; exact_policy RECORD; expected_rule JSONB;
    BEGIN
      IF NEW.target_type='ownership_snapshot' THEN SELECT record.organization_id,record.submitted_at,organization.jurisdiction_code INTO target FROM fractal.ownership_snapshot_requests record JOIN fractal.organizations organization ON organization.id=record.organization_id WHERE record.id=NEW.target_id;
      ELSIF NEW.target_type='distribution_declaration' THEN SELECT record.organization_id,record.submitted_at,organization.jurisdiction_code INTO target FROM fractal.distribution_declaration_requests record JOIN fractal.organizations organization ON organization.id=record.organization_id WHERE record.id=NEW.target_id;
      ELSIF NEW.target_type='distribution_payout_exception' THEN SELECT record.organization_id,record.opened_at AS submitted_at,organization.jurisdiction_code INTO target FROM fractal.distribution_payout_exception_cases record JOIN fractal.organizations organization ON organization.id=record.organization_id WHERE record.id=NEW.target_id;
      ELSIF NEW.target_type='distribution_tax_remittance' THEN SELECT record.organization_id,record.submitted_at,organization.jurisdiction_code INTO target FROM fractal.distribution_tax_remittance_requests record JOIN fractal.organizations organization ON organization.id=record.organization_id WHERE record.id=NEW.target_id;
      END IF;
      SELECT version.version_number,version.value_sha256,version.proposed_value,projection.projection_version
        INTO exact_policy
        FROM fractal.platform_configuration_active_versions projection
        JOIN fractal.platform_configuration_versions version ON version.id=projection.active_version_id
       WHERE projection.configuration_key=NEW.configuration_key AND projection.active_version_id=NEW.policy_version_id AND version.status='active';
      expected_rule:=exact_policy.proposed_value #> ARRAY['jurisdictions',NEW.jurisdiction_code,'rules',NEW.record_class];
      IF target IS NULL OR target.organization_id<>NEW.organization_id OR target.jurisdiction_code<>NEW.jurisdiction_code OR target.submitted_at<>NEW.retention_started_at
         OR exact_policy IS NULL OR expected_rule IS NULL
         OR NEW.policy_version_number<>exact_policy.version_number OR NEW.policy_projection_version<>exact_policy.projection_version
         OR NEW.policy_value_sha256<>exact_policy.value_sha256
         OR NEW.policy_reference<>exact_policy.proposed_value->>'policyReference'
         OR NEW.policy_name<>exact_policy.proposed_value->>'policyName'
         OR NEW.policy_schema_version<>exact_policy.proposed_value->>'schemaVersion'
         OR NEW.legal_basis_reference<>(exact_policy.proposed_value #>> ARRAY['jurisdictions',NEW.jurisdiction_code,'legalBasisReference'])
         OR NEW.retention_days<>(expected_rule->>'retentionDays')::integer
         OR NEW.correction_treatment<>expected_rule->>'correctionTreatment'
         OR NEW.erasure_treatment<>expected_rule->>'erasureTreatment'
         OR NEW.restriction_treatment<>expected_rule->>'restrictionTreatment'
         OR NEW.objection_treatment<>expected_rule->>'objectionTreatment' THEN
        RAISE EXCEPTION 'distribution record requires its exact active lifecycle policy binding';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_lifecycle_binding_validate BEFORE INSERT ON fractal.distribution_lifecycle_policy_bindings
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_lifecycle_policy_binding();

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_lifecycle_policy_binding()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'distribution lifecycle policy bindings are immutable'; END; $$;
    CREATE TRIGGER distribution_lifecycle_binding_immutable BEFORE UPDATE OR DELETE ON fractal.distribution_lifecycle_policy_bindings
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_lifecycle_policy_binding();

    CREATE OR REPLACE FUNCTION fractal.require_distribution_lifecycle_policy_binding()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE expected_type TEXT;
    BEGIN
      expected_type:=CASE TG_TABLE_NAME
        WHEN 'ownership_snapshot_requests' THEN 'ownership_snapshot'
        WHEN 'distribution_declaration_requests' THEN 'distribution_declaration'
        WHEN 'distribution_payout_exception_cases' THEN 'distribution_payout_exception'
        WHEN 'distribution_tax_remittance_requests' THEN 'distribution_tax_remittance' END;
      IF NOT EXISTS(SELECT 1 FROM fractal.distribution_lifecycle_policy_bindings binding WHERE binding.target_type=expected_type AND binding.target_id=NEW.id)
        THEN RAISE EXCEPTION 'new distribution records require an approved lifecycle policy binding'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER ownership_snapshot_lifecycle_binding_required AFTER INSERT ON fractal.ownership_snapshot_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_distribution_lifecycle_policy_binding();
    CREATE CONSTRAINT TRIGGER distribution_declaration_lifecycle_binding_required AFTER INSERT ON fractal.distribution_declaration_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_distribution_lifecycle_policy_binding();
    CREATE CONSTRAINT TRIGGER distribution_payout_exception_lifecycle_binding_required AFTER INSERT ON fractal.distribution_payout_exception_cases
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_distribution_lifecycle_policy_binding();
    CREATE CONSTRAINT TRIGGER distribution_tax_remittance_lifecycle_binding_required AFTER INSERT ON fractal.distribution_tax_remittance_requests
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_distribution_lifecycle_policy_binding();

    CREATE OR REPLACE FUNCTION fractal.distribution_lifecycle_target_involves_identity(target_type TEXT,target_id UUID,identity_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT CASE target_type
        WHEN 'ownership_snapshot' THEN EXISTS(SELECT 1 FROM fractal.ownership_snapshot_holdings holding WHERE holding.snapshot_request_id=target_id AND holding.investor_identity_id=identity_id)
        WHEN 'distribution_declaration' THEN EXISTS(SELECT 1 FROM fractal.distribution_entitlements entitlement WHERE entitlement.declaration_request_id=target_id AND entitlement.investor_identity_id=identity_id)
        WHEN 'distribution_payout_exception' THEN EXISTS(SELECT 1 FROM fractal.distribution_payout_exception_cases case_record JOIN fractal.distribution_payout_instructions payout ON payout.id=case_record.payout_instruction_id WHERE case_record.id=target_id AND payout.investor_identity_id=identity_id)
        WHEN 'distribution_tax_remittance' THEN EXISTS(SELECT 1 FROM fractal.investor_distribution_tax_statements statement WHERE statement.remittance_request_id=target_id AND statement.investor_identity_id=identity_id)
        ELSE FALSE END
    $$;

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    ALTER TABLE fractal.privacy_data_sources DROP CONSTRAINT privacy_data_sources_retention_policy_status_check;
    ALTER TABLE fractal.privacy_data_sources DROP CONSTRAINT privacy_data_source_execution_shape;
    ALTER TABLE fractal.privacy_data_sources ADD CONSTRAINT privacy_data_sources_retention_policy_status_check
      CHECK(retention_policy_status IN('unapproved','partial','approved','not_applicable'));
    ALTER TABLE fractal.privacy_data_sources ADD CONSTRAINT privacy_data_source_execution_shape CHECK(
      (contains_personal_data AND access_status IN('available','unavailable') AND portability_status IN('available','unavailable')
        AND correction_status='unavailable' AND erasure_status='unavailable' AND restriction_status='unavailable' AND objection_status='unavailable'
        AND retention_policy_status IN('unapproved','partial','approved') AND hold_coverage_status IN('absent','partial')
        AND blocker IS NOT NULL AND length(blocker) BETWEEN 20 AND 1000)
      OR (NOT contains_personal_data AND subject_linkage='technical_no_subject'
        AND access_status='not_applicable' AND portability_status='not_applicable' AND correction_status='not_applicable'
        AND erasure_status='not_applicable' AND restriction_status='not_applicable' AND objection_status='not_applicable'
        AND retention_policy_status='not_applicable' AND hold_coverage_status='not_applicable' AND blocker IS NULL));
    UPDATE fractal.privacy_data_sources SET retention_policy_status='partial',
      blocker='New organization-scoped distribution anchors require exact approved lifecycle-policy bindings; legacy rows, standalone payout destinations/recovery, rights execution, and production delivery remain unavailable.'
      WHERE source_key=ANY(ARRAY[
        'postgres.fractal.ownership_snapshot_requests','postgres.fractal.ownership_snapshot_holdings','postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_entitlements',
        'postgres.fractal.distribution_funding_requests','postgres.fractal.distribution_payout_instructions','postgres.fractal.distribution_payout_provider_events',
        'postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_payout_exception_evidence','postgres.fractal.distribution_payout_exception_hold_requests','postgres.fractal.distribution_payout_exception_executions',
        'postgres.fractal.distribution_tax_remittance_requests','postgres.fractal.distribution_tax_remittance_reversal_requests','postgres.fractal.investor_distribution_tax_statements']);
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    VALUES('postgres.fractal.distribution_lifecycle_policy_bindings','postgres_relation','fractal.distribution_lifecycle_policy_bindings','investor_finance_ownership',true,'relational_identity',ARRAY['distribution_retention_and_treatment_policy_binding'],'catalogued','available','unavailable','unavailable','unavailable','unavailable','unavailable','approved','partial','Subject-bounded access exposes only the applicable policy treatment and dates; executable correction, restriction, objection, erasure, and production delivery adapters remain unavailable.');
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    UPDATE fractal.platform_configuration_definitions
       SET validation_schema='{"type":"object","required":["profileReference","profileName","schemaVersion","fieldCatalogVersion","jurisdictionCode","legalBasisReference","effectiveScope","access","portability"],"operationalValidator":"privacy_content_profile_v1_v2_v3_v4_v5_v6_v7_v8_v9_v10_v11_v12_v13_v14_v15_v16_v17_v18_v19_v20_v21_v22_v23_v24_v25_v26_v27_v28_v29_v30_v31_v32_v33_v34_v35_v36_v37_v38_v39"}'::jsonb
     WHERE configuration_key='privacy.rights.content_profile';
    ALTER TABLE fractal.privacy_rights_package_preparations DROP CONSTRAINT privacy_package_content_profile_shape;
    ALTER TABLE fractal.privacy_rights_package_preparations ADD CONSTRAINT privacy_package_content_profile_shape CHECK(
      (content_profile_binding_status='legacy_unprofiled' AND content_profile_configuration_key IS NULL AND content_profile_version_id IS NULL AND content_profile_version_number IS NULL AND content_profile_projection_version IS NULL AND content_profile_value_sha256 IS NULL AND content_profile_reference IS NULL AND content_profile_name IS NULL AND content_profile_schema_version IS NULL AND content_profile_field_catalog_version IS NULL AND content_profile_jurisdiction_code IS NULL AND content_profile_legal_basis_reference IS NULL AND content_profile_effective_scope IS NULL AND selected_content_profile IS NULL)
      OR (content_profile_binding_status='governed' AND content_profile_configuration_key='privacy.rights.content_profile' AND content_profile_version_id IS NOT NULL AND content_profile_version_number>0 AND content_profile_projection_version>0 AND content_profile_value_sha256 ~ '^[0-9a-f]{64}$' AND length(content_profile_reference) BETWEEN 3 AND 120 AND length(content_profile_name) BETWEEN 10 AND 160 AND content_profile_schema_version='privacy-content-profile-v1' AND content_profile_field_catalog_version IN('privacy-safe-fields-v1','privacy-safe-fields-v2','privacy-safe-fields-v3','privacy-safe-fields-v4','privacy-safe-fields-v5','privacy-safe-fields-v6','privacy-safe-fields-v7','privacy-safe-fields-v8','privacy-safe-fields-v9','privacy-safe-fields-v10','privacy-safe-fields-v11','privacy-safe-fields-v12','privacy-safe-fields-v13','privacy-safe-fields-v14','privacy-safe-fields-v15','privacy-safe-fields-v16','privacy-safe-fields-v17','privacy-safe-fields-v18','privacy-safe-fields-v19','privacy-safe-fields-v20','privacy-safe-fields-v21','privacy-safe-fields-v22','privacy-safe-fields-v23','privacy-safe-fields-v24','privacy-safe-fields-v25','privacy-safe-fields-v26','privacy-safe-fields-v27','privacy-safe-fields-v28','privacy-safe-fields-v29','privacy-safe-fields-v30','privacy-safe-fields-v31','privacy-safe-fields-v32','privacy-safe-fields-v33','privacy-safe-fields-v34','privacy-safe-fields-v35','privacy-safe-fields-v36','privacy-safe-fields-v37','privacy-safe-fields-v38','privacy-safe-fields-v39') AND content_profile_jurisdiction_code ~ '^[A-Z0-9-]{2,16}$' AND length(content_profile_legal_basis_reference) BETWEEN 10 AND 500 AND content_profile_effective_scope='authenticated_data_subject_access_and_portability' AND jsonb_typeof(selected_content_profile)='object'));
    CREATE OR REPLACE FUNCTION fractal.require_exact_privacy_content_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE exact_profile RECORD; expected_rule_count INTEGER;
    BEGIN
      IF NEW.content_profile_binding_status<>'governed' THEN RAISE EXCEPTION 'new privacy package preparation requires a governed content profile'; END IF;
      SELECT version.version_number,version.value_sha256,version.proposed_value,projection.projection_version INTO exact_profile
        FROM fractal.platform_configuration_active_versions projection JOIN fractal.platform_configuration_versions version ON version.id=projection.active_version_id AND version.status='active'
       WHERE projection.configuration_key=NEW.content_profile_configuration_key AND version.id=NEW.content_profile_version_id;
      IF exact_profile IS NULL OR NEW.content_profile_version_number IS DISTINCT FROM exact_profile.version_number OR NEW.content_profile_projection_version IS DISTINCT FROM exact_profile.projection_version OR NEW.content_profile_value_sha256 IS DISTINCT FROM exact_profile.value_sha256 OR NEW.content_profile_reference IS DISTINCT FROM exact_profile.proposed_value->>'profileReference' OR NEW.content_profile_name IS DISTINCT FROM exact_profile.proposed_value->>'profileName' OR NEW.content_profile_schema_version IS DISTINCT FROM exact_profile.proposed_value->>'schemaVersion' OR NEW.content_profile_field_catalog_version IS DISTINCT FROM exact_profile.proposed_value->>'fieldCatalogVersion' OR NEW.content_profile_jurisdiction_code IS DISTINCT FROM exact_profile.proposed_value->>'jurisdictionCode' OR NEW.content_profile_legal_basis_reference IS DISTINCT FROM exact_profile.proposed_value->>'legalBasisReference' OR NEW.content_profile_effective_scope IS DISTINCT FROM exact_profile.proposed_value->>'effectiveScope' OR NEW.selected_content_profile IS DISTINCT FROM exact_profile.proposed_value->NEW.request_type THEN RAISE EXCEPTION 'privacy package preparation requires the exact active approved content profile'; END IF;
      IF NEW.content_profile_field_catalog_version<>'privacy-safe-fields-v39' THEN RAISE EXCEPTION 'privacy package preparation requires an active v39 content profile after distribution lifecycle policy activation'; END IF;
      expected_rule_count:=CASE NEW.request_type WHEN 'access' THEN 123 ELSE 24 END;
      IF jsonb_typeof(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.selected_content_profile->'sourceRules') IS DISTINCT FROM expected_rule_count THEN RAISE EXCEPTION 'privacy package preparation requires the exact right-specific collector rule count'; END IF;
      RETURN NEW;
    END; $$;
  `,
};
