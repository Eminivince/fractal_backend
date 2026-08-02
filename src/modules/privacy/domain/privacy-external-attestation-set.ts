import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { stableJsonStringify } from "../../../utils/idempotency.js";
import {
  externalPrivacySourceKeys,
  type ExternalPrivacySourceKey,
  type PrivacyExternalAdapterPolicy,
} from "./privacy-external-adapter-policy.js";
import {
  EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
} from "./privacy-external-coverage.js";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const keyId = z.string().trim().regex(/^[A-Za-z0-9_-]{1,64}$/);
const boundedReference = z.string().trim().min(10).max(500);
const instant = z.string().datetime({ offset: true });
const coverageSchema = z.object({
  inventoryVersion: z.literal(EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION),
  componentKeys: z.array(
    z.string().regex(/^[a-z][a-z0-9_]{2,119}$/),
  ).min(1).max(32),
}).strict();

export const externalPrivacyAttestationEvidenceKeys = [
  "subjectCorrelation",
  "fieldMinimization",
  "access",
  "portability",
  "correction",
  "erasure",
  "restriction",
  "objection",
  "residency",
  "retention",
  "deletion",
  "security",
  "providerHealth",
] as const;

const evidenceSchema = z.object(Object.fromEntries(
  externalPrivacyAttestationEvidenceKeys.map((name) => [name, sha256]),
) as Record<typeof externalPrivacyAttestationEvidenceKeys[number], typeof sha256>).strict();

export const privacyExternalAttestationPayloadSchema = z.object({
  schemaVersion: z.enum([
    "privacy-external-source-attestation-payload-v1",
    "privacy-external-source-attestation-payload-v2",
  ]),
  attestationId: z.string().uuid(),
  sourceKey: z.enum(externalPrivacySourceKeys),
  policyBinding: z.object({
    configurationKey: z.literal("privacy.external_source.adapter_policy"),
    versionId: z.string().uuid(),
    versionNumber: z.number().int().positive(),
    projectionVersion: z.number().int().positive(),
    valueSha256: sha256,
  }).strict(),
  implementation: z.object({
    adapterKey: z.string().trim().regex(/^[a-z][a-z0-9._-]{4,159}$/),
    version: z.string().trim().regex(/^[1-9][0-9]*\.[0-9]+\.[0-9]+$/),
    sha256,
    releaseSha256: sha256,
  }).strict(),
  provider: z.object({
    environment: z.literal("production"),
    accountReference: boundedReference,
    regionReference: boundedReference,
  }).strict(),
  evidence: evidenceSchema,
  coverage: coverageSchema.optional(),
  observedAt: instant,
  validFrom: instant,
  expiresAt: instant,
  nonce: z.string().regex(/^[0-9a-f]{32,128}$/),
}).strict().superRefine((payload, context) => {
  const observedAt = Date.parse(payload.observedAt);
  const validFrom = Date.parse(payload.validFrom);
  const expiresAt = Date.parse(payload.expiresAt);
  if (observedAt > validFrom) {
    context.addIssue({ code: "custom", path: ["validFrom"], message: "Valid-from time cannot be before the observation time." });
  }
  if (validFrom >= expiresAt) {
    context.addIssue({ code: "custom", path: ["expiresAt"], message: "Expiry time must be after the valid-from time." });
  }
  if (
    payload.schemaVersion === "privacy-external-source-attestation-payload-v1"
    && payload.coverage
  ) {
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "A version 1 attestation cannot contain a version 2 coverage inventory.",
    });
  }
  if (
    payload.schemaVersion === "privacy-external-source-attestation-payload-v2"
    && !payload.coverage
  ) {
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "A version 2 attestation requires an exact coverage inventory.",
    });
  }
});

export const privacyExternalSignedAttestationSchema = z.object({
  payload: privacyExternalAttestationPayloadSchema,
  signature: z.object({
    algorithm: z.literal("Ed25519"),
    keyId,
    valueBase64: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/).min(80).max(128),
  }).strict(),
}).strict();

