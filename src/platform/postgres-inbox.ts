import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { hashPayload } from "../utils/idempotency.js";

export class InboxPayloadConflictError extends Error {}

export interface InboxEventInput {
  provider: "paystack" | "sumsub";
  externalEventId: string;
  payload: Record<string, unknown>;
  receivedAt?: Date;
}

type InboxPrivacyAttribution = {
  classification: "subject_attributed" | "external_subject_unlinked";
  subjectIdentityIds: string[];
  basis: "paystack_payment_reference" | "paystack_distribution_transfer" | "paystack_professional_transfer" | "sumsub_application" | "known_provider_unlinked";
};

async function resolveInboxPrivacyAttribution(
  client: PoolClient,
  provider: InboxEventInput["provider"],
  payload: Record<string, unknown>,
): Promise<InboxPrivacyAttribution> {
  if (provider === "sumsub") {
    const event = payload.event && typeof payload.event === "object" ? payload.event as Record<string, unknown> : {};
    const externalUserId = typeof event.externalUserId === "string" ? event.externalUserId.trim() : "";
    const applicantId = typeof event.applicantId === "string" ? event.applicantId.trim() : "";
    const result = await client.query<{ identity_id: string }>(
      `SELECT DISTINCT identity_id
         FROM (
           SELECT identity_id
             FROM fractal.provider_identity_verification_applications
            WHERE provider='sumsub'
              AND (($1<>'' AND external_user_id=$1) OR ($2<>'' AND applicant_id=$2))
            FOR SHARE
         ) matched_applications`,
      [externalUserId, applicantId],
    );
    if (result.rows.length > 1) {
      throw new InboxPayloadConflictError("Provider event references more than one internal identity");
    }
    const identityId = result.rows[0]?.identity_id;
    return identityId
      ? { classification: "subject_attributed", subjectIdentityIds: [identityId], basis: "sumsub_application" }
      : { classification: "external_subject_unlinked", subjectIdentityIds: [], basis: "known_provider_unlinked" };
  }

  const data = payload.data && typeof payload.data === "object" ? payload.data as Record<string, unknown> : {};
  const reference = typeof data.reference === "string" ? data.reference.trim() : "";
  const transferCode = typeof data.transfer_code === "string" ? data.transfer_code.trim() : "";
  const matches: Array<{ identityId: string; basis: InboxPrivacyAttribution["basis"] }> = [];
  if (reference) {
    const payment = await client.query<{ identity_id: string }>(
      `SELECT commitment.investor_identity_id AS identity_id
         FROM fractal.payment_intents intent
         JOIN fractal.investment_commitments commitment ON commitment.id=intent.commitment_id
        WHERE intent.provider='paystack' AND intent.provider_reference=$1
        LIMIT 1 FOR SHARE OF intent, commitment`,
      [reference],
    );
    if (payment.rows[0]) {
      matches.push({ identityId: payment.rows[0].identity_id, basis: "paystack_payment_reference" });
    }
  }
  if (transferCode) {
    const distribution = await client.query<{ identity_id: string }>(
      `SELECT investor_identity_id AS identity_id
         FROM fractal.distribution_payout_instructions
        WHERE provider='paystack' AND provider_transfer_code=$1
        LIMIT 1 FOR SHARE`,
      [transferCode],
    );
    if (distribution.rows[0]) {
      matches.push({ identityId: distribution.rows[0].identity_id, basis: "paystack_distribution_transfer" });
    }
    const professional = await client.query<{ identity_id: string }>(
      `SELECT invoice.submitted_by_identity_id AS identity_id
         FROM fractal.professional_payout_instructions payout
         JOIN fractal.professional_invoices invoice ON invoice.id=payout.invoice_id
        WHERE payout.provider='paystack' AND payout.provider_transfer_code=$1
        LIMIT 1 FOR SHARE OF payout, invoice`,
      [transferCode],
    );
    if (professional.rows[0]) {
      matches.push({ identityId: professional.rows[0].identity_id, basis: "paystack_professional_transfer" });
    }
  }
  if (new Set(matches.map((match) => match.identityId)).size > 1) {
    throw new InboxPayloadConflictError("Provider event references more than one internal identity");
  }
  const match = matches[0];
  if (match) {
    return { classification: "subject_attributed", subjectIdentityIds: [match.identityId], basis: match.basis };
  }
  return { classification: "external_subject_unlinked", subjectIdentityIds: [], basis: "known_provider_unlinked" };
}

export interface ReceivedInboxEvent {
  id: string;
  duplicate: boolean;
  processed: boolean;
}

