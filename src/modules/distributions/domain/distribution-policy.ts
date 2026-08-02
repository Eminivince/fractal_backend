import { z } from "zod";

const currencyRule = z.object({
  minimumConfirmations: z.number().int().min(1).max(10_000),
  maximumDeclarationMinor: z.string().regex(/^[1-9][0-9]{0,18}$/),
  maximumWithholdingTaxBps: z.number().int().min(0).max(10_000),
  retentionDays: z.number().int().min(1).max(9_131),
}).strict();

const jurisdictionRule = z.object({
  legalBasisReference: z.string().trim().min(3).max(300),
  currencies: z.record(z.string().regex(/^[A-Z]{3}$/), currencyRule),
}).strict();

const policy = z.object({
  policyReference: z.string().trim().min(3).max(120),
  policyName: z.string().trim().min(3).max(160),
  schemaVersion: z.literal("distribution-policy-v1"),
  jurisdictions: z.record(z.string().regex(/^[A-Z]{2}$/), jurisdictionRule),
}).strict().superRefine((value, context) => {
  if (Object.keys(value.jurisdictions).length === 0) context.addIssue({ code: "custom", path: ["jurisdictions"], message: "At least one jurisdiction is required" });
  for (const [jurisdiction, rule] of Object.entries(value.jurisdictions)) {
    if (Object.keys(rule.currencies).length === 0) context.addIssue({ code: "custom", path: ["jurisdictions", jurisdiction, "currencies"], message: "At least one currency is required" });
  }
});

export type DistributionPolicy = z.infer<typeof policy>;
export function parseDistributionPolicy(value: unknown) { return policy.parse(value); }
export function validateDistributionPolicy(value: unknown) {
  const result = policy.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`);
}
