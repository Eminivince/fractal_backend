import { describe, expect, it } from "vitest";
import { parseDistributionPolicy, validateDistributionPolicy } from "../distribution-policy.js";
import { distributionLifecycleRecordClasses, parseDistributionLifecyclePolicy, validateDistributionLifecyclePolicy } from "../distribution-lifecycle-policy.js";

const distributionPolicy = {
  policyReference: "DIST-1", policyName: "Distribution policy", schemaVersion: "distribution-policy-v1",
  jurisdictions: { NG: { legalBasisReference: "SEC rule", currencies: { NGN: { minimumConfirmations: 1, maximumDeclarationMinor: "100000", maximumWithholdingTaxBps: 500, retentionDays: 365 } } } },
};
const lifecyclePolicy = {
  policyReference: "DIST-LIFE-1", policyName: "Distribution record lifecycle policy", schemaVersion: "distribution-lifecycle-policy-v1",
  jurisdictions: { NG: { legalBasisReference: "Applicable retention and privacy rule", rules: Object.fromEntries(distributionLifecycleRecordClasses.map((recordClass) => [recordClass, { retentionDays: 365, correctionTreatment: "append_only_domain_correction", erasureTreatment: "retain_then_review_for_minimization_or_disposition", restrictionTreatment: "mandatory_processing_only", objectionTreatment: "documented_lawful_basis_review" }])) } },
};

describe("distribution policies", () => {
  it("parses complete jurisdiction and currency controls", () => {
    expect(parseDistributionPolicy(distributionPolicy)).toEqual(distributionPolicy);
    expect(validateDistributionPolicy(distributionPolicy)).toEqual([]);
  });

  it("rejects empty and malformed distribution controls", () => {
    expect(validateDistributionPolicy({ ...distributionPolicy, jurisdictions: {} })).toEqual(expect.arrayContaining([expect.stringContaining("At least one jurisdiction")]));
    expect(validateDistributionPolicy({ ...distributionPolicy, jurisdictions: { NG: { ...distributionPolicy.jurisdictions.NG, currencies: {} } } })).toEqual(expect.arrayContaining([expect.stringContaining("At least one currency")]));
    expect(() => parseDistributionPolicy({ ...distributionPolicy, schemaVersion: "v2" })).toThrow();
    expect(validateDistributionPolicy(null)).toEqual(expect.arrayContaining([expect.stringMatching(/^value:/)]));
  });

  it("parses complete immutable lifecycle controls", () => {
    expect(parseDistributionLifecyclePolicy(lifecyclePolicy)).toEqual(lifecyclePolicy);
    expect(validateDistributionLifecyclePolicy(lifecyclePolicy)).toEqual([]);
  });

  it("rejects missing record classes and invalid jurisdiction limits", () => {
    const missing = { ...lifecyclePolicy, jurisdictions: { NG: { ...lifecyclePolicy.jurisdictions.NG, rules: { ...lifecyclePolicy.jurisdictions.NG.rules } } } } as any;
    delete missing.jurisdictions.NG.rules.tax_remittance;
    expect(validateDistributionLifecyclePolicy(missing)).toEqual(expect.arrayContaining([expect.stringContaining("tax_remittance")]));
    expect(validateDistributionLifecyclePolicy({ ...lifecyclePolicy, jurisdictions: {} })).toEqual(expect.arrayContaining([expect.stringContaining("At least one jurisdiction")]));
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(65 + (index % 26))}`, lifecyclePolicy.jurisdictions.NG]));
    expect(validateDistributionLifecyclePolicy({ ...lifecyclePolicy, jurisdictions: tooMany })).toEqual(expect.arrayContaining([expect.stringContaining("No more than 50")]))
    expect(validateDistributionLifecyclePolicy(null)).toEqual(expect.arrayContaining([expect.stringMatching(/^policy:/)]));
  });
});
