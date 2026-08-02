import { describe, expect, it } from "vitest";
import {
  parsePrivacyExternalAdapterPolicy,
  validatePrivacyExternalAdapterPolicy,
} from "../privacy-external-adapter-policy.js";
import { evaluateExternalPrivacyAdapterRuntime } from "../../../../platform/privacy-external-adapter-runtime.js";
import { privacyAdapterDigest, validPrivacyExternalAdapterPolicy as validPolicy } from "../../../../testing/privacy-external-adapter-policy.fixture.js";

describe("external privacy adapter policy", () => {
  it("accepts only an exact, fail-closed contract for all declared external sources", () => {
    const policy = validPolicy();
    expect(parsePrivacyExternalAdapterPolicy(policy).sources).toHaveLength(11);
    expect(validatePrivacyExternalAdapterPolicy({ ...policy, sources: policy.sources.slice(1) }).join(" ")).toMatch(/>=11 items|external\.chain\.public_records/);
    const duplicated = structuredClone(policy);
    duplicated.sources[10] = structuredClone(duplicated.sources[0]!);
    expect(validatePrivacyExternalAdapterPolicy(duplicated).join(" ")).toMatch(/unique|exact inventory/);
  });

  it("rejects unsafe field projection and weakened execution semantics", () => {
    const unsafe = structuredClone(validPolicy());
    unsafe.sources[0]!.fields[1] = {
      sourceField: "internalDiagnostic", outputField: "diagnostic", classification: "secret_or_internal",
      handling: "include", reason: "This intentionally invalid fixture attempts to expose internal provider diagnostics.",
    };
    expect(validatePrivacyExternalAdapterPolicy(unsafe).join(" ")).toContain("Secret or internal fields cannot be included");
    const permissive = structuredClone(validPolicy()) as unknown as Record<string, any>;
    permissive.sources[0].execution.failClosed = false;
    expect(validatePrivacyExternalAdapterPolicy(permissive).join(" ")).toContain("Invalid input");
    const incompleteCoverage = structuredClone(validPolicy());
    incompleteCoverage.sources[0]!.coverage!.componentKeys =
      incompleteCoverage.sources[0]!.coverage!.componentKeys.slice(1);
    expect(validatePrivacyExternalAdapterPolicy(incompleteCoverage).join(" "))
      .toContain("exact privacy-external-coverage-v1 component order");
  });

  it("distinguishes missing, mismatched, and exact runtime implementations", () => {
    const policy = validPolicy();
    const exact = policy.sources[0]!;
    const mismatch = policy.sources[1]!;
    const evaluation = evaluateExternalPrivacyAdapterRuntime(policy, [{
      sourceKey: exact.sourceKey, adapterKey: exact.implementation.adapterKey,
      version: exact.implementation.version, sha256: exact.implementation.sha256, releaseSha256: privacyAdapterDigest("release"),
      coverageInventoryVersion: exact.coverage!.inventoryVersion,
      coverageComponentKeys: exact.coverage!.componentKeys,
    }, {
      sourceKey: mismatch.sourceKey, adapterKey: mismatch.implementation.adapterKey,
      version: mismatch.implementation.version, sha256: privacyAdapterDigest("different-runtime"), releaseSha256: privacyAdapterDigest("release"),
      coverageInventoryVersion: mismatch.coverage!.inventoryVersion,
      coverageComponentKeys: mismatch.coverage!.componentKeys,
    }]);
    expect(evaluation.runtimeCompatibleSourceCount).toBe(1);
    expect(evaluation.mismatchedRuntimeSourceKeys).toEqual([mismatch.sourceKey]);
    expect(evaluation.missingRuntimeSourceKeys).toHaveLength(9);
    const ambiguous = evaluateExternalPrivacyAdapterRuntime(policy, [{
      sourceKey: exact.sourceKey, adapterKey: exact.implementation.adapterKey,
      version: exact.implementation.version, sha256: exact.implementation.sha256, releaseSha256: privacyAdapterDigest("release"),
      coverageInventoryVersion: exact.coverage!.inventoryVersion,
      coverageComponentKeys: exact.coverage!.componentKeys,
    }, {
      sourceKey: exact.sourceKey, adapterKey: exact.implementation.adapterKey,
      version: exact.implementation.version, sha256: privacyAdapterDigest("duplicate-runtime"), releaseSha256: privacyAdapterDigest("release"),
      coverageInventoryVersion: exact.coverage!.inventoryVersion,
      coverageComponentKeys: exact.coverage!.componentKeys,
    }]);
    expect(ambiguous.runtimeCompatibleSourceCount).toBe(0);
    expect(ambiguous.duplicateRuntimeSourceKeys).toEqual([exact.sourceKey]);

    const incomplete = evaluateExternalPrivacyAdapterRuntime(policy, [{
      sourceKey: exact.sourceKey,
      adapterKey: exact.implementation.adapterKey,
      version: exact.implementation.version,
      sha256: exact.implementation.sha256,
      releaseSha256: privacyAdapterDigest("release"),
      coverageInventoryVersion: exact.coverage!.inventoryVersion,
      coverageComponentKeys: exact.coverage!.componentKeys.slice(1),
    }]);
    expect(incomplete.runtimeCompatibleSourceCount).toBe(0);
    expect(incomplete.coverageMismatchedRuntimeSourceKeys)
      .toEqual([exact.sourceKey]);

    const legacy = structuredClone(policy);
    legacy.schemaVersion = "privacy-external-source-adapter-policy-v1";
    for (const source of legacy.sources) delete source.coverage;
    expect(parsePrivacyExternalAdapterPolicy(legacy).schemaVersion)
      .toBe("privacy-external-source-adapter-policy-v1");
    expect(evaluateExternalPrivacyAdapterRuntime(legacy, [])
      .coverageMissingSourceKeys).toHaveLength(11);
  });
});