export const privacyExternalAttestationSetSchema = z.object({
  schemaVersion: z.enum([
    "privacy-external-source-attestation-set-v1",
    "privacy-external-source-attestation-set-v2",
  ]),
  setReference: z.string().trim().min(10).max(160),
  generatedAt: instant,
  attestations: z.array(privacyExternalSignedAttestationSchema).length(externalPrivacySourceKeys.length),
}).strict().superRefine((set, context) => {
  const sourceKeys = set.attestations.map((item) => item.payload.sourceKey);
  const attestationIds = set.attestations.map((item) => item.payload.attestationId);
  const nonces = set.attestations.map((item) => item.payload.nonce);
  if (new Set(sourceKeys).size !== sourceKeys.length) {
    context.addIssue({ code: "custom", path: ["attestations"], message: "Each external source must have one attestation." });
  }
  if (new Set(attestationIds).size !== attestationIds.length) {
    context.addIssue({ code: "custom", path: ["attestations"], message: "Attestation IDs must be unique." });
  }
  if (new Set(nonces).size !== nonces.length) {
    context.addIssue({ code: "custom", path: ["attestations"], message: "Attestation nonces must be unique." });
  }
  const missing = externalPrivacySourceKeys.filter((sourceKey) => !sourceKeys.includes(sourceKey));
  if (missing.length) {
    context.addIssue({ code: "custom", path: ["attestations"], message: `Attestations are missing for: ${missing.join(", ")}.` });
  }
  const expectedPayloadVersion = set.schemaVersion === "privacy-external-source-attestation-set-v2"
    ? "privacy-external-source-attestation-payload-v2"
    : "privacy-external-source-attestation-payload-v1";
  if (set.attestations.some((attestation) => (
    attestation.payload.schemaVersion !== expectedPayloadVersion
  ))) {
    context.addIssue({
      code: "custom",
      path: ["attestations"],
      message: "Every attestation payload version must match the attestation set version.",
    });
  }
});

export type PrivacyExternalAttestationPayload = z.infer<typeof privacyExternalAttestationPayloadSchema>;
export type PrivacyExternalSignedAttestation = z.infer<typeof privacyExternalSignedAttestationSchema>;
export type PrivacyExternalAttestationSet = z.infer<typeof privacyExternalAttestationSetSchema>;

export type ExternalPrivacyAttestationKey = {
  publicKeyPem: string;
  status: "active" | "revoked";
};

export type ExternalPrivacyAttestationKeyRing = Readonly<Record<string, ExternalPrivacyAttestationKey>>;

export type ExternalPrivacyAttestationRuntimeDescriptor = {
  sourceKey: ExternalPrivacySourceKey;
  adapterKey: string;
  version: string;
  sha256: string;
  releaseSha256: string;
  coverageInventoryVersion: typeof EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION;
  coverageComponentKeys: readonly string[];
};

export type ExternalPrivacyPolicyBinding = {
  configurationKey: "privacy.external_source.adapter_policy";
  versionId: string;
  versionNumber: number;
  projectionVersion: number;
  valueSha256: string;
};

export type ExternalPrivacyAttestationStatus =
  | "valid"
  | "policy_mismatch"
  | "runtime_missing"
  | "runtime_ambiguous"
  | "runtime_mismatch"
  | "policy_coverage_missing"
  | "coverage_mismatch"
  | "key_unknown"
  | "key_revoked"
  | "key_invalid"
  | "signature_invalid"
  | "not_yet_valid"
  | "expired"
  | "stale";

export function parsePrivacyExternalAttestationSet(value: unknown): PrivacyExternalAttestationSet {
  return privacyExternalAttestationSetSchema.parse(value);
}

export function validatePrivacyExternalAttestationSet(value: unknown): string[] {
  const result = privacyExternalAttestationSetSchema.safeParse(value);
  return result.success ? [] : result.error.issues.map((issue) => `${issue.path.join(".") || "attestationSet"}: ${issue.message}`);
}

