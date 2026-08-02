import type { PostgresMigration } from "./types.js";

/** Fail-closed materialization, private retrieval, expiry, and destruction evidence for complete privacy packages. */
export const privacyPackageDeliveryAuthorityMigration: PostgresMigration = {
  version: "135-privacy-package-delivery-authority",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.valid_privacy_fulfillment_coverage(value JSONB)
    RETURNS BOOLEAN LANGUAGE plpgsql IMMUTABLE AS $$
    BEGIN
      IF jsonb_typeof(value)<>'object' OR value->>'schemaVersion'<>'privacy-fulfillment-inventory-v2'
         OR (SELECT count(*) FROM jsonb_object_keys(value))<>7
         OR jsonb_typeof(value->'complete')<>'boolean'
         OR jsonb_typeof(value->'executionAvailable')<>'boolean'
         OR jsonb_typeof(value->'coveredAuthorities')<>'array'
         OR jsonb_typeof(value->'uncoveredAuthorities')<>'array'
         OR jsonb_typeof(value->'authorities')<>'array' OR jsonb_array_length(value->'authorities') NOT BETWEEN 1 AND 50
         OR jsonb_typeof(value->'legalHold')<>'object' OR (SELECT count(*) FROM jsonb_object_keys(value->'legalHold'))<>2
         OR jsonb_typeof(value->'legalHold'->'active')<>'boolean'
         OR jsonb_typeof(value->'legalHold'->'pendingImposition')<>'boolean' THEN RETURN FALSE; END IF;
      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(value->'authorities') item
        WHERE jsonb_typeof(item)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(item))<>6
          OR jsonb_typeof(item->'key')<>'string' OR jsonb_typeof(item->'label')<>'string'
          OR jsonb_typeof(item->'sourceCount')<>'number' OR (item->>'sourceCount')::integer<1
          OR item->>'inventoryStatus' NOT IN ('catalogued','unresolved')
          OR item->>'rightStatus' NOT IN ('available','partial','unavailable','not_applicable')
          OR NOT (jsonb_typeof(item->'blocker')='string' OR jsonb_typeof(item->'blocker')='null')
      ) OR (SELECT count(*) FROM jsonb_array_elements(value->'authorities'))<>(SELECT count(DISTINCT item->>'key') FROM jsonb_array_elements(value->'authorities') item)
        THEN RETURN FALSE; END IF;
      RETURN (value->>'complete')::boolean = (
          jsonb_array_length(value->'uncoveredAuthorities')=0
          AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'authorities') item WHERE item->>'inventoryStatus'<>'catalogued' OR item->>'rightStatus' NOT IN('available','not_applicable'))
        )
        AND (value->>'executionAvailable')::boolean=(value->>'complete')::boolean
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'coveredAuthorities') item WHERE jsonb_typeof(item)<>'string')
        AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value->'uncoveredAuthorities') item WHERE jsonb_typeof(item)<>'string');
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.privacy_package_manifest_has_no_unavailable(value JSONB)
    RETURNS BOOLEAN LANGUAGE sql IMMUTABLE AS $$
      SELECT NOT EXISTS(SELECT 1 FROM jsonb_array_elements(value) item WHERE item->>'status'='unavailable')
    $$;

    ALTER TABLE fractal.privacy_rights_package_preparations
      DROP CONSTRAINT privacy_rights_package_preparati_unavailable_source_count_check,
      DROP CONSTRAINT privacy_rights_package_preparations_outcome_check,
      DROP CONSTRAINT privacy_rights_package_preparations_deliverable_check;
    ALTER TABLE fractal.privacy_rights_package_preparations
      ADD CONSTRAINT privacy_package_unavailable_source_count CHECK(unavailable_source_count>=0),
      ADD CONSTRAINT privacy_package_outcome CHECK(outcome IN('blocked_incomplete_coverage','ready_for_delivery')),
      ADD CONSTRAINT privacy_package_deliverability CHECK(
        (outcome='blocked_incomplete_coverage' AND deliverable=false AND unavailable_source_count>0
          AND (coverage_snapshot->>'complete')::boolean=false AND (coverage_snapshot->>'executionAvailable')::boolean=false)
        OR (outcome='ready_for_delivery' AND deliverable=true AND unavailable_source_count=0
          AND (coverage_snapshot->>'complete')::boolean=true AND (coverage_snapshot->>'executionAvailable')::boolean=true
          AND fractal.privacy_package_manifest_has_no_unavailable(source_manifest))
      );

    CREATE TABLE fractal.privacy_rights_package_deliveries (
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^PRD-[0-9]{8}-[A-Z0-9]{8}$'),
      preparation_id UUID NOT NULL UNIQUE REFERENCES fractal.privacy_rights_package_preparations(id),
      privacy_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_requests(id),
      requester_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      status TEXT NOT NULL CHECK(status IN('queued','materializing','available','failed','expired','cleanup_requested','destroyed','cleanup_failed')),
      canonical_format TEXT NOT NULL CHECK(canonical_format='application/vnd.fractal.privacy-package+json;version=1'),
      source_manifest_sha256 CHAR(64) NOT NULL CHECK(source_manifest_sha256 ~ '^[0-9a-f]{64}$'),
      content_sha256 CHAR(64) CHECK(content_sha256 IS NULL OR content_sha256 ~ '^[0-9a-f]{64}$'),
      byte_count INTEGER CHECK(byte_count IS NULL OR byte_count BETWEEN 1 AND 104857600),
      storage_key TEXT CHECK(storage_key IS NULL OR length(storage_key) BETWEEN 1 AND 2000),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      requested_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      retrieval_expires_at TIMESTAMPTZ NOT NULL,
      retain_until TIMESTAMPTZ NOT NULL,
      claimed_by TEXT CHECK(claimed_by IS NULL OR length(claimed_by) BETWEEN 1 AND 200),
      claimed_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0),
      generated_at TIMESTAMPTZ,
      available_at TIMESTAMPTZ,
      expired_at TIMESTAMPTZ,
      destroyed_at TIMESTAMPTZ,
      failure_category TEXT CHECK(failure_category IS NULL OR failure_category IN('stale_preparation','collection_failed','storage_failed','finalization_failed','cleanup_failed')),
      UNIQUE(requested_by_identity_id,command_key),
      CHECK(retrieval_expires_at>requested_at AND retain_until>=retrieval_expires_at),
      CHECK((claimed_by IS NULL)=(claimed_at IS NULL)),
      CHECK(
        (status='queued' AND content_sha256 IS NULL AND byte_count IS NULL AND storage_key IS NULL AND claimed_by IS NULL AND generated_at IS NULL AND available_at IS NULL AND expired_at IS NULL AND destroyed_at IS NULL AND failure_category IS NULL)
        OR (status='materializing' AND content_sha256 IS NULL AND byte_count IS NULL AND storage_key IS NULL AND claimed_by IS NOT NULL AND generated_at IS NULL AND available_at IS NULL AND expired_at IS NULL AND destroyed_at IS NULL AND failure_category IS NULL)
        OR (status='available' AND content_sha256 IS NOT NULL AND byte_count IS NOT NULL AND storage_key IS NOT NULL AND claimed_by IS NULL AND generated_at IS NOT NULL AND available_at IS NOT NULL AND expired_at IS NULL AND destroyed_at IS NULL AND failure_category IS NULL)
        OR (status='failed' AND storage_key IS NULL AND claimed_by IS NULL AND available_at IS NULL AND destroyed_at IS NULL AND failure_category IS NOT NULL)
        OR (status='expired' AND content_sha256 IS NOT NULL AND byte_count IS NOT NULL AND storage_key IS NOT NULL AND claimed_by IS NULL AND available_at IS NOT NULL AND expired_at IS NOT NULL AND destroyed_at IS NULL AND failure_category IS NULL)
        OR (status='cleanup_requested' AND content_sha256 IS NOT NULL AND byte_count IS NOT NULL AND storage_key IS NOT NULL AND claimed_by IS NULL AND available_at IS NOT NULL AND destroyed_at IS NULL AND failure_category IS NULL)
        OR (status='destroyed' AND content_sha256 IS NOT NULL AND byte_count IS NOT NULL AND storage_key IS NOT NULL AND claimed_by IS NULL AND available_at IS NOT NULL AND destroyed_at IS NOT NULL AND failure_category IS NULL)
        OR (status='cleanup_failed' AND content_sha256 IS NOT NULL AND byte_count IS NOT NULL AND storage_key IS NOT NULL AND claimed_by IS NULL AND available_at IS NOT NULL AND destroyed_at IS NULL AND failure_category='cleanup_failed')
      )
    );
    CREATE INDEX privacy_package_delivery_queue_idx ON fractal.privacy_rights_package_deliveries(status,requested_at,id);
    CREATE INDEX privacy_package_delivery_subject_idx ON fractal.privacy_rights_package_deliveries(requester_identity_id,requested_at DESC,id DESC);
    CREATE INDEX privacy_package_delivery_retention_idx ON fractal.privacy_rights_package_deliveries(retain_until,id) WHERE status IN('available','expired');

    CREATE TABLE fractal.privacy_rights_package_access_events (
      id UUID PRIMARY KEY,
      delivery_id UUID NOT NULL REFERENCES fractal.privacy_rights_package_deliveries(id),
      privacy_request_id UUID NOT NULL REFERENCES fractal.privacy_rights_requests(id),
      requester_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      accessed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      access_type TEXT NOT NULL CHECK(access_type='download'),
      content_sha256 CHAR(64) NOT NULL CHECK(content_sha256 ~ '^[0-9a-f]{64}$'),
      bytes_served INTEGER NOT NULL CHECK(bytes_served BETWEEN 1 AND 104857600),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX privacy_package_access_subject_idx ON fractal.privacy_rights_package_access_events(requester_identity_id,occurred_at DESC,id DESC);

    CREATE OR REPLACE FUNCTION fractal.privacy_package_preparation_is_current(preparation_id UUID)
    RETURNS BOOLEAN LANGUAGE sql STABLE AS $$
      SELECT COALESCE((SELECT preparation.deliverable
          AND EXISTS(SELECT 1 FROM fractal.platform_configuration_active_versions active
            WHERE active.configuration_key=preparation.configuration_key AND active.active_version_id=preparation.policy_version_id)
          AND EXISTS(SELECT 1 FROM fractal.platform_configuration_active_versions active
            WHERE active.configuration_key=preparation.content_profile_configuration_key AND active.active_version_id=preparation.content_profile_version_id)
          AND jsonb_array_length(preparation.source_manifest)=(SELECT count(*) FROM fractal.privacy_data_sources)
          AND NOT EXISTS(
            SELECT 1 FROM fractal.privacy_data_sources source
            LEFT JOIN jsonb_array_elements(preparation.source_manifest) item ON item->>'sourceKey'=source.source_key
            WHERE item IS NULL OR item->>'authorityKey'<>source.authority_key
              OR item->>'status'<>CASE
                WHEN NOT source.contains_personal_data THEN 'not_applicable'
                WHEN (CASE preparation.request_type WHEN 'access' THEN source.access_status ELSE source.portability_status END)='available' THEN 'collected'
                ELSE 'unavailable'
              END)
        FROM fractal.privacy_rights_package_preparations preparation WHERE preparation.id=preparation_id),false)
    $$;

    CREATE OR REPLACE FUNCTION fractal.validate_privacy_package_delivery_request()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE preparation RECORD;
    BEGIN
      SELECT privacy_request_id,requester_identity_id,canonical_format,source_manifest_sha256,deliverable,outcome,
             requester_retrieval_hours,package_retention_hours,prepared_by_identity_id
        INTO preparation FROM fractal.privacy_rights_package_preparations WHERE id=NEW.preparation_id;
      IF preparation IS NULL OR preparation.deliverable IS NOT TRUE OR preparation.outcome<>'ready_for_delivery'
         OR fractal.privacy_package_preparation_is_current(NEW.preparation_id) IS NOT TRUE
         OR NEW.privacy_request_id<>preparation.privacy_request_id OR NEW.requester_identity_id<>preparation.requester_identity_id
         OR NEW.canonical_format<>preparation.canonical_format OR NEW.source_manifest_sha256<>preparation.source_manifest_sha256
         OR NEW.requested_by_identity_id IN(preparation.prepared_by_identity_id,preparation.requester_identity_id) OR NEW.status<>'queued'
         OR NEW.retrieval_expires_at<>NEW.requested_at+preparation.requester_retrieval_hours*interval '1 hour'
         OR NEW.retain_until<>NEW.requested_at+preparation.package_retention_hours*interval '1 hour' THEN
        RAISE EXCEPTION 'privacy package delivery requires a complete exact preparation and a different delivery authorizer';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_package_delivery_insert_validate BEFORE INSERT ON fractal.privacy_rights_package_deliveries
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_privacy_package_delivery_request();

    CREATE OR REPLACE FUNCTION fractal.protect_privacy_package_delivery()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'privacy package delivery evidence is immutable'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.reference IS DISTINCT FROM OLD.reference OR NEW.preparation_id IS DISTINCT FROM OLD.preparation_id
         OR NEW.privacy_request_id IS DISTINCT FROM OLD.privacy_request_id OR NEW.requester_identity_id IS DISTINCT FROM OLD.requester_identity_id
         OR NEW.canonical_format IS DISTINCT FROM OLD.canonical_format OR NEW.source_manifest_sha256 IS DISTINCT FROM OLD.source_manifest_sha256
         OR NEW.command_key IS DISTINCT FROM OLD.command_key OR NEW.requested_by_identity_id IS DISTINCT FROM OLD.requested_by_identity_id
         OR NEW.requested_at IS DISTINCT FROM OLD.requested_at OR NEW.retrieval_expires_at IS DISTINCT FROM OLD.retrieval_expires_at
         OR NEW.retain_until IS DISTINCT FROM OLD.retain_until OR NEW.attempts<OLD.attempts
         OR (OLD.content_sha256 IS NOT NULL AND NEW.content_sha256 IS DISTINCT FROM OLD.content_sha256)
         OR (OLD.byte_count IS NOT NULL AND NEW.byte_count IS DISTINCT FROM OLD.byte_count)
         OR (OLD.storage_key IS NOT NULL AND NEW.storage_key IS DISTINCT FROM OLD.storage_key)
         OR (OLD.generated_at IS NOT NULL AND NEW.generated_at IS DISTINCT FROM OLD.generated_at)
         OR (OLD.available_at IS NOT NULL AND NEW.available_at IS DISTINCT FROM OLD.available_at)
         OR (OLD.expired_at IS NOT NULL AND NEW.expired_at IS DISTINCT FROM OLD.expired_at)
         OR (OLD.destroyed_at IS NOT NULL AND NEW.destroyed_at IS DISTINCT FROM OLD.destroyed_at) THEN
        RAISE EXCEPTION 'privacy package delivery origin and evidence are immutable';
      END IF;
      IF NOT ((OLD.status='queued' AND NEW.status='materializing')
        OR (OLD.status='materializing' AND NEW.status IN('materializing','available','failed'))
        OR (OLD.status='available' AND NEW.status IN('expired','cleanup_requested'))
        OR (OLD.status='expired' AND NEW.status='cleanup_requested')
        OR (OLD.status='cleanup_requested' AND NEW.status IN('destroyed','cleanup_failed'))) THEN
        RAISE EXCEPTION 'invalid privacy package delivery transition';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_package_delivery_guard BEFORE UPDATE OR DELETE ON fractal.privacy_rights_package_deliveries
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_privacy_package_delivery();

    CREATE OR REPLACE FUNCTION fractal.validate_privacy_package_access_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE delivery RECORD;
    BEGIN
      SELECT privacy_request_id,requester_identity_id,status,content_sha256,byte_count,retrieval_expires_at INTO delivery
        FROM fractal.privacy_rights_package_deliveries WHERE id=NEW.delivery_id;
      IF delivery IS NULL OR delivery.status<>'available' OR now()>=delivery.retrieval_expires_at
         OR NEW.privacy_request_id<>delivery.privacy_request_id OR NEW.requester_identity_id<>delivery.requester_identity_id
         OR NEW.accessed_by_identity_id<>delivery.requester_identity_id OR NEW.content_sha256<>delivery.content_sha256
         OR NEW.bytes_served<>delivery.byte_count THEN RAISE EXCEPTION 'privacy package access requires the owning requester and exact available bytes within the retrieval window'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER privacy_package_access_validate BEFORE INSERT ON fractal.privacy_rights_package_access_events
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_privacy_package_access_event();
    CREATE TRIGGER privacy_package_access_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_rights_package_access_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_privacy_rights_evidence();

    ALTER TABLE fractal.storage_cleanup_tasks
      DROP CONSTRAINT storage_cleanup_tasks_purpose_check,
      DROP CONSTRAINT storage_cleanup_governed_purpose_shape,
      ADD COLUMN privacy_package_delivery_id UUID UNIQUE REFERENCES fractal.privacy_rights_package_deliveries(id);
    ALTER TABLE fractal.storage_cleanup_tasks ADD CONSTRAINT storage_cleanup_tasks_purpose_check
      CHECK(purpose IN('orphan_cleanup','governed_disposition','organization_document_disposition','privacy_package_delivery'));
    ALTER TABLE fractal.storage_cleanup_tasks ADD CONSTRAINT storage_cleanup_governed_purpose_shape CHECK(
      (purpose='orphan_cleanup' AND governed_disposition_id IS NULL AND organization_document_disposition_id IS NULL AND organization_document_version_id IS NULL AND privacy_package_delivery_id IS NULL)
      OR (purpose='governed_disposition' AND governed_disposition_id IS NOT NULL AND organization_document_disposition_id IS NULL AND organization_document_version_id IS NULL AND privacy_package_delivery_id IS NULL)
      OR (purpose='organization_document_disposition' AND governed_disposition_id IS NULL AND organization_document_disposition_id IS NOT NULL AND organization_document_version_id IS NOT NULL AND privacy_package_delivery_id IS NULL)
      OR (purpose='privacy_package_delivery' AND governed_disposition_id IS NULL AND organization_document_disposition_id IS NULL AND organization_document_version_id IS NULL AND privacy_package_delivery_id IS NOT NULL)
    );

    CREATE OR REPLACE FUNCTION fractal.enforce_storage_cleanup_subject_link_immutability()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.source IS DISTINCT FROM OLD.source OR NEW.metadata_error IS DISTINCT FROM OLD.metadata_error
         OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.purpose IS DISTINCT FROM OLD.purpose
         OR NEW.governed_disposition_id IS DISTINCT FROM OLD.governed_disposition_id
         OR NEW.organization_document_disposition_id IS DISTINCT FROM OLD.organization_document_disposition_id
         OR NEW.organization_document_version_id IS DISTINCT FROM OLD.organization_document_version_id
         OR NEW.privacy_package_delivery_id IS DISTINCT FROM OLD.privacy_package_delivery_id THEN
        RAISE EXCEPTION 'storage cleanup origin and subject linkage are immutable';
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.require_privacy_package_cleanup_task()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status IN('cleanup_requested','destroyed','cleanup_failed') AND NOT EXISTS(
        SELECT 1 FROM fractal.storage_cleanup_tasks task WHERE task.privacy_package_delivery_id=NEW.id AND task.storage_key=NEW.storage_key)
        THEN RAISE EXCEPTION 'privacy package cleanup state requires its exact durable cleanup task'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER privacy_package_cleanup_task_required AFTER UPDATE ON fractal.privacy_rights_package_deliveries
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_privacy_package_cleanup_task();

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    VALUES
      ('postgres.fractal.privacy_rights_package_deliveries','postgres_relation','fractal.privacy_rights_package_deliveries','privacy_register',true,'direct_identity',ARRAY['privacy_package_delivery_lifecycle'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','approved','partial','Subject-safe delivery lifecycle collection and production provider evidence are not yet active.'),
      ('postgres.fractal.privacy_rights_package_access_events','postgres_relation','fractal.privacy_rights_package_access_events','privacy_register',true,'direct_identity',ARRAY['privacy_package_retrieval_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','approved','partial','Subject-safe retrieval evidence collection and production provider evidence are not yet active.');
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
