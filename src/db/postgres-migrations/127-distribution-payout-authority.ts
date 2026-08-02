import type { PostgresMigration } from "./types.js";

/** Separates destination verification, funding approval, dispatch, and settlement from declaration. */
export const distributionPayoutAuthorityMigration: PostgresMigration = {
  version: "127-distribution-payout-authority",
  sql: `
    CREATE TABLE fractal.investor_distribution_payout_profiles(
      id UUID PRIMARY KEY,
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      version INTEGER NOT NULL CHECK(version>0),
      provider TEXT NOT NULL CHECK(provider='paystack'),
      rail TEXT NOT NULL CHECK(rail='bank_transfer'),
      currency CHAR(3) NOT NULL CHECK(currency='NGN'),
      account_holder_name TEXT NOT NULL CHECK(length(account_holder_name) BETWEEN 2 AND 200),
      account_last4 CHAR(4) NOT NULL CHECK(account_last4 ~ '^[0-9]{4}$'),
      provider_recipient_reference TEXT NOT NULL UNIQUE CHECK(length(provider_recipient_reference) BETWEEN 4 AND 500),
      status TEXT NOT NULL CHECK(status IN('verified','superseded')),
      verified_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      verified_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      superseded_at TIMESTAMPTZ,
      UNIQUE(investor_identity_id,version),
      CHECK(investor_identity_id=verified_by_identity_id),
      CHECK((status='verified' AND superseded_at IS NULL) OR (status='superseded' AND superseded_at IS NOT NULL))
    );
    CREATE UNIQUE INDEX investor_distribution_payout_profiles_current_idx ON fractal.investor_distribution_payout_profiles(investor_identity_id,currency) WHERE status='verified';

    CREATE TABLE fractal.distribution_payout_recipient_recovery_cases(
      id UUID PRIMARY KEY,
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      provider TEXT NOT NULL CHECK(provider='paystack'),
      provider_recipient_reference TEXT NOT NULL UNIQUE CHECK(length(provider_recipient_reference) BETWEEN 4 AND 500),
      failure_reason TEXT NOT NULL CHECK(length(failure_reason) BETWEEN 1 AND 2000),
      status TEXT NOT NULL DEFAULT 'open' CHECK(status IN('open','resolved')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      resolved_at TIMESTAMPTZ,
      CHECK((status='open' AND resolved_at IS NULL) OR (status='resolved' AND resolved_at IS NOT NULL))
    );

    CREATE TABLE fractal.distribution_funding_requests(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DFR-[0-9]{8}-[A-Z0-9]{8}$'),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      declaration_request_id UUID NOT NULL REFERENCES fractal.distribution_declaration_requests(id),
      provider TEXT NOT NULL CHECK(provider='paystack'),
      currency CHAR(3) NOT NULL CHECK(currency='NGN'),
      amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
      funding_evidence_reference TEXT NOT NULL CHECK(length(funding_evidence_reference) BETWEEN 4 AND 300),
      funding_evidence_sha256 CHAR(64) NOT NULL CHECK(funding_evidence_sha256 ~ '^[a-f0-9]{64}$'),
      submission_observed_balance_minor BIGINT NOT NULL CHECK(submission_observed_balance_minor>=0),
      approval_observed_balance_minor BIGINT CHECK(approval_observed_balance_minor>=0),
      status TEXT NOT NULL CHECK(status IN('submitted','approved','rejected')),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_at TIMESTAMPTZ,
      decision_reason TEXT,
      UNIQUE(submitted_by_identity_id,command_key),
      CHECK((status='submitted' AND approval_observed_balance_minor IS NULL AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND decision_reason IS NULL)
        OR (status='approved' AND approval_observed_balance_minor IS NOT NULL AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 2000)
        OR (status='rejected' AND approval_observed_balance_minor IS NULL AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 2000))
    );
    CREATE UNIQUE INDEX distribution_funding_one_active_idx ON fractal.distribution_funding_requests(declaration_request_id) WHERE status IN('submitted','approved');
    CREATE INDEX distribution_funding_org_idx ON fractal.distribution_funding_requests(organization_id,submitted_at DESC,id DESC);

    CREATE TABLE fractal.distribution_payout_instructions(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DPI-[A-Z0-9]{24}$'),
      funding_request_id UUID NOT NULL REFERENCES fractal.distribution_funding_requests(id),
      declaration_request_id UUID NOT NULL REFERENCES fractal.distribution_declaration_requests(id),
      entitlement_id UUID NOT NULL UNIQUE REFERENCES fractal.distribution_entitlements(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      payout_profile_version_id UUID NOT NULL REFERENCES fractal.investor_distribution_payout_profiles(id),
      provider TEXT NOT NULL CHECK(provider='paystack'),
      provider_recipient_reference TEXT NOT NULL CHECK(length(provider_recipient_reference) BETWEEN 4 AND 500),
      provider_transfer_code TEXT UNIQUE,
      currency CHAR(3) NOT NULL CHECK(currency='NGN'),
      amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
      status TEXT NOT NULL CHECK(status IN('authorized','dispatching','submitted','uncertain','confirmed','failed','reversed')),
      authorized_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      authorized_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      dispatch_started_at TIMESTAMPTZ,
      dispatch_worker_id TEXT,
      submitted_at TIMESTAMPTZ,
      confirmed_at TIMESTAMPTZ,
      failed_at TIMESTAMPTZ,
      failure_reason TEXT,
      settlement_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      reversal_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      CHECK((status='authorized' AND dispatch_started_at IS NULL AND submitted_at IS NULL AND confirmed_at IS NULL AND failed_at IS NULL AND failure_reason IS NULL AND settlement_journal_id IS NULL AND reversal_journal_id IS NULL)
        OR (status='dispatching' AND dispatch_started_at IS NOT NULL AND submitted_at IS NULL AND confirmed_at IS NULL AND failed_at IS NULL AND failure_reason IS NULL AND settlement_journal_id IS NULL AND reversal_journal_id IS NULL)
        OR (status='submitted' AND dispatch_started_at IS NOT NULL AND submitted_at IS NOT NULL AND confirmed_at IS NULL AND failed_at IS NULL AND settlement_journal_id IS NULL AND reversal_journal_id IS NULL)
        OR (status='uncertain' AND dispatch_started_at IS NOT NULL AND confirmed_at IS NULL AND failed_at IS NOT NULL AND length(failure_reason)>0 AND settlement_journal_id IS NULL AND reversal_journal_id IS NULL)
        OR (status='confirmed' AND submitted_at IS NOT NULL AND confirmed_at IS NOT NULL AND failed_at IS NULL AND failure_reason IS NULL AND settlement_journal_id IS NOT NULL AND reversal_journal_id IS NULL)
        OR (status='failed' AND confirmed_at IS NULL AND failed_at IS NOT NULL AND length(failure_reason)>0 AND settlement_journal_id IS NULL AND reversal_journal_id IS NULL)
        OR (status='reversed' AND confirmed_at IS NOT NULL AND failed_at IS NOT NULL AND length(failure_reason)>0 AND settlement_journal_id IS NOT NULL AND reversal_journal_id IS NOT NULL))
    );
    CREATE INDEX distribution_payout_status_idx ON fractal.distribution_payout_instructions(status,authorized_at,id);
    CREATE INDEX distribution_payout_investor_idx ON fractal.distribution_payout_instructions(investor_identity_id,authorized_at DESC,id DESC);

    CREATE TABLE fractal.distribution_payout_provider_events(
      id UUID PRIMARY KEY,
      payout_instruction_id UUID NOT NULL REFERENCES fractal.distribution_payout_instructions(id),
      provider TEXT NOT NULL CHECK(provider='paystack'),
      source TEXT NOT NULL CHECK(source IN('verification','webhook')),
      outcome TEXT NOT NULL CHECK(outcome IN('success','failed','reversed')),
      provider_transfer_code TEXT NOT NULL CHECK(length(provider_transfer_code) BETWEEN 3 AND 500),
      amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
      currency CHAR(3) NOT NULL CHECK(currency='NGN'),
      occurred_at TIMESTAMPTZ NOT NULL,
      evidence_sha256 CHAR(64) NOT NULL CHECK(evidence_sha256 ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(payout_instruction_id,outcome,provider_transfer_code,evidence_sha256)
    );

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_funding_request() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE declaration_record RECORD;
    BEGIN
      SELECT organization_id,currency,net_amount_minor,status INTO declaration_record FROM fractal.distribution_declaration_requests WHERE id=NEW.declaration_request_id;
      IF declaration_record IS NULL OR declaration_record.status<>'approved' OR declaration_record.organization_id<>NEW.organization_id OR declaration_record.currency<>NEW.currency OR declaration_record.net_amount_minor<>NEW.amount_minor THEN
        RAISE EXCEPTION 'distribution funding must exactly bind an approved declaration net liability';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_funding_insert_guard BEFORE INSERT ON fractal.distribution_funding_requests FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_funding_request();

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_payout_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE entitlement_record RECORD; funding_record RECORD; profile_record RECORD;
    BEGIN
      SELECT declaration_request_id,investor_identity_id,net_amount_minor INTO entitlement_record FROM fractal.distribution_entitlements WHERE id=NEW.entitlement_id;
      SELECT declaration_request_id,organization_id,provider,currency INTO funding_record FROM fractal.distribution_funding_requests WHERE id=NEW.funding_request_id;
      SELECT investor_identity_id,provider,currency,provider_recipient_reference INTO profile_record FROM fractal.investor_distribution_payout_profiles WHERE id=NEW.payout_profile_version_id;
      IF entitlement_record IS NULL OR funding_record IS NULL OR profile_record IS NULL OR entitlement_record.declaration_request_id<>NEW.declaration_request_id OR funding_record.declaration_request_id<>NEW.declaration_request_id
        OR entitlement_record.investor_identity_id<>NEW.investor_identity_id OR entitlement_record.net_amount_minor<>NEW.amount_minor
        OR profile_record.investor_identity_id<>NEW.investor_identity_id OR profile_record.provider<>NEW.provider OR profile_record.currency<>NEW.currency OR profile_record.provider_recipient_reference<>NEW.provider_recipient_reference
        OR funding_record.provider<>NEW.provider OR funding_record.currency<>NEW.currency THEN RAISE EXCEPTION 'distribution payout instruction must exactly bind funding, entitlement, investor, and verified destination'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_payout_insert_guard BEFORE INSERT ON fractal.distribution_payout_instructions FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_payout_instruction();

    CREATE OR REPLACE FUNCTION fractal.assert_distribution_payout_projection(funding_id UUID) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE funding_record RECORD; expected_count INTEGER; actual_count INTEGER; actual_amount BIGINT;
    BEGIN
      SELECT declaration_request_id,amount_minor,status INTO funding_record FROM fractal.distribution_funding_requests WHERE id=funding_id;
      IF funding_record IS NULL OR funding_record.status<>'approved' THEN RETURN; END IF;
      SELECT entitlement_count INTO expected_count FROM fractal.distribution_declaration_requests WHERE id=funding_record.declaration_request_id;
      SELECT count(*)::integer,COALESCE(sum(amount_minor),0) INTO actual_count,actual_amount FROM fractal.distribution_payout_instructions WHERE funding_request_id=funding_id;
      IF actual_count<>expected_count OR actual_amount<>funding_record.amount_minor THEN RAISE EXCEPTION 'approved distribution funding requires one exact payout instruction per entitlement'; END IF;
    END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_funding_projection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_distribution_payout_projection(NEW.id); RETURN NEW; END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_instruction_projection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_distribution_payout_projection(NEW.funding_request_id); RETURN NEW; END; $$;
    CREATE CONSTRAINT TRIGGER distribution_funding_projection AFTER UPDATE ON fractal.distribution_funding_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_distribution_funding_projection_trigger();
    CREATE CONSTRAINT TRIGGER distribution_instruction_projection AFTER INSERT ON fractal.distribution_payout_instructions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_distribution_instruction_projection_trigger();

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_funding_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'distribution funding requests are not deletable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.organization_id<>OLD.organization_id OR NEW.declaration_request_id<>OLD.declaration_request_id OR NEW.provider<>OLD.provider OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.funding_evidence_reference<>OLD.funding_evidence_reference OR NEW.funding_evidence_sha256<>OLD.funding_evidence_sha256 OR NEW.submission_observed_balance_minor<>OLD.submission_observed_balance_minor OR NEW.command_key<>OLD.command_key OR NEW.request_hash<>OLD.request_hash OR NEW.submitted_by_identity_id<>OLD.submitted_by_identity_id OR NEW.submitted_at<>OLD.submitted_at THEN RAISE EXCEPTION 'distribution funding facts are immutable'; END IF;
      IF OLD.status<>'submitted' OR NEW.status NOT IN('approved','rejected') OR NEW.reviewed_by_identity_id=OLD.submitted_by_identity_id THEN RAISE EXCEPTION 'distribution funding requires one independent terminal decision'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_funding_update_guard BEFORE UPDATE OR DELETE ON fractal.distribution_funding_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_funding_request();

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_payout_profile() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'distribution payout profiles are not deletable'; END IF;
      IF NEW.id<>OLD.id OR NEW.investor_identity_id<>OLD.investor_identity_id OR NEW.version<>OLD.version OR NEW.provider<>OLD.provider OR NEW.rail<>OLD.rail OR NEW.currency<>OLD.currency OR NEW.account_holder_name<>OLD.account_holder_name OR NEW.account_last4<>OLD.account_last4 OR NEW.provider_recipient_reference<>OLD.provider_recipient_reference OR NEW.verified_by_identity_id<>OLD.verified_by_identity_id OR NEW.verified_at<>OLD.verified_at OR OLD.status<>'verified' OR NEW.status<>'superseded' OR NEW.superseded_at IS NULL THEN RAISE EXCEPTION 'distribution payout profile facts are immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_payout_profile_guard BEFORE UPDATE OR DELETE ON fractal.investor_distribution_payout_profiles FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_payout_profile();
    CREATE OR REPLACE FUNCTION fractal.protect_distribution_payout_recipient_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.investor_identity_id<>OLD.investor_identity_id OR NEW.provider<>OLD.provider OR NEW.provider_recipient_reference<>OLD.provider_recipient_reference OR NEW.failure_reason<>OLD.failure_reason OR NEW.created_at<>OLD.created_at OR OLD.status<>'open' OR NEW.status<>'resolved' OR NEW.resolved_at IS NULL THEN RAISE EXCEPTION 'distribution payout recipient recovery facts are immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_payout_recipient_recovery_guard BEFORE UPDATE OR DELETE ON fractal.distribution_payout_recipient_recovery_cases FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_payout_recipient_recovery();

    CREATE OR REPLACE FUNCTION fractal.assert_distribution_payout_journal(p_payout_id UUID,p_journal_id UUID,p_reversal BOOLEAN) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE payout_record RECORD; journal_record RECORD; debit_count INTEGER; credit_count INTEGER; debit_amount BIGINT; credit_amount BIGINT; debit_code TEXT; credit_code TEXT;
    BEGIN
      SELECT payout.amount_minor,payout.currency,funding.organization_id,payout.settlement_journal_id INTO payout_record FROM fractal.distribution_payout_instructions payout JOIN fractal.distribution_funding_requests funding ON funding.id=payout.funding_request_id WHERE payout.id=p_payout_id;
      SELECT organization_id,currency,reversal_of,metadata->>'distributionPayoutInstructionId' AS payout_id INTO journal_record FROM fractal.journal_entries WHERE id=p_journal_id;
      SELECT count(*) FILTER(WHERE posting.direction='debit'),count(*) FILTER(WHERE posting.direction='credit'),sum(posting.amount_minor) FILTER(WHERE posting.direction='debit'),sum(posting.amount_minor) FILTER(WHERE posting.direction='credit'),max(account.code) FILTER(WHERE posting.direction='debit'),max(account.code) FILTER(WHERE posting.direction='credit') INTO debit_count,credit_count,debit_amount,credit_amount,debit_code,credit_code FROM fractal.journal_postings posting JOIN fractal.ledger_accounts account ON account.id=posting.account_id WHERE posting.journal_id=p_journal_id;
      IF payout_record IS NULL OR journal_record IS NULL OR journal_record.organization_id<>payout_record.organization_id OR journal_record.currency<>payout_record.currency OR journal_record.payout_id<>p_payout_id::text OR debit_count<>1 OR credit_count<>1 OR debit_amount<>payout_record.amount_minor OR credit_amount<>payout_record.amount_minor THEN RAISE EXCEPTION 'distribution payout requires its exact balanced journal'; END IF;
      IF p_reversal THEN
        IF journal_record.reversal_of<>payout_record.settlement_journal_id OR debit_code<>('ASSET.DISTRIBUTION_PAYOUT_CLEARING.'||payout_record.currency) OR credit_code<>('LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.'||payout_record.currency) THEN RAISE EXCEPTION 'distribution payout reversal journal is invalid'; END IF;
      ELSE
        IF journal_record.reversal_of IS NOT NULL OR debit_code<>('LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.'||payout_record.currency) OR credit_code<>('ASSET.DISTRIBUTION_PAYOUT_CLEARING.'||payout_record.currency) THEN RAISE EXCEPTION 'distribution payout settlement journal is invalid'; END IF;
      END IF;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_payout_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'distribution payout instructions are not deletable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.funding_request_id<>OLD.funding_request_id OR NEW.declaration_request_id<>OLD.declaration_request_id OR NEW.entitlement_id<>OLD.entitlement_id OR NEW.investor_identity_id<>OLD.investor_identity_id OR NEW.payout_profile_version_id<>OLD.payout_profile_version_id OR NEW.provider<>OLD.provider OR NEW.provider_recipient_reference<>OLD.provider_recipient_reference OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.authorized_by_identity_id<>OLD.authorized_by_identity_id OR NEW.authorized_at<>OLD.authorized_at THEN RAISE EXCEPTION 'distribution payout instruction facts are immutable'; END IF;
      IF NEW.status='confirmed' THEN PERFORM fractal.assert_distribution_payout_journal(NEW.id,NEW.settlement_journal_id,false); END IF;
      IF NEW.status='reversed' THEN PERFORM fractal.assert_distribution_payout_journal(NEW.id,NEW.reversal_journal_id,true); END IF;
      IF (OLD.status='authorized' AND NEW.status IN('dispatching','failed')) OR (OLD.status='dispatching' AND NEW.status IN('submitted','uncertain','failed')) OR (OLD.status='submitted' AND NEW.status IN('confirmed','uncertain','failed')) OR (OLD.status='uncertain' AND NEW.status IN('confirmed','failed')) OR (OLD.status='confirmed' AND NEW.status='reversed') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution payout transition';
    END; $$;
    CREATE TRIGGER distribution_payout_instruction_guard BEFORE UPDATE OR DELETE ON fractal.distribution_payout_instructions FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_payout_instruction();
    CREATE OR REPLACE FUNCTION fractal.validate_distribution_payout_provider_event() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE payout_record RECORD;
    BEGIN
      SELECT amount_minor,currency,provider,provider_transfer_code INTO payout_record FROM fractal.distribution_payout_instructions WHERE id=NEW.payout_instruction_id;
      IF payout_record IS NULL OR payout_record.amount_minor<>NEW.amount_minor OR payout_record.currency<>NEW.currency OR payout_record.provider<>NEW.provider OR (payout_record.provider_transfer_code IS NOT NULL AND payout_record.provider_transfer_code<>NEW.provider_transfer_code) THEN RAISE EXCEPTION 'distribution provider event does not match its governed payout instruction'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_payout_provider_event_guard BEFORE INSERT ON fractal.distribution_payout_provider_events FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_payout_provider_event();
    CREATE TRIGGER distribution_payout_provider_events_immutable BEFORE UPDATE OR DELETE ON fractal.distribution_payout_provider_events FOR EACH ROW EXECUTE FUNCTION fractal.reject_distribution_immutable();

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'investor_finance_ownership',true,'relational_identity',ARRAY['payout_destination_and_settlement_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Subject-scoped collection, financial retention, legal holds, destination secrecy, and rights treatment remain incomplete.'
      FROM unnest(ARRAY['investor_distribution_payout_profiles','distribution_payout_recipient_recovery_cases','distribution_funding_requests','distribution_payout_instructions','distribution_payout_provider_events']) name ON CONFLICT(source_key) DO NOTHING;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
