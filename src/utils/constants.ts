export const roles = [
  "admin",
  "operator",
  "issuer",
  "investor",
  "professional",
] as const;
export type Role = (typeof roles)[number];

// A-07: Admin sub-roles for granular permission control
export const adminSubRoles = ["super_admin", "compliance", "ops", "finance"] as const;
export type AdminSubRole = (typeof adminSubRoles)[number];

// A-19: Business suspension reasons
export const suspensionReasons = [
  "aml_concern",
  "kyb_lapse",
  "regulatory_breach",
  "fraudulent_activity",
  "court_order",
  "voluntary_suspension",
  "non_payment",
  "other",
] as const;
export type SuspensionReason = (typeof suspensionReasons)[number];

// A-46: Professional suspension reasons
export const professionalSuspensionReasons = [
  "license_expired",
  "coi_violation",
  "quality_failure",
  "regulatory_sanction",
  "misconduct",
  "voluntary_withdrawal",
  "other",
] as const;
export type ProfessionalSuspensionReason = (typeof professionalSuspensionReasons)[number];

// A-25: Application rejection reason codes
export const rejectionReasonCodes = [
  "insufficient_documentation",
  "valuation_not_supported",
  "legal_structure_issue",
  "regulatory_concern",
  "financial_viability",
  "kyb_not_approved",
  "stage_gate_incomplete",
  "other",
] as const;
export type RejectionReasonCode = (typeof rejectionReasonCodes)[number];

export const professionalOnboardingStatuses = [
  "draft",
  "submitted",
  "in_review",
  "approved",
  "rejected",
] as const;
export type ProfessionalOnboardingStatus =
  (typeof professionalOnboardingStatuses)[number];

export const workOrderStatuses = [
  "assigned",
  "accepted",
  "declined",
  "in_progress",
  "needs_info",
  "submitted",
  "under_review",
  "completed",
  "cancelled",
  "withdrawn",
  // PR-03: COI conflict flag status
  "conflict_flagged",
] as const;
export type WorkOrderStatus = (typeof workOrderStatuses)[number];

export const riskFlagTaxonomy = [
  "title_encumbrance",
  "missing_permit",
  "related_party",
  "overvaluation",
  "sanctions_hit",
  "insurance_gap",
  "structural_defect",
  "legal_dispute",
  "incomplete_docs",
  "other",
] as const;
export type RiskFlagType = (typeof riskFlagTaxonomy)[number];

export const applicationStatuses = [
  "draft",
  "submitted",
  "in_review",
  "needs_info",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type ApplicationStatus = (typeof applicationStatuses)[number];

export const offeringStatuses = [
  "draft",
  "pending_review",
  "needs_revision",
  "open",
  "paused",
  "closed",
  "servicing",
  "exited",
  "cancelled",
] as const;
export type OfferingStatus = (typeof offeringStatuses)[number];

export const subscriptionStatuses = [
  "draft",
  "committed",
  "payment_pending",
  "paid",
  "allocation_confirmed",
  "cancelled",
  "refunded",
] as const;
export type SubscriptionStatus = (typeof subscriptionStatuses)[number];

export const distributionStatuses = [
  "draft",
  "pending_approval",
  "approved",
  "scheduled",
  "paid",
  "failed",
  "reversed",
] as const;
export type DistributionStatus = (typeof distributionStatuses)[number];

export const milestoneStatuses = [
  "not_started",
  "evidence_submitted",
  "in_review",
  "verified",
  "rejected",
] as const;
export type MilestoneStatus = (typeof milestoneStatuses)[number];

export const trancheStatuses = ["locked", "eligible", "released", "failed", "reversed"] as const;
export type TrancheStatus = (typeof trancheStatuses)[number];

export const stages = [
  "Intake",
  "Diligence",
  "Structuring",
  "Compliance",
  "Issuance",
  "Servicing",
  "Exit",
] as const;
export type Stage = (typeof stages)[number];

export const entityTypes = [
  "application",
  "offering",
  "subscription",
  "distribution",
  "milestone",
  "tranche",
  "anchor",
  "ledger_entry",
  "escrow_receipt",
  "reconciliation_run",
  "business",
  "user",
  "platform_config",
  "template",
  "task",
  "work_order",
  "dispute",
] as const;
export type EntityType = (typeof entityTypes)[number];
