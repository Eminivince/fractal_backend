import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import {
  evaluatePrivacyExternalAttestationSet,
  parseExternalPrivacyAttestationKeyRing,
  type ExternalPrivacyAttestationKeyRing,
  type ExternalPrivacyAttestationRuntimeDescriptor,
} from "../modules/privacy/domain/privacy-external-attestation-set.js";
import type { PrivacyExternalAdapterPolicy } from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import type { ActivePlatformConfigurationBinding } from "./postgres-platform-configuration.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import { externalPrivacyAdapterRuntimeRegistry } from "./privacy-external-adapter-registry.js";

export const EXTERNAL_PRIVACY_ATTESTATION_SET_KEY = "privacy.external_source.attestation_set";

export async function readActiveExternalPrivacyAttestationReadiness(
  client: PoolClient,
  input: {
    policy: PrivacyExternalAdapterPolicy;
    policyBinding: ActivePlatformConfigurationBinding;
    runtimeRegistry?: readonly ExternalPrivacyAttestationRuntimeDescriptor[];
    applicationReleaseSha256?: string;
    keyRing?: ExternalPrivacyAttestationKeyRing;
    keyRingErrors?: readonly string[];
    now?: Date;
  },
) {
  const binding = await readActivePlatformConfigurationForBinding(client, EXTERNAL_PRIVACY_ATTESTATION_SET_KEY);
  if (!binding) {
    return {
      status: "not_activated" as const,
      versionId: null,
      versionNumber: null,
      projectionVersion: null,
      valueSha256: null,
      setReference: null,
      validSourceCount: 0,
      invalidSourceKeys: [] as string[],
      earliestExpiryAt: null,
      configurationErrorCount: 0,
      sources: [] as Array<{ sourceKey: string; status: string; failures: string[]; reason: string; expiresAt?: string }>,
      blocksAvailability: true,
    };
  }
  const parsedKeyRing = input.keyRing
    ? { keyRing: input.keyRing, errors: [...(input.keyRingErrors ?? [])] }
    : parseExternalPrivacyAttestationKeyRing(env.PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON);
  const evaluation = evaluatePrivacyExternalAttestationSet({
    value: binding.value,
    policy: input.policy,
    policyBinding: {
      configurationKey: "privacy.external_source.adapter_policy",
      versionId: input.policyBinding.versionId,
      versionNumber: input.policyBinding.versionNumber,
      projectionVersion: input.policyBinding.projectionVersion,
      valueSha256: input.policyBinding.valueSha256,
    },
    runtimeRegistry: input.runtimeRegistry ?? externalPrivacyAdapterRuntimeRegistry,
    applicationReleaseSha256: input.applicationReleaseSha256 ?? env.APPLICATION_RELEASE_SHA256,
    keyRing: parsedKeyRing.keyRing,
    keyRingErrors: parsedKeyRing.errors,
    now: input.now,
  });
  const expectedCount = input.policy.sources.length;
  const status = evaluation.validSourceCount === expectedCount
    ? "active_valid" as const
    : evaluation.validSourceCount > 0
      ? "active_partially_valid" as const
      : "active_invalid" as const;
  return {
    status,
    versionId: binding.versionId,
    versionNumber: binding.versionNumber,
    projectionVersion: binding.projectionVersion,
    valueSha256: binding.valueSha256,
    setReference: evaluation.setReference,
    validSourceCount: evaluation.validSourceCount,
    invalidSourceKeys: evaluation.invalidSourceKeys,
    earliestExpiryAt: evaluation.earliestExpiryAt,
    configurationErrorCount: evaluation.errors.length,
    sources: evaluation.sources,
    blocksAvailability: true,
  };
}
