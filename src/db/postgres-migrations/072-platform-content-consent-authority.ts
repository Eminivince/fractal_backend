import type { PostgresMigration } from "./types.js";

/**
 * Establishes immutable, maker-checker legal publication and exact consent
 * evidence. Definitions are safe metadata; no legal draft is seeded or made
 * public by migration because legal approval cannot be fabricated by code.
 */
export const platformContentConsentAuthorityMigration: PostgresMigration = {
  version: "072-platform-content-consent-authority",
  sql: `
    INSERT INTO fractal.administrator_capability_definitions
      (capability_key, label, description)
    VALUES
      ('platform_content_manage', 'Platform legal content management', 'Read, propose, independently approve, publish, supersede, and evidence governed legal document versions.')
    ON CONFLICT (capability_key) DO NOTHING;

    INSERT INTO fractal.administrator_capability_assignments
      (id, identity_id, capability_key)
    SELECT md5(assignment.identity_id::text || ':platform_content_manage')::uuid,
           assignment.identity_id,
           'platform_content_manage'
      FROM fractal.identity_role_assignments assignment
      JOIN fractal.identities identity ON identity.id = assignment.identity_id
     WHERE assignment.role = 'admin'
       AND assignment.scope_type = 'global'
       AND assignment.revoked_at IS NULL
       AND identity.status = 'active'
    ON CONFLICT DO NOTHING;

    CREATE TABLE fractal.platform_content_definitions (
      document_key TEXT PRIMARY KEY CHECK (document_key ~ '^[a-z][a-z0-9_]{2,79}$'),
      slug TEXT NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
      title TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 120),
      document_type TEXT NOT NULL CHECK (document_type IN ('terms', 'privacy', 'risk_disclosure', 'cookie_notice', 'platform_disclosure')),
      jurisdiction_code TEXT NOT NULL CHECK (jurisdiction_code = 'GLOBAL' OR jurisdiction_code ~ '^[A-Z]{2}$'),
      audience TEXT NOT NULL CHECK (audience IN ('public', 'registered_users', 'investors', 'issuers', 'professionals')),
      required_at_registration BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );

    INSERT INTO fractal.platform_content_definitions
      (document_key, slug, title, document_type, jurisdiction_code, audience, required_at_registration)
    VALUES
      ('terms_global_public', 'terms', 'Terms of use', 'terms', 'GLOBAL', 'public', TRUE),
      ('privacy_global_public', 'privacy', 'Privacy notice', 'privacy', 'GLOBAL', 'public', TRUE),
      ('risk_global_public', 'risk-disclosures', 'Risk disclosures', 'risk_disclosure', 'GLOBAL', 'public', FALSE),
      ('cookies_global_public', 'cookies', 'Cookie notice', 'cookie_notice', 'GLOBAL', 'public', FALSE),
      ('platform_disclosure_global_public', 'platform-disclosure', 'Platform disclosure', 'platform_disclosure', 'GLOBAL', 'public', FALSE);

    CREATE TABLE fractal.platform_content_versions (
      id UUID PRIMARY KEY,
      document_key TEXT NOT NULL REFERENCES fractal.platform_content_definitions(document_key),
      semantic_version TEXT NOT NULL CHECK (semantic_version ~ '^[0-9]+\\.[0-9]+\\.[0-9]+$'),
      state_version INTEGER NOT NULL CHECK (state_version > 0),
      status TEXT NOT NULL CHECK (status IN ('validation_failed', 'pending', 'rejected', 'scheduled', 'published', 'superseded', 'failed')),
      content JSONB NOT NULL CHECK (jsonb_typeof(content) = 'object'),
      content_bytes BYTEA NOT NULL CHECK (octet_length(content_bytes) BETWEEN 2 AND 524288),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      validation_output JSONB NOT NULL CHECK (jsonb_typeof(validation_output) = 'object'),
      change_summary TEXT NOT NULL CHECK (length(change_summary) BETWEEN 10 AND 2000),
      reacceptance_required BOOLEAN NOT NULL,
      proposed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      decision_reason TEXT CHECK (decision_reason IS NULL OR length(decision_reason) BETWEEN 10 AND 2000),
      effective_at TIMESTAMPTZ NOT NULL,
      proposed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      published_at TIMESTAMPTZ,
      superseded_at TIMESTAMPTZ,
      supersedes_version_id UUID REFERENCES fractal.platform_content_versions(id),
      failure_code TEXT,
      failure_detail TEXT,
      UNIQUE (document_key, semantic_version),
      UNIQUE (document_key, id),
      CONSTRAINT platform_content_independent_reviewer CHECK (reviewed_by_identity_id IS NULL OR reviewed_by_identity_id <> proposed_by_identity_id),
      CONSTRAINT platform_content_review_shape CHECK (
        (status IN ('validation_failed', 'pending') AND reviewed_by_identity_id IS NULL AND decision_reason IS NULL AND reviewed_at IS NULL AND published_at IS NULL)
        OR (status = 'rejected' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND published_at IS NULL)
        OR (status IN ('scheduled', 'published', 'superseded') AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL)
        OR (status = 'failed' AND reviewed_by_identity_id IS NOT NULL AND decision_reason IS NOT NULL AND reviewed_at IS NOT NULL AND failure_code IS NOT NULL AND failure_detail IS NOT NULL)
      ),
      CONSTRAINT platform_content_publication_shape CHECK (
        (status IN ('validation_failed', 'pending', 'rejected', 'scheduled', 'failed') AND published_at IS NULL AND superseded_at IS NULL)
        OR (status = 'published' AND published_at IS NOT NULL AND superseded_at IS NULL)
        OR (status = 'superseded' AND published_at IS NOT NULL AND superseded_at IS NOT NULL)
      )
    );
    CREATE UNIQUE INDEX platform_content_one_open_version_idx ON fractal.platform_content_versions (document_key) WHERE status IN ('pending', 'scheduled');
    CREATE UNIQUE INDEX platform_content_one_published_version_idx ON fractal.platform_content_versions (document_key) WHERE status = 'published';
    CREATE INDEX platform_content_publication_queue_idx ON fractal.platform_content_versions (effective_at, document_key) WHERE status = 'scheduled';
    CREATE INDEX platform_content_history_idx ON fractal.platform_content_versions (document_key, proposed_at DESC);

    CREATE TABLE fractal.platform_content_publications (
      document_key TEXT PRIMARY KEY REFERENCES fractal.platform_content_definitions(document_key),
      published_version_id UUID NOT NULL UNIQUE,
      projection_version INTEGER NOT NULL CHECK (projection_version > 0),
      bound_at TIMESTAMPTZ NOT NULL,
      CONSTRAINT platform_content_publication_same_definition FOREIGN KEY (document_key, published_version_id)
        REFERENCES fractal.platform_content_versions(document_key, id)
    );

    CREATE TABLE fractal.platform_content_events (
      id UUID PRIMARY KEY,
      content_version_id UUID NOT NULL REFERENCES fractal.platform_content_versions(id),
      sequence INTEGER NOT NULL CHECK (sequence > 0),
      event_type TEXT NOT NULL CHECK (event_type IN ('proposed', 'validation_failed', 'approved', 'rejected', 'published', 'superseded', 'publication_failed')),
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'system')),
      actor_identity_id UUID REFERENCES fractal.identities(id),
      reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 2000),
      evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (content_version_id, sequence),
      CONSTRAINT platform_content_event_actor_shape CHECK (
        (actor_type = 'user' AND actor_identity_id IS NOT NULL)
        OR (actor_type = 'system' AND actor_identity_id IS NULL)
      )
    );

    CREATE TABLE fractal.legal_document_acceptances (
      id UUID PRIMARY KEY,
      identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      content_version_id UUID NOT NULL REFERENCES fractal.platform_content_versions(id),
      document_key TEXT NOT NULL,
      semantic_version TEXT NOT NULL,
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
      acceptance_context TEXT NOT NULL CHECK (acceptance_context IN ('registration', 'reacceptance')),
      affirmative_action TEXT NOT NULL CHECK (affirmative_action IN ('checkbox', 'review_and_accept')),
      ip_hash CHAR(64) CHECK (ip_hash IS NULL OR ip_hash ~ '^[0-9a-f]{64}$'),
      user_agent_hash CHAR(64) CHECK (user_agent_hash IS NULL OR user_agent_hash ~ '^[0-9a-f]{64}$'),
      evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
      accepted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (identity_id, content_version_id),
      CONSTRAINT legal_acceptance_exact_version FOREIGN KEY (document_key, content_version_id)
        REFERENCES fractal.platform_content_versions(document_key, id)
    );
    CREATE INDEX legal_document_acceptances_identity_idx ON fractal.legal_document_acceptances (identity_id, accepted_at DESC);

    CREATE OR REPLACE FUNCTION fractal.reject_platform_content_evidence_mutation()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'platform content evidence is immutable'; END; $$;
    CREATE TRIGGER platform_content_events_immutable BEFORE UPDATE OR DELETE ON fractal.platform_content_events
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_platform_content_evidence_mutation();
    CREATE TRIGGER legal_document_acceptances_immutable BEFORE UPDATE OR DELETE ON fractal.legal_document_acceptances
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_platform_content_evidence_mutation();

    CREATE OR REPLACE FUNCTION fractal.protect_platform_content_version_facts()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'platform content version history is immutable'; END IF;
      IF NEW.id <> OLD.id OR NEW.document_key <> OLD.document_key OR NEW.semantic_version <> OLD.semantic_version
         OR NEW.content <> OLD.content OR NEW.content_bytes <> OLD.content_bytes OR NEW.content_sha256 <> OLD.content_sha256
         OR NEW.validation_output <> OLD.validation_output OR NEW.change_summary <> OLD.change_summary
         OR NEW.reacceptance_required <> OLD.reacceptance_required OR NEW.proposed_by_identity_id <> OLD.proposed_by_identity_id
         OR NEW.effective_at <> OLD.effective_at OR NEW.proposed_at <> OLD.proposed_at
         OR NEW.supersedes_version_id IS DISTINCT FROM OLD.supersedes_version_id THEN
        RAISE EXCEPTION 'proposed platform content facts are immutable';
      END IF;
      IF OLD.status NOT IN ('pending', 'scheduled', 'published') THEN RAISE EXCEPTION 'terminal platform content versions are immutable'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER platform_content_version_guard BEFORE UPDATE OR DELETE ON fractal.platform_content_versions
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_platform_content_version_facts();

    CREATE OR REPLACE FUNCTION fractal.require_platform_content_version_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE expected_type TEXT;
    BEGIN
      expected_type := CASE NEW.status WHEN 'pending' THEN 'proposed' WHEN 'validation_failed' THEN 'validation_failed'
        WHEN 'rejected' THEN 'rejected' WHEN 'scheduled' THEN 'approved' WHEN 'published' THEN 'published'
        WHEN 'superseded' THEN 'superseded' WHEN 'failed' THEN 'publication_failed' END;
      IF TG_OP = 'INSERT' THEN
        IF NEW.status NOT IN ('pending', 'validation_failed') THEN RAISE EXCEPTION 'platform content must begin as pending or validation_failed'; END IF;
      ELSE
        IF NEW.state_version <> OLD.state_version + 1 THEN RAISE EXCEPTION 'platform content state version must advance exactly once'; END IF;
        IF NOT ((OLD.status = 'pending' AND NEW.status IN ('scheduled','rejected')) OR (OLD.status = 'scheduled' AND NEW.status IN ('published','failed')) OR (OLD.status = 'published' AND NEW.status = 'superseded')) THEN
          RAISE EXCEPTION 'invalid platform content status transition';
        END IF;
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM fractal.platform_content_events event
         WHERE event.content_version_id = NEW.id AND event.sequence = NEW.state_version
           AND event.event_type = expected_type AND event.to_status = NEW.status
           AND ((TG_OP = 'INSERT' AND NEW.status = 'pending' AND event.from_status IS NULL)
             OR (TG_OP = 'INSERT' AND NEW.status = 'validation_failed' AND event.from_status = 'pending')
             OR (TG_OP = 'UPDATE' AND event.from_status = OLD.status))
           AND ((NEW.status = 'pending' AND event.actor_identity_id = NEW.proposed_by_identity_id AND event.reason = NEW.change_summary)
             OR (NEW.status = 'validation_failed' AND event.actor_identity_id = NEW.proposed_by_identity_id)
             OR (NEW.status IN ('scheduled','rejected') AND event.actor_identity_id = NEW.reviewed_by_identity_id AND event.reason = NEW.decision_reason)
             OR (NEW.status IN ('published','superseded','failed') AND event.actor_type = 'system' AND event.actor_identity_id IS NULL))
      ) THEN RAISE EXCEPTION 'platform content projection requires its matching immutable event'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER platform_content_version_event AFTER INSERT OR UPDATE ON fractal.platform_content_versions
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_platform_content_version_event();

    CREATE OR REPLACE FUNCTION fractal.protect_platform_content_publication()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'platform content publications are retained'; END IF;
      IF NEW.document_key <> OLD.document_key OR NEW.projection_version <> OLD.projection_version + 1
         OR NEW.published_version_id = OLD.published_version_id OR NEW.bound_at < OLD.bound_at THEN
        RAISE EXCEPTION 'invalid platform content publication transition';
      END IF;
      RETURN NEW;
    END;
    $$;
    CREATE TRIGGER platform_content_publication_guard BEFORE UPDATE OR DELETE ON fractal.platform_content_publications
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_platform_content_publication();

    CREATE OR REPLACE FUNCTION fractal.require_platform_content_publication_event()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM fractal.platform_content_versions version
        JOIN fractal.platform_content_events event ON event.content_version_id = version.id
        WHERE version.id = NEW.published_version_id AND version.document_key = NEW.document_key
          AND version.status = 'published' AND event.sequence = version.state_version
          AND event.event_type = 'published' AND event.evidence ->> 'projectionVersion' = NEW.projection_version::text
      ) THEN RAISE EXCEPTION 'platform content publication requires its exact publication event'; END IF;
      RETURN NEW;
    END;
    $$;
    CREATE CONSTRAINT TRIGGER platform_content_publication_event AFTER INSERT OR UPDATE ON fractal.platform_content_publications
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_platform_content_publication_event();
  `,
};
