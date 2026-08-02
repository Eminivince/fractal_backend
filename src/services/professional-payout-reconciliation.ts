import { env } from "../config/env.js";
import { requirePostgres } from "../db/postgres.js";
import { recordProfessionalPayoutProviderOutcome } from "../platform/postgres-professional-invoices.js";
import { verifyPaystackTransfer, type PaystackTransferDetails } from "./paystack.js";
import type { ProfessionalPayoutLogger } from "./professional-payout-dispatcher.js";

export type ProfessionalTransferVerifier = (reference: string) => Promise<PaystackTransferDetails>;

function toOutcome(status: string): "success" | "failed" | "reversed" | null {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  if (status === "reversed") return "reversed";
  return null;
}

/** Provider calls happen outside a DB transaction; the governed DB update is conditional and idempotent. */
export async function reconcileProfessionalPayouts(input: {
  logger: ProfessionalPayoutLogger;
  limit?: number;
  verify?: ProfessionalTransferVerifier;
}): Promise<number> {
  const instructions = await requirePostgres().query<{ reference: string }>(
    `SELECT reference
       FROM fractal.professional_payout_instructions
      WHERE status IN ('submitted', 'uncertain')
      ORDER BY COALESCE(submitted_at, dispatch_started_at, authorized_at), id
      LIMIT $1`,
    [input.limit ?? env.PROFESSIONAL_PAYOUT_RECONCILIATION_BATCH_SIZE],
  );
  const verify = input.verify ?? ((reference) => verifyPaystackTransfer(reference));
  let reconciled = 0;
  for (const instruction of instructions.rows) {
    try {
      const transfer = await verify(instruction.reference);
      if (transfer.reference !== instruction.reference) throw new Error("Provider transfer reference does not match payout instruction");
      const outcome = toOutcome(transfer.status);
      if (!outcome) continue;
      const result = await recordProfessionalPayoutProviderOutcome({
        outcome,
        reference: transfer.reference,
        transferCode: transfer.transfer_code,
        amountMinor: transfer.amount,
        currency: transfer.currency,
        reason: typeof transfer.failures === "string" ? transfer.failures : undefined,
        source: "verification",
      });
      if (result.handled) reconciled += 1;
    } catch (error) {
      input.logger.error({ err: error, reference: instruction.reference }, "Professional payout verification failed; retained for reconciliation");
    }
  }
  return reconciled;
}

export function startProfessionalPayoutReconciliationWorker(input: { logger: ProfessionalPayoutLogger }): { stop: () => void } {
  let stopped = false;
  let running = false;
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const reconciled = await reconcileProfessionalPayouts(input);
      if (reconciled) input.logger.info({ reconciled }, "Professional payout outcomes reconciled");
    } catch (error) {
      input.logger.error({ err: error }, "Professional payout reconciliation worker failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), env.PROFESSIONAL_PAYOUT_RECONCILIATION_INTERVAL_MS);
  timer.unref();
  void tick();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
