import { randomUUID } from "node:crypto";
import type { PrivacyExternalAdapterPolicy } from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import type {
  ExternalPrivacyPolicyBinding,
  PrivacyExternalAttestationSet,
} from "../modules/privacy/domain/privacy-external-attestation-set.js";
import { privacyAdapterDigest } from "./privacy-external-adapter-policy.fixture.js";

export function structurallyValidPrivacyExternalAttestationSet(
  policy: PrivacyExternalAdapterPolicy,
  policyBinding: ExternalPrivacyPolicyBinding,
): PrivacyExternalAttestationSet {
  const releaseSha256 = privacyAdapterDigest("unregistered-test-release");
  const evidence = {
    subjectCorrelation: privacyAdapterDigest("subject-correlation"),
    fieldMinimization: privacyAdapterDigest("field-minimization"),
    access: privacyAdapterDigest("access"),
    portability: privacyAdapterDigest("portability"),
    correction: privacyAdapterDigest("correction"),
    erasure: privacyAdapterDigest("erasure"),
    restriction: privacyAdapterDigest("restriction"),
    objection: privacyAdapterDigest("objection"),
    residency: privacyAdapterDigest("residency"),
    retention: privacyAdapterDigest("retention"),
    deletion: privacyAdapterDigest("deletion"),
    security: privacyAdapterDigest("security"),
    providerHealth: privacyAdapterDigest("provider-health"),
  };
  return {
    schemaVersion: "privacy-external-source-attestation-set-v2",
    setReference: "structurally-valid-untrusted-test-set",
    generatedAt: new Date().toISOString(),
    attestations: policy.sources.map((source, index) => ({
      payload: {
        schemaVersion: "privacy-external-source-attestation-payload-v2",
        attestationId: randomUUID(),
        sourceKey: source.sourceKey,
        policyBinding: { ...policyBinding },
        implementation: {
          adapterKey: source.implementation.adapterKey,
          version: source.implementation.version,
          sha256: source.implementation.sha256,
          releaseSha256,
        },
        provider: {
          environment: "production",
          accountReference: `untrusted-provider-account-${index}`,
          regionReference: "untrusted-provider-region-reference",
        },
        evidence,
        coverage: source.coverage!,
        observedAt: new Date(Date.now() - 60_000).toISOString(),
        validFrom: new Date(Date.now() - 30_000).toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
        nonce: index.toString(16).padStart(32, "0"),
      },
      signature: {
        algorithm: "Ed25519",
        keyId: "untrusted-test-probe",
        valueBase64: Buffer.alloc(64).toString("base64"),
      },
    })),
  };
}
