import { z } from "zod";

export const distributionLifecycleRecordClasses = [
  "ownership_snapshot",
  "distribution_declaration",
  "payout_exception",
  "tax_remittance",
] as const;

export type DistributionLifecycleRecordClass = (typeof distributionLifecycleRecordClasses)[number];

const treatmentRule = z.object({
  retentionDays: z.number().int().min(1).max(9_131),
  correctionTreatment: z.literal("append_only_domain_correction"),
  erasureTreatment: z.literal("retain_then_review_for_minimization_or_disposition"),
  restrictionTreatment: z.literal("mandatory_processing_only"),
  objectionTreatment: z.literal("documented_lawful_basis_review"),
}).strict();

const completeRules = z.record(z.enum(distributionLifecycleRecordClasses), treatmentRule).refine(
  (value) => distributionLifecycleRecordClasses.every((recordClass) => recordClass in value),
  "Every distribution lifecycle record class requires a treatment rule.",
);

const jurisdictionPolicy = z.object({
  legalBasisReference: z.string().trim().min(10).max(500),
  rules: completeRules,
}).strict();

const policySchema = z.object({
  policyReference: z.string().trim().min(3).max(120),
  policyName: z.string().trim().min(10).max(160),
  schemaVersion: z.literal("distribution-lifecycle-policy-v1"),
  jurisdictions: z.record(z.string().regex(/^[A-Z]{2}$/), jurisdictionPolicy)
    .refine((value) => Object.keys(value).length >= 1, "At least one jurisdiction is required.")
    .refine((value) => Object.keys(value).length <= 50, "No more than 50 jurisdictions are allowed."),
}).strict();

export type DistributionLifecyclePolicy = z.infer<typeof policySchema>;

export function parseDistributionLifecyclePolicy(value: unknown): DistributionLifecyclePolicy {
  return policySchema.parse(value);
}

export function validateDistributionLifecyclePolicy(value: unknown): string[] {
  const result = policySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`);
}
