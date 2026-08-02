import type { PostgresMigration } from "./types.js";

/** Adds an immutable, server-owned self-declaration link without permitting arbitrary subject assignment. */
export const organizationBeneficialOwnerSelfLinkMigration: PostgresMigration = {
  version: "120-organization-beneficial-owner-self-link",
  sql: `
    ALTER TABLE fractal.organization_beneficial_owner_declarations
      ADD COLUMN subject_identity_id UUID REFERENCES fractal.identities(id),
      ADD COLUMN subject_link_basis TEXT,
      ADD COLUMN subject_linked_at TIMESTAMPTZ,
      ADD CONSTRAINT organization_beneficial_owner_subject_link_shape CHECK (
        (subject_identity_id IS NULL AND subject_link_basis IS NULL AND subject_linked_at IS NULL)
        OR
        (owner_type='natural_person' AND subject_identity_id IS NOT NULL
          AND subject_link_basis='submitting_identity_self_declaration' AND subject_linked_at IS NOT NULL)
      );

    CREATE FUNCTION fractal.enforce_beneficial_owner_self_link()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE
      request_submitter UUID;
    BEGIN
      IF NEW.subject_identity_id IS NULL THEN
        RETURN NEW;
      END IF;

      SELECT request.submitted_by_identity_id INTO request_submitter
      FROM fractal.organization_verification_requests request
      JOIN fractal.identities identity ON identity.id = request.submitted_by_identity_id
        AND identity.status = 'active' AND identity.email_verified_at IS NOT NULL
      WHERE request.id = NEW.verification_request_id;

      IF request_submitter IS NULL OR NEW.subject_identity_id <> request_submitter THEN
        RAISE EXCEPTION 'beneficial-owner identity link must reference the active verified verification request submitter';
      END IF;

      RETURN NEW;
    END;
    $$;

    CREATE TRIGGER organization_beneficial_owner_self_link_guard
      BEFORE INSERT ON fractal.organization_beneficial_owner_declarations
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_beneficial_owner_self_link();

    CREATE UNIQUE INDEX organization_beneficial_owner_request_subject_unique_idx
      ON fractal.organization_beneficial_owner_declarations (verification_request_id,subject_identity_id)
      WHERE subject_identity_id IS NOT NULL;
  `,
};
