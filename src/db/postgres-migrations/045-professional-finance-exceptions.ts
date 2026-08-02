import type { PostgresMigration } from "./types.js";

/** Evidence-backed, maker-checker resolution cases. No case can automatically send money or rewrite a settlement record. */
export const professionalFinanceExceptionsMigration: PostgresMigration = {
  version: "045-professional-finance-exceptions",
  sql: `
    CREATE TABLE IF NOT EXISTS fractal.professional_finance_exception_cases (
      id UUID PRIMARY KEY,
      payout_instruction_id UUID REFERENCES fractal.professional_payout_instructions(id),
      recipient_recovery_case_id UUID REFERENCES fractal.professional_payout_recipient_recovery_cases(id),
      issuer_organization_id UUID NOT NULL REFERENCES fractal.organizations(id),
      status TEXT NOT NULL CHECK (status IN ('open', 'evidence_submitted', 'decision_pending', 'approved', 'rejected', 'executed', 'closed')),
      resolution_type TEXT CHECK (resolution_type IN ('provider_settlement_confirmed', 'credit_note', 'replacement_payout', 'manual_settlement', 'recipient_deactivation_review')),
      opened_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      prepared_by_identity_id UUID REFERENCES fractal.identities(id),
      reviewed_by_identity_id UUID REFERENCES fractal.identities(id),
      resolution_reason TEXT,
      opened_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      prepared_at TIMESTAMPTZ,
      reviewed_at TIMESTAMPTZ,
      executed_at TIMESTAMPTZ,
      closed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CHECK ((payout_instruction_id IS NOT NULL)::integer + (recipient_recovery_case_id IS NOT NULL)::integer = 1),
      CHECK ((status IN ('open', 'evidence_submitted') AND resolution_type IS NULL AND prepared_by_identity_id IS NULL AND prepared_at IS NULL AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL)
        OR (status = 'decision_pending' AND resolution_type IS NOT NULL AND prepared_by_identity_id IS NOT NULL AND prepared_at IS NOT NULL AND reviewed_by_identity_id IS NULL AND reviewed_at IS NULL)
        OR (status IN ('approved', 'rejected', 'executed', 'closed') AND resolution_type IS NOT NULL AND prepared_by_identity_id IS NOT NULL AND prepared_at IS NOT NULL AND reviewed_by_identity_id IS NOT NULL AND reviewed_at IS NOT NULL)),
      CHECK (prepared_by_identity_id IS NULL OR prepared_by_identity_id <> reviewed_by_identity_id),
      CHECK ((status NOT IN ('executed', 'closed')) OR executed_at IS NOT NULL),
      CHECK ((status <> 'closed') OR closed_at IS NOT NULL)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS professional_finance_exception_payout_open_idx
      ON fractal.professional_finance_exception_cases (payout_instruction_id) WHERE status <> 'closed';
    CREATE UNIQUE INDEX IF NOT EXISTS professional_finance_exception_recovery_open_idx
      ON fractal.professional_finance_exception_cases (recipient_recovery_case_id) WHERE status <> 'closed';
    CREATE INDEX IF NOT EXISTS professional_finance_exception_queue_idx
      ON fractal.professional_finance_exception_cases (status, opened_at, id);

    CREATE TABLE IF NOT EXISTS fractal.professional_finance_exception_evidence (
      id UUID PRIMARY KEY,
      case_id UUID NOT NULL REFERENCES fractal.professional_finance_exception_cases(id),
      evidence_type TEXT NOT NULL CHECK (evidence_type IN ('provider_verification', 'provider_webhook', 'bank_confirmation', 'account_ownership', 'customer_communication', 'accounting_entry', 'other')),
      content_sha256 CHAR(64) NOT NULL CHECK (content_sha256 ~ '^[a-f0-9]{64}$'),
      storage_key TEXT NOT NULL CHECK (length(storage_key) BETWEEN 1 AND 1000),
      filename TEXT NOT NULL CHECK (length(filename) BETWEEN 1 AND 240),
      mime_type TEXT NOT NULL CHECK (length(mime_type) BETWEEN 3 AND 120),
      uploaded_by_identity_id UUID NOT NULL REFERENCES fractal.identities(id),
      uploaded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (case_id, content_sha256)
    );

    CREATE OR REPLACE FUNCTION fractal.enforce_professional_finance_exception_case_transition()
    RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.id IS DISTINCT FROM OLD.id OR NEW.payout_instruction_id IS DISTINCT FROM OLD.payout_instruction_id
        OR NEW.recipient_recovery_case_id IS DISTINCT FROM OLD.recipient_recovery_case_id
        OR NEW.issuer_organization_id IS DISTINCT FROM OLD.issuer_organization_id
        OR NEW.opened_by_identity_id IS DISTINCT FROM OLD.opened_by_identity_id
        OR NEW.opened_at IS DISTINCT FROM OLD.opened_at OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'professional finance exception facts are immutable';
      END IF;
      IF OLD.status = 'open' AND NEW.status = 'evidence_submitted' THEN RETURN NEW; END IF;
      IF OLD.status = 'evidence_submitted' AND NEW.status = 'decision_pending' AND NEW.prepared_by_identity_id IS NOT NULL THEN RETURN NEW; END IF;
      IF OLD.status = 'decision_pending' AND NEW.status IN ('approved', 'rejected')
        AND NEW.reviewed_by_identity_id IS NOT NULL AND NEW.reviewed_by_identity_id <> OLD.prepared_by_identity_id THEN RETURN NEW; END IF;
      IF OLD.status = 'approved' AND NEW.status = 'executed' THEN RETURN NEW; END IF;
      IF OLD.status IN ('rejected', 'executed') AND NEW.status = 'closed' THEN RETURN NEW; END IF;
      RAISE EXCEPTION 'invalid professional finance exception transition';
    END;
    $$;
    DROP TRIGGER IF EXISTS professional_finance_exception_cases_transition ON fractal.professional_finance_exception_cases;
    CREATE TRIGGER professional_finance_exception_cases_transition BEFORE UPDATE OR DELETE ON fractal.professional_finance_exception_cases
      FOR EACH ROW EXECUTE FUNCTION fractal.enforce_professional_finance_exception_case_transition();

    CREATE OR REPLACE FUNCTION fractal.protect_professional_finance_exception_evidence()
    RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'professional finance exception evidence is immutable'; END; $$;
    DROP TRIGGER IF EXISTS professional_finance_exception_evidence_immutable ON fractal.professional_finance_exception_evidence;
    CREATE TRIGGER professional_finance_exception_evidence_immutable BEFORE UPDATE OR DELETE ON fractal.professional_finance_exception_evidence
      FOR EACH ROW EXECUTE FUNCTION fractal.protect_professional_finance_exception_evidence();
  `,
};
