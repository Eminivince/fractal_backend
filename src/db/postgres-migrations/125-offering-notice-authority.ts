import type { PostgresMigration } from "./types.js";

export const offeringNoticeAuthorityMigration:PostgresMigration={
  version:"125-offering-notice-authority",
  sql:`
    INSERT INTO fractal.platform_configuration_definitions(configuration_key,label,description,value_type,validation_schema,consumer_binding)
    VALUES('offering.notice.policy','Offering notice policy','Approved jurisdictional retention and acknowledgment rules for material communications made available to confirmed investors.','json','{"schemaVersion":"offering-notice-policy-v1","requiresCompleteJurisdictionCategoryMatrix":true}'::jsonb,'new_case')
    ON CONFLICT(configuration_key) DO NOTHING;

    CREATE TABLE fractal.offering_notice_requests(
      id UUID PRIMARY KEY, reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^ONR-[0-9]{8}-[A-Z0-9]{8}$'),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id), offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      category TEXT NOT NULL CHECK(category IN('material_event','operational_update','financial_report','meeting_notice','distribution_information')),
      subject TEXT NOT NULL CHECK(length(subject) BETWEEN 5 AND 240), body TEXT NOT NULL CHECK(length(body) BETWEEN 20 AND 12000),
      audience_type TEXT NOT NULL DEFAULT 'confirmed_investors' CHECK(audience_type='confirmed_investors'),
      policy_configuration_key TEXT NOT NULL DEFAULT 'offering.notice.policy' CHECK(policy_configuration_key='offering.notice.policy'),
      policy_version_id UUID NOT NULL, policy_version_number INTEGER NOT NULL CHECK(policy_version_number>0), policy_projection_version INTEGER NOT NULL CHECK(policy_projection_version>0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK(policy_value_sha256 ~ '^[a-f0-9]{64}$'), policy_reference TEXT NOT NULL, policy_name TEXT NOT NULL,
      policy_schema_version TEXT NOT NULL CHECK(policy_schema_version='offering-notice-policy-v1'), policy_jurisdiction_code CHAR(2) NOT NULL CHECK(policy_jurisdiction_code ~ '^[A-Z]{2}$'),
      policy_legal_basis_reference TEXT NOT NULL, retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 9131),
      acknowledgment_required BOOLEAN NOT NULL, acknowledgment_window_days INTEGER,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','approved','rejected')),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200), submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id), submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id), reviewed_at TIMESTAMPTZ, decision_reason TEXT, published_notice_id UUID,
      UNIQUE(submitted_by_identity_id,command_key),
      CHECK((acknowledgment_required AND acknowledgment_window_days BETWEEN 1 AND 365) OR (NOT acknowledgment_required AND acknowledgment_window_days IS NULL)),
      CHECK((status='submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND decision_reason IS NULL AND published_notice_id IS NULL)
         OR (status='approved' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL AND published_notice_id IS NOT NULL)
         OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND decision_reason IS NOT NULL AND published_notice_id IS NULL)),
      CHECK(reviewed_by_identity_id IS NULL OR reviewed_by_identity_id<>submitted_by_identity_id)
    );
    CREATE INDEX offering_notice_requests_org_idx ON fractal.offering_notice_requests(organization_id,submitted_at DESC,id DESC);

    CREATE TABLE fractal.offering_notices(
      id UUID PRIMARY KEY, request_id UUID NOT NULL UNIQUE REFERENCES fractal.offering_notice_requests(id), organization_id UUID NOT NULL REFERENCES fractal.organizations(id), offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      category TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL, audience_type TEXT NOT NULL CHECK(audience_type='confirmed_investors'),
      policy_version_id UUID NOT NULL, policy_reference TEXT NOT NULL, policy_jurisdiction_code CHAR(2) NOT NULL, policy_legal_basis_reference TEXT NOT NULL,
      retention_days INTEGER NOT NULL, retain_until TIMESTAMPTZ NOT NULL, acknowledgment_required BOOLEAN NOT NULL, acknowledgment_due_at TIMESTAMPTZ,
      audience_count INTEGER NOT NULL CHECK(audience_count>0), published_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id), published_at TIMESTAMPTZ NOT NULL,
      CHECK((acknowledgment_required AND acknowledgment_due_at IS NOT NULL) OR (NOT acknowledgment_required AND acknowledgment_due_at IS NULL))
    );
    ALTER TABLE fractal.offering_notice_requests ADD CONSTRAINT offering_notice_requests_published_notice_fk FOREIGN KEY(published_notice_id) REFERENCES fractal.offering_notices(id);
    CREATE INDEX offering_notices_org_idx ON fractal.offering_notices(organization_id,published_at DESC,id DESC);

    CREATE TABLE fractal.offering_notice_recipients(
      id UUID PRIMARY KEY, notice_id UUID NOT NULL REFERENCES fractal.offering_notices(id), investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      source_reservation_id UUID NOT NULL REFERENCES fractal.investment_reservations(id), made_available_at TIMESTAMPTZ NOT NULL,
      first_read_at TIMESTAMPTZ, acknowledged_at TIMESTAMPTZ, UNIQUE(notice_id,investor_identity_id), UNIQUE(notice_id,source_reservation_id),
      CHECK(acknowledged_at IS NULL OR first_read_at IS NOT NULL), CHECK(first_read_at IS NULL OR first_read_at>=made_available_at), CHECK(acknowledged_at IS NULL OR acknowledged_at>=first_read_at)
    );
    CREATE INDEX offering_notice_recipients_investor_idx ON fractal.offering_notice_recipients(investor_identity_id,made_available_at DESC,notice_id);

    CREATE TABLE fractal.offering_notice_recipient_events(
      id UUID PRIMARY KEY, recipient_id UUID NOT NULL REFERENCES fractal.offering_notice_recipients(id), event_type TEXT NOT NULL CHECK(event_type IN('opened','acknowledged')),
      actor_identity_id UUID NOT NULL REFERENCES fractal.identities(id), occurred_at TIMESTAMPTZ NOT NULL, UNIQUE(recipient_id,event_type)
    );

    CREATE OR REPLACE FUNCTION fractal.validate_offering_notice_request() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE org_jurisdiction TEXT; product_org UUID; active_record RECORD; rule JSONB;
    BEGIN
      SELECT organization_id INTO product_org FROM fractal.offering_products WHERE id=NEW.offering_id;
      SELECT jurisdiction_code INTO org_jurisdiction FROM fractal.organizations WHERE id=NEW.organization_id;
      SELECT projection.active_version_id,projection.projection_version,version.version_number,version.value_sha256,version.proposed_value INTO active_record
        FROM fractal.platform_configuration_active_versions projection JOIN fractal.platform_configuration_versions version ON version.id=projection.active_version_id
       WHERE projection.configuration_key='offering.notice.policy';
      rule:=active_record.proposed_value->'jurisdictions'->org_jurisdiction->'rules'->NEW.category;
      IF product_org IS NULL OR product_org<>NEW.organization_id THEN RAISE EXCEPTION 'offering notice organization must match offering'; END IF;
      IF org_jurisdiction IS NULL OR active_record IS NULL OR rule IS NULL THEN RAISE EXCEPTION 'approved offering notice policy is unavailable'; END IF;
      IF NEW.policy_version_id<>active_record.active_version_id OR NEW.policy_version_number<>active_record.version_number OR NEW.policy_projection_version<>active_record.projection_version OR NEW.policy_value_sha256<>active_record.value_sha256
         OR NEW.policy_reference<>active_record.proposed_value->>'policyReference' OR NEW.policy_name<>active_record.proposed_value->>'policyName' OR NEW.policy_schema_version<>active_record.proposed_value->>'schemaVersion'
         OR NEW.policy_jurisdiction_code<>org_jurisdiction OR NEW.policy_legal_basis_reference<>active_record.proposed_value->'jurisdictions'->org_jurisdiction->>'legalBasisReference'
         OR NEW.retention_days<>(rule->>'retentionDays')::integer OR NEW.acknowledgment_required<>(rule->>'acknowledgmentRequired')::boolean
         OR NEW.acknowledgment_window_days IS DISTINCT FROM (rule->>'acknowledgmentWindowDays')::integer THEN RAISE EXCEPTION 'offering notice request must bind the exact active policy rule'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER offering_notice_request_validate BEFORE INSERT ON fractal.offering_notice_requests FOR EACH ROW EXECUTE FUNCTION fractal.validate_offering_notice_request();

    CREATE OR REPLACE FUNCTION fractal.protect_offering_notice_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'offering notice request evidence is immutable'; END IF;
      IF OLD.status<>'submitted' OR NEW.status NOT IN('approved','rejected') OR NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.organization_id<>OLD.organization_id OR NEW.offering_id<>OLD.offering_id OR NEW.category<>OLD.category OR NEW.subject<>OLD.subject OR NEW.body<>OLD.body OR NEW.audience_type<>OLD.audience_type
         OR NEW.policy_configuration_key<>OLD.policy_configuration_key OR NEW.policy_version_id<>OLD.policy_version_id OR NEW.policy_version_number<>OLD.policy_version_number OR NEW.policy_projection_version<>OLD.policy_projection_version OR NEW.policy_value_sha256<>OLD.policy_value_sha256
         OR NEW.policy_reference<>OLD.policy_reference OR NEW.policy_name<>OLD.policy_name OR NEW.policy_schema_version<>OLD.policy_schema_version OR NEW.policy_jurisdiction_code<>OLD.policy_jurisdiction_code OR NEW.policy_legal_basis_reference<>OLD.policy_legal_basis_reference
         OR NEW.retention_days<>OLD.retention_days OR NEW.acknowledgment_required<>OLD.acknowledgment_required OR NEW.acknowledgment_window_days IS DISTINCT FROM OLD.acknowledgment_window_days
         OR NEW.command_key<>OLD.command_key OR NEW.submitted_by_identity_id<>OLD.submitted_by_identity_id OR NEW.submitted_at<>OLD.submitted_at THEN RAISE EXCEPTION 'offering notice request facts are immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER offering_notice_request_guard BEFORE UPDATE OR DELETE ON fractal.offering_notice_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_notice_request();

    CREATE OR REPLACE FUNCTION fractal.reject_offering_notice_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'published offering notice evidence is immutable'; END; $$;
    CREATE TRIGGER offering_notices_immutable BEFORE UPDATE OR DELETE ON fractal.offering_notices FOR EACH ROW EXECUTE FUNCTION fractal.reject_offering_notice_mutation();

    CREATE OR REPLACE FUNCTION fractal.validate_offering_notice_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE notice_record RECORD; reservation_record RECORD;
    BEGIN
      SELECT offering_id,published_at INTO notice_record FROM fractal.offering_notices WHERE id=NEW.notice_id;
      SELECT offering_id,investor_identity_id,status INTO reservation_record FROM fractal.investment_reservations WHERE id=NEW.source_reservation_id;
      IF reservation_record IS NULL OR reservation_record.status<>'confirmed' OR reservation_record.offering_id<>notice_record.offering_id OR reservation_record.investor_identity_id<>NEW.investor_identity_id OR NEW.made_available_at<>notice_record.published_at THEN RAISE EXCEPTION 'offering notice recipient requires an exact confirmed investment'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER offering_notice_recipient_validate BEFORE INSERT ON fractal.offering_notice_recipients FOR EACH ROW EXECUTE FUNCTION fractal.validate_offering_notice_recipient();

    CREATE OR REPLACE FUNCTION fractal.protect_offering_notice_recipient() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.notice_id<>OLD.notice_id OR NEW.investor_identity_id<>OLD.investor_identity_id OR NEW.source_reservation_id<>OLD.source_reservation_id OR NEW.made_available_at<>OLD.made_available_at
         OR (OLD.first_read_at IS NOT NULL AND NEW.first_read_at<>OLD.first_read_at) OR (OLD.acknowledged_at IS NOT NULL AND NEW.acknowledged_at<>OLD.acknowledged_at) THEN RAISE EXCEPTION 'offering notice recipient evidence is immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER offering_notice_recipient_guard BEFORE UPDATE OR DELETE ON fractal.offering_notice_recipients FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_notice_recipient();

    CREATE OR REPLACE FUNCTION fractal.protect_offering_notice_recipient_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'offering notice recipient events are immutable'; END; $$;
    CREATE TRIGGER offering_notice_recipient_events_immutable BEFORE UPDATE OR DELETE ON fractal.offering_notice_recipient_events FOR EACH ROW EXECUTE FUNCTION fractal.protect_offering_notice_recipient_event();

    CREATE OR REPLACE FUNCTION fractal.validate_offering_notice_recipient_event() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE recipient_record RECORD;
    BEGIN
      SELECT investor_identity_id,first_read_at,acknowledged_at INTO recipient_record FROM fractal.offering_notice_recipients WHERE id=NEW.recipient_id;
      IF recipient_record IS NULL OR NEW.actor_identity_id<>recipient_record.investor_identity_id THEN RAISE EXCEPTION 'offering notice event actor must be its recipient'; END IF;
      IF NEW.event_type='opened' AND recipient_record.first_read_at IS NOT NULL THEN RAISE EXCEPTION 'offering notice opened event already exists'; END IF;
      IF NEW.event_type='acknowledged' AND (recipient_record.first_read_at IS NULL OR recipient_record.acknowledged_at IS NOT NULL) THEN RAISE EXCEPTION 'offering notice acknowledgment requires one prior open'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER offering_notice_recipient_event_validate BEFORE INSERT ON fractal.offering_notice_recipient_events FOR EACH ROW EXECUTE FUNCTION fractal.validate_offering_notice_recipient_event();

    CREATE OR REPLACE FUNCTION fractal.require_offering_notice_recipient_event_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.first_read_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fractal.offering_notice_recipient_events WHERE recipient_id=NEW.id AND event_type='opened' AND occurred_at=NEW.first_read_at) THEN RAISE EXCEPTION 'offering notice read projection requires its exact event'; END IF;
      IF NEW.acknowledged_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM fractal.offering_notice_recipient_events WHERE recipient_id=NEW.id AND event_type='acknowledged' AND occurred_at=NEW.acknowledged_at) THEN RAISE EXCEPTION 'offering notice acknowledgment projection requires its exact event'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER offering_notice_recipient_event_projection AFTER INSERT OR UPDATE ON fractal.offering_notice_recipients DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_offering_notice_recipient_event_projection();

    CREATE OR REPLACE FUNCTION fractal.require_offering_notice_event_back_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.event_type='opened' AND NOT EXISTS(SELECT 1 FROM fractal.offering_notice_recipients WHERE id=NEW.recipient_id AND first_read_at=NEW.occurred_at) THEN RAISE EXCEPTION 'offering notice opened event requires its exact projection'; END IF;
      IF NEW.event_type='acknowledged' AND NOT EXISTS(SELECT 1 FROM fractal.offering_notice_recipients WHERE id=NEW.recipient_id AND acknowledged_at=NEW.occurred_at) THEN RAISE EXCEPTION 'offering notice acknowledgment event requires its exact projection'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER offering_notice_event_back_projection AFTER INSERT ON fractal.offering_notice_recipient_events DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_offering_notice_event_back_projection();

    CREATE OR REPLACE FUNCTION fractal.require_offering_notice_audience_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE expected_count INTEGER; actual_count INTEGER;
    BEGIN
      SELECT audience_count INTO expected_count FROM fractal.offering_notices WHERE id=NEW.notice_id;
      SELECT count(*)::integer INTO actual_count FROM fractal.offering_notice_recipients WHERE notice_id=NEW.notice_id;
      IF actual_count<>expected_count THEN RAISE EXCEPTION 'offering notice frozen audience must match its exact projection'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER offering_notice_audience_projection AFTER INSERT ON fractal.offering_notice_recipients DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_offering_notice_audience_projection();

    CREATE OR REPLACE FUNCTION fractal.require_offering_notice_request_back_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NOT EXISTS(SELECT 1 FROM fractal.offering_notice_requests WHERE id=NEW.request_id AND status='approved' AND published_notice_id=NEW.id) THEN RAISE EXCEPTION 'published offering notice requires its approved request projection'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER offering_notice_request_back_projection AFTER INSERT ON fractal.offering_notices DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.require_offering_notice_request_back_projection();

    CREATE OR REPLACE FUNCTION fractal.validate_offering_notice_projection() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE notice_record RECORD; recipient_count INTEGER; expected_count INTEGER;
    BEGIN
      SELECT * INTO notice_record FROM fractal.offering_notices WHERE request_id=NEW.id;
      IF NEW.status='approved' THEN
        SELECT count(*)::integer INTO recipient_count FROM fractal.offering_notice_recipients WHERE notice_id=notice_record.id;
        SELECT count(DISTINCT investor_identity_id)::integer INTO expected_count FROM fractal.investment_reservations WHERE offering_id=NEW.offering_id AND status='confirmed' AND created_at<=notice_record.published_at;
        IF notice_record IS NULL OR NEW.published_notice_id<>notice_record.id OR notice_record.organization_id<>NEW.organization_id OR notice_record.offering_id<>NEW.offering_id OR notice_record.category<>NEW.category OR notice_record.subject<>NEW.subject OR notice_record.body<>NEW.body
           OR notice_record.policy_version_id<>NEW.policy_version_id OR notice_record.policy_reference<>NEW.policy_reference OR notice_record.policy_jurisdiction_code<>NEW.policy_jurisdiction_code OR notice_record.policy_legal_basis_reference<>NEW.policy_legal_basis_reference OR notice_record.retention_days<>NEW.retention_days
           OR notice_record.retain_until<>notice_record.published_at+NEW.retention_days*interval '24 hours' OR notice_record.acknowledgment_required<>NEW.acknowledgment_required
           OR notice_record.acknowledgment_due_at IS DISTINCT FROM (CASE WHEN NEW.acknowledgment_required THEN notice_record.published_at+NEW.acknowledgment_window_days*interval '24 hours' ELSE NULL END)
           OR notice_record.published_by_identity_id<>NEW.reviewed_by_identity_id OR notice_record.published_at<>NEW.reviewed_at OR notice_record.audience_count<>recipient_count OR recipient_count<>expected_count THEN RAISE EXCEPTION 'approved offering notice request requires its exact complete projection'; END IF;
      ELSIF notice_record IS NOT NULL THEN RAISE EXCEPTION 'non-approved offering notice request cannot have a published projection'; END IF;
      RETURN NEW;
    END; $$;
    CREATE CONSTRAINT TRIGGER offering_notice_projection_guard AFTER INSERT OR UPDATE ON fractal.offering_notice_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.validate_offering_notice_projection();

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'investor_finance_ownership',true,'relational_identity',ARRAY['offering_notice_and_recipient_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Subject-scoped collection, privacy-rights retention approval, legal-hold coverage, and rights-execution treatment for governed offering notices remain incomplete.'
      FROM unnest(ARRAY['offering_notice_requests','offering_notices','offering_notice_recipients','offering_notice_recipient_events']) name ON CONFLICT(source_key) DO NOTHING;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
