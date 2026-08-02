import { describe, expect, it } from "vitest";
import { serializePaymentIntentStatus } from "../postgres-payment-status.js";

const base = { id: "intent-1", status: "pending", currency: "NGN", amountMinor: "100000", expiresAt: new Date("2026-07-18T12:00:00.000Z") };

describe("investor payment-intent status projection", () => {
  it("does not expose a URL until the instruction is initialized", () => {
    expect(serializePaymentIntentStatus({ ...base, instructionStatus: "pending", checkoutUrl: "https://provider.example/private", terminalAt: null }).providerInstruction)
      .toEqual({ status: "pending", checkoutUrl: null, retryable: false, error: null });
  });

  it("withdraws an initialized checkout URL once the intent is no longer payable", () => {
    expect(serializePaymentIntentStatus({ ...base, status: "receipt_matched", instructionStatus: "initialized", checkoutUrl: "https://provider.example/checkout", terminalAt: null }).providerInstruction.checkoutUrl)
      .toBeNull();
    expect(serializePaymentIntentStatus({ ...base, expiresAt: new Date("2020-01-01T00:00:00.000Z"), instructionStatus: "initialized", checkoutUrl: "https://provider.example/checkout", terminalAt: null }).providerInstruction.checkoutUrl)
      .toBeNull();
  });

  it("distinguishes worker-retryable from terminal failures without leaking diagnostics", () => {
    expect(serializePaymentIntentStatus({ ...base, instructionStatus: "failed", checkoutUrl: null, terminalAt: null }).providerInstruction)
      .toEqual({ status: "failed", checkoutUrl: null, retryable: true, error: "Payment setup could not be completed." });
    expect(serializePaymentIntentStatus({ ...base, instructionStatus: "failed", checkoutUrl: null, terminalAt: new Date() }).providerInstruction)
      .toEqual({ status: "failed", checkoutUrl: null, retryable: false, error: "Payment setup could not be completed." });
  });
});
