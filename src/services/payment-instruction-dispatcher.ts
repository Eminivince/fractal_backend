import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { requirePostgres } from "../db/postgres.js";
import { initializePaystackTransaction, PaystackRequestError, type PaystackCheckout } from "./paystack.js";
import {
  claimPaymentProviderInstructions,
  markPaymentInstructionForRetry,
  markPaymentInstructionInitialized,
  type ClaimedPaymentInstruction,
} from "../platform/postgres-payment-instructions.js";

export interface PaymentInstructionLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export type PaystackInitializer = (input: { email: string; amountKobo: number; reference: string; metadata: Record<string, unknown> }) => Promise<PaystackCheckout>;

interface PaymentInstructionDetails {
  email: string;
  amountMinor: string;
  currency: string;
  reference: string;
  metadata: Record<string, unknown>;
}

async function loadPaystackInstruction(instruction: ClaimedPaymentInstruction): Promise<PaymentInstructionDetails> {
  const result = await requirePostgres().query<{
    email: string; expected_minor: string; currency: string; provider_reference: string;
    payment_intent_id: string; commitment_id: string;
  }>(
    `SELECT identity.email, intent.expected_minor, intent.currency, intent.provider_reference,
            intent.id AS payment_intent_id, commitment.id AS commitment_id
       FROM fractal.payment_provider_instructions instruction
       JOIN fractal.payment_intents intent ON intent.id = instruction.payment_intent_id
       JOIN fractal.investment_commitments commitment ON commitment.id = intent.commitment_id
       JOIN fractal.identities identity ON identity.id = commitment.investor_identity_id
      WHERE instruction.id = $1`,
    [instruction.id],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`Payment instruction ${instruction.id} was not found`);
  if (row.currency !== "NGN") throw new Error(`Paystack instruction ${instruction.id} has unsupported currency ${row.currency}`);
  return {
    email: row.email,
    amountMinor: row.expected_minor,
    currency: row.currency,
    reference: row.provider_reference,
    metadata: { paymentIntentId: row.payment_intent_id, commitmentId: row.commitment_id },
  };
}

export async function processPaymentProviderInstruction(
  instruction: ClaimedPaymentInstruction,
  workerId: string,
  initialize: PaystackInitializer = (input) => initializePaystackTransaction({ email: input.email, amountKobo: input.amountKobo, reference: input.reference, metadata: input.metadata }),
): Promise<void> {
  if (instruction.provider !== "paystack") throw new Error(`Unsupported payment provider: ${instruction.provider}`);
  const details = await loadPaystackInstruction(instruction);
  const amountKobo = Number(details.amountMinor);
  if (!Number.isSafeInteger(amountKobo) || amountKobo <= 0) throw new Error(`Invalid Paystack instruction amount: ${details.amountMinor}`);
  const checkout = await initialize({ email: details.email, amountKobo, reference: details.reference, metadata: details.metadata });
  await markPaymentInstructionInitialized({ instructionId: instruction.id, workerId, checkoutUrl: checkout.authorization_url, accessCode: checkout.access_code });
}

export async function dispatchPendingPaymentProviderInstructions(input: { workerId?: string; logger: PaymentInstructionLogger; initialize?: PaystackInitializer }): Promise<number> {
  const workerId = input.workerId ?? randomUUID();
  const instructions = await claimPaymentProviderInstructions({ workerId, limit: env.OUTBOX_DISPATCH_BATCH_SIZE, claimTimeoutSeconds: env.PAYMENT_INSTRUCTION_CLAIM_TIMEOUT_SECONDS });
  for (const instruction of instructions) {
    try {
      await processPaymentProviderInstruction(instruction, workerId, input.initialize);
      input.logger.info({ instructionId: instruction.id, paymentIntentId: instruction.paymentIntentId }, "Payment provider instruction initialized");
    } catch (error) {
      const terminal = instruction.attempts >= env.PAYMENT_INSTRUCTION_MAX_ATTEMPTS
        || (error instanceof Error && error.message.startsWith("Unsupported payment provider"))
        || (error instanceof PaystackRequestError && !error.retryable);
      const delaySeconds = Math.min(60 * 60, env.PAYMENT_INSTRUCTION_RETRY_BASE_SECONDS * 2 ** Math.max(0, instruction.attempts - 1));
      await markPaymentInstructionForRetry({ instructionId: instruction.id, workerId, retryAt: new Date(Date.now() + delaySeconds * 1_000), error, terminal });
      input.logger.error({ err: error, instructionId: instruction.id, terminal, delaySeconds }, "Payment provider instruction failed");
    }
  }
  return instructions.length;
}

export function startPaymentProviderInstructionDispatcher(input: { logger: PaymentInstructionLogger; initialize?: PaystackInitializer }): { stop: () => void } {
  const workerId = randomUUID();
  let stopped = false;
  let running = false;
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try { await dispatchPendingPaymentProviderInstructions({ ...input, workerId }); }
    catch (error) { input.logger.error({ err: error }, "Payment instruction dispatcher failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void dispatch(), env.PAYMENT_INSTRUCTION_DISPATCH_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
