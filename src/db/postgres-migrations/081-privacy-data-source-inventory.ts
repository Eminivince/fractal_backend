import type { PostgresMigration } from "./types.js";

/**
 * Technical source discovery for privacy-rights execution. This catalog is
 * intentionally not an export or erasure engine: every personal-data adapter
 * remains unavailable until a later migration binds tested implementation and
 * approved operating policy.
 */
export const privacyDataSourceInventoryMigration: PostgresMigration = {
  version: "081-privacy-data-source-inventory",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.valid_privacy_rights_applicability(value TEXT[])
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
      SELECT value <@ ARRAY['access','portability','correction','erasure','restriction','objection']::text[]
        AND cardinality(value)=cardinality(ARRAY(SELECT DISTINCT item FROM unnest(value) item))
    $$;

    CREATE TABLE IF NOT EXISTS fractal.privacy_data_authorities (
      authority_key TEXT PRIMARY KEY CHECK (authority_key ~ '^[a-z][a-z0-9_]{2,79}$'),
      label TEXT NOT NULL UNIQUE CHECK (length(label) BETWEEN 5 AND 120),
      description TEXT NOT NULL CHECK (length(description) BETWEEN 20 AND 1000),
      contains_personal_data BOOLEAN NOT NULL,
      rights_applicability TEXT[] NOT NULL,
      blocker TEXT,
      CONSTRAINT privacy_data_authority_rights_shape CHECK (
        fractal.valid_privacy_rights_applicability(rights_applicability)
        AND ((contains_personal_data AND cardinality(rights_applicability)>0 AND blocker IS NOT NULL AND length(blocker) BETWEEN 20 AND 1000)
          OR (NOT contains_personal_data AND cardinality(rights_applicability)=0 AND blocker IS NULL))
      )
    );

    INSERT INTO fractal.privacy_data_authorities
      (authority_key,label,description,contains_personal_data,rights_applicability,blocker)
    VALUES
      ('identity_access_security','Identity, access and security','Account identity, credentials, sessions, access governance, wallet links, security notices, and administrator access evidence.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'No canonical export, correction, restriction, objection, or hold-aware erasure adapter is bound to this authority.'),
      ('legal_consent_content','Legal acceptance and consent','Actor-linked legal-document and agreement acceptance evidence plus governed publication activity.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Acceptance evidence needs approved retention treatment and a canonical subject export adapter.'),
      ('identity_verification','Identity verification provider evidence','Verification applications, provider events, evidence references, decisions, and processor-side records.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Provider retrieval, correction, restriction, deletion, residency, and processor confirmation are not integrated.'),
      ('investor_finance_ownership','Investor, payment and ownership records','Compliance profiles, offering interactions, commitments, reservations, payments, ledger evidence, allocations, and wallet ownership.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Financial retention rules and complete relational, provider, chain, and document adapters are not approved or integrated.'),
      ('issuer_organization_offerings','Issuer, organization and offering records','Organizations, memberships, beneficial ownership, applications, reviews, offerings, publication, and chain-operation evidence.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Organization-scoped subject resolution and governed document, chain, correction, restriction, and erasure adapters are incomplete.'),
      ('professional_work_finance','Professional work and finance','Professional memberships, work orders, deliverables, invoices, tax, payout, recovery, exception, and accounting evidence.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Firm-scoped subject resolution, document retrieval, financial retention, and rights-execution adapters are incomplete.'),
      ('support_and_lifecycle','Support, attachments and lifecycle','Requester support cases, communications, classified attachments, access events, holds, retention, and disposition evidence.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Content-safe export, object-version discovery, requester correction, restriction, and erasure execution are not complete.'),
      ('provider_operations','Provider operations and incidents','Provider inbox records, administrator incidents, event histories, and operational processor references.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Subject correlation, processor retrieval, retention, and rights-execution coverage remain unavailable.'),
      ('platform_governance','Platform governance and configuration','Actor-linked configuration proposals, approvals, activation attempts, and governed operating-value history.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Actor-linked governance evidence needs approved retention and canonical export treatment.'),
      ('audit_command_delivery','Audit, command and delivery evidence','Immutable audit chains, idempotency records, outbox delivery, governance documents, and operational delivery evidence.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Subject correlation, immutable-record retention decisions, and external delivery evidence adapters are incomplete.'),
      ('privacy_register','Privacy-rights register','Privacy requests, policy bindings, decisions, timelines, and the source inventory used to govern fulfillment.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'The privacy register can be read, but no frozen canonical fulfillment package or delivery authority exists.'),
      ('external_objects_backups_logs','Objects, backups, logs and external copies','Managed object versions, backups, replicas, logs, traces, error monitoring, caches, processor records, and chain copies.',true,ARRAY['access','portability','correction','erasure','restriction','objection'],'Locations, residency, historical-version enumeration, processor actions, and destruction proof are not fully integrated.'),
      ('platform_system_metadata','Platform system metadata','Migration and technical catalog rows that contain no identified data subject or actor activity.',false,ARRAY[]::text[],NULL)
    ON CONFLICT (authority_key) DO NOTHING;

    CREATE TABLE IF NOT EXISTS fractal.privacy_data_sources (
      source_key TEXT PRIMARY KEY CHECK (source_key ~ '^[a-z0-9][a-z0-9._:-]{2,199}$'),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('postgres_relation','external_processor','object_store','cache','backup','log_or_trace','blockchain')),
      source_locator TEXT NOT NULL CHECK (length(source_locator) BETWEEN 3 AND 300),
      authority_key TEXT NOT NULL REFERENCES fractal.privacy_data_authorities(authority_key) ON DELETE RESTRICT,
      contains_personal_data BOOLEAN NOT NULL,
      subject_linkage TEXT NOT NULL CHECK (subject_linkage IN ('direct_identity','relational_identity','organization_relationship','embedded_reference','provider_correlation','technical_no_subject','unresolved')),
      data_categories TEXT[] NOT NULL CHECK (cardinality(data_categories) BETWEEN 1 AND 30),
      inventory_status TEXT NOT NULL CHECK (inventory_status IN ('catalogued','unresolved')),
      access_status TEXT NOT NULL CHECK (access_status IN ('unavailable','not_applicable')),
      portability_status TEXT NOT NULL CHECK (portability_status IN ('unavailable','not_applicable')),
      correction_status TEXT NOT NULL CHECK (correction_status IN ('unavailable','not_applicable')),
      erasure_status TEXT NOT NULL CHECK (erasure_status IN ('unavailable','not_applicable')),
      restriction_status TEXT NOT NULL CHECK (restriction_status IN ('unavailable','not_applicable')),
      objection_status TEXT NOT NULL CHECK (objection_status IN ('unavailable','not_applicable')),
      retention_policy_status TEXT NOT NULL CHECK (retention_policy_status IN ('unapproved','not_applicable')),
      hold_coverage_status TEXT NOT NULL CHECK (hold_coverage_status IN ('absent','partial','not_applicable')),
      blocker TEXT,
      catalogued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (source_kind,source_locator),
      CONSTRAINT privacy_data_source_execution_shape CHECK (
        (contains_personal_data
          AND access_status='unavailable' AND portability_status='unavailable' AND correction_status='unavailable'
          AND erasure_status='unavailable' AND restriction_status='unavailable' AND objection_status='unavailable'
          AND retention_policy_status='unapproved' AND hold_coverage_status IN ('absent','partial')
          AND blocker IS NOT NULL AND length(blocker) BETWEEN 20 AND 1000)
        OR (NOT contains_personal_data AND subject_linkage='technical_no_subject'
          AND access_status='not_applicable' AND portability_status='not_applicable' AND correction_status='not_applicable'
          AND erasure_status='not_applicable' AND restriction_status='not_applicable' AND objection_status='not_applicable'
          AND retention_policy_status='not_applicable' AND hold_coverage_status='not_applicable' AND blocker IS NULL)
      )
    );
    CREATE INDEX IF NOT EXISTS privacy_data_sources_authority_idx
      ON fractal.privacy_data_sources (authority_key,source_kind,source_key);
    CREATE INDEX IF NOT EXISTS privacy_data_sources_gap_idx
      ON fractal.privacy_data_sources (inventory_status,authority_key,source_key)
      WHERE contains_personal_data;

    INSERT INTO fractal.privacy_data_sources
      (source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,
       inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,
       retention_policy_status,hold_coverage_status,blocker)
    SELECT
      'postgres.fractal.' || tables.tablename,
      'postgres_relation',
      'fractal.' || tables.tablename,
      CASE
        WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'platform_system_metadata'
        WHEN tables.tablename LIKE 'privacy_%' THEN 'privacy_register'
        WHEN tables.tablename LIKE 'support_%' OR tables.tablename LIKE 'data_legal_hold%' OR tables.tablename='storage_cleanup_tasks' THEN 'support_and_lifecycle'
        WHEN tables.tablename LIKE 'professional_%' THEN 'professional_work_finance'
        WHEN tables.tablename LIKE 'organization_%' OR tables.tablename LIKE 'offering_%' OR tables.tablename LIKE 'asset_application_%' OR tables.tablename LIKE 'approved_asset_%' THEN 'issuer_organization_offerings'
        WHEN tables.tablename LIKE 'investment_%' OR tables.tablename LIKE 'investor_%' OR tables.tablename LIKE 'payment_%' OR tables.tablename LIKE 'journal_%' OR tables.tablename LIKE 'ledger_%' THEN 'investor_finance_ownership'
        WHEN tables.tablename LIKE 'provider_identity_verification_%' THEN 'identity_verification'
        WHEN tables.tablename LIKE 'administrator_provider_%' OR tables.tablename='inbox_events' THEN 'provider_operations'
        WHEN tables.tablename LIKE 'platform_content_%' OR tables.tablename LIKE 'legal_document_%' OR tables.tablename LIKE 'agreement_%' THEN 'legal_consent_content'
        WHEN tables.tablename LIKE 'platform_configuration_%' THEN 'platform_governance'
        WHEN tables.tablename LIKE 'audit_%' OR tables.tablename='outbox_events' OR tables.tablename='idempotency_commands' OR tables.tablename='governance_evidence_documents' THEN 'audit_command_delivery'
        ELSE 'identity_access_security'
      END,
      tables.tablename NOT IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources'),
      CASE
        WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'technical_no_subject'
        WHEN tables.tablename='identities' THEN 'direct_identity'
        WHEN tables.tablename LIKE 'organization_%' OR tables.tablename LIKE 'offering_%' OR tables.tablename LIKE 'asset_application_%' OR tables.tablename LIKE 'approved_asset_%' OR tables.tablename LIKE 'professional_%' THEN 'organization_relationship'
        ELSE 'relational_identity'
      END,
      ARRAY[CASE
        WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'technical_metadata'
        ELSE 'relation:' || tables.tablename
      END]::text[],
      'catalogued',
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unavailable' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unavailable' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unavailable' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unavailable' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unavailable' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unavailable' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable' ELSE 'unapproved' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN 'not_applicable'
           WHEN tables.tablename LIKE 'support_%' OR tables.tablename LIKE 'data_legal_hold%' THEN 'partial' ELSE 'absent' END,
      CASE WHEN tables.tablename IN ('schema_migrations','administrator_capability_definitions','platform_configuration_definitions','platform_content_definitions','privacy_data_authorities','privacy_data_sources') THEN NULL
           ELSE 'The relation is discovered, but no tested canonical rights adapter and approved retention treatment are bound.' END
    FROM pg_catalog.pg_tables tables
    WHERE tables.schemaname='fractal'
    ON CONFLICT (source_key) DO NOTHING;

    INSERT INTO fractal.privacy_data_sources
      (source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,
       inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,
       retention_policy_status,hold_coverage_status,blocker)
    VALUES
      ('external.mongo.legacy_identity_projection','external_processor','MongoDB legacy identity projection','identity_access_security',true,'direct_identity',ARRAY['legacy_identity_projection'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Frozen-write reconciliation, retention, and destruction proof for the legacy projection are not complete.'),
      ('external.redis.operational_cache','cache','Redis queues, rate limits, and operational cache','external_objects_backups_logs',true,'embedded_reference',ARRAY['session_and_operational_metadata'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Key inventory, subject correlation, expiry assurance, replicas, and deletion evidence are not complete.'),
      ('external.resend.delivery','external_processor','Resend authentication and notification delivery records','audit_command_delivery',true,'provider_correlation',ARRAY['email_delivery_metadata'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Provider-side event retrieval, retention, residency, and deletion confirmation are not integrated.'),
      ('external.identity_verification.provider','external_processor','Configured identity verification provider','identity_verification',true,'provider_correlation',ARRAY['identity_and_verification_evidence'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Provider contract, field inventory, residency, retrieval, correction, restriction, and deletion APIs remain unverified.'),
      ('external.payment.provider','external_processor','Configured payment and banking providers','investor_finance_ownership',true,'provider_correlation',ARRAY['payment_and_recipient_metadata'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Provider data inventory, retention, subject correlation, retrieval, and rights operations remain unverified.'),
      ('external.chain.public_records','blockchain','Configured EVM networks, contracts, indexers, and RPC providers','external_objects_backups_logs',true,'embedded_reference',ARRAY['wallet_and_public_transaction_records'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Public-chain immutability and processor/indexer copies require explicit disclosure and non-erasure treatment.'),
      ('external.object_store.managed','object_store','Managed private object store and historical versions','external_objects_backups_logs',true,'relational_identity',ARRAY['evidence_documents_and_attachments'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','partial','Bucket inventory, version enumeration, object-lock state, residency, and destruction proof are not integrated.'),
      ('external.postgres.backups','backup','Managed PostgreSQL backups, replicas, snapshots, and point-in-time recovery','external_objects_backups_logs',true,'unresolved',ARRAY['database_backups_and_historical_rows'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Backup locations, retention, restore scope, expiry, subject handling, and destruction evidence are not approved.'),
      ('external.telemetry.logs','log_or_trace','Application logs, traces, metrics, and error monitoring','external_objects_backups_logs',true,'embedded_reference',ARRAY['network_device_actor_and_error_metadata'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Field-level telemetry inventory, redaction, residency, retention, subject correlation, and deletion are not proven.'),
      ('external.edge.access_logs','log_or_trace','DNS, CDN, proxy, firewall, and hosting access logs','external_objects_backups_logs',true,'embedded_reference',ARRAY['network_and_device_metadata'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Provider inventory, residency, retention, access export, and deletion treatment are not approved or integrated.'),
      ('external.malware_scan.provider','external_processor','ClamAV or configured malware-scanning service','support_and_lifecycle',true,'provider_correlation',ARRAY['attachment_scan_metadata'],'unresolved','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','partial','Scanner deployment, transient-content handling, logs, retention, and processor-side deletion evidence are not proven.')
    ON CONFLICT (source_key) DO NOTHING;

    CREATE OR REPLACE FUNCTION fractal.reject_privacy_data_inventory_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'privacy data source inventory is migration-owned and immutable'; END; $$;
    DROP TRIGGER IF EXISTS privacy_data_authorities_immutable ON fractal.privacy_data_authorities;
    CREATE TRIGGER privacy_data_authorities_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_authorities
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();

    CREATE OR REPLACE FUNCTION fractal.valid_privacy_fulfillment_coverage(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value) <> 'object' THEN RETURN FALSE; END IF;
      IF value->>'schemaVersion'='privacy-fulfillment-inventory-v1' THEN
        RETURN (SELECT count(*) FROM jsonb_object_keys(value))=6
          AND jsonb_typeof(value->'complete')='boolean' AND value->>'complete'='false'
          AND jsonb_typeof(value->'executionAvailable')='boolean' AND value->>'executionAvailable'='false'
          AND jsonb_typeof(value->'coveredAuthorities')='array' AND jsonb_typeof(value->'uncoveredAuthorities')='array'
          AND jsonb_typeof(value->'legalHold')='object' AND (SELECT count(*) FROM jsonb_object_keys(value->'legalHold'))=2
          AND jsonb_typeof(value->'legalHold'->'active')='boolean' AND jsonb_typeof(value->'legalHold'->'pendingImposition')='boolean'
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'coveredAuthorities') item WHERE jsonb_typeof(item)<>'string')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(value->'uncoveredAuthorities') item WHERE jsonb_typeof(item)<>'string');
      END IF;
      IF value->>'schemaVersion'<>'privacy-fulfillment-inventory-v2'
         OR (SELECT count(*) FROM jsonb_object_keys(value))<>7
         OR jsonb_typeof(value->'complete')<>'boolean' OR value->>'complete'<>'false'
         OR jsonb_typeof(value->'executionAvailable')<>'boolean' OR value->>'executionAvailable'<>'false'
         OR jsonb_typeof(value->'coveredAuthorities')<>'array' OR jsonb_typeof(value->'uncoveredAuthorities')<>'array'
         OR jsonb_typeof(value->'authorities')<>'array' OR jsonb_array_length(value->'authorities') NOT BETWEEN 1 AND 50
         OR jsonb_typeof(value->'legalHold')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value->'legalHold'))<>2
         OR jsonb_typeof(value->'legalHold'->'active')<>'boolean' OR jsonb_typeof(value->'legalHold'->'pendingImposition')<>'boolean' THEN RETURN FALSE; END IF;
      RETURN NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(value->'authorities') item
        WHERE jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>6
          OR jsonb_typeof(item->'key')<>'string' OR jsonb_typeof(item->'label')<>'string'
          OR jsonb_typeof(item->'sourceCount')<>'number' OR (item->>'sourceCount')::integer<1
          OR item->>'inventoryStatus' NOT IN ('catalogued','unresolved')
          OR item->>'rightStatus' NOT IN ('unavailable','not_applicable')
          OR NOT (jsonb_typeof(item->'blocker')='string' OR jsonb_typeof(item->'blocker')='null')
      ) AND (SELECT count(*)=count(DISTINCT item->>'key') FROM jsonb_array_elements(value->'authorities') item);
    END; $$;
  `,
};
