import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { stableJsonStringify } from "../../../../utils/idempotency.js";
import {
  evaluatePrivacyExternalAttestationSet,
  parseExternalPrivacyAttestationKeyRing,
  parsePrivacyExternalAttestationSet,
  type ExternalPrivacyPolicyBinding,
  type PrivacyExternalAttestationPayload,
} from "../privacy-external-attestation-set.js";
import {
  privacyAdapterDigest,
  validPrivacyExternalAdapterPolicy,
} from "../../../../testing/privacy-external-adapter-policy.fixture.js";

const now = new Date("2026-07-26T12:00:00.000Z");

function fixture() {
  const policy = validPrivacyExternalAdapterPolicy();
  const policyBinding: ExternalPrivacyPolicyBinding = {
    configurationKey: "privacy.external_source.adapter_policy",
    versionId: randomUUID(),
    versionNumber: 4,
    projectionVersion: 3,
    valueSha256: privacyAdapterDigest("active-policy"),
  };
  const releaseSha256 = privacyAdapterDigest("release-2026-07-26");
  const runtimeRegistry = policy.sources.map((source) => ({
    sourceKey: source.sourceKey,
    adapterKey: source.implementation.adapterKey,
    version: source.implementation.version,
    sha256: source.implementation.sha256,
    releaseSha256,
    coverageInventoryVersion: source.coverage!.inventoryVersion,
    coverageComponentKeys: source.coverage!.componentKeys,
  }));
  const pair = generateKeyPairSync("ed25519");
  const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
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
  const attestations = policy.sources.map((source, index) => {
    const payload: PrivacyExternalAttestationPayload = {
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
        accountReference: `provider-account-reference-${index}`,
        regionReference: "provider-region-reference-NG-LAGOS",
      },
      evidence,
      coverage: source.coverage!,
      observedAt: "2026-07-26T11:58:00.000Z",
      validFrom: "2026-07-26T11:59:00.000Z",
      expiresAt: "2026-07-26T12:10:00.000Z",
      nonce: index.toString(16).padStart(32, "0"),
    };
    return {
      payload,
      signature: {
        algorithm: "Ed25519" as const,
        keyId: "probe-2026-07",
        valueBase64: sign(null, Buffer.from(stableJsonStringify(payload), "utf8"), pair.privateKey).toString("base64"),
      },
    };
  });
  const value = {
    schemaVersion: "privacy-external-source-attestation-set-v2" as const,
    setReference: "production-probe-set-2026-07-26",
    generatedAt: "2026-07-26T11:58:30.000Z",
    attestations,
  };
  return {
    policy,
    policyBinding,
    runtimeRegistry,
    applicationReleaseSha256: releaseSha256,
    value,
    keyRing: { "probe-2026-07": { publicKeyPem, status: "active" as const } },
  };
}

describe("external privacy attestation set", () => {
  it("accepts eleven current signatures with exact policy, runtime, release, and provider bindings", () => {
    const input = fixture();
    expect(parsePrivacyExternalAttestationSet(input.value).attestations).toHaveLength(11);
    const result = evaluatePrivacyExternalAttestationSet({ ...input, now });
    expect(result.validSourceCount).toBe(11);
    expect(result.invalidSourceKeys).toEqual([]);
    expect(result.earliestExpiryAt).toBe("2026-07-26T12:10:00.000Z");
  });

  it("rejects tampering, wrong policy bindings, and ambiguous runtime records", () => {
    const tampered = fixture();
    tampered.value.attestations[0]!.payload.provider.accountReference = "changed-provider-account-reference";
    expect(evaluatePrivacyExternalAttestationSet({ ...tampered, now }).sources[0]).toMatchObject({ status: "signature_invalid" });

    const wrongPolicy = fixture();
    wrongPolicy.value.attestations[0]!.payload.policyBinding.valueSha256 = privacyAdapterDigest("wrong-policy");
    expect(evaluatePrivacyExternalAttestationSet({ ...wrongPolicy, now }).sources[0]).toMatchObject({ status: "policy_mismatch" });

    const ambiguous = fixture();
    ambiguous.runtimeRegistry.push({ ...ambiguous.runtimeRegistry[0]! });
    expect(evaluatePrivacyExternalAttestationSet({ ...ambiguous, now }).sources[0]).toMatchObject({ status: "runtime_ambiguous" });

    const incompleteCoverage = fixture();
    incompleteCoverage.runtimeRegistry[0] = {
      ...incompleteCoverage.runtimeRegistry[0]!,
      coverageComponentKeys:
        incompleteCoverage.runtimeRegistry[0]!.coverageComponentKeys.slice(1),
    };
    expect(evaluatePrivacyExternalAttestationSet({
      ...incompleteCoverage,
      now,
    }).sources[0]).toMatchObject({ status: "coverage_mismatch" });
  });

  it("rejects expired evidence and revoked or unknown signing keys", () => {
    const expired = fixture();
    expect(evaluatePrivacyExternalAttestationSet({
      ...expired,
      now: new Date("2026-07-26T12:11:00.000Z"),
    }).validSourceCount).toBe(0);

    const revoked = fixture();
    expect(evaluatePrivacyExternalAttestationSet({
      ...revoked,
      keyRing: { "probe-2026-07": { ...revoked.keyRing["probe-2026-07"]!, status: "revoked" } },
      now,
    }).validSourceCount).toBe(0);

    const unknown = fixture();
    expect(evaluatePrivacyExternalAttestationSet({ ...unknown, keyRing: {}, now }).validSourceCount).toBe(0);
  });

  it("rejects future, stale, wrong-release, and duplicate evidence", () => {
    const future = fixture();
    expect(evaluatePrivacyExternalAttestationSet({
      ...future,
      now: new Date("2026-07-26T11:50:00.000Z"),
    }).sources[0]).toMatchObject({ status: "not_yet_valid" });

    const stale = fixture();
    for (const source of stale.policy.sources) source.execution.evidenceMaximumAgeSeconds = 60;
    expect(evaluatePrivacyExternalAttestationSet({ ...stale, now }).sources[0]).toMatchObject({ status: "stale" });

    const wrongRelease = fixture();
    expect(evaluatePrivacyExternalAttestationSet({
      ...wrongRelease,
      applicationReleaseSha256: privacyAdapterDigest("different-release"),
      now,
    }).sources[0]).toMatchObject({ status: "runtime_mismatch" });

    const duplicate = fixture();
    duplicate.value.attestations[10] = structuredClone(duplicate.value.attestations[0]!);
    expect(() => parsePrivacyExternalAttestationSet(duplicate.value)).toThrow();
  });

  it("rejects malformed key sets and non-Ed25519 keys", () => {
    expect(parseExternalPrivacyAttestationKeyRing("{").errors).toHaveLength(1);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ type: "spki", format: "pem" }).toString();
    const result = parseExternalPrivacyAttestationKeyRing(JSON.stringify({
      "probe-rsa": { publicKeyPem: rsa, status: "active" },
    }));
    expect(result.keyRing).toEqual({});
    expect(result.errors.join(" ")).toContain("Ed25519");
  });
});
