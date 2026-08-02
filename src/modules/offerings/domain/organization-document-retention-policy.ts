import { z } from "zod";

export const organizationDocumentCategories = [
  "corporate",
  "finance",
  "operations",
  "compliance",
  "governance",
  "other",
] as const;

export const organizationDocumentRetentionBases = [
  "legal_requirement",
  "contractual_record",
  "corporate_record",
  "operational_record",
] as const;

const retentionRule = z.object({ retentionDays: z.number().int().min(1).max(9_131) }).strict();
const basisRules = z
  .record(z.enum(organizationDocumentRetentionBases), retentionRule)
  .refine(
    (value) => organizationDocumentRetentionBases.every((basis) => basis in value),
    "Every retention basis requires a rule.",
  );
const categoryRules = z
  .record(z.enum(organizationDocumentCategories), basisRules)
  .refine(
    (value) => organizationDocumentCategories.every((category) => category in value),
    "Every document category requires retention rules.",
  );

const jurisdictionPolicy = z
  .object({
    legalBasisReference: z.string().trim().min(10).max(500),
    rules: categoryRules,
  })
  .strict();

const policySchema = z
  .object({
    policyReference: z.string().trim().min(3).max(120),
    policyName: z.string().trim().min(10).max(160),
    schemaVersion: z.literal("organization-document-retention-v1"),
    jurisdictions: z
      .record(z.string().regex(/^[A-Z]{2}$/), jurisdictionPolicy)
      .refine((value) => Object.keys(value).length >= 1, "At least one jurisdiction is required.")
      .refine((value) => Object.keys(value).length <= 50, "No more than 50 jurisdictions are allowed."),
  })
  .strict();

export type OrganizationDocumentRetentionPolicy = z.infer<typeof policySchema>;
export type OrganizationDocumentCategory = (typeof organizationDocumentCategories)[number];
export type OrganizationDocumentRetentionBasis = (typeof organizationDocumentRetentionBases)[number];

export function validateOrganizationDocumentRetentionPolicy(value: unknown): string[] {
  const result = policySchema.safeParse(value);
  return result.success
    ? []
    : result.error.issues.map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`);
}

export function parseOrganizationDocumentRetentionPolicy(value: unknown): OrganizationDocumentRetentionPolicy {
  return policySchema.parse(value);
}
