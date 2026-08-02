import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readBinding: vi.fn(),
}));

vi.mock("../postgres-platform-configuration.js", () => ({
  readActivePlatformConfigurationForBinding: mocks.readBinding,
}));

import {
  bindDistributionLifecyclePolicy,
  DistributionLifecyclePolicyError,
} from "../postgres-distribution-lifecycle.js";

const policy = {
  policyReference: "FRAC-PRIV-001",
  policyName: "Distribution lifecycle and privacy policy",
  schemaVersion: "distribution-lifecycle-policy-v1",
  jurisdictions: {
    NG: {
      legalBasisReference: "Nigeria data protection legal basis",
      rules: {
        ownership_snapshot: rule(365),
        distribution_declaration: rule(730),
        payout_exception: rule(90),
        tax_remittance: rule(2_190),
      },
    },
  },
};

function rule(retentionDays: number) {
  return {
    retentionDays,
    correctionTreatment: "append_only_domain_correction",
    erasureTreatment: "retain_then_review_for_minimization_or_disposition",
    restrictionTreatment: "mandatory_processing_only",
    objectionTreatment: "documented_lawful_basis_review",
  };
}

function clientWith(jurisdictionCode: string | null) {
  return { query: vi.fn().mockResolvedValueOnce({ rows: [{ jurisdiction_code: jurisdictionCode }] }).mockResolvedValue({ rows: [] }) } as any;
}

function activeBinding(value: unknown = policy) {
  return {
    versionId: "version-1",
    versionNumber: 4,
    projectionVersion: 7,
    valueSha256: "a".repeat(64),
    value,
  };
}

describe("distribution lifecycle policy binding", () => {
  it("requires an organization jurisdiction before it creates a binding", async () => {
    const client = clientWith(null);

    await expect(bindDistributionLifecyclePolicy(client, input())).rejects.toThrow(DistributionLifecyclePolicyError);
    await expect(bindDistributionLifecyclePolicy(clientWith(null), input())).rejects.toThrow("approved jurisdiction");
    expect(mocks.readBinding).not.toHaveBeenCalled();
  });

  it("requires an active approved lifecycle policy", async () => {
    mocks.readBinding.mockReset().mockResolvedValue(null);

    await expect(bindDistributionLifecyclePolicy(clientWith("NG"), input())).rejects.toThrow("approved lifecycle and privacy-treatment policy");
  });

  it("rejects a jurisdiction or record class that the active policy does not cover", async () => {
    mocks.readBinding.mockReset().mockResolvedValue(activeBinding());

    await expect(bindDistributionLifecyclePolicy(clientWith("GH"), input())).rejects.toThrow("does not cover GH/ownership_snapshot");

    const missingRulePolicy = structuredClone(policy) as any;
    delete missingRulePolicy.jurisdictions.NG.rules.payout_exception;
    mocks.readBinding.mockResolvedValueOnce(activeBinding(missingRulePolicy));
    await expect(bindDistributionLifecyclePolicy(clientWith("NG"), input({ targetType: "distribution_payout_exception" }))).rejects.toThrow();
  });

  it("stores the immutable policy snapshot and calculated retention for each target type", async () => {
    const client = clientWith("NG");
    mocks.readBinding.mockReset().mockResolvedValue(activeBinding());
    const startedAt = new Date("2026-01-15T00:00:00.000Z");

    const result = await bindDistributionLifecyclePolicy(client, input({
      targetType: "distribution_tax_remittance",
      retentionStartedAt: startedAt,
    }));

    expect(mocks.readBinding).toHaveBeenCalledWith(client, "privacy.distribution.lifecycle_policy");
    expect(result).toMatchObject({
      policyVersionId: "version-1",
      policyReference: "FRAC-PRIV-001",
      recordClass: "tax_remittance",
      retentionDays: 2_190,
      retainUntil: new Date("2032-01-14T00:00:00.000Z"),
    });
    expect(result.id).toEqual(expect.any(String));
    expect(client.query).toHaveBeenCalledTimes(2);
    const [sql, values] = client.query.mock.calls[1];
    expect(sql).toContain("INSERT INTO fractal.distribution_lifecycle_policy_bindings");
    expect(values).toEqual(expect.arrayContaining([
      result.id,
      "distribution_tax_remittance",
      "target-1",
      "organization-1",
      "tax_remittance",
      "version-1",
      4,
      7,
      "a".repeat(64),
      "NG",
      2_190,
      startedAt,
      new Date("2032-01-14T00:00:00.000Z"),
    ]));
  });
});

function input(overrides: Partial<{
  targetType: "ownership_snapshot" | "distribution_declaration" | "distribution_payout_exception" | "distribution_tax_remittance";
  targetId: string;
  organizationId: string;
  retentionStartedAt: Date;
}> = {}) {
  return {
    targetType: "ownership_snapshot" as const,
    targetId: "target-1",
    organizationId: "organization-1",
    retentionStartedAt: new Date("2026-01-15T00:00:00.000Z"),
    ...overrides,
  };
}
