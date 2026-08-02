import { z } from "zod";
import type { SupportCaseCategory, SupportCaseImpact } from "../../../platform/postgres-support-cases.js";

const targetSchema = z.object({
  priority: z.enum(["p1", "p2", "p3", "p4"]),
  acknowledgementMinutes: z.number().int().min(5).max(10_080),
  resolutionMinutes: z.number().int().min(15).max(43_200),
  escalationMinutesBeforeResolution: z.number().int().min(5).max(10_080),
}).strict().superRefine((target, context) => {
  if (target.escalationMinutesBeforeResolution >= target.resolutionMinutes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["escalationMinutesBeforeResolution"],
      message: "Escalation lead time must be shorter than the resolution target.",
    });
  }
});

const categorySchema = z.enum([
  "account_access", "identity_verification", "investment_record", "payment_status", "organization",
  "professional_work", "security_concern", "privacy_request", "formal_complaint", "other",
]);
const impactSchema = z.enum(["question", "blocked", "financial_or_legal_risk", "security_or_privacy_concern"]);

export const supportCaseServicePolicySchema = z.object({
  policyReference: z.string().trim().min(3).max(120),
  policyName: z.string().trim().min(10).max(160),
  impactTargets: z.object({
    question: targetSchema,
    blocked: targetSchema,
    financial_or_legal_risk: targetSchema,
    security_or_privacy_concern: targetSchema,
  }).strict(),
  categoryOverrides: z.array(z.object({
    category: categorySchema,
    reportedImpact: impactSchema,
    target: targetSchema,
  }).strict()).max(40).default([]),
}).strict().superRefine((policy, context) => {
  const seen = new Set<string>();
  policy.categoryOverrides.forEach((override, index) => {
    const key = `${override.category}:${override.reportedImpact}`;
    if (seen.has(key)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["categoryOverrides", index], message: "Category and impact overrides must be unique." });
    }
    seen.add(key);
  });
});

export type SupportCaseServicePolicy = z.infer<typeof supportCaseServicePolicySchema>;
export type SupportCaseServiceTarget = z.infer<typeof targetSchema>;

export function parseSupportCaseServicePolicy(value: unknown): SupportCaseServicePolicy {
  return supportCaseServicePolicySchema.parse(value);
}

export function validateSupportCaseServicePolicy(value: unknown): string[] {
  const result = supportCaseServicePolicySchema.safeParse(value);
  if (result.success) return [];
  return result.error.issues.map((issue) => `${issue.path.join(".") || "value"}: ${issue.message}`);
}

export function targetForSupportCase(
  policy: SupportCaseServicePolicy,
  category: SupportCaseCategory,
  reportedImpact: SupportCaseImpact,
): SupportCaseServiceTarget {
  return policy.categoryOverrides.find((override) => override.category === category && override.reportedImpact === reportedImpact)?.target
    ?? policy.impactTargets[reportedImpact];
}
