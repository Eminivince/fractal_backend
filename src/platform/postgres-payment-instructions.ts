import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import type { ClaimedOutboxEvent } from "./postgres-outbox.js";

export interface ClaimedPaymentInstruction {
  id: string;
  paymentIntentId: string;
  provider: string;
  attempts: number;
}

/** Projects an already-committed payment event into one durable provider call. */
export async function projectPaymentIntentCreated(client: PoolClient, event: ClaimedOutboxEvent): Promise<void> {
  if (event.eventType !== "payment.intent.created") throw new Error(`Unsupported payment event: ${event.eventType}`);
  const intent = await client.query<{ provider: string }>("SELECT provider FROM fractal.payment_intents WHERE id = $1", [event.aggregateId]);
  const provider = intent.rows[0]?.provider;
  if (!provider) throw new Error(`Payment intent ${event.aggregateId} was not found for outbox projection`);
  await client.query(
    `INSERT INTO fractal.payment_provider_instructions
       (id, payment_intent_id, outbox_event_id, provider, status)
     VALUES ($1, $2, $3, $4, 'pending')
     ON CONFLICT (outbox_event_id) DO NOTHING`,
    [randomUUID(), event.aggregateId, event.id, provider],
  );
}

export async function claimPaymentProviderInstructions(input: {
  workerId: string;
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedPaymentInstruction[]> {
  if (input.limit <= 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{ id: string; payment_intent_id: string; provider: string; attempts: number }>(
      `WITH candidates AS (
         SELECT id FROM fractal.payment_provider_instructions
          WHERE status IN ('pending', 'failed') AND terminal_at IS NULL AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($1 * interval '1 second'))
          ORDER BY created_at, id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE fractal.payment_provider_instructions instruction
          SET claimed_at = now(), claimed_by = $3, attempts = instruction.attempts + 1
         FROM candidates WHERE instruction.id = candidates.id
       RETURNING instruction.id, instruction.payment_intent_id, instruction.provider, instruction.attempts`,
      [input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((row) => ({ id: row.id, paymentIntentId: row.payment_intent_id, provider: row.provider, attempts: row.attempts }));
  });
}

export async function markPaymentInstructionInitialized(input: { instructionId: string; workerId: string; checkoutUrl: string; accessCode?: string }): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `UPDATE fractal.payment_provider_instructions
          SET status = 'initialized', checkout_url = $3, provider_access_code = $4, initialized_at = now(),
              claimed_at = NULL, claimed_by = NULL, last_error = NULL, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status IN ('pending', 'failed')`,
      [input.instructionId, input.workerId, input.checkoutUrl, input.accessCode ?? null],
    );
    if (result.rowCount !== 1) throw new Error(`Payment instruction ${input.instructionId} is no longer claimed`);
  });
}

export async function markPaymentInstructionForRetry(input: { instructionId: string; workerId: string; retryAt: Date; error: unknown; terminal: boolean }): Promise<void> {
  const message = input.error instanceof Error ? input.error.message : String(input.error);
  await withPostgresTransaction(async (client) => {
    const result = await client.query(
      `UPDATE fractal.payment_provider_instructions
          SET status = 'failed', claimed_at = NULL, claimed_by = NULL,
              next_attempt_at = CASE WHEN $4 THEN next_attempt_at ELSE $3 END,
              terminal_at = CASE WHEN $4 THEN now() ELSE NULL END,
              last_error = $5, updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status IN ('pending', 'failed')`,
      [input.instructionId, input.workerId, input.retryAt, input.terminal, message.slice(0, 2_000)],
    );
    if (result.rowCount !== 1) throw new Error(`Payment instruction ${input.instructionId} is no longer claimed`);
  });
}
