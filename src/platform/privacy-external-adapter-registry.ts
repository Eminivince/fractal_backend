import { env } from "../config/env.js";
import type {
  ExternalPrivacySourceKey,
  PrivacyExternalAdapterPolicy,
} from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import type { ExternalPrivacyAttestationRuntimeDescriptor } from "../modules/privacy/domain/privacy-external-attestation-set.js";
import {
  CHAIN_PRIVACY_ADAPTER_KEY,
  CHAIN_PRIVACY_ADAPTER_VERSION,
} from "../services/privacy-external-chain-adapter.js";
import {
  RESEND_PRIVACY_ADAPTER_KEY,
  RESEND_PRIVACY_ADAPTER_VERSION,
} from "../services/privacy-external-resend-adapter.js";
import {
  SUMSUB_PRIVACY_ADAPTER_KEY,
  SUMSUB_PRIVACY_ADAPTER_VERSION,
} from "../services/privacy-external-sumsub-adapter.js";
import {
  EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
  requiredExternalPrivacyCoverage,
} from "../modules/privacy/domain/privacy-external-coverage.js";
import { stableJsonStringify } from "../utils/idempotency.js";

export type ExternalPrivacyAdapterRuntimeDescriptor = ExternalPrivacyAttestationRuntimeDescriptor;

/**
 * A deployment must supply exact artifact and release hashes. Source code alone
 * does not make the adapter available.
 */
export const externalPrivacyAdapterRuntimeRegistry: readonly ExternalPrivacyAdapterRuntimeDescriptor[] = [
  ...(env.PRIVACY_CHAIN_ADAPTER_SHA256 && env.APPLICATION_RELEASE_SHA256
    ? [{
        sourceKey: "external.chain.public_records" as const,
        adapterKey: CHAIN_PRIVACY_ADAPTER_KEY,
        version: CHAIN_PRIVACY_ADAPTER_VERSION,
        sha256: env.PRIVACY_CHAIN_ADAPTER_SHA256,
        releaseSha256: env.APPLICATION_RELEASE_SHA256,
        coverageInventoryVersion: EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
        coverageComponentKeys: requiredExternalPrivacyCoverage(
          "external.chain.public_records",
        ).componentKeys,
      }]
    : []),
  ...(env.PRIVACY_RESEND_ADAPTER_SHA256 && env.APPLICATION_RELEASE_SHA256
    ? [{
        sourceKey: "external.resend.delivery" as const,
        adapterKey: RESEND_PRIVACY_ADAPTER_KEY,
        version: RESEND_PRIVACY_ADAPTER_VERSION,
        sha256: env.PRIVACY_RESEND_ADAPTER_SHA256,
        releaseSha256: env.APPLICATION_RELEASE_SHA256,
        coverageInventoryVersion: EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
        coverageComponentKeys: requiredExternalPrivacyCoverage(
          "external.resend.delivery",
        ).componentKeys,
      }]
    : []),
  ...(env.PRIVACY_SUMSUB_ADAPTER_SHA256 && env.APPLICATION_RELEASE_SHA256
    ? [{
        sourceKey: "external.identity_verification.provider" as const,
        adapterKey: SUMSUB_PRIVACY_ADAPTER_KEY,
        version: SUMSUB_PRIVACY_ADAPTER_VERSION,
        sha256: env.PRIVACY_SUMSUB_ADAPTER_SHA256,
        releaseSha256: env.APPLICATION_RELEASE_SHA256,
        coverageInventoryVersion: EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
        coverageComponentKeys: requiredExternalPrivacyCoverage(
          "external.identity_verification.provider",
        ).componentKeys,
      }]
    : []),
];

export function evaluateExternalPrivacyAdapterRuntime(
  policy: PrivacyExternalAdapterPolicy,
  registry: readonly ExternalPrivacyAdapterRuntimeDescriptor[] = externalPrivacyAdapterRuntimeRegistry,
) {
  const runtimeBySource = new Map<ExternalPrivacySourceKey, ExternalPrivacyAdapterRuntimeDescriptor[]>();
  for (const descriptor of registry) {
    const descriptors = runtimeBySource.get(descriptor.sourceKey) ?? [];
    descriptors.push(descriptor);
    runtimeBySource.set(descriptor.sourceKey, descriptors);
  }
  const sources = policy.sources.map((source) => {
    if (!source.coverage) {
      return {
        sourceKey: source.sourceKey,
        status: "policy_coverage_missing" as const,
      };
    }
    const runtimes = runtimeBySource.get(source.sourceKey) ?? [];
    if (!runtimes.length) return { sourceKey: source.sourceKey, status: "runtime_missing" as const };
    if (runtimes.length > 1) return { sourceKey: source.sourceKey, status: "runtime_ambiguous" as const };
    const runtime = runtimes[0]!;
    const compatible = runtime.adapterKey === source.implementation.adapterKey
      && runtime.version === source.implementation.version
      && runtime.sha256 === source.implementation.sha256;
    if (!compatible) {
      return {
        sourceKey: source.sourceKey,
        status: "runtime_mismatch" as const,
      };
    }
    const coverageCompatible =
      runtime.coverageInventoryVersion === source.coverage.inventoryVersion
      && stableJsonStringify(runtime.coverageComponentKeys)
        === stableJsonStringify(source.coverage.componentKeys);
    return {
      sourceKey: source.sourceKey,
      status: coverageCompatible
        ? "runtime_compatible" as const
        : "runtime_coverage_mismatch" as const,
    };
  });
  return {
    contractSourceCount: policy.sources.length,
    runtimeCompatibleSourceCount: sources.filter((source) => source.status === "runtime_compatible").length,
    missingRuntimeSourceKeys: sources.filter((source) => source.status === "runtime_missing").map((source) => source.sourceKey),
    mismatchedRuntimeSourceKeys: sources.filter((source) => source.status === "runtime_mismatch").map((source) => source.sourceKey),
    coverageMissingSourceKeys: sources.filter((source) => source.status === "policy_coverage_missing").map((source) => source.sourceKey),
    coverageMismatchedRuntimeSourceKeys: sources.filter((source) => source.status === "runtime_coverage_mismatch").map((source) => source.sourceKey),
    duplicateRuntimeSourceKeys: sources.filter((source) => source.status === "runtime_ambiguous").map((source) => source.sourceKey),
    sources,
  };
}