export interface ClaimedInboxEvent {
  id: string;
  provider: string;
  externalEventId: string;
  payload: Record<string, unknown>;
  receivedAt: Date;
  attempts: number;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

/**
 * Stores a signed provider event before any business side effect. A retry with
 * the same provider event ID must have identical evidence; otherwise it is a
 * provider/security anomaly rather than a legitimate duplicate.
 */
export async function receiveInboxEvent(input: InboxEventInput): Promise<ReceivedInboxEvent> {
  const provider = requiredText(input.provider, "provider");
  const externalEventId = requiredText(input.externalEventId, "externalEventId");
  const payloadHash = hashPayload(input.payload);
  return withPostgresTransaction(async (client) => {
    const privacy = await resolveInboxPrivacyAttribution(client, input.provider, input.payload);
    const inserted = await client.query<{ id: string; processed_at: Date | null }>(
      `INSERT INTO fractal.inbox_events
         (id, provider, external_event_id, payload, payload_hash, received_at,
          privacy_classification, privacy_subject_identity_ids, privacy_attribution_basis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::uuid[], $9)
       ON CONFLICT (provider, external_event_id) DO NOTHING
       RETURNING id, processed_at`,
      [
        randomUUID(), provider, externalEventId, input.payload, payloadHash, input.receivedAt ?? new Date(),
        privacy.classification, privacy.subjectIdentityIds, privacy.basis,
      ],
    );
    if (inserted.rowCount === 1) {
      const row = inserted.rows[0];
      if (!row) throw new Error("Inbox event insert did not return a row");
      return { id: row.id, duplicate: false, processed: false };
    }
    const existing = await client.query<{
      id: string; payload_hash: string; processed_at: Date | null;
      privacy_classification: string; privacy_subject_identity_ids: string[]; privacy_attribution_basis: string;
    }>(
      `SELECT id, payload_hash, processed_at, privacy_classification,
              privacy_subject_identity_ids, privacy_attribution_basis
         FROM fractal.inbox_events
        WHERE provider = $1 AND external_event_id = $2
        FOR UPDATE`,
      [provider, externalEventId],
    );
    const row = existing.rows[0];
    if (!row) throw new Error("Inbox event disappeared during duplicate resolution");
    if (row.payload_hash !== payloadHash) {
      throw new InboxPayloadConflictError("Provider event ID was reused with a different payload");
    }
    if (
      row.privacy_classification !== privacy.classification
      || row.privacy_attribution_basis !== privacy.basis
      || row.privacy_subject_identity_ids.join(",") !== privacy.subjectIdentityIds.join(",")
    ) {
      throw new InboxPayloadConflictError("Provider event attribution changed after immutable receipt");
    }
    return { id: row.id, duplicate: true, processed: row.processed_at !== null };
  });
}

export async function claimInboxEvents(input: {
  workerId: string;
  providers: readonly string[];
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedInboxEvent[]> {
  if (input.providers.length === 0 || input.limit <= 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      provider: string;
      external_event_id: string;
      payload: Record<string, unknown>;
      received_at: Date;
      attempts: number;
    }>(
      `WITH candidates AS (
         SELECT id
           FROM fractal.inbox_events
          WHERE provider = ANY($1::text[])
            AND processed_at IS NULL
            AND failed_at IS NULL
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($2 * interval '1 second'))
          ORDER BY received_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $3
       )
       UPDATE fractal.inbox_events event
          SET claimed_at = now(), claimed_by = $4, attempts = event.attempts + 1
         FROM candidates
        WHERE event.id = candidates.id
       RETURNING event.id, event.provider, event.external_event_id, event.payload,
                 event.received_at, event.attempts`,
      [input.providers, input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((event) => ({
      id: event.id,
      provider: event.provider,
      externalEventId: event.external_event_id,
      payload: event.payload,
      receivedAt: event.received_at,
      attempts: event.attempts,
    }));
  });
}

export async function markInboxEventProcessed(client: PoolClient, eventId: string, workerId: string): Promise<void> {
  const result = await client.query(
    `UPDATE fractal.inbox_events
        SET processed_at = now(), claimed_at = NULL, claimed_by = NULL, last_error = NULL
      WHERE id = $1 AND claimed_by = $2 AND processed_at IS NULL`,
    [eventId, workerId],
  );
  if (result.rowCount !== 1) throw new Error(`Inbox event ${eventId} is no longer claimed by this worker`);
}

export async function markInboxEventForRetry(input: {
  eventId: string;
  workerId: string;
  retryAt: Date;
  error: unknown;
  terminal: boolean;
}): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `UPDATE fractal.inbox_events
          SET claimed_at = NULL,
              claimed_by = NULL,
              next_attempt_at = CASE WHEN $4 THEN next_attempt_at ELSE $3 END,
              failed_at = CASE WHEN $4 THEN now() ELSE NULL END,
              last_error = $5
        WHERE id = $1 AND claimed_by = $2 AND processed_at IS NULL`,
      [input.eventId, input.workerId, input.retryAt, input.terminal, message.slice(0, 2_000)],
    );
    if (result.rowCount !== 1) throw new Error(`Inbox event ${input.eventId} is no longer claimed by this worker`);
  });
}
