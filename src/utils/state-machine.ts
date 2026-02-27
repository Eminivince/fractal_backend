import { HttpError } from "./errors.js";
import type {
  ApplicationStatus,
  DistributionStatus,
  MilestoneStatus,
  OfferingStatus,
  SubscriptionStatus,
  TrancheStatus,
} from "./constants.js";

interface ApplicationContext {
  minimumDocsSatisfied?: boolean;
  tasksComplete?: boolean;
  evidenceVerified?: boolean;
  legalChecklistSatisfied?: boolean;
}

interface OfferingContext {
  applicationApproved?: boolean;
  economicPolicyValid?: boolean;
  disclosurePackPresent?: boolean;
  feesConfigured?: boolean;
  hasPendingReconciliation?: boolean;
  overrideRequested?: boolean;
  allocationSnapshotAnchored?: boolean;
}

interface SubscriptionContext {
  kycApproved?: boolean;
  eligibilitySatisfied?: boolean;
  hasVerifiedReceipt?: boolean;
  hasReversalRecord?: boolean;
  approvalPolicySatisfied?: boolean;
}

interface DistributionContext {
  hasPayoutReceipts?: boolean;
  trusteeProcessCompleted?: boolean;
}

interface MilestoneContext {
  hasEvidence?: boolean;
}

interface TrancheContext {
  hasPayoutReceipts?: boolean;
  trusteeProcessCompleted?: boolean;
}

const applicationTransitions: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ["submitted", "withdrawn"],
  submitted: ["in_review", "withdrawn"],
  in_review: ["needs_info", "approved", "rejected", "withdrawn"],
  needs_info: ["submitted", "withdrawn"],
  approved: [],
  rejected: [],
  withdrawn: [],
};

const offeringTransitions: Record<OfferingStatus, OfferingStatus[]> = {
  draft: ["pending_review", "cancelled"],
  pending_review: ["needs_revision", "open", "cancelled"],
  needs_revision: ["pending_review", "cancelled"],
  open: ["paused", "closed"],
  paused: ["open"],
  closed: ["servicing"],
  servicing: ["exited"],
  exited: [],
  cancelled: [],
};

const subscriptionTransitions: Record<SubscriptionStatus, SubscriptionStatus[]> = {
  draft: ["committed", "cancelled"],
  committed: ["payment_pending", "cancelled"],
  payment_pending: ["paid", "cancelled"],
  paid: ["allocation_confirmed", "refunded"],
  allocation_confirmed: ["refunded"],
  cancelled: [],
  refunded: [],
};

const distributionTransitions: Record<DistributionStatus, DistributionStatus[]> = {
  draft: ["pending_approval"],
  pending_approval: ["approved"],
  approved: ["scheduled"],
  scheduled: ["paid", "failed"],
  paid: ["reversed"],
  failed: [],
  reversed: [],
};

const milestoneTransitions: Record<MilestoneStatus, MilestoneStatus[]> = {
  not_started: ["evidence_submitted"],
  evidence_submitted: ["in_review"],
  in_review: ["verified", "rejected"],
  verified: [],
  rejected: ["evidence_submitted"],
};

const trancheTransitions: Record<TrancheStatus, TrancheStatus[]> = {
  locked: ["eligible"],
  eligible: ["released"],
  released: ["failed", "reversed"],
  failed: [],
  reversed: [],
};

function invalidTransition(entityType: string, fromStatus: string, toStatus: string): never {
  throw new HttpError(409, `Invalid ${entityType} transition: ${fromStatus} -> ${toStatus}`);
}

