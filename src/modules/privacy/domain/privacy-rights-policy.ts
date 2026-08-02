import { z } from "zod";

const responseDays = z.number().int().min(1).max(365);

export const privacyRightsResponsePolicySchema = z.object({
  policyReference: z.string().trim().min(3).max(120),
  policyName: z.string().trim().min(10).max(160),
  jurisdiction: z.string().trim().min(2).max(120),
  controllerName: z.string().trim().min(3).max(200),
  identityAssurance: z.literal("authenticated_verified_email_session"),
  communicationChannel: z.literal("authenticated_register"),
  deadlineBasis: z.literal("calendar_days_from_authenticated_intake"),
  responseCalendarDays: z.object({
    access: responseDays,
    portability: responseDays,
    correction: responseDays,
    erasure: responseDays,
    restriction: responseDays,
    objection: responseDays,
  }).strict(),
}).strict();

export type PrivacyRightsResponsePolicy = z.infer<typeof privacyRightsResponsePolicySchema>;

export function parsePrivacyRightsResponsePolicy(value: unknown): PrivacyRightsResponsePolicy {
  return privacyRightsResponsePolicySchema.parse(value);
}

export function validatePrivacyRightsResponsePolicy(value: unknown): string[] {
  const result = privacyRightsResponsePolicySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`);
}
