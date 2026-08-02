import type { PostgresMigration } from "./types.js";

/** Separates tax calculation, filing, payment evidence, confirmed remittance, and investor statements. */
export const distributionTaxRemittanceMigration: PostgresMigration = {
  version: "129-distribution-tax-remittance",
  sql: `
    CREATE TABLE fractal.distribution_tax_remittance_policies(
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      version INTEGER NOT NULL CHECK(version>0),
      jurisdiction_code TEXT NOT NULL CHECK(jurisdiction_code ~ '^[A-Z]{2}$'),
      currency CHAR(3) NOT NULL CHECK(currency=upper(currency)),
      tax_authority_name TEXT NOT NULL CHECK(length(tax_authority_name) BETWEEN 3 AND 240),
      tax_authority_reference TEXT NOT NULL CHECK(length(tax_authority_reference) BETWEEN 8 AND 1000),
      filing_due_days INTEGER NOT NULL CHECK(filing_due_days BETWEEN 0 AND 366),
      payment_due_days INTEGER NOT NULL CHECK(payment_due_days BETWEEN 0 AND 366),
      effective_from TIMESTAMPTZ NOT NULL,
      effective_until TIMESTAMPTZ,
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
    CREATE INDEX distribution_tax_policy_active_idx ON fractal.distribution_tax_remittance_policies(organization_id,jurisdiction_code,currency,effective_from DESC,id) WHERE status='active';

    CREATE TABLE fractal.distribution_tax_remittance_requests(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DTR-[A-Z0-9]{20}$'),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      declaration_request_id UUID NOT NULL UNIQUE REFERENCES fractal.distribution_declaration_requests(id),
      policy_id UUID NOT NULL REFERENCES fractal.distribution_tax_remittance_policies(id),
      jurisdiction_code TEXT NOT NULL CHECK(jurisdiction_code ~ '^[A-Z]{2}$'),
      currency CHAR(3) NOT NULL CHECK(currency=upper(currency)),
      amount_minor BIGINT NOT NULL CHECK(amount_minor>0),
      tax_period_start DATE NOT NULL,
      tax_period_end DATE NOT NULL,
      filing_due_at TIMESTAMPTZ NOT NULL,
      payment_due_at TIMESTAMPTZ NOT NULL,
      filing_reference TEXT NOT NULL CHECK(length(filing_reference) BETWEEN 8 AND 500),
      filing_evidence_sha256 CHAR(64) NOT NULL CHECK(filing_evidence_sha256 ~ '^[a-f0-9]{64}$'),
      payment_reference TEXT,
      payment_evidence_sha256 CHAR(64),
      authority_receipt_reference TEXT,
      authority_receipt_sha256 CHAR(64),
      status TEXT NOT NULL CHECK(status IN('submitted','approved','rejected','payment_evidence_submitted','remitted','payment_rejected','reversed')),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      payment_submitted_by_identity_id UUID REFERENCES fractal.identities(id),
      payment_reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      remittance_confirmed_by_identity_id UUID REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      payment_submitted_at TIMESTAMPTZ,
      payment_reviewed_at TIMESTAMPTZ,
      remitted_at TIMESTAMPTZ,
      reversed_at TIMESTAMPTZ,
      decision_reason TEXT,
      remittance_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      reversal_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      CHECK(tax_period_end>=tax_period_start),
      CHECK(filing_due_at>=tax_period_end::timestamptz AND payment_due_at>=tax_period_end::timestamptz),
      CHECK((payment_reference IS NULL AND payment_evidence_sha256 IS NULL AND payment_submitted_by_identity_id IS NULL AND payment_submitted_at IS NULL) OR (length(payment_reference) BETWEEN 8 AND 500 AND payment_evidence_sha256 ~ '^[a-f0-9]{64}$' AND payment_submitted_by_identity_id IS NOT NULL AND payment_submitted_at IS NOT NULL)),
      CHECK((authority_receipt_reference IS NULL AND authority_receipt_sha256 IS NULL AND remittance_confirmed_by_identity_id IS NULL AND remitted_at IS NULL) OR (length(authority_receipt_reference) BETWEEN 8 AND 500 AND authority_receipt_sha256 ~ '^[a-f0-9]{64}$' AND remittance_confirmed_by_identity_id IS NOT NULL AND remitted_at IS NOT NULL)),
      CHECK(reviewed_by_identity_id IS NULL OR reviewed_by_identity_id<>submitted_by_identity_id),
      CHECK(remittance_confirmed_by_identity_id IS NULL OR remittance_confirmed_by_identity_id<>payment_submitted_by_identity_id),
      CHECK(payment_reviewed_by_identity_id IS NULL OR payment_reviewed_by_identity_id<>payment_submitted_by_identity_id),
      CHECK((status='submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND decision_reason IS NULL AND remittance_journal_id IS NULL)
        OR (status IN('approved','rejected') AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 2000 AND remittance_journal_id IS NULL)
        OR (status='payment_evidence_submitted' AND reviewed_by_identity_id IS NOT NULL AND payment_submitted_by_identity_id IS NOT NULL AND payment_reviewed_by_identity_id IS NULL AND payment_reviewed_at IS NULL AND remittance_journal_id IS NULL)
        OR (status='payment_rejected' AND reviewed_by_identity_id IS NOT NULL AND payment_submitted_by_identity_id IS NOT NULL AND payment_reviewed_by_identity_id IS NOT NULL AND payment_reviewed_at IS NOT NULL AND remittance_journal_id IS NULL)
        OR (status='remitted' AND payment_reviewed_by_identity_id IS NOT NULL AND payment_reviewed_at IS NOT NULL AND remittance_confirmed_by_identity_id=payment_reviewed_by_identity_id AND remittance_journal_id IS NOT NULL AND reversal_journal_id IS NULL)
        OR (status='reversed' AND remittance_confirmed_by_identity_id IS NOT NULL AND remittance_journal_id IS NOT NULL AND reversal_journal_id IS NOT NULL AND reversed_at IS NOT NULL))
    );
    CREATE INDEX distribution_tax_remittance_queue_idx ON fractal.distribution_tax_remittance_requests(status,payment_due_at,id);
    CREATE INDEX distribution_tax_remittance_org_idx ON fractal.distribution_tax_remittance_requests(organization_id,submitted_at DESC,id DESC);

    CREATE TABLE fractal.distribution_tax_remittance_reversal_requests(
      id UUID PRIMARY KEY,
      remittance_request_id UUID NOT NULL UNIQUE REFERENCES fractal.distribution_tax_remittance_requests(id),
      reason TEXT NOT NULL CHECK(length(reason) BETWEEN 20 AND 2000),
      status TEXT NOT NULL CHECK(status IN('pending','approved','rejected','executed')),
      prepared_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reversal_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      prepared_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      CHECK((status='pending' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND reversal_journal_id IS NULL AND executed_at IS NULL)
        OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND reversal_journal_id IS NULL AND executed_at IS NULL)
        OR (status='approved' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND reversal_journal_id IS NOT NULL AND executed_at IS NULL)
        OR (status='executed' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND reversal_journal_id IS NOT NULL AND executed_at IS NOT NULL)),
      CHECK(reviewed_by_identity_id IS NULL OR reviewed_by_identity_id<>prepared_by_identity_id)
    );

    CREATE TABLE fractal.investor_distribution_tax_statements(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DTS-[A-Z0-9]{20}$'),
      remittance_request_id UUID NOT NULL REFERENCES fractal.distribution_tax_remittance_requests(id),
      declaration_request_id UUID NOT NULL REFERENCES fractal.distribution_declaration_requests(id),
      entitlement_id UUID NOT NULL UNIQUE REFERENCES fractal.distribution_entitlements(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      jurisdiction_code TEXT NOT NULL CHECK(jurisdiction_code ~ '^[A-Z]{2}$'),
      currency CHAR(3) NOT NULL CHECK(currency=upper(currency)),
      gross_amount_minor BIGINT NOT NULL CHECK(gross_amount_minor>0),
      withholding_tax_minor BIGINT NOT NULL CHECK(withholding_tax_minor>=0),
      tax_period_start DATE NOT NULL,
      tax_period_end DATE NOT NULL,
      tax_authority_name TEXT NOT NULL,
      authority_receipt_reference TEXT NOT NULL,
      authority_receipt_sha256 CHAR(64) NOT NULL CHECK(authority_receipt_sha256 ~ '^[a-f0-9]{64}$'),
      legal_basis_reference TEXT NOT NULL,
      statement_sha256 CHAR(64) NOT NULL CHECK(statement_sha256 ~ '^[a-f0-9]{64}$'),
      status TEXT NOT NULL CHECK(status IN('active','revoked')),
      issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      revoked_at TIMESTAMPTZ,
      UNIQUE(remittance_request_id,investor_identity_id),
      CHECK((status='active' AND revoked_at IS NULL) OR (status='revoked' AND revoked_at IS NOT NULL))
    );
    CREATE INDEX investor_distribution_tax_statement_owner_idx ON fractal.investor_distribution_tax_statements(investor_identity_id,issued_at DESC,id DESC);

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_tax_policy() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.organization_id<>OLD.organization_id OR NEW.version<>OLD.version OR NEW.jurisdiction_code<>OLD.jurisdiction_code OR NEW.currency<>OLD.currency OR NEW.tax_authority_name<>OLD.tax_authority_name OR NEW.tax_authority_reference<>OLD.tax_authority_reference OR NEW.filing_due_days<>OLD.filing_due_days OR NEW.payment_due_days<>OLD.payment_due_days OR NEW.effective_from<>OLD.effective_from OR NEW.effective_until IS DISTINCT FROM OLD.effective_until OR NEW.prepared_by_identity_id<>OLD.prepared_by_identity_id OR NEW.created_at<>OLD.created_at THEN RAISE EXCEPTION 'distribution tax policy facts are immutable'; END IF;
      IF OLD.status='draft' AND NEW.status='active' AND NEW.approved_by_identity_id IS NOT NULL AND NEW.approved_by_identity_id<>OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status='active' AND NEW.status='superseded' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution tax policy transition';
    END; $$;
    CREATE TRIGGER distribution_tax_policy_guard BEFORE UPDATE OR DELETE ON fractal.distribution_tax_remittance_policies FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_tax_policy();

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_tax_remittance_insert() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE declaration_record RECORD; policy_record RECORD;
    BEGIN
      SELECT organization_id,currency,withholding_tax_minor,policy_jurisdiction_code,status,reviewed_at INTO declaration_record FROM fractal.distribution_declaration_requests WHERE id=NEW.declaration_request_id;
      SELECT * INTO policy_record FROM fractal.distribution_tax_remittance_policies WHERE id=NEW.policy_id;
      IF declaration_record IS NULL OR declaration_record.status<>'approved' OR declaration_record.withholding_tax_minor<=0 OR declaration_record.organization_id<>NEW.organization_id OR declaration_record.currency<>NEW.currency OR declaration_record.withholding_tax_minor<>NEW.amount_minor OR declaration_record.policy_jurisdiction_code<>NEW.jurisdiction_code OR policy_record IS NULL OR policy_record.status<>'active' OR policy_record.organization_id<>NEW.organization_id OR policy_record.jurisdiction_code<>NEW.jurisdiction_code OR policy_record.currency<>NEW.currency OR policy_record.effective_from>NEW.submitted_at OR (policy_record.effective_until IS NOT NULL AND policy_record.effective_until<=NEW.submitted_at) OR NEW.filing_due_at<>(NEW.tax_period_end::timestamptz+(policy_record.filing_due_days*interval '1 day')) OR NEW.payment_due_at<>(NEW.tax_period_end::timestamptz+(policy_record.payment_due_days*interval '1 day')) THEN RAISE EXCEPTION 'tax remittance must exactly bind an approved withholding liability and active authority policy'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_tax_remittance_insert_guard BEFORE INSERT ON fractal.distribution_tax_remittance_requests FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_tax_remittance_insert();

    CREATE OR REPLACE FUNCTION fractal.assert_distribution_tax_journal(p_request_id UUID,p_journal_id UUID,p_reversal BOOLEAN) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE request_record RECORD; journal_record RECORD; debit_count INTEGER; credit_count INTEGER; debit_amount BIGINT; credit_amount BIGINT; debit_code TEXT; credit_code TEXT;
    BEGIN
      SELECT * INTO request_record FROM fractal.distribution_tax_remittance_requests WHERE id=p_request_id;
      SELECT organization_id,currency,reversal_of,metadata->>'distributionTaxRemittanceRequestId' AS request_id INTO journal_record FROM fractal.journal_entries WHERE id=p_journal_id;
      SELECT count(*) FILTER(WHERE posting.direction='debit'),count(*) FILTER(WHERE posting.direction='credit'),sum(posting.amount_minor) FILTER(WHERE posting.direction='debit'),sum(posting.amount_minor) FILTER(WHERE posting.direction='credit'),max(account.code) FILTER(WHERE posting.direction='debit'),max(account.code) FILTER(WHERE posting.direction='credit') INTO debit_count,credit_count,debit_amount,credit_amount,debit_code,credit_code FROM fractal.journal_postings posting JOIN fractal.ledger_accounts account ON account.id=posting.account_id WHERE posting.journal_id=p_journal_id;
      IF journal_record IS NULL OR journal_record.organization_id<>request_record.organization_id OR journal_record.currency<>request_record.currency OR journal_record.request_id<>request_record.id::text OR debit_count<>1 OR credit_count<>1 OR debit_amount<>request_record.amount_minor OR credit_amount<>request_record.amount_minor THEN RAISE EXCEPTION 'tax remittance requires its exact balanced journal'; END IF;
      IF p_reversal THEN
        IF journal_record.reversal_of<>request_record.remittance_journal_id OR debit_code<>('ASSET.DISTRIBUTION_TAX_REMITTANCE_CLEARING.'||request_record.currency) OR credit_code<>('LIABILITY.INVESTOR_DISTRIBUTION_WHT.'||request_record.currency) THEN RAISE EXCEPTION 'tax remittance reversal journal is invalid'; END IF;
      ELSE
        IF journal_record.reversal_of IS NOT NULL OR debit_code<>('LIABILITY.INVESTOR_DISTRIBUTION_WHT.'||request_record.currency) OR credit_code<>('ASSET.DISTRIBUTION_TAX_REMITTANCE_CLEARING.'||request_record.currency) THEN RAISE EXCEPTION 'tax remittance settlement journal is invalid'; END IF;
      END IF;
    END; $$;

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_tax_remittance() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.organization_id<>OLD.organization_id OR NEW.declaration_request_id<>OLD.declaration_request_id OR NEW.policy_id<>OLD.policy_id OR NEW.jurisdiction_code<>OLD.jurisdiction_code OR NEW.currency<>OLD.currency OR NEW.amount_minor<>OLD.amount_minor OR NEW.tax_period_start<>OLD.tax_period_start OR NEW.tax_period_end<>OLD.tax_period_end OR NEW.filing_due_at<>OLD.filing_due_at OR NEW.payment_due_at<>OLD.payment_due_at OR NEW.filing_reference<>OLD.filing_reference OR NEW.filing_evidence_sha256<>OLD.filing_evidence_sha256 OR NEW.submitted_by_identity_id<>OLD.submitted_by_identity_id OR NEW.submitted_at<>OLD.submitted_at THEN RAISE EXCEPTION 'distribution tax remittance facts are immutable'; END IF;
      IF OLD.status='submitted' AND NEW.status IN('approved','rejected') AND NEW.reviewed_by_identity_id<>OLD.submitted_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status='approved' AND NEW.status='payment_evidence_submitted' THEN RETURN NEW; END IF;
      IF OLD.status='payment_evidence_submitted' AND NEW.status IN('remitted','payment_rejected') AND NEW.payment_reviewed_by_identity_id<>OLD.payment_submitted_by_identity_id THEN IF NEW.status='remitted' THEN PERFORM fractal.assert_distribution_tax_journal(NEW.id,NEW.remittance_journal_id,false); END IF; RETURN NEW; END IF;
      IF OLD.status='remitted' AND NEW.status='reversed' THEN PERFORM fractal.assert_distribution_tax_journal(NEW.id,NEW.reversal_journal_id,true); IF NOT EXISTS(SELECT 1 FROM fractal.distribution_tax_remittance_reversal_requests reversal WHERE reversal.remittance_request_id=NEW.id AND reversal.status='approved' AND reversal.reversal_journal_id=NEW.reversal_journal_id) THEN RAISE EXCEPTION 'tax remittance reversal requires an independently approved request'; END IF; RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution tax remittance transition';
    END; $$;
    CREATE TRIGGER distribution_tax_remittance_guard BEFORE UPDATE OR DELETE ON fractal.distribution_tax_remittance_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_tax_remittance();

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_tax_statement() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE remittance_record RECORD; entitlement_record RECORD; declaration_record RECORD;
    BEGIN
      SELECT * INTO remittance_record FROM fractal.distribution_tax_remittance_requests WHERE id=NEW.remittance_request_id;
      SELECT * INTO entitlement_record FROM fractal.distribution_entitlements WHERE id=NEW.entitlement_id;
      SELECT policy_legal_basis_reference INTO declaration_record FROM fractal.distribution_declaration_requests WHERE id=NEW.declaration_request_id;
      IF remittance_record IS NULL OR remittance_record.status<>'remitted' OR entitlement_record IS NULL OR entitlement_record.declaration_request_id<>NEW.declaration_request_id OR entitlement_record.investor_identity_id<>NEW.investor_identity_id OR entitlement_record.gross_amount_minor<>NEW.gross_amount_minor OR entitlement_record.withholding_tax_minor<>NEW.withholding_tax_minor OR remittance_record.declaration_request_id<>NEW.declaration_request_id OR remittance_record.jurisdiction_code<>NEW.jurisdiction_code OR remittance_record.currency<>NEW.currency OR remittance_record.tax_period_start<>NEW.tax_period_start OR remittance_record.tax_period_end<>NEW.tax_period_end OR remittance_record.authority_receipt_reference<>NEW.authority_receipt_reference OR remittance_record.authority_receipt_sha256<>NEW.authority_receipt_sha256 OR declaration_record.policy_legal_basis_reference<>NEW.legal_basis_reference THEN RAISE EXCEPTION 'investor tax statement must exactly bind a confirmed remittance and entitlement'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_tax_statement_insert_guard BEFORE INSERT ON fractal.investor_distribution_tax_statements FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_tax_statement();
    CREATE OR REPLACE FUNCTION fractal.protect_distribution_tax_statement() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.remittance_request_id<>OLD.remittance_request_id OR NEW.declaration_request_id<>OLD.declaration_request_id OR NEW.entitlement_id<>OLD.entitlement_id OR NEW.investor_identity_id<>OLD.investor_identity_id OR NEW.jurisdiction_code<>OLD.jurisdiction_code OR NEW.currency<>OLD.currency OR NEW.gross_amount_minor<>OLD.gross_amount_minor OR NEW.withholding_tax_minor<>OLD.withholding_tax_minor OR NEW.tax_period_start<>OLD.tax_period_start OR NEW.tax_period_end<>OLD.tax_period_end OR NEW.tax_authority_name<>OLD.tax_authority_name OR NEW.authority_receipt_reference<>OLD.authority_receipt_reference OR NEW.authority_receipt_sha256<>OLD.authority_receipt_sha256 OR NEW.legal_basis_reference<>OLD.legal_basis_reference OR NEW.statement_sha256<>OLD.statement_sha256 OR NEW.issued_at<>OLD.issued_at OR OLD.status<>'active' OR NEW.status<>'revoked' OR NEW.revoked_at IS NULL THEN RAISE EXCEPTION 'investor distribution tax statement facts are immutable'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_tax_statement_guard BEFORE UPDATE OR DELETE ON fractal.investor_distribution_tax_statements FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_tax_statement();
    CREATE OR REPLACE FUNCTION fractal.protect_distribution_tax_reversal_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.remittance_request_id<>OLD.remittance_request_id OR NEW.reason<>OLD.reason OR NEW.prepared_by_identity_id<>OLD.prepared_by_identity_id OR NEW.prepared_at<>OLD.prepared_at THEN RAISE EXCEPTION 'distribution tax reversal-request facts are immutable'; END IF;
      IF OLD.status='pending' AND NEW.status IN('approved','rejected') AND NEW.reviewed_by_identity_id<>OLD.prepared_by_identity_id THEN IF NEW.status='approved' THEN PERFORM fractal.assert_distribution_tax_journal(NEW.remittance_request_id,NEW.reversal_journal_id,true); END IF; RETURN NEW; END IF;
      IF OLD.status='approved' AND NEW.status='executed' AND NEW.executed_at IS NOT NULL THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid distribution tax reversal-request transition';
    END; $$;
    CREATE TRIGGER distribution_tax_reversal_request_guard BEFORE UPDATE OR DELETE ON fractal.distribution_tax_remittance_reversal_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_tax_reversal_request();
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_tax_statement_projection(p_request_id UUID) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE request_record RECORD; expected_count INTEGER; actual_count INTEGER; tax_sum BIGINT; revoked_count INTEGER;
    BEGIN
      SELECT * INTO request_record FROM fractal.distribution_tax_remittance_requests WHERE id=p_request_id;
      IF request_record IS NULL OR request_record.status NOT IN('remitted','reversed') THEN RETURN; END IF;
      SELECT entitlement_count INTO expected_count FROM fractal.distribution_declaration_requests WHERE id=request_record.declaration_request_id;
      SELECT count(*)::integer,COALESCE(sum(withholding_tax_minor),0),count(*) FILTER(WHERE status='revoked')::integer INTO actual_count,tax_sum,revoked_count FROM fractal.investor_distribution_tax_statements WHERE remittance_request_id=p_request_id;
      IF actual_count<>expected_count OR tax_sum<>request_record.amount_minor OR (request_record.status='reversed' AND revoked_count<>actual_count) OR (request_record.status='remitted' AND revoked_count<>0) THEN RAISE EXCEPTION 'tax remittance requires one exact statement per entitlement with matching lifecycle'; END IF;
    END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_tax_request_statements_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_distribution_tax_statement_projection(NEW.id); RETURN NEW; END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_tax_statement_request_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_distribution_tax_statement_projection(NEW.remittance_request_id); RETURN NEW; END; $$;
    CREATE CONSTRAINT TRIGGER distribution_tax_request_statement_projection AFTER UPDATE ON fractal.distribution_tax_remittance_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_distribution_tax_request_statements_trigger();
    CREATE CONSTRAINT TRIGGER distribution_tax_statement_projection AFTER INSERT OR UPDATE ON fractal.investor_distribution_tax_statements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_distribution_tax_statement_request_trigger();

    DROP TRIGGER privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'investor_finance_ownership',true,'relational_identity',ARRAY['withholding_tax_remittance_and_statement_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Subject-scoped collection, statutory retention, holds, and rights treatment are scheduled for the distribution privacy checkpoint.' FROM unnest(ARRAY['distribution_tax_remittance_policies','distribution_tax_remittance_requests','distribution_tax_remittance_reversal_requests','investor_distribution_tax_statements']) name;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
