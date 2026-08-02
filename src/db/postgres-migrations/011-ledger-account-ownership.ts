import type { PostgresMigration } from "./types.js";

/** Scope each chart of accounts to its legal organization before money flows use it. */
export const ledgerAccountOwnershipMigration: PostgresMigration = {
  version: "011-ledger-account-ownership",
  sql: `
    ALTER TABLE fractal.ledger_accounts
      ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES fractal.organizations(id);

    ALTER TABLE fractal.ledger_accounts
      DROP CONSTRAINT IF EXISTS ledger_accounts_code_key;

    CREATE UNIQUE INDEX IF NOT EXISTS ledger_accounts_organization_code_key
      ON fractal.ledger_accounts (organization_id, code) NULLS NOT DISTINCT;
    CREATE INDEX IF NOT EXISTS ledger_accounts_organization_active_idx
      ON fractal.ledger_accounts (organization_id, code)
      WHERE active = true;

    CREATE OR REPLACE FUNCTION fractal.assert_journal_is_balanced(p_journal_id UUID)
    RETURNS VOID
    LANGUAGE plpgsql
    AS $$
    DECLARE
      v_status TEXT;
      v_currency CHAR(3);
      v_organization_id UUID;
      v_posting_count BIGINT;
      v_debits BIGINT;
      v_credits BIGINT;
      v_currency_mismatches BIGINT;
      v_account_scope_mismatches BIGINT;
    BEGIN
      SELECT status, currency, organization_id INTO v_status, v_currency, v_organization_id
        FROM fractal.journal_entries
       WHERE id = p_journal_id;

      IF NOT FOUND OR v_status <> 'posted' THEN
        RETURN;
      END IF;

      SELECT
        count(*),
        COALESCE(sum(posting.amount_minor) FILTER (WHERE posting.direction = 'debit'), 0),
        COALESCE(sum(posting.amount_minor) FILTER (WHERE posting.direction = 'credit'), 0),
        count(*) FILTER (WHERE posting.currency <> v_currency),
        count(*) FILTER (WHERE account.organization_id IS DISTINCT FROM v_organization_id)
      INTO v_posting_count, v_debits, v_credits, v_currency_mismatches, v_account_scope_mismatches
      FROM fractal.journal_postings posting
      JOIN fractal.ledger_accounts account ON account.id = posting.account_id
      WHERE posting.journal_id = p_journal_id;

      IF v_posting_count < 2 THEN
        RAISE EXCEPTION 'journal % must have at least two postings', p_journal_id USING ERRCODE = '23514';
      END IF;
      IF v_debits <> v_credits THEN
        RAISE EXCEPTION 'journal % is unbalanced: debits=% credits=%', p_journal_id, v_debits, v_credits USING ERRCODE = '23514';
      END IF;
      IF v_currency_mismatches <> 0 THEN
        RAISE EXCEPTION 'journal % contains posting currency different from journal currency', p_journal_id USING ERRCODE = '23514';
      END IF;
      IF v_account_scope_mismatches <> 0 THEN
        RAISE EXCEPTION 'journal % contains an account owned by a different organization', p_journal_id USING ERRCODE = '23514';
      END IF;
    END;
    $$;
  `,
};
