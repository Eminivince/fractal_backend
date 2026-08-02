import type { PostgresMigration } from "./types.js";

/** Classifies the global support deadline sweep register as system-run technical metadata with no subject link. */
export const privacySupportSweepClassificationMigration: PostgresMigration = {
  version: "118-privacy-support-sweep-classification",
  sql: `
    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    UPDATE fractal.privacy_data_sources
       SET authority_key='platform_system_metadata',contains_personal_data=false,
           subject_linkage='technical_no_subject',data_categories=ARRAY['technical_metadata'],
           access_status='not_applicable',portability_status='not_applicable',
           correction_status='not_applicable',erasure_status='not_applicable',
           restriction_status='not_applicable',objection_status='not_applicable',
           retention_policy_status='not_applicable',hold_coverage_status='not_applicable',blocker=NULL
     WHERE source_key='postgres.fractal.support_case_service_sweeps';
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
