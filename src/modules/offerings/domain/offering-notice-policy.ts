import { z } from "zod";

export const offeringNoticeCategories = ["material_event", "operational_update", "financial_report", "meeting_notice", "distribution_information"] as const;
export type OfferingNoticeCategory = typeof offeringNoticeCategories[number];

const rule = z.object({
  retentionDays: z.number().int().min(1).max(9_131),
  acknowledgmentRequired: z.boolean(),
  acknowledgmentWindowDays: z.number().int().min(1).max(365).nullable(),
}).strict().superRefine((value, context) => {
  if (value.acknowledgmentRequired !== (value.acknowledgmentWindowDays !== null)) context.addIssue({code:"custom",message:"acknowledgmentWindowDays must be set exactly when acknowledgmentRequired is true"});
});

const completeRules = z.object(Object.fromEntries(offeringNoticeCategories.map(category=>[category,rule])) as Record<OfferingNoticeCategory,typeof rule>).strict();
const policy = z.object({
  policyReference:z.string().trim().min(3).max(120),
  policyName:z.string().trim().min(3).max(160),
  schemaVersion:z.literal("offering-notice-policy-v1"),
  jurisdictions:z.record(z.string().regex(/^[A-Z]{2}$/),z.object({legalBasisReference:z.string().trim().min(10).max(500),rules:completeRules}).strict()).refine(value=>Object.keys(value).length>0,"At least one jurisdiction is required"),
}).strict();

export type OfferingNoticePolicy = z.infer<typeof policy>;
export function parseOfferingNoticePolicy(value:unknown){return policy.parse(value);}
export function validateOfferingNoticePolicy(value:unknown){const result=policy.safeParse(value);return result.success?[]:result.error.issues.map(issue=>`${issue.path.join(".")||"value"}: ${issue.message}`);}
