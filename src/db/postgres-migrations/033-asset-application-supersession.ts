import type { PostgresMigration } from "./types.js";

/** Makes material changes explicit: a newer approved application supersedes its predecessor for future publication. */
export const assetApplicationSupersessionMigration: PostgresMigration = {
  version: "033-asset-application-supersession",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.asset_application_version_supersessions (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      superseded_application_version_id UUID NOT NULL UNIQUE REFERENCES fractal.approved_asset_application_versions(id),
      replacement_application_version_id UUID NOT NULL UNIQUE REFERENCES fractal.approved_asset_application_versions(id),
      superseded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      superseded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 2 AND 2000),
      CHECK (superseded_application_version_id <> replacement_application_version_id)
    );
    CREATE INDEX IF NOT EXISTS asset_application_version_supersessions_org_idx
      ON fractal.asset_application_version_supersessions (organization_id, superseded_at DESC, id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_asset_application_version_supersession()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'fractal.asset_application_version_supersessions are immutable'; END;
    $$;
    DROP TRIGGER IF EXISTS asset_application_version_supersessions_immutable ON fractal.asset_application_version_supersessions;
    CREATE TRIGGER asset_application_version_supersessions_immutable
      BEFORE UPDATE OR DELETE ON fractal.asset_application_version_supersessions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_asset_application_version_supersession();

    CREATE OR REPLACE FUNCTION fractal.validate_offering_publication_request_origin()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE origin fractal.approved_asset_application_versions%ROWTYPE;
    BEGIN
      IF NEW.approved_asset_application_version_id IS NULL THEN
        RAISE EXCEPTION 'offering publication requires an approved asset application version';
      END IF;
      SELECT * INTO origin FROM fractal.approved_asset_application_versions WHERE id = NEW.approved_asset_application_version_id;
      IF NOT FOUND OR origin.organization_id <> NEW.organization_id OR origin.currency <> NEW.currency
         OR NEW.capacity_minor > origin.requested_capacity_minor THEN
        RAISE EXCEPTION 'offering publication does not match its approved asset application origin';
      END IF;
      IF EXISTS (SELECT 1 FROM fractal.asset_application_version_supersessions WHERE superseded_application_version_id = origin.id) THEN
        RAISE EXCEPTION 'offering publication origin has been superseded by a material application change';
      END IF;
      RETURN NEW;
    END;
    $$;
  `,
};