export function assertTransition(
  entityType: "application",
  fromStatus: ApplicationStatus,
  toStatus: ApplicationStatus,
  context?: ApplicationContext,
): void;
export function assertTransition(
  entityType: "offering",
  fromStatus: OfferingStatus,
  toStatus: OfferingStatus,
  context?: OfferingContext,
): void;
export function assertTransition(
  entityType: "subscription",
  fromStatus: SubscriptionStatus,
  toStatus: SubscriptionStatus,
  context?: SubscriptionContext,
): void;
export function assertTransition(
  entityType: "distribution",
  fromStatus: DistributionStatus,
  toStatus: DistributionStatus,
  context?: DistributionContext,
): void;
export function assertTransition(
  entityType: "milestone",
  fromStatus: MilestoneStatus,
  toStatus: MilestoneStatus,
  context?: MilestoneContext,
): void;
export function assertTransition(
  entityType: "tranche",
  fromStatus: TrancheStatus,
  toStatus: TrancheStatus,
  context?: TrancheContext,
): void;
export function assertTransition(
  entityType: string,
  fromStatus: string,
  toStatus: string,
  context?:
    | ApplicationContext
    | OfferingContext
    | SubscriptionContext
    | DistributionContext
    | MilestoneContext
    | TrancheContext,
) {
  if (entityType === "application") {
    const applicationContext = context as ApplicationContext | undefined;
    if (!applicationTransitions[fromStatus as ApplicationStatus]?.includes(toStatus as ApplicationStatus)) {
      invalidTransition(entityType, fromStatus, toStatus);
    }

    if (fromStatus === "draft" && toStatus === "submitted" && !applicationContext?.minimumDocsSatisfied) {
      throw new HttpError(422, "Cannot submit application: required intake documents/checklist are incomplete");
    }

    if (fromStatus === "in_review" && toStatus === "approved") {
      if (!applicationContext?.tasksComplete) throw new HttpError(422, "Cannot approve application: tasks not complete");
      if (!applicationContext?.evidenceVerified) {
        throw new HttpError(422, "Cannot approve application: required evidence not fully verified");
      }
      if (!applicationContext?.legalChecklistSatisfied) {
        throw new HttpError(422, "Cannot approve application: legal checklist not satisfied");
      }
    }
    return;
  }

  if (entityType === "offering") {
    const offeringContext = context as OfferingContext | undefined;
    if (!offeringTransitions[fromStatus as OfferingStatus]?.includes(toStatus as OfferingStatus)) {
      invalidTransition(entityType, fromStatus, toStatus);
    }

    if (fromStatus === "pending_review" && toStatus === "open") {
      if (!offeringContext?.applicationApproved) throw new HttpError(422, "Cannot open offering: application not approved");
      if (!offeringContext?.economicPolicyValid) throw new HttpError(422, "Cannot open offering: economic policy is invalid");
      if (!offeringContext?.disclosurePackPresent) {
        throw new HttpError(422, "Cannot open offering: disclosure pack missing");
      }
      if (!offeringContext?.feesConfigured) throw new HttpError(422, "Cannot open offering: fee schedule not configured");
    }

    if (fromStatus === "open" && toStatus === "closed") {
      const blocked = offeringContext?.hasPendingReconciliation;
      const overrideRequested = offeringContext?.overrideRequested;
      if (blocked && !overrideRequested) {
        throw new HttpError(422, "Cannot close offering while payment reconciliations are pending");
      }
    }

    if (fromStatus === "closed" && toStatus === "servicing" && !offeringContext?.allocationSnapshotAnchored) {
      throw new HttpError(422, "Cannot enter servicing: allocation snapshot not anchored");
    }
    return;
  }

  if (entityType === "subscription") {
    const subscriptionContext = context as SubscriptionContext | undefined;
    if (!subscriptionTransitions[fromStatus as SubscriptionStatus]?.includes(toStatus as SubscriptionStatus)) {
      invalidTransition(entityType, fromStatus, toStatus);
    }

    if (toStatus === "committed") {
      if (!subscriptionContext?.kycApproved) throw new HttpError(422, "Cannot commit: KYC not approved");
      if (!subscriptionContext?.eligibilitySatisfied) throw new HttpError(422, "Cannot commit: eligibility not satisfied");
    }

    if (fromStatus === "payment_pending" && toStatus === "paid" && !subscriptionContext?.hasVerifiedReceipt) {
      throw new HttpError(422, "Cannot mark paid: verified receipt is required");
    }

    if (toStatus === "refunded") {
      if (!subscriptionContext?.hasReversalRecord) throw new HttpError(422, "Cannot refund: reversal record missing");
      if (!subscriptionContext?.approvalPolicySatisfied) {
        throw new HttpError(422, "Cannot refund: approval policy requirements not met");
      }
    }
    return;
  }

  if (entityType === "distribution") {
    const distributionContext = context as DistributionContext | undefined;
    if (!distributionTransitions[fromStatus as DistributionStatus]?.includes(toStatus as DistributionStatus)) {
      invalidTransition(entityType, fromStatus, toStatus);
    }

    if (fromStatus === "scheduled" && toStatus === "paid" && !distributionContext?.hasPayoutReceipts) {
      throw new HttpError(422, "Cannot mark distribution paid: payout receipts required");
    }

    if (fromStatus === "paid" && toStatus === "reversed" && !distributionContext?.trusteeProcessCompleted) {
      throw new HttpError(422, "Cannot reverse distribution: trustee process not completed");
    }
    return;
  }

  if (entityType === "milestone") {
    const milestoneContext = context as MilestoneContext | undefined;
    if (!milestoneTransitions[fromStatus as MilestoneStatus]?.includes(toStatus as MilestoneStatus)) {
      invalidTransition(entityType, fromStatus, toStatus);
    }

    if (fromStatus === "in_review" && toStatus === "verified" && !milestoneContext?.hasEvidence) {
      throw new HttpError(422, "Cannot verify milestone without evidence docs");
    }
    return;
  }

  if (entityType === "tranche") {
    const trancheContext = context as TrancheContext | undefined;
    if (!trancheTransitions[fromStatus as TrancheStatus]?.includes(toStatus as TrancheStatus)) {
      invalidTransition(entityType, fromStatus, toStatus);
    }

    if (fromStatus === "eligible" && toStatus === "released" && !trancheContext?.hasPayoutReceipts) {
      throw new HttpError(422, "Cannot release tranche without payout receipts");
    }

    if (fromStatus === "released" && toStatus === "reversed" && !trancheContext?.trusteeProcessCompleted) {
      throw new HttpError(422, "Cannot reverse tranche: trustee process not completed");
    }
    return;
  }

  throw new HttpError(500, `Unknown entity type: ${entityType}`);
}
