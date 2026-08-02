import type { PostgresMigration } from "./types.js";

/** Evidence-backed diligence requests attached to an immutable asset-application version. */
export const assetApplicationReviewItemsMigration: PostgresMigration = {
  version: "032-asset-application-review-items",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.asset_application_review_items (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      application_request_id UUID NOT NULL REFERENCES fractal.asset_application_requests(id),
      category TEXT NOT NULL CHECK (length(category) BETWEEN 2 AND 80),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
      request_message TEXT NOT NULL CHECK (length(request_message) BETWEEN 2 AND 2000),
      required BOOLEAN NOT NULL DEFAULT true,
      status TEXT NOT NULL CHECK (status IN ('open', 'responded', 'verified', 'rejected')),
      response_message TEXT,
      response_evidence_document_id UUID REFERENCES fractal.asset_application_evidence_documents(id),
      responded_by_identity_id UUID REFERENCES fractal.identities(id),
      responded_at TIMESTAMPTZ,
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_at TIMESTAMPTZ,
      review_notes TEXT,
      opened_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'open' AND response_message IS NULL AND response_evidence_document_id IS NULL AND responded_by_identity_id IS NULL AND responded_at IS NULL AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND review_notes IS NULL)
          OR (status = 'responded' AND response_message IS NOT NULL AND response_evidence_document_id IS NOT NULL AND responded_by_identity_id IS NOT NULL AND responded_at IS NOT NULL AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND review_notes IS NULL)
          OR (status = 'verified' AND response_message IS NOT NULL AND response_evidence_document_id IS NOT NULL AND responded_by_identity_id IS NOT NULL AND responded_at IS NOT NULL AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL)
          OR (status = 'rejected' AND response_message IS NOT NULL AND response_evidence_document_id IS NOT NULL AND responded_by_identity_id IS NOT NULL AND responded_at IS NOT NULL AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND review_notes IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS asset_application_review_items_application_idx
      ON fractal.asset_application_review_items (organization_id, application_request_id, status, opened_at, id);

    CREATE OR REPLACE FUNCTION fractal.enforce_asset_application_review_item_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'asset application review items are not deletable'; END IF;
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.application_request_id IS DISTINCT FROM OLD.application_request_id OR NEW.category IS DISTINCT FROM OLD.category
         OR NEW.title IS DISTINCT FROM OLD.title OR NEW.request_message IS DISTINCT FROM OLD.request_message
         OR NEW.required IS DISTINCT FROM OLD.required OR NEW.opened_by_identity_id IS DISTINCT FROM OLD.opened_by_identity_id
         OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'asset application review item facts are immutable';
      END IF;
      IF OLD.status = 'open' AND NEW.status = 'responded' THEN RETURN NEW; END IF;
      IF OLD.status = 'responded' AND NEW.status IN ('verified', 'rejected') THEN
        IF NEW.response_message IS DISTINCT FROM OLD.response_message OR NEW.response_evidence_document_id IS DISTINCT FROM OLD.response_evidence_document_id
           OR NEW.responded_by_identity_id IS DISTINCT FROM OLD.responded_by_identity_id OR NEW.responded_at IS DISTINCT FROM OLD.responded_at THEN
          RAISE EXCEPTION 'responded diligence evidence is immutable during review';
        END IF;
        RETURN NEW;
      END IF;
      IF OLD.status = 'rejected' AND NEW.status = 'responded' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid asset application review item transition';
    END;
    $$;
    DROP TRIGGER IF EXISTS asset_application_review_items_transition ON fractal.asset_application_review_items;
    CREATE TRIGGER asset_application_review_items_transition
      BEFORE UPDATE OR DELETE ON fractal.asset_application_review_items
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_asset_application_review_item_transition();
  `,
};
