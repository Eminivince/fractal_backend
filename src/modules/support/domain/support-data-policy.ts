import { z } from "zod";

export const supportAttachmentClassifications = [
  "general",
  "personal_data",
  "financial_record",
  "identity_document",
  "security_sensitive",
] as const;

export type SupportAttachmentClassification =
  (typeof supportAttachmentClassifications)[number];

const policySchema = z
  .object({
    policyReference: z.string().trim().min(3).max(120),
    policyName: z.string().trim().min(10).max(160),
    maximumBytes: z
      .number()
      .int()
      .min(1)
      .max(15 * 1024 * 1024),
    allowedMimeTypes: z
      .array(
        z.enum([
          "application/pdf",
          "image/jpeg",
          "image/png",
          "image/webp",
          "image/tiff",
          "application/msword",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ]),
      )
      .min(1)
      .max(10)
      .refine(
        (values) => new Set(values).size === values.length,
        "MIME types must be unique.",
      ),
    classifications: z
      .record(
        z.enum(supportAttachmentClassifications),
        z
          .object({ retentionDays: z.number().int().min(1).max(3_650) })
          .strict(),
      )
      .refine(
        (value) =>
          supportAttachmentClassifications.every((key) => key in value),
        "Every classification requires a retention rule.",
      ),
  })
  .strict();

export type SupportCaseDataPolicy = z.infer<typeof policySchema>;

export function validateSupportCaseDataPolicy(value: unknown): string[] {
  const parsed = policySchema.safeParse(value);
  return parsed.success
    ? []
    : parsed.error.issues.map(
        (issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`,
      );
}

export function parseSupportCaseDataPolicy(
  value: unknown,
): SupportCaseDataPolicy {
  return policySchema.parse(value);
}
