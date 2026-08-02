import { z } from "zod";
import {
  EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
  externalPrivacyRequiredCoverage,
} from "./privacy-external-coverage.js";

export const externalPrivacySourceKeys = [
  "external.chain.public_records",
  "external.edge.access_logs",
  "external.identity_verification.provider",
  "external.malware_scan.provider",
  "external.mongo.legacy_identity_projection",
  "external.object_store.managed",
  "external.payment.provider",
  "external.postgres.backups",
  "external.redis.operational_cache",
  "external.resend.delivery",
  "external.telemetry.logs",
] as const;

export type ExternalPrivacySourceKey = typeof externalPrivacySourceKeys[number];

const sourceKeySchema = z.enum(externalPrivacySourceKeys);
const boundedReference = z.string().trim().min(10).max(500);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const coverageSchema = z.object({
  inventoryVersion: z.literal(EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION),
  componentKeys: z.array(
    z.string().regex(/^[a-z][a-z0-9_]{2,119}$/),
  ).min(1).max(32),
}).strict();

const rightOperation = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("collect"), operationReference: boundedReference }).strict(),
  z.object({ mode: z.literal("provider_action"), operationReference: boundedReference }).strict(),
  z.object({ mode: z.literal("immutable_disclosure"), legalReason: boundedReference }).strict(),
  z.object({ mode: z.literal("not_applicable"), legalReason: boundedReference }).strict(),
]);

const safeField = z.object({
  sourceField: z.string().trim().min(1).max(160),
  outputField: z.string().trim().min(1).max(160).nullable(),
  classification: z.enum(["personal_metadata", "business_record", "public_record", "technical_metadata", "secret_or_internal"]),
  handling: z.enum(["include", "redact", "omit"]),
  reason: boundedReference,
}).strict().superRefine((field, context) => {
  if ((field.handling === "include") !== (field.outputField !== null)) {
    context.addIssue({ code: "custom", path: ["outputField"], message: "Only included fields may have an output field." });
  }
  if (field.handling === "include" && field.classification === "secret_or_internal") {
    context.addIssue({ code: "custom", path: ["classification"], message: "Secret or internal fields cannot be included." });
  }
});

const sourcePolicy = z.object({
  sourceKey: sourceKeySchema,
  implementation: z.object({
    adapterKey: z.string().trim().regex(/^[a-z][a-z0-9._-]{4,159}$/),
    version: z.string().trim().regex(/^[1-9][0-9]*\.[0-9]+\.[0-9]+$/),
    sha256,
    releaseBinding: z.literal("exact_release_sha256"),
  }).strict(),
  collectionMode: z.enum(["live_api", "provider_export", "managed_inventory", "public_immutable_disclosure", "expiry_attestation"]),
  correlation: z.object({
    mode: z.enum(["exact_provider_reference", "exact_identity_reference", "exact_wallet_binding", "exact_object_ownership", "bounded_log_correlation", "expiry_only"]),
    referenceFields: z.array(z.string().trim().min(1).max(120)).min(1).max(12),
    maximumSubjectsPerRecord: z.number().int().min(1).max(25),
    ambiguityBehavior: z.literal("reject"),
    unmatchedBehavior: z.literal("remain_unlinked"),
  }).strict(),
  rights: z.object({
    access: rightOperation,
    portability: rightOperation,
    correction: rightOperation,
    erasure: rightOperation,
    restriction: rightOperation,
    objection: rightOperation,
  }).strict(),
  fields: z.array(safeField).min(1).max(100),
  execution: z.object({
    timeoutMs: z.number().int().min(500).max(120_000),
    maximumRecords: z.number().int().min(1).max(100_000),
    maximumBytes: z.number().int().min(1_024).max(100 * 1024 * 1024),
    evidenceMaximumAgeSeconds: z.number().int().min(30).max(604_800),
    deterministicOrdering: z.literal(true),
    failClosed: z.literal(true),
    retryPolicy: z.literal("bounded_no_automatic_rights_side_effect"),
    requiresProductionAttestation: z.literal(true),
  }).strict(),
  governance: z.object({
    processorAgreementReference: boundedReference,
    lawfulBasisReference: boundedReference,
    retentionPolicyReference: boundedReference,
    subprocessorInventoryReference: boundedReference,
    securityControlReference: boundedReference,
    deletionSemantics: boundedReference,
    residencyRegions: z.array(z.string().trim().regex(/^[A-Z0-9-]{2,32}$/)).min(1).max(20),
  }).strict(),
  coverage: coverageSchema.optional(),
}).strict().superRefine((source, context) => {
  if (!new Set(source.correlation.referenceFields).size || new Set(source.correlation.referenceFields).size !== source.correlation.referenceFields.length) {
    context.addIssue({ code: "custom", path: ["correlation", "referenceFields"], message: "Correlation reference fields must be unique." });
  }
  if (new Set(source.governance.residencyRegions).size !== source.governance.residencyRegions.length) {
    context.addIssue({ code: "custom", path: ["governance", "residencyRegions"], message: "Residency regions must be unique." });
  }
  const includedFields = source.fields.filter((field) => field.handling === "include");
  if (source.rights.access.mode === "collect" && includedFields.length === 0) {
    context.addIssue({ code: "custom", path: ["fields"], message: "An access collector must include at least one safe field." });
  }
  const outputFields = includedFields.map((field) => field.outputField);
  if (new Set(outputFields).size !== outputFields.length) {
    context.addIssue({ code: "custom", path: ["fields"], message: "Included output fields must be unique." });
  }
  const sourceFields = source.fields.map((field) => field.sourceField);
  if (new Set(sourceFields).size !== sourceFields.length) {
    context.addIssue({ code: "custom", path: ["fields"], message: "Source fields must be classified exactly once." });
  }
  if (source.rights.access.mode === "not_applicable") {
    context.addIssue({ code: "custom", path: ["rights", "access"], message: "Every declared personal-data source requires access collection or an immutable-record disclosure." });
  }
  if (source.collectionMode === "public_immutable_disclosure" && source.rights.access.mode !== "immutable_disclosure") {
    context.addIssue({ code: "custom", path: ["rights", "access"], message: "Public immutable sources require an immutable access disclosure." });
  }
});

