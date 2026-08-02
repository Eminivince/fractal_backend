import { describe, it, expect } from "vitest";
import { assertTransition } from "../state-machine.js";

describe("distribution state machine — atomic mark-paid (3.4)", () => {
  it("allows scheduled -> paying (the atomic claim)", () => {
    expect(() => assertTransition("distribution", "scheduled", "paying")).not.toThrow();
  });

  it("no longer allows scheduled -> paid directly (must go through paying)", () => {
    expect(() => assertTransition("distribution", "scheduled", "paid")).toThrow();
  });

  it("allows paying -> paid only with payout receipts", () => {
    expect(() =>
      assertTransition("distribution", "paying", "paid", { hasPayoutReceipts: true }),
    ).not.toThrow();
    expect(() =>
      assertTransition("distribution", "paying", "paid", { hasPayoutReceipts: false }),
    ).toThrow(/payout receipts/);
  });

  it("allows paying -> failed", () => {
    expect(() => assertTransition("distribution", "paying", "failed")).not.toThrow();
  });

  it("allows paid -> reversed only with trustee completion", () => {
    expect(() =>
      assertTransition("distribution", "paid", "reversed", { trusteeProcessCompleted: true }),
    ).not.toThrow();
    expect(() =>
      assertTransition("distribution", "paid", "reversed", { trusteeProcessCompleted: false }),
    ).toThrow();
  });
});

describe("tranche state machine — atomic release (3.4)", () => {
  it("allows eligible -> processing with an outbound transfer", () => {
    expect(() =>
      assertTransition("tranche", "eligible", "processing", { hasOutboundTransfer: true }),
    ).not.toThrow();
  });

  it("requires payout receipts for processing -> released (manual mode after claim)", () => {
    expect(() =>
      assertTransition("tranche", "processing", "released", { hasPayoutReceipts: true }),
    ).not.toThrow();
    expect(() =>
      assertTransition("tranche", "processing", "released", { hasPayoutReceipts: false }),
    ).toThrow(/payout receipts/);
  });

  it("rejects an invalid jump (locked -> released)", () => {
    expect(() => assertTransition("tranche", "locked", "released")).toThrow();
  });
});

describe("application and offering gates", () => {
  it("requires intake, review tasks, evidence, and legal checks for applications", () => {
    expect(() => assertTransition("application", "draft", "submitted")).toThrow(/intake documents/);
    expect(() => assertTransition("application", "draft", "submitted", { minimumDocsSatisfied: true })).not.toThrow();
    expect(() => assertTransition("application", "in_review", "approved", { tasksComplete: true })).toThrow(/evidence/);
    expect(() => assertTransition("application", "in_review", "approved", { tasksComplete: true, evidenceVerified: true })).toThrow(/legal checklist/);
    expect(() => assertTransition("application", "in_review", "approved", { tasksComplete: true, evidenceVerified: true, legalChecklistSatisfied: true })).not.toThrow();
    expect(() => assertTransition("application", "approved", "submitted")).toThrow(/Invalid application transition/);
  });

  it("requires complete governance data before an offering opens", () => {
    expect(() => assertTransition("offering", "pending_review", "open", { applicationApproved: true })).toThrow(/economic policy/);
    expect(() => assertTransition("offering", "pending_review", "open", { applicationApproved: true, economicPolicyValid: true })).toThrow(/disclosure pack/);
    expect(() => assertTransition("offering", "pending_review", "open", { applicationApproved: true, economicPolicyValid: true, disclosurePackPresent: true, feesConfigured: true })).not.toThrow();
    expect(() => assertTransition("offering", "open", "closed", { hasPendingReconciliation: true })).toThrow(/reconciliations/);
    expect(() => assertTransition("offering", "open", "closed", { hasPendingReconciliation: true, overrideRequested: true })).not.toThrow();
    expect(() => assertTransition("offering", "closed", "servicing")).toThrow(/snapshot/);
    expect(() => assertTransition("offering", "closed", "servicing", { allocationSnapshotAnchored: true })).not.toThrow();
    expect(() => assertTransition("offering", "draft", "open")).toThrow(/Invalid offering transition/);
  });
});

describe("subscription and payout gates", () => {
  it("requires KYC, eligibility, a receipt, reversal evidence, and approval for subscriptions", () => {
    expect(() => assertTransition("subscription", "draft", "committed")).toThrow(/KYC/);
    expect(() => assertTransition("subscription", "draft", "committed", { kycApproved: true })).toThrow(/eligibility/);
    expect(() => assertTransition("subscription", "draft", "committed", { kycApproved: true, eligibilitySatisfied: true })).not.toThrow();
    expect(() => assertTransition("subscription", "payment_pending", "paid")).toThrow(/verified receipt/);
    expect(() => assertTransition("subscription", "payment_pending", "paid", { hasVerifiedReceipt: true })).not.toThrow();
    expect(() => assertTransition("subscription", "paid", "refunded", { hasReversalRecord: true })).toThrow(/approval policy/);
    expect(() => assertTransition("subscription", "paid", "refunded", { hasReversalRecord: true, approvalPolicySatisfied: true })).not.toThrow();
    expect(() => assertTransition("subscription", "draft", "paid")).toThrow(/Invalid subscription transition/);
  });

  it("requires required evidence for milestones, tranches, and distribution lines", () => {
    expect(() => assertTransition("milestone", "in_review", "verified")).toThrow(/evidence docs/);
    expect(() => assertTransition("milestone", "in_review", "verified", { hasEvidence: true })).not.toThrow();
    expect(() => assertTransition("milestone", "not_started", "verified")).toThrow(/Invalid milestone transition/);
    expect(() => assertTransition("tranche", "eligible", "processing")).toThrow(/outbound transfer/);
    expect(() => assertTransition("tranche", "eligible", "processing", { hasOutboundTransfer: true })).not.toThrow();
    expect(() => assertTransition("tranche", "released", "reversed")).toThrow(/trustee process/);
    expect(() => assertTransition("tranche", "released", "reversed", { trusteeProcessCompleted: true })).not.toThrow();
    expect(() => assertTransition("distributionLine", "pending", "processing")).toThrow(/outbound transfer/);
    expect(() => assertTransition("distributionLine", "pending", "processing", { hasOutboundTransfer: true })).not.toThrow();
    expect(() => assertTransition("distributionLine", "pending", "reversed")).toThrow(/Invalid distributionLine transition/);
  });

  it("rejects unknown state-machine entity types", () => {
    expect(() => assertTransition("unknown" as any, "draft" as any, "open" as any)).toThrow(/Unknown entity type/);
  });
});
