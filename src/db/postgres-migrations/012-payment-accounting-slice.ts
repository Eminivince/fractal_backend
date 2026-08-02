import type { PostgresMigration } from "./types.js";

/** The first PostgreSQL-authoritative payment lifecycle. */
export const paymentAccountingSliceMigration: PostgresMigration = {
  version: "012-payment-accounting-slice",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.investment_commitments (
      id UUID PRIMARY KEY,
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      investor_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      offering_reference TEXT NOT NULL CHECK (length(offering_reference) BETWEEN 1 AND 200),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      committed_minor BIGINT NOT NULL CHECK (committed_minor > 0),
      status TEXT NOT NULL CHECK (status IN ('payment_pending', 'payment_received', 'cancelled', 'expired', 'refunded')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS investment_commitments_organization_idx
      ON fractal.investment_commitments (organization_id, created_at, id);
    CREATE INDEX IF NOT EXISTS investment_commitments_investor_idx
      ON fractal.investment_commitments (investor_identity_id, created_at, id);

    CREATE TABLE IF NOT EXISTS fractal.payment_intents (
      id UUID PRIMARY KEY,
      commitment_id UUID NOT NULL REFERENCES fractal.investment_commitments(id),
      provider TEXT NOT NULL,
      provider_reference TEXT NOT NULL,
      expected_minor BIGINT NOT NULL CHECK (expected_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      status TEXT NOT NULL CHECK (status IN ('pending', 'receipt_matched', 'amount_mismatch', 'cancelled', 'expired')),
      expires_at TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_reference),
      CHECK (expires_at > created_at)
    );
    CREATE INDEX IF NOT EXISTS payment_intents_commitment_idx
      ON fractal.payment_intents (commitment_id, created_at, id);
    CREATE INDEX IF NOT EXISTS payment_intents_pending_expiry_idx
      ON fractal.payment_intents (expires_at, id)
      WHERE status = 'pending';

    CREATE TABLE IF NOT EXISTS fractal.payment_receipts (
      id UUID PRIMARY KEY,
      payment_intent_id UUID NOT NULL REFERENCES fractal.payment_intents(id),
      provider TEXT NOT NULL,
      provider_event_id TEXT NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      amount_minor BIGINT NOT NULL CHECK (amount_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      status TEXT NOT NULL CHECK (status IN ('matched', 'amount_mismatch')),
      journal_id UUID UNIQUE REFERENCES fractal.journal_entries(id),
      received_at TIMESTAMPTZ NOT NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (provider, provider_event_id)
    );
    CREATE INDEX IF NOT EXISTS payment_receipts_intent_idx
      ON fractal.payment_receipts (payment_intent_id, received_at, id);

    CREATE TABLE IF NOT EXISTS fractal.payment_reconciliation_cases (
      id UUID PRIMARY KEY,
      receipt_id UUID NOT NULL UNIQUE REFERENCES fractal.payment_receipts(id),
      organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      case_type TEXT NOT NULL CHECK (case_type IN ('amount_mismatch', 'currency_mismatch', 'late_payment')),
      status TEXT NOT NULL CHECK (status IN ('open', 'resolved', 'dismissed')) DEFAULT 'open',
      expected_minor BIGINT NOT NULL CHECK (expected_minor > 0),
      actual_minor BIGINT NOT NULL CHECK (actual_minor > 0),
      currency CHAR(3) NOT NULL CHECK (currency = upper(currency)),
      details JSONB NOT NULL DEFAULT '{}'::jsonb,
      resolved_by_identity_id UUID REFERENCES fractal.identities(id),
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((status = 'open' AND resolved_at IS NULL AND resolved_by_identity_id IS NULL)
        OR (status <> 'open' AND resolved_at IS NOT NULL AND resolved_by_identity_id IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS payment_reconciliation_cases_open_idx
      ON fractal.payment_reconciliation_cases (organization_id, created_at, id)
      WHERE status = 'open';

    CREATE OR REPLACE FUNCTION fractal.reject_immutable_payment_receipt_mutation()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      RAISE EXCEPTION 'fractal.payment_receipts is append-only';
    END;
    $$;
    DROP TRIGGER IF EXISTS payment_receipts_immutable ON fractal.payment_receipts;
    CREATE TRIGGER payment_receipts_immutable
      BEFORE UPDATE OR DELETE ON fractal.payment_receipts
      FOR EACH ROW EXECUTE FUNCTION fractal.reject_immutable_payment_receipt_mutation();

    CREATE OR REPLACE FUNCTION fractal.enforce_payment_intent_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status <> 'pending' THEN
        RAISE EXCEPTION 'payment intent % is terminal', OLD.id USING ERRCODE = '23514';
      END IF;
      IF NEW.status NOT IN ('receipt_matched', 'amount_mismatch', 'cancelled', 'expired') THEN
        RAISE EXCEPTION 'invalid payment-intent transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
      END IF;
      RETURN NEW;
    END;
    $$;
    DROP TRIGGER IF EXISTS payment_intents_state_transition ON fractal.payment_intents;
    CREATE TRIGGER payment_intents_state_transition
      BEFORE UPDATE OF status ON fractal.payment_intents
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_payment_intent_transition();

    CREATE OR REPLACE FUNCTION fractal.enforce_commitment_transition()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD.status = 'payment_pending' AND NEW.status IN ('payment_received', 'cancelled', 'expired') THEN
        RETURN NEW;
      END IF;
      IF OLD.status = 'payment_received' AND NEW.status = 'refunded' THEN
        RETURN NEW;
      END IF;
      RAISE EXCEPTION 'invalid commitment transition from % to %', OLD.status, NEW.status USING ERRCODE = '23514';
    END;
    $$;
    DROP TRIGGER IF EXISTS investment_commitments_state_transition ON fractal.investment_commitments;
    CREATE TRIGGER investment_commitments_state_transition
      BEFORE UPDATE OF status ON fractal.investment_commitments
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_commitment_transition();
  `,
};
