import type { PostgresMigration } from "./types.js";

/** Records why an amended application exists and makes version succession a database invariant. */
export const assetApplicationAmendmentsMigration: PostgresMigration = {
  version: "034-asset-application-amendments",
  sql: `
    ALTER TABLE fractal.asset_application_requests
      ADD COLUMN IF NOT EXISTS material_change_summary TEXT;

    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'asset_application_requests_material_change_summary_check'
          AND conrelid = 'fractal.asset_application_requests'::regclass
      ) THEN
        ALTER TABLE fractal.asset_application_requests
          ADD CONSTRAINT asset_application_requests_material_change_summary_check
          CHECK (
            (application_version = 1 AND material_change_summary IS NULL)
            OR (application_version > 1 AND length(material_change_summary) BETWEEN 20 AND 2000)
          );
      END IF;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.validate_asset_application_version_sequence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE expected_version INTEGER;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text || ':' || NEW.application_reference));
      SELECT COALESCE(MAX(application_version), 0) + 1
        INTO expected_version
        FROM fractal.asset_application_requests
       WHERE organization_id = NEW.organization_id
         AND application_reference = NEW.application_reference;
      IF NEW.application_version <> expected_version THEN
        RAISE EXCEPTION 'asset application version must be the next sequential version for this application reference';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS asset_application_requests_version_sequence ON fractal.asset_application_requests;
    CREATE TRIGGER asset_application_requests_version_sequence
      BEFORE INSERT ON fractal.asset_application_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_asset_application_version_sequence();

    CREATE OR REPLACE FUNCTION fractal.enforce_asset_application_request_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF OLD.status <> 'submitted' OR NEW.status NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'asset application request may only be decided once';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
        OR NEW.application_reference IS DISTINCT FROM OLD.application_reference OR NEW.application_version IS DISTINCT FROM OLD.application_version
        OR NEW.asset_name IS DISTINCT FROM OLD.asset_name OR NEW.asset_type IS DISTINCT FROM OLD.asset_type
        OR NEW.country_code IS DISTINCT FROM OLD.country_code OR NEW.state IS DISTINCT FROM OLD.state OR NEW.city IS DISTINCT FROM OLD.city
        OR NEW.summary IS DISTINCT FROM OLD.summary OR NEW.requested_capacity_minor IS DISTINCT FROM OLD.requested_capacity_minor
        OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.dossier_evidence_document_id IS DISTINCT FROM OLD.dossier_evidence_document_id
        OR NEW.dossier_hash IS DISTINCT FROM OLD.dossier_hash OR NEW.material_change_summary IS DISTINCT FROM OLD.material_change_summary
        OR NEW.submitted_by_identity_id IS DISTINCT FROM OLD.submitted_by_identity_id
        OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'submitted asset application facts are immutable';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.supersede_prior_approved_asset_application_version()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE prior_version_id UUID;
    DECLARE change_summary TEXT;
    BEGIN
      PERFORM pg_advisory_xact_lock(hashtext(NEW.organization_id::text || ':' || NEW.application_reference));
      SELECT id INTO prior_version_id
        FROM fractal.approved_asset_application_versions
       WHERE organization_id = NEW.organization_id
         AND application_reference = NEW.application_reference
         AND application_version < NEW.application_version
         AND NOT EXISTS (
           SELECT 1 FROM fractal.asset_application_version_supersessions
            WHERE superseded_application_version_id = fractal.approved_asset_application_versions.id
         )
       ORDER BY application_version DESC
       LIMIT 1;
      IF prior_version_id IS NOT NULL THEN
        SELECT material_change_summary INTO change_summary
          FROM fractal.asset_application_requests
         WHERE id = NEW.application_request_id;
        INSERT INTO fractal.asset_application_version_supersessions
          (id, organization_id, superseded_application_version_id, replacement_application_version_id, superseded_by_identity_id, reason)
        VALUES
          (md5(random()::text || clock_timestamp()::text || NEW.id::text)::uuid, NEW.organization_id, prior_version_id, NEW.id, NEW.approved_by_identity_id, change_summary);
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS approved_asset_application_versions_supersede_prior ON fractal.approved_asset_application_versions;
    CREATE TRIGGER approved_asset_application_versions_supersede_prior
      AFTER INSERT ON fractal.approved_asset_application_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.supersede_prior_approved_asset_application_version();
  `,
};
