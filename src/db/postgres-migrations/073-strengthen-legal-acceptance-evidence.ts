import type { PostgresMigration } from "./types.js";

/**
 * Makes the copied fields in a legal acceptance database-verifiable facts.
 * The application already writes exact current versions; this trigger prevents
 * a direct or future alternate writer from recording mismatched evidence.
 */
export const strengthenLegalAcceptanceEvidenceMigration: PostgresMigration = {
  version: "073-strengthen-legal-acceptance-evidence",
  sql: `
    CREATE OR REPLACE FUNCTION fractal.require_exact_legal_acceptance_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      exact_version fractal.platform_content_versions%ROWTYPE;
      definition fractal.platform_content_definitions%ROWTYPE;
      publication fractal.platform_content_publications%ROWTYPE;
    BEGIN
      SELECT * INTO exact_version
        FROM fractal.platform_content_versions
       WHERE id = NEW.content_version_id AND document_key = NEW.document_key;
      SELECT * INTO definition
        FROM fractal.platform_content_definitions
       WHERE document_key = NEW.document_key;
      SELECT * INTO publication
        FROM fractal.platform_content_publications
       WHERE document_key = NEW.document_key;

      IF exact_version.id IS NULL OR definition.document_key IS NULL OR publication.document_key IS NULL
         OR publication.published_version_id IS DISTINCT FROM NEW.content_version_id
         OR exact_version.status IS DISTINCT FROM 'published'
         OR exact_version.effective_at > NEW.accepted_at THEN
        RAISE EXCEPTION 'legal acceptance must bind the exact current published version';
      END IF;
      IF NEW.semantic_version IS DISTINCT FROM exact_version.semantic_version
         OR NEW.content_sha256 IS DISTINCT FROM exact_version.content_sha256
         OR NEW.evidence ->> 'acceptedContentSha256' IS DISTINCT FROM exact_version.content_sha256
         OR NEW.evidence ->> 'slug' IS DISTINCT FROM definition.slug
         OR NEW.evidence ->> 'projectionVersion' IS DISTINCT FROM publication.projection_version::text THEN
        RAISE EXCEPTION 'legal acceptance copied evidence does not match the published version';
      END IF;
      IF NEW.accepted_at > transaction_timestamp() + interval '5 minutes' THEN
        RAISE EXCEPTION 'legal acceptance time is outside the permitted boundary';
      END IF;
      IF NEW.acceptance_context = 'registration'
         AND (NOT definition.required_at_registration OR NEW.affirmative_action <> 'checkbox') THEN
        RAISE EXCEPTION 'registration acceptance has an invalid document or affirmative action';
      END IF;
      IF NEW.acceptance_context = 'reacceptance'
         AND (NOT exact_version.reacceptance_required OR NEW.affirmative_action <> 'review_and_accept') THEN
        RAISE EXCEPTION 'reacceptance has an invalid version or affirmative action';
      END IF;
      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER legal_document_acceptances_exact_evidence
      BEFORE INSERT ON fractal.legal_document_acceptances
      FOR EACH ROW EXECUTE FUNCTION fractal.require_exact_legal_acceptance_evidence();
  `,
};
