import type { PostgresMigration } from "./types.js";

export const distributionAuthorityMigration: PostgresMigration = {
  version: "126-distribution-authority",
  sql: `
    INSERT INTO fractal.platform_configuration_definitions(configuration_key,label,description,value_type,validation_schema,consumer_binding)
    VALUES('offering.distribution.policy','Offering distribution policy','Approved jurisdiction, currency, confirmation, withholding, declaration-limit, and retention rules for record-date distributions.','json','{"schemaVersion":"distribution-policy-v1"}'::jsonb,'new_case')
    ON CONFLICT(configuration_key) DO NOTHING;

    CREATE TABLE fractal.ownership_snapshot_requests(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^OSR-[0-9]{8}-[A-Z0-9]{8}$'),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      chain_id INTEGER NOT NULL CHECK(chain_id>0),
      token_contract_address CHAR(42) NOT NULL CHECK(token_contract_address ~ '^0x[0-9a-f]{40}$'),
      record_at TIMESTAMPTZ NOT NULL,
      block_number BIGINT NOT NULL CHECK(block_number>=0),
      block_hash CHAR(66) NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
      confirmations INTEGER NOT NULL CHECK(confirmations>=0),
      source_type TEXT NOT NULL CHECK(source_type IN('independent_indexer','archive_rpc')),
      source_reference TEXT NOT NULL CHECK(length(source_reference) BETWEEN 3 AND 300),
      source_manifest_sha256 CHAR(64) NOT NULL CHECK(source_manifest_sha256 ~ '^[a-f0-9]{64}$'),
      total_supply_units NUMERIC(78,0) NOT NULL CHECK(total_supply_units>0),
      holder_count INTEGER NOT NULL CHECK(holder_count>0 AND holder_count<=10000),
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','approved','rejected')),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_at TIMESTAMPTZ,
      decision_reason TEXT,
      UNIQUE(submitted_by_identity_id,command_key),
      CHECK((status='submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND decision_reason IS NULL)
        OR (status IN('approved','rejected') AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 2000))
    );
    CREATE INDEX ownership_snapshot_requests_org_idx ON fractal.ownership_snapshot_requests(organization_id,submitted_at DESC,id DESC);
    CREATE INDEX ownership_snapshot_requests_offering_idx ON fractal.ownership_snapshot_requests(offering_id,record_at DESC,id DESC);

    CREATE TABLE fractal.ownership_snapshot_holdings(
      id UUID PRIMARY KEY,
      snapshot_request_id UUID NOT NULL REFERENCES fractal.ownership_snapshot_requests(id) ON DELETE RESTRICT,
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      wallet_address CHAR(42) NOT NULL CHECK(wallet_address ~ '^0x[0-9a-f]{40}$'),
      balance_units NUMERIC(78,0) NOT NULL CHECK(balance_units>0),
      source_row_sha256 CHAR(64) NOT NULL CHECK(source_row_sha256 ~ '^[a-f0-9]{64}$'),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(snapshot_request_id,wallet_address)
    );
    CREATE INDEX ownership_snapshot_holdings_investor_idx ON fractal.ownership_snapshot_holdings(investor_identity_id,snapshot_request_id);

    CREATE TABLE fractal.distribution_declaration_requests(
      id UUID PRIMARY KEY,
      reference TEXT NOT NULL UNIQUE CHECK(reference ~ '^DDR-[0-9]{8}-[A-Z0-9]{8}$'),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      offering_id UUID NOT NULL REFERENCES fractal.offering_products(id),
      ownership_snapshot_request_id UUID NOT NULL REFERENCES fractal.ownership_snapshot_requests(id),
      period_label TEXT NOT NULL CHECK(length(period_label) BETWEEN 3 AND 120),
      currency CHAR(3) NOT NULL CHECK(currency=upper(currency)),
      gross_amount_minor BIGINT NOT NULL CHECK(gross_amount_minor>0),
      withholding_tax_bps INTEGER NOT NULL CHECK(withholding_tax_bps BETWEEN 0 AND 10000),
      withholding_tax_minor BIGINT NOT NULL CHECK(withholding_tax_minor>=0),
      net_amount_minor BIGINT NOT NULL CHECK(net_amount_minor>0),
      payment_due_at TIMESTAMPTZ NOT NULL,
      entitlement_count INTEGER NOT NULL CHECK(entitlement_count>0 AND entitlement_count<=10000),
      policy_configuration_key TEXT NOT NULL DEFAULT 'offering.distribution.policy' CHECK(policy_configuration_key='offering.distribution.policy'),
      policy_version_id UUID NOT NULL,
      policy_version_number INTEGER NOT NULL CHECK(policy_version_number>0),
      policy_projection_version INTEGER NOT NULL CHECK(policy_projection_version>0),
      policy_value_sha256 CHAR(64) NOT NULL CHECK(policy_value_sha256 ~ '^[a-f0-9]{64}$'),
      policy_reference TEXT NOT NULL,
      policy_name TEXT NOT NULL,
      policy_schema_version TEXT NOT NULL CHECK(policy_schema_version='distribution-policy-v1'),
      policy_jurisdiction_code CHAR(2) NOT NULL CHECK(policy_jurisdiction_code ~ '^[A-Z]{2}$'),
      policy_legal_basis_reference TEXT NOT NULL,
      policy_minimum_confirmations INTEGER NOT NULL CHECK(policy_minimum_confirmations>0),
      policy_maximum_declaration_minor BIGINT NOT NULL CHECK(policy_maximum_declaration_minor>0),
      policy_maximum_withholding_tax_bps INTEGER NOT NULL CHECK(policy_maximum_withholding_tax_bps BETWEEN 0 AND 10000),
      retention_days INTEGER NOT NULL CHECK(retention_days BETWEEN 1 AND 9131),
      retain_until TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN('submitted','approved','rejected')),
      command_key TEXT NOT NULL CHECK(length(command_key) BETWEEN 1 AND 200),
      request_hash CHAR(64) NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
      submitted_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_at TIMESTAMPTZ,
      decision_reason TEXT,
      declaration_journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      UNIQUE(submitted_by_identity_id,command_key),
      UNIQUE(ownership_snapshot_request_id,period_label),
      FOREIGN KEY(policy_configuration_key,policy_version_id) REFERENCES fractal.platform_configuration_versions(configuration_key,id),
      CHECK(gross_amount_minor=withholding_tax_minor+net_amount_minor),
      CHECK(gross_amount_minor<=policy_maximum_declaration_minor AND withholding_tax_bps<=policy_maximum_withholding_tax_bps),
      CHECK(retain_until=submitted_at+retention_days*interval '24 hours'),
      CHECK((status='submitted' AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL AND decision_reason IS NULL AND declaration_journal_id IS NULL)
        OR (status='approved' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 2000 AND declaration_journal_id IS NOT NULL)
        OR (status='rejected' AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL AND length(decision_reason) BETWEEN 20 AND 2000 AND declaration_journal_id IS NULL))
    );
    CREATE INDEX distribution_declarations_org_idx ON fractal.distribution_declaration_requests(organization_id,submitted_at DESC,id DESC);
    CREATE INDEX distribution_declarations_offering_idx ON fractal.distribution_declaration_requests(offering_id,submitted_at DESC,id DESC);

    CREATE OR REPLACE FUNCTION fractal.validate_distribution_policy_binding() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE version_record RECORD; active_projection INTEGER; jurisdiction JSONB; currency_rule JSONB;
    BEGIN
      SELECT version_number,value_sha256,proposed_value INTO version_record FROM fractal.platform_configuration_versions WHERE id=NEW.policy_version_id AND configuration_key=NEW.policy_configuration_key AND status='active';
      SELECT projection_version INTO active_projection FROM fractal.platform_configuration_active_versions WHERE configuration_key=NEW.policy_configuration_key AND active_version_id=NEW.policy_version_id;
      IF version_record IS NULL OR active_projection IS NULL THEN RAISE EXCEPTION 'distribution declaration requires the exact active policy version'; END IF;
      jurisdiction:=version_record.proposed_value->'jurisdictions'->NEW.policy_jurisdiction_code; currency_rule:=jurisdiction->'currencies'->NEW.currency;
      IF jurisdiction IS NULL OR currency_rule IS NULL OR version_record.version_number<>NEW.policy_version_number OR active_projection<>NEW.policy_projection_version OR version_record.value_sha256<>NEW.policy_value_sha256
        OR version_record.proposed_value->>'policyReference'<>NEW.policy_reference OR version_record.proposed_value->>'policyName'<>NEW.policy_name OR version_record.proposed_value->>'schemaVersion'<>NEW.policy_schema_version
        OR jurisdiction->>'legalBasisReference'<>NEW.policy_legal_basis_reference OR (currency_rule->>'minimumConfirmations')::integer<>NEW.policy_minimum_confirmations
        OR (currency_rule->>'maximumDeclarationMinor')::bigint<>NEW.policy_maximum_declaration_minor OR (currency_rule->>'maximumWithholdingTaxBps')::integer<>NEW.policy_maximum_withholding_tax_bps
        OR (currency_rule->>'retentionDays')::integer<>NEW.retention_days THEN RAISE EXCEPTION 'distribution declaration policy snapshot does not match its exact active version'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_policy_binding_validate BEFORE INSERT ON fractal.distribution_declaration_requests FOR EACH ROW EXECUTE FUNCTION fractal.validate_distribution_policy_binding();

    CREATE TABLE fractal.distribution_entitlements(
      id UUID PRIMARY KEY,
      declaration_request_id UUID NOT NULL REFERENCES fractal.distribution_declaration_requests(id) ON DELETE RESTRICT,
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      balance_units NUMERIC(78,0) NOT NULL CHECK(balance_units>0),
      gross_amount_minor BIGINT NOT NULL CHECK(gross_amount_minor>0),
      withholding_tax_minor BIGINT NOT NULL CHECK(withholding_tax_minor>=0),
      net_amount_minor BIGINT NOT NULL CHECK(net_amount_minor>0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE(declaration_request_id,investor_identity_id),
      CHECK(gross_amount_minor=withholding_tax_minor+net_amount_minor)
    );
    CREATE INDEX distribution_entitlements_investor_idx ON fractal.distribution_entitlements(investor_identity_id,created_at DESC,id DESC);

    CREATE OR REPLACE FUNCTION fractal.validate_snapshot_holding() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE snapshot_chain INTEGER;
    BEGIN
      SELECT chain_id INTO snapshot_chain FROM fractal.ownership_snapshot_requests WHERE id=NEW.snapshot_request_id;
      IF snapshot_chain IS NULL OR NOT EXISTS(SELECT 1 FROM fractal.investor_wallets WHERE investor_identity_id=NEW.investor_identity_id AND chain_id=snapshot_chain AND wallet_address=NEW.wallet_address AND status='active') THEN
        RAISE EXCEPTION 'ownership snapshot holding requires an active identity-bound wallet';
      END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER ownership_snapshot_holding_validate BEFORE INSERT ON fractal.ownership_snapshot_holdings FOR EACH ROW EXECUTE FUNCTION fractal.validate_snapshot_holding();

    CREATE OR REPLACE FUNCTION fractal.assert_snapshot_projection(snapshot_id UUID) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE expected_count INTEGER; actual_count INTEGER; expected_supply NUMERIC(78,0); actual_supply NUMERIC(78,0);
    BEGIN
      SELECT holder_count,total_supply_units INTO expected_count,expected_supply FROM fractal.ownership_snapshot_requests WHERE id=snapshot_id;
      SELECT count(*)::integer,COALESCE(sum(balance_units),0) INTO actual_count,actual_supply FROM fractal.ownership_snapshot_holdings WHERE snapshot_request_id=snapshot_id;
      IF expected_count IS NULL OR actual_count<>expected_count OR actual_supply<>expected_supply THEN RAISE EXCEPTION 'ownership snapshot holdings must exactly reconcile to declared count and total supply'; END IF;
    END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_snapshot_request_projection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_snapshot_projection(NEW.id); RETURN NEW; END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_snapshot_holding_projection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_snapshot_projection(NEW.snapshot_request_id); RETURN NEW; END; $$;
    CREATE CONSTRAINT TRIGGER ownership_snapshot_request_projection AFTER INSERT ON fractal.ownership_snapshot_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_snapshot_request_projection_trigger();
    CREATE CONSTRAINT TRIGGER ownership_snapshot_holding_projection AFTER INSERT ON fractal.ownership_snapshot_holdings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_snapshot_holding_projection_trigger();

    CREATE OR REPLACE FUNCTION fractal.protect_snapshot_request() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'ownership snapshot requests are not deletable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.organization_id<>OLD.organization_id OR NEW.offering_id<>OLD.offering_id OR NEW.chain_id<>OLD.chain_id OR NEW.token_contract_address<>OLD.token_contract_address OR NEW.record_at<>OLD.record_at OR NEW.block_number<>OLD.block_number OR NEW.block_hash<>OLD.block_hash OR NEW.confirmations<>OLD.confirmations OR NEW.source_type<>OLD.source_type OR NEW.source_reference<>OLD.source_reference OR NEW.source_manifest_sha256<>OLD.source_manifest_sha256 OR NEW.total_supply_units<>OLD.total_supply_units OR NEW.holder_count<>OLD.holder_count OR NEW.command_key<>OLD.command_key OR NEW.request_hash<>OLD.request_hash OR NEW.submitted_by_identity_id<>OLD.submitted_by_identity_id OR NEW.submitted_at<>OLD.submitted_at THEN RAISE EXCEPTION 'ownership snapshot facts are immutable'; END IF;
      IF OLD.status<>'submitted' OR NEW.status NOT IN('approved','rejected') OR NEW.reviewed_by_identity_id=OLD.submitted_by_identity_id THEN RAISE EXCEPTION 'ownership snapshot requires one independent terminal decision'; END IF;
      PERFORM fractal.assert_snapshot_projection(NEW.id); RETURN NEW;
    END; $$;
    CREATE TRIGGER ownership_snapshot_request_guard BEFORE UPDATE OR DELETE ON fractal.ownership_snapshot_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_snapshot_request();
    CREATE OR REPLACE FUNCTION fractal.reject_distribution_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fractal.% is immutable',TG_TABLE_NAME; END; $$;
    CREATE TRIGGER ownership_snapshot_holdings_immutable BEFORE UPDATE OR DELETE ON fractal.ownership_snapshot_holdings FOR EACH ROW EXECUTE FUNCTION fractal.reject_distribution_immutable();
    CREATE TRIGGER distribution_entitlements_immutable BEFORE UPDATE OR DELETE ON fractal.distribution_entitlements FOR EACH ROW EXECUTE FUNCTION fractal.reject_distribution_immutable();

    CREATE OR REPLACE FUNCTION fractal.assert_distribution_projection(declaration_id UUID) RETURNS void LANGUAGE plpgsql AS $$
    DECLARE declaration_record RECORD; actual_count INTEGER; gross_sum BIGINT; tax_sum BIGINT; net_sum BIGINT; balance_sum NUMERIC(78,0); snapshot_supply NUMERIC(78,0);
    BEGIN
      SELECT * INTO declaration_record FROM fractal.distribution_declaration_requests WHERE id=declaration_id;
      SELECT count(*)::integer,COALESCE(sum(gross_amount_minor),0),COALESCE(sum(withholding_tax_minor),0),COALESCE(sum(net_amount_minor),0),COALESCE(sum(balance_units),0) INTO actual_count,gross_sum,tax_sum,net_sum,balance_sum FROM fractal.distribution_entitlements WHERE declaration_request_id=declaration_id;
      SELECT total_supply_units INTO snapshot_supply FROM fractal.ownership_snapshot_requests WHERE id=declaration_record.ownership_snapshot_request_id AND status='approved';
      IF declaration_record IS NULL OR snapshot_supply IS NULL OR actual_count<>declaration_record.entitlement_count OR gross_sum<>declaration_record.gross_amount_minor OR tax_sum<>declaration_record.withholding_tax_minor OR net_sum<>declaration_record.net_amount_minor OR balance_sum<>snapshot_supply THEN RAISE EXCEPTION 'distribution entitlements must exactly reconcile to the approved snapshot and declaration'; END IF;
    END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_request_projection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_distribution_projection(NEW.id); RETURN NEW; END; $$;
    CREATE OR REPLACE FUNCTION fractal.assert_distribution_entitlement_projection_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM fractal.assert_distribution_projection(NEW.declaration_request_id); RETURN NEW; END; $$;
    CREATE CONSTRAINT TRIGGER distribution_request_projection AFTER INSERT OR UPDATE ON fractal.distribution_declaration_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_distribution_request_projection_trigger();
    CREATE CONSTRAINT TRIGGER distribution_entitlement_projection AFTER INSERT ON fractal.distribution_entitlements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION fractal.assert_distribution_entitlement_projection_trigger();

    CREATE OR REPLACE FUNCTION fractal.protect_distribution_request() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE journal_record RECORD;
    BEGIN
      IF TG_OP='DELETE' THEN RAISE EXCEPTION 'distribution declaration requests are not deletable'; END IF;
      IF NEW.id<>OLD.id OR NEW.reference<>OLD.reference OR NEW.organization_id<>OLD.organization_id OR NEW.offering_id<>OLD.offering_id OR NEW.ownership_snapshot_request_id<>OLD.ownership_snapshot_request_id OR NEW.period_label<>OLD.period_label OR NEW.currency<>OLD.currency OR NEW.gross_amount_minor<>OLD.gross_amount_minor OR NEW.withholding_tax_bps<>OLD.withholding_tax_bps OR NEW.withholding_tax_minor<>OLD.withholding_tax_minor OR NEW.net_amount_minor<>OLD.net_amount_minor OR NEW.payment_due_at<>OLD.payment_due_at OR NEW.entitlement_count<>OLD.entitlement_count OR NEW.policy_configuration_key<>OLD.policy_configuration_key OR NEW.policy_version_id<>OLD.policy_version_id OR NEW.policy_version_number<>OLD.policy_version_number OR NEW.policy_projection_version<>OLD.policy_projection_version OR NEW.policy_value_sha256<>OLD.policy_value_sha256 OR NEW.policy_reference<>OLD.policy_reference OR NEW.policy_name<>OLD.policy_name OR NEW.policy_schema_version<>OLD.policy_schema_version OR NEW.policy_jurisdiction_code<>OLD.policy_jurisdiction_code OR NEW.policy_legal_basis_reference<>OLD.policy_legal_basis_reference OR NEW.policy_minimum_confirmations<>OLD.policy_minimum_confirmations OR NEW.policy_maximum_declaration_minor<>OLD.policy_maximum_declaration_minor OR NEW.policy_maximum_withholding_tax_bps<>OLD.policy_maximum_withholding_tax_bps OR NEW.retention_days<>OLD.retention_days OR NEW.retain_until<>OLD.retain_until OR NEW.command_key<>OLD.command_key OR NEW.request_hash<>OLD.request_hash OR NEW.submitted_by_identity_id<>OLD.submitted_by_identity_id OR NEW.submitted_at<>OLD.submitted_at THEN RAISE EXCEPTION 'distribution declaration facts are immutable'; END IF;
      IF OLD.status<>'submitted' OR NEW.status NOT IN('approved','rejected') OR NEW.reviewed_by_identity_id=OLD.submitted_by_identity_id THEN RAISE EXCEPTION 'distribution declaration requires one independent terminal decision'; END IF;
      IF NEW.status='approved' THEN
        SELECT organization_id,currency,metadata->>'distributionDeclarationRequestId' AS declaration_id INTO journal_record FROM fractal.journal_entries WHERE id=NEW.declaration_journal_id;
        IF journal_record IS NULL OR journal_record.organization_id<>NEW.organization_id OR journal_record.currency<>NEW.currency OR journal_record.declaration_id<>NEW.id::text THEN RAISE EXCEPTION 'approved distribution requires its exact immutable declaration journal'; END IF;
      END IF;
      PERFORM fractal.assert_distribution_projection(NEW.id); RETURN NEW;
    END; $$;
    CREATE TRIGGER distribution_request_guard BEFORE UPDATE OR DELETE ON fractal.distribution_declaration_requests FOR EACH ROW EXECUTE FUNCTION fractal.protect_distribution_request();

    DROP TRIGGER IF EXISTS privacy_data_sources_immutable ON fractal.privacy_data_sources;
    INSERT INTO fractal.privacy_data_sources(source_key,source_kind,source_locator,authority_key,contains_personal_data,subject_linkage,data_categories,inventory_status,access_status,portability_status,correction_status,erasure_status,restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker)
    SELECT 'postgres.fractal.'||name,'postgres_relation','fractal.'||name,'investor_finance_ownership',true,'relational_identity',ARRAY['ownership_snapshot_and_distribution_evidence'],'catalogued','unavailable','unavailable','unavailable','unavailable','unavailable','unavailable','unapproved','absent','Subject-scoped collection, financial retention approval, legal-hold coverage, and rights-execution treatment for distribution evidence remain incomplete.'
      FROM unnest(ARRAY['ownership_snapshot_requests','ownership_snapshot_holdings','distribution_declaration_requests','distribution_entitlements']) name ON CONFLICT(source_key) DO NOTHING;
    CREATE TRIGGER privacy_data_sources_immutable BEFORE UPDATE OR DELETE ON fractal.privacy_data_sources FOR EACH ROW EXECUTE FUNCTION fractal.reject_privacy_data_inventory_mutation();
  `,
};
