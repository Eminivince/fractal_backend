import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { initiatePaystackTransfer, type PaystackTransfer } from "./paystack.js";

type Instruction = {
  id: string;
  provider_recipient_reference: string;
  amount_minor: string;
  reference: string;
  currency: string;
};

export interface ProfessionalPayoutLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export type ProfessionalTransferInitiator = (input: {
  recipientCode: string;
  amountKobo: number;
  reference: string;
  reason: string;
}) => Promise<PaystackTransfer>;

async function claim(workerId: string): Promise<Instruction | null> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<Instruction>(
      `WITH candidate AS (
         SELECT id
           FROM fractal.professional_payout_instructions
          WHERE status = 'authorized'
          ORDER BY authorized_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT 1
       )
       UPDATE fractal.professional_payout_instructions instruction
          SET status = 'dispatching', dispatch_started_at = now(), dispatch_worker_id = $1
         FROM candidate
        WHERE instruction.id = candidate.id
       RETURNING instruction.id, instruction.provider_recipient_reference, instruction.amount_minor,
                 instruction.reference, instruction.currency`,
      [workerId],
    );
    return result.rows[0] ?? null;
  });
}

/** A crashed worker is never allowed to make a bank transfer eligible for automatic retry. */
export async function recoverStaleProfessionalPayoutDispatches(maxAgeSeconds = env.PROFESSIONAL_PAYOUT_DISPATCH_LEASE_TIMEOUT_SECONDS): Promise<number> {
  const result = await requirePostgres().query(
    `UPDATE fractal.professional_payout_instructions
        SET status = 'uncertain', failed_at = now(),
            failure_reason = 'Dispatch lease expired before the provider outcome was durably recorded'
      WHERE status = 'dispatching'
        AND dispatch_started_at < now() - ($1 * interval '1 second')`,
    [maxAgeSeconds],
  );
  return result.rowCount ?? 0;
}

export async function dispatchOneProfessionalPayout(
  workerId: string,
  initiate: ProfessionalTransferInitiator = (input) => initiatePaystackTransfer(input),
): Promise<boolean> {
  const instruction = await claim(workerId);
  if (!instruction) return false;

  try {
    if (instruction.currency !== "NGN") throw new Error("Unsupported payout currency");
    const amountKobo = Number(instruction.amount_minor);
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) throw new Error("Invalid payout amount");
    const transfer = await initiate({
      recipientCode: instruction.provider_recipient_reference,
      amountKobo,
      reference: instruction.reference,
      reason: `Professional invoice payout ${instruction.reference}`,
    });
    const result = await requirePostgres().query(
      `UPDATE fractal.professional_payout_instructions
          SET status = 'submitted', provider_transfer_code = $2, submitted_at = now()
        WHERE id = $1 AND status = 'dispatching'`,
      [instruction.id, transfer.transfer_code],
    );
    if (result.rowCount !== 1) throw new Error("Payout dispatch outcome could not be durably recorded; reconciliation is required");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await requirePostgres().query(
      `UPDATE fractal.professional_payout_instructions
          SET status = 'uncertain', failed_at = now(), failure_reason = $2
        WHERE id = $1 AND status = 'dispatching'`,
      [instruction.id, reason.slice(0, 2_000)],
    );
    throw error;
  }
  return true;
}

export function startProfessionalPayoutDispatcher(input: { logger: ProfessionalPayoutLogger }): { stop: () => void } {
  const workerId = randomUUID();
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const recovered = await recoverStaleProfessionalPayoutDispatches();
      if (recovered) input.logger.error({ recovered }, "Professional payouts require reconciliation after an expired dispatch lease");
      while (await dispatchOneProfessionalPayout(workerId)) input.logger.info({ workerId }, "Professional payout submitted to provider");
    } catch (error) {
      input.logger.error({ err: error, workerId }, "Professional payout requires reconciliation");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), env.PROFESSIONAL_PAYOUT_DISPATCH_INTERVAL_MS);
  timer.unref();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
