import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { recordDistributionPayoutProviderOutcome } from "../platform/postgres-distribution-payouts.js";
import { initiatePaystackTransfer, verifyPaystackTransfer, type PaystackTransfer, type PaystackTransferDetails } from "./paystack.js";

type Instruction = { id: string; provider_recipient_reference: string; amount_minor: string; reference: string; currency: string };
export interface DistributionPayoutLogger { info: (obj: unknown, message?: string) => void; error: (obj: unknown, message?: string) => void }
export type DistributionTransferInitiator = (input: { recipientCode: string; amountKobo: number; reference: string; reason: string }) => Promise<PaystackTransfer>;
export type DistributionTransferVerifier = (reference: string) => Promise<PaystackTransferDetails>;

async function claim(workerId: string): Promise<Instruction | null> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<Instruction>(`WITH candidate AS (SELECT id FROM fractal.distribution_payout_instructions WHERE status='authorized' ORDER BY authorized_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE fractal.distribution_payout_instructions payout SET status='dispatching',dispatch_started_at=now(),dispatch_worker_id=$1 FROM candidate WHERE payout.id=candidate.id
      RETURNING payout.id,payout.provider_recipient_reference,payout.amount_minor,payout.reference,payout.currency`, [workerId]);
    return result.rows[0] ?? null;
  });
}

/** A crashed worker becomes uncertain and is never automatically resent. */
export async function recoverStaleDistributionPayoutDispatches(maxAgeSeconds = env.DISTRIBUTION_PAYOUT_DISPATCH_LEASE_TIMEOUT_SECONDS) {
  const result = await requirePostgres().query(`UPDATE fractal.distribution_payout_instructions SET status='uncertain',failed_at=now(),failure_reason='Dispatch lease expired before the provider outcome was durably recorded' WHERE status='dispatching' AND dispatch_started_at<now()-($1*interval '1 second')`, [maxAgeSeconds]);
  return result.rowCount ?? 0;
}

export async function dispatchOneDistributionPayout(workerId: string, initiate: DistributionTransferInitiator = (input) => initiatePaystackTransfer(input)) {
  const instruction = await claim(workerId);
  if (!instruction) return false;
  try {
    if (instruction.currency !== "NGN") throw new Error("Unsupported distribution payout currency");
    const amountKobo = Number(instruction.amount_minor);
    if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) throw new Error("Invalid distribution payout amount");
    const transfer = await initiate({ recipientCode: instruction.provider_recipient_reference, amountKobo, reference: instruction.reference, reason: `Investor distribution ${instruction.reference}` });
    const updated = await requirePostgres().query("UPDATE fractal.distribution_payout_instructions SET status='submitted',provider_transfer_code=$2,submitted_at=now() WHERE id=$1 AND status='dispatching'", [instruction.id, transfer.transfer_code]);
    if (updated.rowCount !== 1) throw new Error("Distribution payout outcome could not be durably recorded; reconciliation is required");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    await requirePostgres().query("UPDATE fractal.distribution_payout_instructions SET status='uncertain',failed_at=now(),failure_reason=$2 WHERE id=$1 AND status='dispatching'", [instruction.id, reason.slice(0, 2000)]);
    throw error;
  }
  return true;
}

function outcome(status: string): "success" | "failed" | "reversed" | null { return status === "success" || status === "failed" || status === "reversed" ? status : null; }
export async function reconcileDistributionPayouts(input: { logger: DistributionPayoutLogger; limit?: number; verify?: DistributionTransferVerifier }) {
  const rows = await requirePostgres().query<{ reference: string }>("SELECT reference FROM fractal.distribution_payout_instructions WHERE status IN('submitted','uncertain') ORDER BY COALESCE(submitted_at,dispatch_started_at,authorized_at),id LIMIT $1", [input.limit ?? env.DISTRIBUTION_PAYOUT_RECONCILIATION_BATCH_SIZE]);
  const verify = input.verify ?? ((reference) => verifyPaystackTransfer(reference));
  let reconciled = 0;
  for (const row of rows.rows) {
    try {
      const transfer = await verify(row.reference);
      if (transfer.reference !== row.reference) throw new Error("Provider transfer reference does not match distribution payout instruction");
      const result = outcome(transfer.status);
      if (!result) continue;
      const recorded = await recordDistributionPayoutProviderOutcome({ reference: transfer.reference, outcome: result, transferCode: transfer.transfer_code, amountMinor: transfer.amount, currency: transfer.currency, reason: typeof transfer.failures === "string" ? transfer.failures : undefined, source: "verification" });
      if (recorded.handled) reconciled += 1;
    } catch (error) { input.logger.error({ err: error, reference: row.reference }, "Distribution payout verification failed; retained for reconciliation"); }
  }
  return reconciled;
}

export function startDistributionPayoutWorkers(input: { logger: DistributionPayoutLogger }) {
  const workerId = randomUUID(); let stopped = false; let dispatchRunning = false; let reconcileRunning = false;
  const dispatch = async () => { if (stopped || dispatchRunning) return; dispatchRunning = true; try { const recovered = await recoverStaleDistributionPayoutDispatches(); if (recovered) input.logger.error({ recovered }, "Distribution payouts require reconciliation after expired dispatch leases"); while (await dispatchOneDistributionPayout(workerId)) input.logger.info({ workerId }, "Distribution payout submitted to provider"); } catch (error) { input.logger.error({ err: error, workerId }, "Distribution payout requires reconciliation"); } finally { dispatchRunning = false; } };
  const reconcile = async () => { if (stopped || reconcileRunning) return; reconcileRunning = true; try { const count = await reconcileDistributionPayouts(input); if (count) input.logger.info({ reconciled: count }, "Distribution payout outcomes reconciled"); } catch (error) { input.logger.error({ err: error }, "Distribution payout reconciliation worker failed"); } finally { reconcileRunning = false; } };
  const dispatchTimer = setInterval(() => void dispatch(), env.DISTRIBUTION_PAYOUT_DISPATCH_INTERVAL_MS); dispatchTimer.unref();
  const reconcileTimer = setInterval(() => void reconcile(), env.DISTRIBUTION_PAYOUT_RECONCILIATION_INTERVAL_MS); reconcileTimer.unref();
  void dispatch(); void reconcile();
  return { stop: () => { stopped = true; clearInterval(dispatchTimer); clearInterval(reconcileTimer); } };
}
