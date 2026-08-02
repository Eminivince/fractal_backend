import type { PostgresMigration } from "./types.js";

/** Governed correction authority for failed, reversed, and ambiguous investor-distribution payouts. */
export const distributionPayoutExceptionsMigration: PostgresMigration = {
  version: "128-distribution-payout-exceptions",
  sql: `
    CREATE TABLE fractal.distribution_payout_exception_policies(
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      version INTEGER NOT NULL CHECK(version>0),
      resolution_type TEXT NOT NULL CHECK(resolution_type IN('replacement_payout','manual_settlement','write_off')),
      currency CHAR(3) NOT NULL CHECK(currency='NGN'),
      maximum_amount_minor BIGINT NOT NULL CHECK(maximum_amount_minor>0),
      effective_from TIMESTAMPTZ NOT NULL,
      effective_until TIMESTAMPTZ,
      policy_reference TEXT NOT NULL CHECK(length(policy_reference) BETWEEN 8 AND 1000),
      status TEXT NOT NULL CHECK(status IN('draft','active','superseded')),
      prepared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      approved_by_identity_id UUID REFERENCES fractal.identities(id),
      approved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(organization_id,version),
      CHECK(effective_until IS NULL OR effective_until>effective_from),
      CHECK((status='draft' AND approved_by_identity_id IS NULL AND approved_at IS NULL) OR (status IN('active','superseded') AND approved_by_identity_id IS NOT NULL AND approved_at IS NOT NULL)),
      CHECK(approved_by_identity_id IS NULL OR approved_by_identity_id<>prepared_by_identity_id)
    );
    CREATE INDEX distribution_payout_exception_policy_active_idx ON fractal.distribution_payout_exception_policies(organization_id,resolution_type,currency,effective_from DESC,id) WHERE status='active';

    CREATE TABLE fractal.distribution_payout_exception_cases(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DPE-[A-Z0-9]{20}$'),
      payout_instruction_id UUID NOT NULL REFERENCES fractal.distribution_payout_instructions(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      status TEXT NOT NULL CHECK(status IN('open','evidence_submitted','decision_pending','approved','rejected','executed','closed')),
      resolution_type TEXT CHECK(resolution_type IN('replacement_payout','manual_settlement','write_off','close_no_action')),
      resolution_reason TEXT,
      hold_status TEXT NOT NULL DEFAULT 'clear' CHECK(hold_status IN('clear','active')),
      opened_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      prepared_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      executed_by_identity_id UUID REFERENCES fractal.identities(id),
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      prepared_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      CHECK((status IN('open','evidence_submitted') AND resolution_type IS NULL AND prepared_by_identity_id IS NULL AND reviewed_by_identity_id IS NULL)
        OR (status='decision_pending' AND resolution_type IS NOT NULL AND prepared_by_identity_id IS NOT NULL AND prepared_at IS NOT NULL AND reviewed_by_identity_id IS NULL)
        OR (status IN('approved','rejected','executed','closed') AND resolution_type IS NOT NULL AND prepared_by_identity_id IS NOT NULL AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL)),
      CHECK(prepared_by_identity_id IS NULL OR prepared_by_identity_id<>reviewed_by_identity_id),
      CHECK((status<>'executed') OR (executed_by_identity_id IS NOT NULL AND executed_at IS NOT NULL)),
      CHECK((status<>'closed') OR closed_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX distribution_payout_exception_one_open_idx ON fractal.distribution_payout_exception_cases(payout_instruction_id) WHERE status<>'closed';
    CREATE INDEX distribution_payout_exception_queue_idx ON fractal.distribution_payout_exception_cases(status,hold_status,opened_at,id);

    CREATE TABLE fractal.distribution_payout_exception_evidence(
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.distribution_payout_exception_cases(id),
      evidence_type TEXT NOT NULL CHECK(evidence_type IN('provider_verification','provider_webhook','bank_confirmation','investor_confirmation','fraud_review','accounting_entry','legal_basis','other')),
      content_sha256 CHAR(64) NOT NULL CHECK(content_sha256 ~ '^[a-f0-9]{64}$'),
      storage_key TEXT NOT NULL CHECK(length(storage_key) BETWEEN 1 AND 1000),
      filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK(length(mime_type) BETWEEN 3 AND 120),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(case_id,content_sha256)
    );

    CREATE TABLE fractal.distribution_payout_exception_hold_requests(
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.distribution_payout_exception_cases(id),
      action TEXT NOT NULL CHECK(action IN('place','release')),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 20 AND 2000),
      status TEXT NOT NULL CHECK(status IN('pending','approved','rejected')),
      prepared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      CHECK((status='pending' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL) OR (status IN('approved','rejected') AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL)),
      CHECK(reviewed_by_identity_id IS NULL OR reviewed_by_identity_id<>prepared_by_identity_id)
    );
    CREATE UNIQUE INDEX distribution_payout_exception_hold_pending_idx ON fractal.distribution_payout_exception_hold_requests(case_id) WHERE status='pending';

    CREATE TABLE fractal.distribution_payout_exception_executions(
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL UNIQUE REFERENCES fractal.distribution_payout_exception_cases(id),
      resolution_type TEXT NOT NULL CHECK(resolution_type IN('replacement_payout','manual_settlement','write_off','close_no_action')),
      approval_policy_id UUID REFERENCES fractal.distribution_payout_exception_policies(id),
      replacement_payout_instruction_id UUID UNIQUE REFERENCES fractal.distribution_payout_instructions(id),
      correction_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      evidence_reference TEXT CHECK(evidence_reference IS NULL OR length(evidence_reference) BETWEEN 8 AND 500),
      executed_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      executed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK((resolution_type='replacement_payout' AND approval_policy_id IS NOT NULL AND replacement_payout_instruction_id IS NOT NULL AND correction_journal_id IS NULL)
        OR (resolution_type IN('manual_settlement','write_off') AND approval_policy_id IS NOT NULL AND replacement_payout_instruction_id IS NULL AND correction_journal_id IS NOT NULL AND evidence_reference IS NOT NULL)
        OR (resolution_type='close_no_action' AND approval_policy_id IS NULL AND replacement_payout_instruction_id IS NULL AND correction_journal_id IS NULL))
    );

    ALTER TABLE fractal.distribution_payout_instructions DROP CONSTRAINT distribution_payout_instructions_entitlement_id_key;
    ALTER TABLE fractal.distribution_payout_instructions
      ADD COLUMN instruction_kind TEXT NOT NULL DEFAULT 'original' CHECK(instruction_kind IN('original','replacement')),
      ADD COLUMN replaces_instruction_id UUID REFERENCES fractal.distribution_payout_instructions(id),
      ADD COLUMN exception_case_id UUID REFERENCES fractal.distribution_payout_exception_cases(id),
      ADD CHECK((instruction_kind='original' AND replaces_instruction_id IS NULL AND exception_case_id IS NULL) OR (instruction_kind='replacement' AND replaces_instruction_id IS NOT NULL AND exception_case_id IS NOT NULL));
    CREATE UNIQUE INDEX distribution_payout_original_entitlement_idx ON fractal.distribution_payout_instructions(entitlement_id) WHERE instruction_kind='original';
    CREATE UNIQUE INDEX distribution_payout_replacement_source_idx ON fractal.distribution_payout_instructions(replaces_instruction_id) WHERE instruction_kind='replacement';

    CREATE OR REPLACE FUNCTION fractal.assert_distribution_payout_projection(funding_id UUID) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE funding_record RECORD; expected_count INTEGER; actual_count INTEGER; actual_amount BIGINT;
    BEGIN
      SELECT declaration_request_id,amount_minor,status INTO funding_record FROM fractal.distribution_funding_requests WHERE id=funding_id;
      IF funding_record IS NULL OR funding_record.status<>'approved' THEN RETURN; END IF;
      SELECT entitlement_count INTO expected_count FROM fractal.distribution_declaration_requests WHERE id=funding_record.declaration_request_id;
      SELECT count(*)::integer,COALESCE(sum(amount_minor),0) INTO actual_count,actual_amount FROM fractal.distribution_payout_instructions WHERE funding_request_id=funding_id AND instruction_kind='original';
      IF actual_count<>expected_count OR actual_amount<>funding_record.amount_minor THEN RAISE EXCEPTION 'approved distribution funding requires one exact original payout instruction per entitlement'; END IF;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_payout_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE entitlement_record RECORD; funding_record RECORD; profile_record RECORD; source_record RECORD; case_record RECORD;
    BEGIN
      SELECT declaration_request_id,investor_identity_id,net_amount_minor INTO entitlement_record FROM fractal.distribution_entitlements WHERE id=NEW.entitlement_id;
      SELECT declaration_request_id,provider,currency INTO funding_record FROM fractal.distribution_funding_requests WHERE id=NEW.funding_request_id;
      SELECT investor_identity_id,provider,currency,provider_recipient_reference,status INTO profile_record FROM fractal.investor_distribution_payout_profiles WHERE id=NEW.payout_profile_version_id;
      IF entitlement_record IS NULL OR funding_record IS NULL OR profile_record IS NULL OR entitlement_record.declaration_request_id<>NEW.declaration_request_id OR funding_record.declaration_request_id<>NEW.declaration_request_id OR entitlement_record.investor_identity_id<>NEW.investor_identity_id OR entitlement_record.net_amount_minor<>NEW.amount_minor OR profile_record.investor_identity_id<>NEW.investor_identity_id OR profile_record.provider<>NEW.provider OR profile_record.currency<>NEW.currency OR profile_record.provider_recipient_reference<>NEW.provider_recipient_reference OR profile_record.status<>'verified' OR funding_record.provider<>NEW.provider OR funding_record.currency<>NEW.currency THEN RAISE EXCEPTION 'distribution payout instruction must exactly bind funding, entitlement, investor, and current verified destination'; END IF;
      IF NEW.instruction_kind='replacement' THEN
        SELECT * INTO source_record FROM fractal.distribution_payout_instructions WHERE id=NEW.replaces_instruction_id;
        SELECT * INTO case_record FROM fractal.distribution_payout_exception_cases WHERE id=NEW.exception_case_id;
        IF source_record IS NULL OR source_record.status NOT IN('failed','reversed') OR source_record.entitlement_id<>NEW.entitlement_id OR source_record.amount_minor<>NEW.amount_minor OR case_record IS NULL OR case_record.payout_instruction_id<>source_record.id OR case_record.status<>'approved' OR case_record.resolution_type<>'replacement_payout' OR case_record.hold_status<>'clear' THEN RAISE EXCEPTION 'replacement payout requires an approved, unheld, terminal-failure exception'; END IF;
      END IF;
      RETURN NEW;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_payout_instruction() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'distribution payout instructions are not deletable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.funding_request_id<>OLD.funding_request_id OR NEW.declaration_request_id<>OLD.declaration_request_id OR NEW.entitlement_id<>OLD.entitlement_id OR NEW.investor_identity_id<>OLD.investor_identity_id OR NEW.payout_profile_version_id<>OLD.payout_profile_version_id OR NEW.provider<>OLD.provider OR NEW.provider_recipient_reference<>OLD.provider_recipient_reference OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.authorized_by_identity_id<>OLD.authorized_by_identity_id OR NEW.authorized_at<>OLD.authorized_at OR NEW.instruction_kind<>OLD.instruction_kind OR NEW.replaces_instruction_id IS DISTINCT FROM OLD.replaces_instruction_id OR NEW.exception_case_id IS DISTINCT FROM OLD.exception_case_id THEN RAISE EXCEPTION 'distribution payout instruction facts are immutable'; END IF;
      IF NEW.status='confirmed' THEN PERFORM fractal.assert_distribution_payout_journal(NEW.id,NEW.settlement_journal_id,false); END IF;
      IF NEW.status='reversed' THEN PERFORM fractal.assert_distribution_payout_journal(NEW.id,NEW.reversal_journal_id,true); END IF;
      IF (OLD.status='authorized' AND NEW.status IN('dispatching','failed')) OR (OLD.status='dispatching' AND NEW.status IN('submitted','uncertain','failed')) OR (OLD.status='submitted' AND NEW.status IN('confirmed','uncertain','failed')) OR (OLD.status='uncertain' AND NEW.status IN('confirmed','failed')) OR (OLD.status='confirmed' AND NEW.status='reversed') THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution payout transition';
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_exception_policy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.version<>OLD.version OR NEW.resolution_type<>OLD.resolution_type OR NEW.currency<>OLD.currency OR NEW.maximum_amount_minor<>OLD.maximum_amount_minor OR NEW.effective_from<>OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until OR NEW.policy_reference<>OLD.policy_reference OR NEW.prepared_by_identity_id<>OLD.prepared_by_identity_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'distribution exception policy facts are immutable'; END IF;
      IF OLD.status='draft' AND NEW.status='active' AND NEW.approved_by_identity_id IS NOT NULL AND NEW.approved_by_identity_id<>OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status='active' AND NEW.status='superseded' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution exception policy transition';
    END; $$;
    CREATE TRIGGER distribution_exception_policy_guard BEFORE UPDATE OR DELETE ON fractal.distribution_payout_exception_policies FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_exception_policy();

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_exception_case() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.payout_instruction_id<>OLD.payout_instruction_id OR NEW.organization_id<>OLD.organization_id OR NEW.opened_by_identity_id<>OLD.opened_by_identity_id OR NEW.opened_at<>OLD.opened_at THEN RAISE EXCEPTION 'distribution payout exception facts are immutable'; END IF;
      IF NEW.hold_status<>OLD.hold_status AND NEW.status<>OLD.status THEN RAISE EXCEPTION 'hold and case decisions must be separate commands'; END IF;
      IF NEW.hold_status<>OLD.hold_status AND NEW.status IN('open','evidence_submitted','decision_pending','approved') THEN RETURN NEW; END IF;
      IF OLD.status='open' AND NEW.status='evidence_submitted' THEN RETURN NEW; END IF;
      IF OLD.status='evidence_submitted' AND NEW.status='decision_pending' THEN RETURN NEW; END IF;
      IF OLD.status='decision_pending' AND NEW.status IN('approved','rejected') AND NEW.reviewed_by_identity_id<>OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status='approved' AND NEW.status='executed' AND OLD.hold_status='clear' THEN RETURN NEW; END IF;
      IF OLD.status IN('rejected','executed') AND NEW.status='closed' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution payout exception transition';
    END; $$;
    CREATE TRIGGER distribution_exception_case_guard BEFORE UPDATE OR DELETE ON fractal.distribution_payout_exception_cases FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_exception_case();
    CREATE OR REPLACE FUNCTION fractal.protect_distribution_exception_hold_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.case_id<>OLD.case_id OR NEW.action<>OLD.action OR NEW.reason<>OLD.reason OR NEW.prepared_by_identity_id<>OLD.prepared_by_identity_id OR NEW.prepared_at<>OLD.prepared_at THEN RAISE EXCEPTION 'distribution exception hold-request facts are immutable'; END IF;
      IF OLD.status='pending' AND NEW.status IN('approved','rejected') AND NEW.reviewed_by_identity_id IS NOT NULL AND NEW.reviewed_by_identity_id<>OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution exception hold-request transition';
    END; $$;
    CREATE TRIGGER distribution_exception_hold_request_guard BEFORE UPDATE OR DELETE ON fractal.distribution_payout_exception_hold_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_exception_hold_request();
    CREATE OR REPLACE FUNCTION fractal.validate_distribution_exception_execution() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE case_record RECORD; payout_record RECORD; policy_record RECORD; replacement_record RECORD; journal_record RECORD; debit_count INTEGER; credit_count INTEGER; debit_amount BIGINT; credit_amount BIGINT; debit_code TEXT; credit_code TEXT;
    BEGIN
      SELECT * INTO case_record FROM fractal.distribution_payout_exception_cases WHERE id=NEW.case_id;
      SELECT payout.*,funding.organization_id INTO payout_record FROM fractal.distribution_payout_instructions payout JOIN fractal.distribution_funding_requests funding ON funding.id=payout.funding_request_id WHERE payout.id=case_record.payout_instruction_id;
      IF case_record IS NULL OR payout_record IS NULL OR case_record.status<>'approved' OR case_record.hold_status<>'clear' OR case_record.resolution_type<>NEW.resolution_type OR NEW.executed_by_identity_id=case_record.prepared_by_identity_id THEN RAISE EXCEPTION 'distribution exception execution requires an approved unheld case and separate executor'; END IF;
      IF NEW.resolution_type<>'close_no_action' THEN
        SELECT * INTO policy_record FROM fractal.distribution_payout_exception_policies WHERE id=NEW.approval_policy_id;
        IF policy_record IS NULL OR policy_record.status<>'active' OR policy_record.organization_id<>case_record.organization_id OR policy_record.resolution_type<>NEW.resolution_type OR policy_record.currency<>payout_record.currency OR policy_record.maximum_amount_minor<payout_record.amount_minor OR policy_record.effective_from>NEW.executed_at OR (policy_record.effective_until IS NOT NULL AND policy_record.effective_until<=NEW.executed_at) THEN RAISE EXCEPTION 'distribution exception execution is outside its active approval policy'; END IF;
      END IF;
      IF NEW.resolution_type='replacement_payout' THEN
        SELECT * INTO replacement_record FROM fractal.distribution_payout_instructions WHERE id=NEW.replacement_payout_instruction_id;
        IF replacement_record IS NULL OR replacement_record.instruction_kind<>'replacement' OR replacement_record.replaces_instruction_id<>payout_record.id OR replacement_record.exception_case_id<>case_record.id OR payout_record.status NOT IN('failed','reversed') THEN RAISE EXCEPTION 'distribution replacement execution does not bind the terminal source payout'; END IF;
      ELSIF NEW.resolution_type IN('manual_settlement','write_off') THEN
        SELECT organization_id,currency,reversal_of,metadata->>'distributionPayoutInstructionId' AS payout_id,metadata->>'distributionPayoutExceptionCaseId' AS case_id INTO journal_record FROM fractal.journal_entries WHERE id=NEW.correction_journal_id;
        SELECT count(*) FILTER(WHERE posting.direction='debit'),count(*) FILTER(WHERE posting.direction='credit'),sum(posting.amount_minor) FILTER(WHERE posting.direction='debit'),sum(posting.amount_minor) FILTER(WHERE posting.direction='credit'),max(account.code) FILTER(WHERE posting.direction='debit'),max(account.code) FILTER(WHERE posting.direction='credit') INTO debit_count,credit_count,debit_amount,credit_amount,debit_code,credit_code FROM fractal.journal_postings posting JOIN fractal.ledger_accounts account ON account.id=posting.account_id WHERE posting.journal_id=NEW.correction_journal_id;
        IF journal_record IS NULL OR journal_record.organization_id<>case_record.organization_id OR journal_record.currency<>payout_record.currency OR journal_record.reversal_of IS NOT NULL OR journal_record.payout_id<>payout_record.id::text OR journal_record.case_id<>case_record.id::text OR debit_count<>1 OR credit_count<>1 OR debit_amount<>payout_record.amount_minor OR credit_amount<>payout_record.amount_minor OR debit_code<>('LIABILITY.INVESTOR_DISTRIBUTIONS_PAYABLE.'||payout_record.currency) OR credit_code<>(CASE WHEN NEW.resolution_type='manual_settlement' THEN 'ASSET.DISTRIBUTION_MANUAL_SETTLEMENT_CLEARING.' ELSE 'REVENUE.DISTRIBUTION_PAYABLE_RELEASE.' END||payout_record.currency) THEN RAISE EXCEPTION 'distribution correction execution requires its exact balanced journal'; END IF;
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_exception_execution_guard BEFORE INSERT ON fractal.distribution_payout_exception_executions FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_exception_execution();
    CREATE TRIGGER distribution_exception_evidence_immutable BEFORE UPDATE OR DELETE ON fractal.distribution_payout_exception_evidence FOR EACH ROW EXECUTE FUNCTION fractal.reject_distribution_immutable();
    CREATE TRIGGER distribution_exception_execution_immutable BEFORE UPDATE OR DELETE ON fractal.distribution_payout_exception_executions FOR EACH ROW EXECUTE FUNCTION fractal.reject_distribution_immutable();

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'investor_finance_ownership',true,'relational_identity',ARRAY['financial_exception_and_corrective_execution_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Subject-scoped collection, retention, legal holds, and rights treatment are scheduled for the distribution privacy checkpoint.' FROM unnest(ARRAY['distribution_payout_exception_policies','distribution_payout_exception_cases','distribution_payout_exception_evidence','distribution_payout_exception_hold_requests','distribution_payout_exception_executions']) name;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
