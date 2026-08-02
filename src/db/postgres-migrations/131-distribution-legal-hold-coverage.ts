import type { PostgresMigration } from "./types.js";

/** Extends the existing maker-checker legal-hold authority to distribution record anchors. */
export const distributionLegalHoldCoverageMigration: PostgresMigration = {
  version: "131-distribution-legal-hold-coverage",
  sql: `
    ALTER TABLE fractal.data_legal_hold_change_requests DROP CONSTRAINT data_legal_hold_change_requests_target_type_check;
    ALTER TABLE fractal.data_legal_hold_change_requests ADD CONSTRAINT data_legal_hold_change_requests_target_type_check
      CHECK(target_type IN('identity','support_case','support_attachment','organization','organization_document','distribution_declaration','distribution_payout_exception','distribution_tax_remittance'));
    ALTER TABLE fractal.data_legal_holds DROP CONSTRAINT data_legal_holds_target_type_check;
    ALTER TABLE fractal.data_legal_holds ADD CONSTRAINT data_legal_holds_target_type_check
      CHECK(target_type IN('identity','support_case','support_attachment','organization','organization_document','distribution_declaration','distribution_payout_exception','distribution_tax_remittance'));

    CREATE OR REPLACE FUNCTION fractal.data_lifecycle_target_exists(target_type TEXT,target_id UUID)
    RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
    BEGIN
      IF target_type='identity' THEN RETURN EXISTS(SELECT 1 FROM fractal.identities WHERE id=target_id); END IF;
      IF target_type='support_case' THEN RETURN EXISTS(SELECT 1 FROM fractal.support_cases WHERE id=target_id); END IF;
      IF target_type='support_attachment' THEN RETURN EXISTS(SELECT 1 FROM fractal.support_case_attachments WHERE id=target_id); END IF;
      IF target_type='organization' THEN RETURN EXISTS(SELECT 1 FROM fractal.organizations WHERE id=target_id); END IF;
      IF target_type='organization_document' THEN RETURN EXISTS(SELECT 1 FROM fractal.organization_documents WHERE id=target_id); END IF;
      IF target_type='distribution_declaration' THEN RETURN EXISTS(SELECT 1 FROM fractal.distribution_declaration_requests WHERE id=target_id); END IF;
      IF target_type='distribution_payout_exception' THEN RETURN EXISTS(SELECT 1 FROM fractal.distribution_payout_exception_cases WHERE id=target_id); END IF;
      IF target_type='distribution_tax_remittance' THEN RETURN EXISTS(SELECT 1 FROM fractal.distribution_tax_remittance_requests WHERE id=target_id); END IF;
      RETURN FALSE;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.distribution_lifecycle_target_involves_identity(target_type TEXT,target_id UUID,identity_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT CASE target_type
        WHEN 'distribution_declaration' THEN EXISTS(
          SELECT 1 FROM fractal.distribution_entitlements entitlement
          WHERE entitlement.declaration_request_id=target_id AND entitlement.investor_identity_id=identity_id)
        WHEN 'distribution_payout_exception' THEN EXISTS(
          SELECT 1 FROM fractal.distribution_payout_exception_cases case_record
          JOIN fractal.distribution_payout_instructions payout ON payout.id=case_record.payout_instruction_id
          WHERE case_record.id=target_id AND payout.investor_identity_id=identity_id)
        WHEN 'distribution_tax_remittance' THEN EXISTS(
          SELECT 1 FROM fractal.investor_distribution_tax_statements statement
          WHERE statement.remittance_request_id=target_id AND statement.investor_identity_id=identity_id)
        ELSE FALSE END
    $$;

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    UPDATE fractal.privacy_data_sources
       SET hold_coverage_status='partial',
           blocker='Subject-bounded access and maker-checker legal holds now cover declaration, payout-exception, and tax-remittance anchors and their dependent records. Approved retention schedules, correction/restriction/objection treatment, erasure refusal or eligible mutable-object disposition, and production rights delivery remain unavailable.'
     WHERE source_key = ANY(ARRAY[
       'postgres.fractal.ownership_snapshot_requests','postgres.fractal.ownership_snapshot_holdings',
       'postgres.fractal.distribution_declaration_requests','postgres.fractal.distribution_entitlements',
       'postgres.fractal.investor_distribution_payout_profiles','postgres.fractal.distribution_payout_recipient_recovery_cases',
       'postgres.fractal.distribution_funding_requests','postgres.fractal.distribution_payout_instructions',
       'postgres.fractal.distribution_payout_provider_events','postgres.fractal.distribution_payout_exception_policies',
       'postgres.fractal.distribution_payout_exception_cases','postgres.fractal.distribution_payout_exception_evidence',
       'postgres.fractal.distribution_payout_exception_hold_requests','postgres.fractal.distribution_payout_exception_executions',
       'postgres.fractal.distribution_tax_remittance_policies','postgres.fractal.distribution_tax_remittance_requests',
       'postgres.fractal.distribution_tax_remittance_reversal_requests','postgres.fractal.investor_distribution_tax_statements'
     ]);
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
