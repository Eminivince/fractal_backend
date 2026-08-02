import { appendPostgresAuditEvent } from "../platform/postgres-audit.js";
import { appendOutboxEvent } from "../platform/postgres-outbox.js";
import { withPostgresTransaction } from "../db/postgres.js";
import { env } from "../config/env.js";

export interface PaymentExpiryLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

interface ExpiredIntent {
  id: string;
  commitment_id: string;
  organization_id: string;
}

/**
 * Releases capacity and prevents late provider initialization after the
 * payment window closes. The payment/reconciliation path remains authoritative
 * if a provider receipt had already matched before this worker locks the row.
 */
export async function expirePendingPaymentIntents(now = new Date()): Promise<number> {
  return withPostgresTransaction(async (client) => {
    const candidates = await client.query<ExpiredIntent>(
      `SELECT intent.id, intent.commitment_id, commitment.organization_id
         FROM fractal.payment_intents intent
         JOIN fractal.investment_commitments commitment ON commitment.id = intent.commitment_id
        WHERE intent.status = 'pending' AND intent.expires_at <= $1
        ORDER BY intent.expires_at, intent.id
        FOR UPDATE SKIP LOCKED
        LIMIT $2`,
      [now, env.PAYMENT_EXPIRY_BATCH_SIZE],
    );
    for (const intent of candidates.rows) {
      await client.query("UPDATE fractal.payment_intents SET status = 'expired', updated_at = now() WHERE id = $1", [intent.id]);
      await client.query("UPDATE fractal.investment_commitments SET status = 'expired', updated_at = now() WHERE id = $1 AND status = 'payment_pending'", [intent.commitment_id]);
      await client.query("UPDATE fractal.investment_reservations SET status = 'expired', updated_at = now() WHERE commitment_id = $1 AND status = 'pending_payment'", [intent.commitment_id]);
      await client.query(
        `UPDATE fractal.payment_provider_instructions
            SET status = 'cancelled', claimed_at = NULL, claimed_by = NULL,
                last_error = 'Payment intent expired before provider initialization', updated_at = now()
          WHERE payment_intent_id = $1 AND status IN ('pending', 'failed')`,
        [intent.id],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `organization:${intent.organization_id}`,
        organizationId: intent.organization_id,
        actorType: "system",
        action: "payment.intent.expired",
        entityType: "payment_intent",
        entityId: intent.id,
        payload: { commitmentId: intent.commitment_id, expiredAt: now.toISOString() },
      });
      await appendOutboxEvent(client, {
        aggregateType: "payment_intent",
        aggregateId: intent.id,
        eventType: "payment.intent.expired",
        payload: { organizationId: intent.organization_id, commitmentId: intent.commitment_id, auditEventId: audit.id },
      });
    }
    return candidates.rowCount ?? 0;
  });
}

export function startPaymentExpiryWorker(logger: PaymentExpiryLogger): { stop: () => void } {
  let running = false;
  let stopped = false;
  const expire = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const count = await expirePendingPaymentIntents();
      if (count) logger.info({ count }, "Expired pending payment intents");
    } catch (error) {
      logger.error({ err: error }, "Payment expiry worker failed");
    } finally { running = false; }
  };
  const timer = setInterval(() => void expire(), env.PAYMENT_EXPIRY_INTERVAL_MS);
  timer.unref();
  void expire();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
