import type { PostgresMigration } from "./types.js";

/**
 * The new accounting ledger is intentionally separate from the prototype
 * MongoDB ledger.  A workflow only becomes authoritative here when it posts a
 * complete journal inside one PostgreSQL transaction.
 */
export const accountingJournalMigration: PostgresMigration = {
  version: "009-accounting-journal",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.ledger_accounts (
      id UUID PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('asset', 'liability', 'equity', 'revenue', 'expense')),
      normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
      active BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK (code = upper(code))
    );

    CREATE TABLE IF NOT EXISTS fractal.journal_entries (
      id UUID PRIMARY KEY,
      scope_key TEXT NOT NULL,
      organization_id UUID REFERENCES fractal.organizations(id),
      idempotency_key TEXT NOT NULL,
      request_hash CHAR(64) NOT NULL,
      status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted')),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      effective_at TIMESTAMPTZ NOT NULL,
      narrative TEXT NOT NULL,
      external_ref TEXT,
      reversal_of UUID UNIQUE REFERENCES fractal.journal_entries(id),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (scope_key, idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS journal_entries_organization_effective_idx
      ON fractal.journal_entries (organization_id, effective_at, id);
    CREATE INDEX IF NOT EXISTS journal_entries_external_ref_idx
      ON fractal.journal_entries (external_ref)
      WHERE external_ref IS NOT NULL;

    CREATE TABLE IF NOT EXISTS fractal.journal_postings (
      journal_id UUID NOT NULL REFERENCES fractal.journal_entries(id) ON DELETE RESTRICT,
      line_number INTEGER NOT NULL CHECK (line_number > 0),
      account_id UUID NOT NULL REFERENCES fractal.ledger_accounts(id) ON DELETE RESTRICT,
      direction TEXT NOT NULL CHECK (direction IN ('debit', 'credit')),
      amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (journal_id, line_number)
    );
    CREATE INDEX IF NOT EXISTS journal_postings_account_idx
      ON fractal.journal_postings (account_id, created_at, journal_id);

    CREATE OR REPLACE FUNCTION fractal.assert_journal_is_balanced(p_journal_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_status TEXT;
      v_currency CHAR(3);
      v_posting_count BIGINT;
      v_debits BIGINT;
      v_credits BIGINT;
      v_currency_mismatches BIGINT;
    BEGIN
      SELECT status, currency INTO v_status, v_currency
        FROM fractal.journal_entries
       WHERE id = p_journal_id;

      IF NOT FOUND OR v_status <> 'posted' THEN
        RETURN;
      END IF;

      SELECT
        count(*),
        COALESCE(sum(amount_minor) FILTER (WHERE direction = 'debit'), 0),
        COALESCE(sum(amount_minor) FILTER (WHERE direction = 'credit'), 0),
        count(*) FILTER (WHERE currency <> v_currency)
      INTO v_posting_count, v_debits, v_credits, v_currency_mismatches
      FROM fractal.journal_postings
      WHERE journal_id = p_journal_id;

      IF v_posting_count < 2 THEN
        RAISE EXCEPTION 'journal % must have at least two postings', p_journal_id
          USING ERRCODE = '23514';
      END IF;
      IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'journal % is unbalanced: debits=% credits=%', p_journal_id, v_debits, v_credits
          USING ERRCODE = '23514';
      END IF;
      IF v_currency_mismatches <> 0 THEN
        RAISE EXCEPTION 'journal % contains posting currency different from journal currency', p_journal_id
          USING ERRCODE = '23514';
      END IF;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.assert_journal_entry_trigger()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM fractal.assert_journal_is_balanced(COALESCE(NEW.id, OLD.id));
      RETURN NULL;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.assert_journal_posting_trigger()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      PERFORM fractal.assert_journal_is_balanced(COALESCE(NEW.journal_id, OLD.journal_id));
      RETURN NULL;
    END;
    $$;

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_journal_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.% is append-only', TG_TABLE_NAME;
    END;
    $$;

    DROP TRIGGER IF EXISTS journal_entries_immutable ON fractal.journal_entries;
    CREATE TRIGGER journal_entries_immutable
      BEFORE UPDATE OR DELETE ON fractal.journal_entries
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_journal_mutation();

    DROP TRIGGER IF EXISTS journal_postings_immutable ON fractal.journal_postings;
    CREATE TRIGGER journal_postings_immutable
      BEFORE UPDATE OR DELETE ON fractal.journal_postings
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_journal_mutation();

    DROP TRIGGER IF EXISTS journal_entries_balanced ON fractal.journal_entries;
    CREATE CONSTRAINT TRIGGER journal_entries_balanced
      AFTER INSERT ON fractal.journal_entries
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.assert_journal_entry_trigger();

    DROP TRIGGER IF EXISTS journal_postings_balanced ON fractal.journal_postings;
    CREATE CONSTRAINT TRIGGER journal_postings_balanced
      AFTER INSERT OR UPDATE OR DELETE ON fractal.journal_postings
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION fractal.assert_journal_posting_trigger();
  `,
};