export function parseExternalPrivacyAttestationKeyRing(value: string | undefined): {
  keyRing: ExternalPrivacyAttestationKeyRing;
  errors: string[];
} {
  if (!value) return { keyRing: {}, errors: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { keyRing: {}, errors: ["PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON must contain valid JSON."] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { keyRing: {}, errors: ["PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON must be an object."] };
  }
  const keyRing: Record<string, ExternalPrivacyAttestationKey> = {};
  const errors: string[] = [];
  for (const [candidateKeyId, candidate] of Object.entries(parsed)) {
    if (!keyId.safeParse(candidateKeyId).success) {
      errors.push(`Attestation key ID ${candidateKeyId} is invalid.`);
      continue;
    }
    const result = z.object({
      publicKeyPem: z.string().min(80).max(2_000),
      status: z.enum(["active", "revoked"]),
    }).strict().safeParse(candidate);
    if (!result.success) {
      errors.push(`Attestation key ${candidateKeyId} has an invalid record.`);
      continue;
    }
    try {
      const publicKey = createPublicKey(result.data.publicKeyPem);
      if (publicKey.asymmetricKeyType !== "ed25519") {
        errors.push(`Attestation key ${candidateKeyId} must be an Ed25519 public key.`);
        continue;
      }
    } catch {
      errors.push(`Attestation key ${candidateKeyId} is not a valid public key.`);
      continue;
    }
    keyRing[candidateKeyId] = result.data;
  }
  return { keyRing, errors };
}

function firstStatus(statuses: ExternalPrivacyAttestationStatus[]): ExternalPrivacyAttestationStatus {
  return statuses[0] ?? "valid";
}

export function evaluatePrivacyExternalAttestationSet(input: {
  value: unknown;
  policy: PrivacyExternalAdapterPolicy;
  policyBinding: ExternalPrivacyPolicyBinding;
  runtimeRegistry: readonly ExternalPrivacyAttestationRuntimeDescriptor[];
  applicationReleaseSha256?: string;
  keyRing: ExternalPrivacyAttestationKeyRing;
  keyRingErrors?: readonly string[];
  now?: Date;
}) {
  const parsed = privacyExternalAttestationSetSchema.safeParse(input.value);
  if (!parsed.success) {
    return {
      setReference: null,
      validSourceCount: 0,
      earliestExpiryAt: null,
      invalidSourceKeys: [...externalPrivacySourceKeys],
      sources: externalPrivacySourceKeys.map((sourceKey) => ({
        sourceKey,
        status: "signature_invalid" as const,
        failures: ["signature_invalid" as const],
        reason: "The attestation set does not satisfy its governed schema.",
      })),
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "attestationSet"}: ${issue.message}`),
    };
  }

  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const clockSkewMs = 5 * 60_000;
  const runtimeBySource = new Map<ExternalPrivacySourceKey, ExternalPrivacyAttestationRuntimeDescriptor[]>();
  for (const descriptor of input.runtimeRegistry) {
    const descriptors = runtimeBySource.get(descriptor.sourceKey) ?? [];
    descriptors.push(descriptor);
    runtimeBySource.set(descriptor.sourceKey, descriptors);
  }
  const policyBySource = new Map(input.policy.sources.map((source) => [source.sourceKey, source]));
  const errors = [...(input.keyRingErrors ?? [])];
  const sources = parsed.data.attestations.map((attestation) => {
    const payload = attestation.payload;
    const policySource = policyBySource.get(payload.sourceKey)!;
    const runtimes = runtimeBySource.get(payload.sourceKey) ?? [];
    const statuses: ExternalPrivacyAttestationStatus[] = [];
    let reason = "The signature and all exact bindings are valid.";
    const expectedCoverage = policySource.coverage;

    if (!expectedCoverage) {
      statuses.push("policy_coverage_missing");
      reason = "The active source policy does not contain the required component coverage inventory.";
    } else if (
      stableJsonStringify(payload.coverage)
      !== stableJsonStringify(expectedCoverage)
    ) {
      statuses.push("coverage_mismatch");
      reason = "The attestation does not bind the exact source component coverage.";
    }

    if ((input.keyRingErrors?.length ?? 0) > 0) {
      statuses.push("key_invalid");
      reason = "The configured attestation key set is invalid.";
    }

    if (stableJsonStringify(payload.policyBinding) !== stableJsonStringify(input.policyBinding)) {
      statuses.push("policy_mismatch");
      reason = "The attestation does not bind the active adapter policy.";
    }
    if (runtimes.length === 0) {
      statuses.push("runtime_missing");
      reason = "The source has no registered runtime implementation.";
    } else if (runtimes.length > 1) {
      statuses.push("runtime_ambiguous");
      reason = "The source has more than one registered runtime implementation.";
    } else {
      const runtime = runtimes[0]!;
      const implementationMatchesPolicy = payload.implementation.adapterKey === policySource.implementation.adapterKey
        && payload.implementation.version === policySource.implementation.version
        && payload.implementation.sha256 === policySource.implementation.sha256;
      const implementationMatchesRuntime = payload.implementation.adapterKey === runtime.adapterKey
        && payload.implementation.version === runtime.version
        && payload.implementation.sha256 === runtime.sha256
        && payload.implementation.releaseSha256 === runtime.releaseSha256
        && payload.implementation.releaseSha256 === input.applicationReleaseSha256;
      const runtimeCoverageMatches = Boolean(expectedCoverage)
        && runtime.coverageInventoryVersion === expectedCoverage?.inventoryVersion
        && stableJsonStringify(runtime.coverageComponentKeys)
          === stableJsonStringify(expectedCoverage?.componentKeys);
      if (!implementationMatchesPolicy || !implementationMatchesRuntime) {
        statuses.push("runtime_mismatch");
        reason = "The attestation does not bind the exact policy and runtime implementation.";
      } else if (!runtimeCoverageMatches) {
        statuses.push("coverage_mismatch");
        reason = "The runtime does not implement the exact source component coverage.";
      }
    }

    const key = input.keyRing[attestation.signature.keyId];
    if (!key) {
      statuses.push("key_unknown");
      reason = "The attestation signing key is not trusted.";
    } else if (key.status === "revoked") {
      statuses.push("key_revoked");
      reason = "The attestation signing key is revoked.";
    } else {
      try {
        const publicKey = createPublicKey(key.publicKeyPem);
        if (publicKey.asymmetricKeyType !== "ed25519") {
          statuses.push("key_invalid");
          reason = "The attestation signing key is not an Ed25519 public key.";
        } else if (!verify(
          null,
          Buffer.from(stableJsonStringify(payload), "utf8"),
          publicKey,
          Buffer.from(attestation.signature.valueBase64, "base64"),
        )) {
          statuses.push("signature_invalid");
          reason = "The attestation signature is invalid.";
        }
      } catch {
        statuses.push("key_invalid");
        reason = "The attestation signing key cannot be used.";
      }
    }

    const observedAt = Date.parse(payload.observedAt);
    const validFrom = Date.parse(payload.validFrom);
    const expiresAt = Date.parse(payload.expiresAt);
    if (validFrom > nowMs + clockSkewMs || observedAt > nowMs + clockSkewMs) {
      statuses.push("not_yet_valid");
      reason = "The attestation is not valid yet.";
    } else if (expiresAt <= nowMs) {
      statuses.push("expired");
      reason = "The attestation is expired.";
    } else if (nowMs - observedAt > policySource.execution.evidenceMaximumAgeSeconds * 1_000) {
      statuses.push("stale");
      reason = "The attestation evidence is older than the source policy allows.";
    }

    return {
      sourceKey: payload.sourceKey,
      status: firstStatus(statuses),
      failures: statuses.length ? [...new Set(statuses)] : ["valid" as const],
      reason,
      expiresAt: payload.expiresAt,
    };
  });
  const invalidSourceKeys = sources.filter((source) => source.status !== "valid").map((source) => source.sourceKey);
  const effectiveExpiryTimes = parsed.data.attestations.map((attestation) => {
    const maximumAgeMs = policyBySource.get(attestation.payload.sourceKey)!.execution.evidenceMaximumAgeSeconds * 1_000;
    return Math.min(
      Date.parse(attestation.payload.expiresAt),
      Date.parse(attestation.payload.observedAt) + maximumAgeMs,
    );
  });
  return {
    setReference: parsed.data.setReference,
    validSourceCount: sources.length - invalidSourceKeys.length,
    earliestExpiryAt: effectiveExpiryTimes.length
      ? new Date(Math.min(...effectiveExpiryTimes)).toISOString()
      : null,
    invalidSourceKeys,
    sources,
    errors,
  };
}
