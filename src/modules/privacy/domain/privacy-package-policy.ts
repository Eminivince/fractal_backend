import { z } from "zod";
import {
  PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
  PRIVACY_PACKAGE_JSON_FORMAT_V1,
} from "./privacy-package-archive.js";

export const privacyPackagePolicySchema = z.object({
  schemaVersion: z.literal("privacy-package-policy-v2").optional(),
  policyReference: z.string().trim().min(3).max(120),
  policyName: z.string().trim().min(10).max(160),
  canonicalFormat: z.enum([
    PRIVACY_PACKAGE_JSON_FORMAT_V1,
    PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
  ]),
  identityAssurance: z.literal("authenticated_verified_email_session"),
  deliveryChannel: z.literal("authenticated_register"),
  allowInternalIncompletePreparation: z.boolean(),
  maximumRecords: z.number().int().min(1).max(100_000),
  maximumBytes: z.number().int().min(1_024).max(100 * 1024 * 1024),
  maximumArtifacts: z.number().int().min(0).max(1_000).optional(),
  packageRetentionHours: z.number().int().min(1).max(720),
  requesterRetrievalHours: z.number().int().min(1).max(168),
}).strict().superRefine((policy, context) => {
  if (policy.requesterRetrievalHours > policy.packageRetentionHours) {
    context.addIssue({ code: "custom", path: ["requesterRetrievalHours"], message: "Requester retrieval cannot outlive package retention." });
  }
  const isArchive = policy.canonicalFormat === PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2;
  if (isArchive && (
    policy.schemaVersion !== "privacy-package-policy-v2"
    || policy.maximumArtifacts === undefined
  )) {
    context.addIssue({
      code: "custom",
      path: ["canonicalFormat"],
      message: "Archive packages require policy version 2 and an artifact limit.",
    });
  }
  if (!isArchive && (
    policy.schemaVersion !== undefined
    || policy.maximumArtifacts !== undefined
  )) {
    context.addIssue({
      code: "custom",
      path: ["canonicalFormat"],
      message: "JSON package policy version 1 cannot contain archive policy fields.",
    });
  }
});

export type PrivacyPackagePolicy = z.infer<typeof privacyPackagePolicySchema>;

export function parsePrivacyPackagePolicy(value: unknown): PrivacyPackagePolicy {
  return privacyPackagePolicySchema.parse(value);
}

export function validatePrivacyPackagePolicy(value: unknown): string[] {
  const result = privacyPackagePolicySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`);
}
