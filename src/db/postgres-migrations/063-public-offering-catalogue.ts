import type { PostgresMigration } from "./types.js";

/**
 * Makes the public catalogue a governed projection of an approved publication
 * request. Public copy is immutable after submission and slugs cannot alias two
 * different offerings.
 */
export const publicOfferingCatalogueMigration: PostgresMigration = {
  version: "063-public-offering-catalogue",
  sql: `
    CREATE UNIQUE INDEX IF NOT EXISTS offering_publication_requests_public_slug_unique
      ON fractal.offering_publication_requests (lower(terms->>'publicSlug'))
      WHERE terms ? 'publicSlug';

    CREATE OR REPLACE FUNCTION fractal.validate_public_offering_catalogue_profile()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE asset_class TEXT;
    BEGIN
      IF jsonb_typeof(NEW.terms) <> 'object' THEN
        RAISE EXCEPTION 'offering terms must be a JSON object';
      END IF;
      IF COALESCE(NEW.terms->>'publicSlug', '') !~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'
         OR length(NEW.terms->>'publicSlug') > 120 THEN
        RAISE EXCEPTION 'public offering slug is invalid';
      END IF;
      asset_class := NEW.terms->>'assetClass';
      IF asset_class NOT IN ('logistics_industrial', 'mixed_use_real_estate', 'renewable_energy',
                             'infrastructure', 'healthcare', 'education', 'agribusiness', 'other') THEN
        RAISE EXCEPTION 'public offering asset class is invalid';
      END IF;
      IF jsonb_typeof(NEW.terms->'minimumTicketMinor') <> 'number'
         OR (NEW.terms->>'minimumTicketMinor')::numeric <= 0
         OR (NEW.terms->>'minimumTicketMinor')::numeric <> trunc((NEW.terms->>'minimumTicketMinor')::numeric)
         OR (NEW.terms->>'minimumTicketMinor')::numeric > NEW.capacity_minor THEN
        RAISE EXCEPTION 'public offering minimum ticket is invalid';
      END IF;
      IF jsonb_typeof(NEW.terms->'targetReturnBps') <> 'number'
         OR (NEW.terms->>'targetReturnBps')::numeric <= 0
         OR (NEW.terms->>'targetReturnBps')::numeric <> trunc((NEW.terms->>'targetReturnBps')::numeric)
         OR (NEW.terms->>'targetReturnBps')::numeric > 10000 THEN
        RAISE EXCEPTION 'public offering target return is invalid';
      END IF;
      IF jsonb_typeof(NEW.terms->'termMonths') <> 'number'
         OR (NEW.terms->>'termMonths')::numeric < 1
         OR (NEW.terms->>'termMonths')::numeric <> trunc((NEW.terms->>'termMonths')::numeric)
         OR (NEW.terms->>'termMonths')::numeric > 600 THEN
        RAISE EXCEPTION 'public offering term is invalid';
      END IF;
      IF length(COALESCE(NEW.terms->>'name', '')) NOT BETWEEN 2 AND 200
         OR length(COALESCE(NEW.terms->>'summary', '')) NOT BETWEEN 20 AND 500
         OR length(COALESCE(NEW.terms->>'thesis', '')) NOT BETWEEN 20 AND 2000
         OR length(COALESCE(NEW.terms->>'riskSummary', '')) NOT BETWEEN 20 AND 2000
         OR length(COALESCE(NEW.terms->>'incomeSource', '')) NOT BETWEEN 10 AND 1000
         OR length(COALESCE(NEW.terms->>'structure', '')) NOT BETWEEN 10 AND 1000
         OR length(COALESCE(NEW.terms->>'security', '')) NOT BETWEEN 10 AND 1000
         OR length(COALESCE(NEW.terms->>'feeSummary', '')) NOT BETWEEN 10 AND 1000
         OR length(COALESCE(NEW.terms->>'nextMilestone', '')) NOT BETWEEN 10 AND 1000 THEN
        RAISE EXCEPTION 'public offering profile is incomplete';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS offering_publication_requests_public_profile_guard
      ON fractal.offering_publication_requests;
    CREATE TRIGGER offering_publication_requests_public_profile_guard
      BEFORE INSERT ON fractal.offering_publication_requests
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_public_offering_catalogue_profile();
  `,
};
