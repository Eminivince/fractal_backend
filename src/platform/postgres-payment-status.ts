export interface PaymentIntentStatusRow {
  id: string;
  status: string;
  expiresAt: Date;
  currency: string;
  amountMinor: string;
  instructionStatus: string | null;
  checkoutUrl: string | null;
  terminalAt: Date | null;
}

/** Safe investor-facing projection; provider diagnostics remain worker-only. */
export function serializePaymentIntentStatus(payment: PaymentIntentStatusRow) {
  const payable = payment.status === "pending" && payment.expiresAt > new Date();
  return {
    id: payment.id,
    status: payment.status,
    currency: payment.currency,
    amountMinor: payment.amountMinor,
    expiresAt: payment.expiresAt.toISOString(),
    providerInstruction: payment.instructionStatus
      ? {
          status: payment.instructionStatus,
          checkoutUrl: payment.instructionStatus === "initialized" && payable ? payment.checkoutUrl : null,
          retryable: payment.instructionStatus === "failed" && payment.terminalAt === null,
          error: payment.instructionStatus === "failed" ? "Payment setup could not be completed." : null,
        }
      : { status: "pending_projection", checkoutUrl: null, retryable: false, error: null },
  };
}
