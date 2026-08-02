import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ binding: vi.fn(), parseKeyRing: vi.fn(), evaluate: vi.fn() }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: mocks.binding }));
vi.mock("../../modules/privacy/domain/privacy-external-attestation-set.js", () => ({ parseExternalPrivacyAttestationKeyRing: mocks.parseKeyRing, evaluatePrivacyExternalAttestationSet: mocks.evaluate }));

import { readActiveExternalPrivacyAttestationReadiness } from "../privacy-external-attestation-runtime.js";

beforeEach(() => { mocks.binding.mockReset(); mocks.parseKeyRing.mockReset(); mocks.evaluate.mockReset(); });

describe("external privacy attestation readiness", () => {
  const policy = { sources: [{ sourceKey: "external.resend.delivery" }, { sourceKey: "external.chain.public_records" }] };
  const policyBinding = { versionId: "policy-1", versionNumber: 2, projectionVersion: 3, valueSha256: "a".repeat(64) };

  it("reports an unavailable state when the signed attestation set is not active", async () => {
    mocks.binding.mockResolvedValue(null);
    await expect(readActiveExternalPrivacyAttestationReadiness({} as never, { policy: policy as never, policyBinding: policyBinding as never, keyRing: {} as never })).resolves.toMatchObject({ status: "not_activated", validSourceCount: 0, blocksAvailability: true });
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("reports active valid when every governed source has a valid attestation", async () => {
    mocks.binding.mockResolvedValue({ versionId: "attestation-1", versionNumber: 4, projectionVersion: 5, valueSha256: "b".repeat(64), value: { setReference: "SET-1" } });
    mocks.evaluate.mockReturnValue({ setReference: "SET-1", validSourceCount: 2, invalidSourceKeys: [], earliestExpiryAt: "2026-08-01T00:00:00.000Z", errors: [], sources: [{ sourceKey: "external.resend.delivery", status: "valid", failures: [], reason: "Valid" }] });
    const result = await readActiveExternalPrivacyAttestationReadiness({} as never, { policy: policy as never, policyBinding: policyBinding as never, keyRing: {} as never, keyRingErrors: ["unused key"] });
    expect(result).toMatchObject({ status: "active_valid", versionId: "attestation-1", validSourceCount: 2, configurationErrorCount: 0 });
    expect(mocks.evaluate).toHaveBeenCalledWith(expect.objectContaining({ policyBinding: expect.objectContaining({ versionId: "policy-1" }), keyRingErrors: ["unused key"] }));
  });

  it("uses the parser and reports partial and invalid sets", async () => {
    mocks.binding.mockResolvedValue({ versionId: "attestation-1", versionNumber: 1, projectionVersion: 1, valueSha256: "b".repeat(64), value: {} });
    mocks.parseKeyRing.mockReturnValue({ keyRing: { current: "key" }, errors: ["bad key"] });
    mocks.evaluate.mockReturnValueOnce({ setReference: "SET-1", validSourceCount: 1, invalidSourceKeys: ["external.chain.public_records"], earliestExpiryAt: null, errors: ["expired"], sources: [] });
    await expect(readActiveExternalPrivacyAttestationReadiness({} as never, { policy: policy as never, policyBinding: policyBinding as never })).resolves.toMatchObject({ status: "active_partially_valid", configurationErrorCount: 1 });
    mocks.evaluate.mockReturnValueOnce({ setReference: "SET-1", validSourceCount: 0, invalidSourceKeys: ["external.resend.delivery"], earliestExpiryAt: null, errors: ["invalid"], sources: [] });
    await expect(readActiveExternalPrivacyAttestationReadiness({} as never, { policy: policy as never, policyBinding: policyBinding as never })).resolves.toMatchObject({ status: "active_invalid", validSourceCount: 0 });
  });
});