export const privacyExternalAdapterPolicySchema = z.object({
  schemaVersion: z.enum([
    "privacy-external-source-adapter-policy-v1",
    "privacy-external-source-adapter-policy-v2",
  ]),
  policyReference: z.string().trim().min(3).max(120),
  policyName: z.string().trim().min(10).max(160),
  jurisdictionCode: z.string().trim().regex(/^[A-Z0-9-]{2,16}$/),
  controllerReference: boundedReference,
  sources: z.array(sourcePolicy).length(externalPrivacySourceKeys.length),
}).strict().superRefine((policy, context) => {
  const actual = policy.sources.map((source) => source.sourceKey);
  if (new Set(actual).size !== actual.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: "External source policies must be unique." });
  }
  const expected = new Set<string>(externalPrivacySourceKeys);
  const missing = externalPrivacySourceKeys.filter((sourceKey) => !actual.includes(sourceKey));
  const unknown = actual.filter((sourceKey) => !expected.has(sourceKey));
  if (missing.length || unknown.length) {
    context.addIssue({ code: "custom", path: ["sources"], message: `External source policy must cover the exact inventory; missing=${missing.join(",") || "none"}; unknown=${unknown.join(",") || "none"}.` });
  }
  for (const [index, source] of policy.sources.entries()) {
    if (policy.schemaVersion === "privacy-external-source-adapter-policy-v1") {
      if (source.coverage) {
        context.addIssue({
          code: "custom",
          path: ["sources", index, "coverage"],
          message: "A version 1 source policy cannot contain a version 2 coverage inventory.",
        });
      }
      continue;
    }
    const required = externalPrivacyRequiredCoverage[source.sourceKey];
    if (
      !source.coverage
      || source.coverage.inventoryVersion !== EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION
      || source.coverage.componentKeys.length !== required.length
      || source.coverage.componentKeys.some((component, componentIndex) => (
        component !== required[componentIndex]
      ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["sources", index, "coverage"],
        message: `Coverage must use the exact ${EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION} component order for ${source.sourceKey}.`,
      });
    }
  }
});

export type PrivacyExternalAdapterPolicy = z.infer<typeof privacyExternalAdapterPolicySchema>;

export function parsePrivacyExternalAdapterPolicy(value: unknown): PrivacyExternalAdapterPolicy {
  return privacyExternalAdapterPolicySchema.parse(value);
}

export function validatePrivacyExternalAdapterPolicy(value: unknown): string[] {
  const result = privacyExternalAdapterPolicySchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "policy"}: ${issue.message}`);
}
