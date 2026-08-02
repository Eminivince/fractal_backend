import type { PostgresMigration } from "./types.js";

/**
 * Makes inbox/outbox data-subject attribution a normalized, immutable fact.
 * Existing rows are classified only from immutable audit evidence or exact
 * provider/business relationships. Unknown legacy rows remain visibly
 * unresolved for the activation migration to stop on.
 */
export const eventPrivacyAttributionMigration: PostgresMigration = {
  version: "138-event-privacy-attribution",
  sql: `
    ALTER TABLE fractal.inbox_events
      ADD COLUMN privacy_classification TEXT NOT NULL DEFAULT 'legacy_unresolved',
      ADD COLUMN privacy_subject_identity_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      ADD COLUMN privacy_attribution_basis TEXT NOT NULL DEFAULT 'legacy_unresolved';
    ALTER TABLE fractal.outbox_events
      ADD COLUMN privacy_classification TEXT NOT NULL DEFAULT 'legacy_unresolved',
      ADD COLUMN privacy_subject_identity_ids UUID[] NOT NULL DEFAULT '{}'::uuid[],
      ADD COLUMN privacy_attribution_basis TEXT NOT NULL DEFAULT 'legacy_unresolved';

    ALTER TABLE fractal.inbox_events
      ADD CONSTRAINT inbox_events_privacy_classification_check CHECK (
        privacy_classification IN ('subject_attributed','external_subject_unlinked','legacy_unresolved')
      ),
      ADD CONSTRAINT inbox_events_privacy_attribution_shape CHECK (
        (privacy_classification='subject_attributed' AND cardinality(privacy_subject_identity_ids) BETWEEN 1 AND 25)
        OR (privacy_classification IN ('external_subject_unlinked','legacy_unresolved') AND cardinality(privacy_subject_identity_ids)=0)
      ),
      ADD CONSTRAINT inbox_events_privacy_basis_check CHECK (
        privacy_attribution_basis IN (
          'paystack_payment_reference','paystack_distribution_transfer','paystack_professional_transfer',
          'sumsub_application','known_provider_unlinked','legacy_unresolved'
        )
      );
    ALTER TABLE fractal.outbox_events
      ADD CONSTRAINT outbox_events_privacy_classification_check CHECK (
        privacy_classification IN ('subject_attributed','technical_no_subject','legacy_unresolved')
      ),
      ADD CONSTRAINT outbox_events_privacy_attribution_shape CHECK (
        (privacy_classification='subject_attributed' AND cardinality(privacy_subject_identity_ids) BETWEEN 1 AND 25)
        OR (privacy_classification IN ('technical_no_subject','legacy_unresolved') AND cardinality(privacy_subject_identity_ids)=0)
      ),
      ADD CONSTRAINT outbox_events_privacy_basis_check CHECK (
        privacy_attribution_basis IN (
          'audit_event_actor','audit_event_actor_and_explicit_subjects','audit_event_actor_and_authoritative_subjects',
          'audit_event_actor_explicit_and_authoritative_subjects','audit_event_authoritative_subjects','audit_event_nonhuman',
          'explicit_subjects','explicit_and_authoritative_subjects','authoritative_subjects','explicit_technical','legacy_audit_actor','legacy_authoritative_relation',
          'legacy_audit_and_relation','legacy_known_nonhuman','legacy_unresolved'
        )
      );

    CREATE INDEX inbox_events_privacy_subjects_idx
      ON fractal.inbox_events USING gin (privacy_subject_identity_ids);
    CREATE INDEX inbox_events_privacy_unresolved_idx
      ON fractal.inbox_events (received_at,id)
      WHERE privacy_classification='legacy_unresolved';
    CREATE INDEX outbox_events_privacy_subjects_idx
      ON fractal.outbox_events USING gin (privacy_subject_identity_ids);
    CREATE INDEX outbox_events_privacy_unresolved_idx
      ON fractal.outbox_events (occurred_at,id)
      WHERE privacy_classification='legacy_unresolved';

    CREATE OR REPLACE FUNCTION fractal.resolve_outbox_privacy_subjects(p_aggregate_type TEXT,p_aggregate_id TEXT)
    RETURNS UUID[] LANGUAGE sql STABLE AS $$
      WITH aggregate_key AS (
        SELECT CASE
          WHEN p_aggregate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN p_aggregate_id::uuid ELSE NULL END AS id
      ), subjects(subject_id) AS (
        SELECT identity.id FROM fractal.identities identity,aggregate_key key WHERE p_aggregate_type='identity' AND identity.id=key.id
        UNION ALL SELECT session.identity_id FROM fractal.auth_sessions session,aggregate_key key WHERE p_aggregate_type='auth_session' AND session.id=key.id
        UNION ALL SELECT request.target_identity_id FROM fractal.administrator_recovery_requests request,aggregate_key key WHERE p_aggregate_type='administrator_recovery_request' AND request.id=key.id
        UNION ALL SELECT request.target_identity_id FROM fractal.administrator_capability_change_requests request,aggregate_key key WHERE p_aggregate_type='administrator_capability_change_request' AND request.id=key.id
        UNION ALL SELECT request.target_identity_id FROM fractal.identity_access_change_requests request,aggregate_key key WHERE p_aggregate_type='identity_access_change_request' AND request.id=key.id
        UNION ALL SELECT application.identity_id FROM fractal.provider_identity_verification_applications application,aggregate_key key WHERE p_aggregate_type='identity_verification_application' AND application.id=key.id
        UNION ALL SELECT evidence.identity_id FROM fractal.provider_identity_verification_events evidence,aggregate_key key WHERE p_aggregate_type='identity_verification_evidence' AND evidence.id=key.id
        UNION ALL SELECT wallet.investor_identity_id FROM fractal.investor_wallets wallet,aggregate_key key WHERE p_aggregate_type='investor_wallet' AND wallet.id=key.id
        UNION ALL SELECT challenge.investor_identity_id FROM fractal.investor_wallet_link_challenges challenge,aggregate_key key WHERE p_aggregate_type='investor_wallet_link_challenge' AND challenge.id=key.id
        UNION ALL SELECT request.investor_identity_id FROM fractal.investor_compliance_review_requests request,aggregate_key key WHERE p_aggregate_type='investor_compliance_review_request' AND request.id=key.id
        UNION ALL SELECT reservation.investor_identity_id FROM fractal.investment_reservations reservation,aggregate_key key WHERE p_aggregate_type='investment_reservation' AND reservation.id=key.id
        UNION ALL SELECT allocation.investor_identity_id FROM fractal.investment_allocation_requests allocation,aggregate_key key WHERE p_aggregate_type='investment_allocation_request' AND allocation.id=key.id
        UNION ALL SELECT allocation.investor_identity_id FROM fractal.investment_allocation_chain_operations operation JOIN fractal.investment_allocation_requests allocation ON allocation.id=operation.allocation_request_id,aggregate_key key WHERE p_aggregate_type='investment_allocation_chain_operation' AND operation.id=key.id
        UNION ALL SELECT commitment.investor_identity_id FROM fractal.payment_intents intent JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id,aggregate_key key WHERE p_aggregate_type='payment_intent' AND intent.id=key.id
        UNION ALL SELECT commitment.investor_identity_id FROM fractal.payment_receipts receipt JOIN fractal.payment_intents intent ON intent.id=receipt.payment_intent_id JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id,aggregate_key key WHERE p_aggregate_type='payment_receipt' AND receipt.id=key.id
        UNION ALL SELECT commitment.investor_identity_id FROM fractal.payment_reconciliation_cases reconciliation JOIN fractal.payment_receipts receipt ON receipt.id=reconciliation.receipt_id JOIN fractal.payment_intents intent ON intent.id=receipt.payment_intent_id JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id,aggregate_key key WHERE p_aggregate_type='payment_reconciliation_case' AND reconciliation.id=key.id
        UNION ALL SELECT request.requester_identity_id FROM fractal.privacy_rights_requests request,aggregate_key key WHERE p_aggregate_type='privacy_rights_request' AND request.id=key.id
        UNION ALL SELECT treatment.requester_identity_id FROM fractal.distribution_privacy_treatment_requests treatment,aggregate_key key WHERE p_aggregate_type='distribution_privacy_treatment' AND treatment.id=key.id
        UNION ALL SELECT profile.investor_identity_id FROM fractal.investor_distribution_payout_profiles profile,aggregate_key key WHERE p_aggregate_type='investor_distribution_payout_profile' AND profile.id=key.id
        UNION ALL SELECT payout.investor_identity_id FROM fractal.distribution_payout_instructions payout,aggregate_key key WHERE p_aggregate_type='distribution_payout_instruction' AND payout.id=key.id
        UNION ALL SELECT payout.investor_identity_id FROM fractal.distribution_payout_exception_cases exception JOIN fractal.distribution_payout_instructions payout ON payout.id=exception.payout_instruction_id,aggregate_key key WHERE p_aggregate_type='distribution_payout_exception' AND exception.id=key.id
        UNION ALL SELECT support.requester_identity_id FROM fractal.support_cases support,aggregate_key key WHERE p_aggregate_type='support_case' AND support.id=key.id
        UNION ALL SELECT support.requester_identity_id FROM fractal.support_case_service_obligations obligation JOIN fractal.support_cases support ON support.id=obligation.case_id,aggregate_key key WHERE p_aggregate_type='support_case_service_obligation' AND obligation.id=key.id
        UNION ALL SELECT support.requester_identity_id FROM fractal.support_attachment_disposition_requests request JOIN fractal.support_case_attachments attachment ON attachment.id=request.attachment_id JOIN fractal.support_cases support ON support.id=attachment.case_id,aggregate_key key WHERE p_aggregate_type='support_attachment_disposition_request' AND request.id=key.id
        UNION ALL SELECT support.requester_identity_id FROM fractal.support_attachment_dispositions disposition JOIN fractal.support_case_attachments attachment ON attachment.id=disposition.attachment_id JOIN fractal.support_cases support ON support.id=attachment.case_id,aggregate_key key WHERE p_aggregate_type='support_attachment_disposition' AND disposition.id=key.id
        UNION ALL SELECT membership.identity_id FROM fractal.organization_memberships membership,aggregate_key key WHERE p_aggregate_type='organization_membership' AND membership.id=key.id
        UNION ALL SELECT source.identity_id FROM fractal.organization_ownership_transfer_requests transfer JOIN fractal.organization_memberships source ON source.id=transfer.source_membership_id,aggregate_key key WHERE p_aggregate_type='organization_ownership_transfer' AND transfer.id=key.id
        UNION ALL SELECT target.identity_id FROM fractal.organization_ownership_transfer_requests transfer JOIN fractal.organization_memberships target ON target.id=transfer.target_membership_id,aggregate_key key WHERE p_aggregate_type='organization_ownership_transfer' AND transfer.id=key.id
        UNION ALL SELECT deliverable.submitted_by_identity_id FROM fractal.professional_deliverable_versions deliverable,aggregate_key key WHERE p_aggregate_type='professional_deliverable_version' AND deliverable.id=key.id
        UNION ALL SELECT invoice.submitted_by_identity_id FROM fractal.professional_invoices invoice,aggregate_key key WHERE p_aggregate_type='professional_invoice' AND invoice.id=key.id
        UNION ALL SELECT invoice.submitted_by_identity_id FROM fractal.professional_payout_instructions payout JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id,aggregate_key key WHERE p_aggregate_type='professional_payout_instruction' AND payout.id=key.id
        UNION ALL SELECT invoice.submitted_by_identity_id FROM fractal.professional_finance_exception_cases exception JOIN fractal.professional_payout_instructions payout ON payout.id=exception.payout_instruction_id JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id,aggregate_key key WHERE p_aggregate_type='professional_finance_exception' AND exception.id=key.id
        UNION ALL SELECT invoice.submitted_by_identity_id FROM fractal.professional_replacement_payout_requests replacement JOIN fractal.professional_payout_instructions payout ON payout.id=replacement.original_payout_instruction_id JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id,aggregate_key key WHERE p_aggregate_type='professional_replacement_payout_request' AND replacement.id=key.id
        UNION ALL SELECT invoice.submitted_by_identity_id FROM fractal.professional_invoice_credit_notes note JOIN fractal.professional_invoices invoice ON invoice.id=note.invoice_id,aggregate_key key WHERE p_aggregate_type='professional_invoice_credit_note' AND note.id=key.id
      )
      SELECT COALESCE(array_agg(DISTINCT subject_id ORDER BY subject_id) FILTER(WHERE subject_id IS NOT NULL),'{}'::uuid[])
        FROM subjects
    $$;

    WITH resolved AS (
      SELECT event.id,
             audit.id IS NOT NULL AS has_audit,
             audit.actor_id,
             fractal.resolve_outbox_privacy_subjects(event.aggregate_type,event.aggregate_id) AS authoritative_identity_ids
        FROM fractal.outbox_events event
        LEFT JOIN fractal.audit_events audit
          ON audit.id=CASE
            WHEN COALESCE(event.payload->>'auditEventId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN (event.payload->>'auditEventId')::uuid ELSE NULL END
    ), attributed AS (
      SELECT resolved.*,
             ARRAY(
               SELECT DISTINCT subject_id FROM unnest(
                 authoritative_identity_ids
                 || CASE WHEN actor_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[actor_id] END
               ) subject_id ORDER BY subject_id
             ) AS subject_ids,
             cardinality(authoritative_identity_ids)>0 AS has_relation
        FROM resolved
    )
    UPDATE fractal.outbox_events event
       SET privacy_classification=CASE
             WHEN cardinality(attributed.subject_ids)>0 THEN 'subject_attributed'
             WHEN attributed.has_audit THEN 'technical_no_subject'
             WHEN event.aggregate_type='identity_verification_evidence' THEN 'technical_no_subject'
             ELSE 'legacy_unresolved' END,
           privacy_subject_identity_ids=attributed.subject_ids,
           privacy_attribution_basis=CASE
             WHEN attributed.actor_id IS NOT NULL AND attributed.has_relation THEN 'legacy_audit_and_relation'
             WHEN attributed.actor_id IS NOT NULL THEN 'legacy_audit_actor'
             WHEN attributed.has_relation THEN 'legacy_authoritative_relation'
             WHEN attributed.has_audit OR event.aggregate_type='identity_verification_evidence' THEN 'legacy_known_nonhuman'
             ELSE 'legacy_unresolved' END
      FROM attributed WHERE attributed.id=event.id;

    WITH matches AS (
      SELECT inbox.id,
             COALESCE(array_agg(DISTINCT candidate.identity_id ORDER BY candidate.identity_id)
               FILTER (WHERE candidate.identity_id IS NOT NULL),'{}'::uuid[]) AS identity_ids,
             (array_agg(candidate.basis ORDER BY candidate.priority)
               FILTER (WHERE candidate.identity_id IS NOT NULL))[1] AS basis
        FROM fractal.inbox_events inbox
        LEFT JOIN LATERAL (
          SELECT application.identity_id,'sumsub_application'::text AS basis,1 AS priority
            FROM fractal.provider_identity_verification_applications application
           WHERE inbox.provider='sumsub' AND application.provider='sumsub'
             AND (
               (COALESCE(inbox.payload->'event'->>'externalUserId','')<>'' AND application.external_user_id=inbox.payload->'event'->>'externalUserId')
               OR (COALESCE(inbox.payload->'event'->>'applicantId','')<>'' AND application.applicant_id=inbox.payload->'event'->>'applicantId')
             )
          UNION ALL
          SELECT commitment.investor_identity_id,'paystack_payment_reference',2
            FROM fractal.payment_intents intent
            JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
           WHERE inbox.provider='paystack' AND intent.provider='paystack'
             AND COALESCE(inbox.payload->'data'->>'reference','')<>''
             AND intent.provider_reference=inbox.payload->'data'->>'reference'
          UNION ALL
          SELECT distribution.investor_identity_id,'paystack_distribution_transfer',3
            FROM fractal.distribution_payout_instructions distribution
           WHERE inbox.provider='paystack' AND distribution.provider='paystack'
             AND COALESCE(inbox.payload->'data'->>'transfer_code','')<>''
             AND distribution.provider_transfer_code=inbox.payload->'data'->>'transfer_code'
          UNION ALL
          SELECT invoice.submitted_by_identity_id,'paystack_professional_transfer',4
            FROM fractal.professional_payout_instructions payout
            JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id
           WHERE inbox.provider='paystack' AND payout.provider='paystack'
             AND COALESCE(inbox.payload->'data'->>'transfer_code','')<>''
             AND payout.provider_transfer_code=inbox.payload->'data'->>'transfer_code'
        ) candidate ON TRUE
       GROUP BY inbox.id
    )
    UPDATE fractal.inbox_events inbox
       SET privacy_classification=CASE
             WHEN cardinality(matches.identity_ids)=0 THEN 'external_subject_unlinked'
             WHEN cardinality(matches.identity_ids)=1 THEN 'subject_attributed'
             ELSE 'legacy_unresolved' END,
           privacy_subject_identity_ids=CASE WHEN cardinality(matches.identity_ids)=1 THEN matches.identity_ids ELSE '{}'::uuid[] END,
           privacy_attribution_basis=CASE
             WHEN cardinality(matches.identity_ids)=0 THEN 'known_provider_unlinked'
             WHEN cardinality(matches.identity_ids)=1 THEN matches.basis
             ELSE 'legacy_unresolved' END
      FROM matches
     WHERE matches.id=inbox.id AND inbox.provider IN ('paystack','sumsub');

    CREATE OR REPLACE FUNCTION fractal.validate_event_privacy_attribution()
    RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE canonical UUID[]; missing_count INTEGER;
    BEGIN
      IF TG_OP='UPDATE' AND (
        NEW.privacy_classification IS DISTINCT FROM OLD.privacy_classification
        OR NEW.privacy_subject_identity_ids IS DISTINCT FROM OLD.privacy_subject_identity_ids
        OR NEW.privacy_attribution_basis IS DISTINCT FROM OLD.privacy_attribution_basis
      ) THEN RAISE EXCEPTION 'event privacy attribution is immutable'; END IF;
      SELECT COALESCE(array_agg(DISTINCT subject_id ORDER BY subject_id),'{}'::uuid[])
        INTO canonical FROM unnest(NEW.privacy_subject_identity_ids) subject_id;
      IF canonical IS DISTINCT FROM NEW.privacy_subject_identity_ids THEN
        RAISE EXCEPTION 'event privacy subject identities must be sorted and unique';
      END IF;
      SELECT count(*) INTO missing_count
        FROM unnest(NEW.privacy_subject_identity_ids) subject_id
        LEFT JOIN fractal.identities identity ON identity.id=subject_id
       WHERE identity.id IS NULL;
      IF missing_count<>0 THEN RAISE EXCEPTION 'event privacy attribution references an unknown identity'; END IF;
      RETURN NEW;
    END; $$;
    CREATE TRIGGER inbox_events_privacy_attribution_guard
      BEFORE INSERT OR UPDATE ON fractal.inbox_events
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_event_privacy_attribution();
    CREATE TRIGGER outbox_events_privacy_attribution_guard
      BEFORE INSERT OR UPDATE ON fractal.outbox_events
      FOR EACH ROW EXECUTE FUNCTION fractal.validate_event_privacy_attribution();
  `,
};
