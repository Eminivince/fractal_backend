import { describe, expect, it } from "vitest";
import {
  EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION,
  requiredExternalPrivacyCoverage,
} from "../privacy-external-coverage.js";
import {
  parsePrivacyRightsResponsePolicy,
  validatePrivacyRightsResponsePolicy,
} from "../privacy-rights-policy.js";

const policy = {
  policyReference: "PRIVACY-RIGHTS-001",
  policyName: "Privacy rights response policy",
  jurisdiction: "NG",
  controllerName: "Fractal Holdings Limited",
  identityAssurance: "authenticated_verified_email_session",
  communicationChannel: "authenticated_register",
  deadlineBasis: "calendar_days_from_authenticated_intake",
  responseCalendarDays: {
    access: 30,
    portability: 30,
    correction: 30,
    erasure: 30,
    restriction: 30,
    objection: 30,
  },
} as const;

describe("privacy rights response policy", () => {
  it("parses a complete controlled policy", () => {
    expect(parsePrivacyRightsResponsePolicy(policy)).toEqual(policy);
    expect(validatePrivacyRightsResponsePolicy(policy)).toEqual([]);
  });

  it("reports missing rights and unsafe response periods", () => {
    const errors = validatePrivacyRightsResponsePolicy({
      ...policy,
      responseCalendarDays: { ...policy.responseCalendarDays, access: 0, objection: undefined },
    });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("responseCalendarDays.access"),
      expect.stringContaining("responseCalendarDays.objection"),
    ]));
    expect(() => parsePrivacyRightsResponsePolicy({})).toThrow();
  });
});

describe("external privacy coverage inventory", () => {
  it("returns a defensive copy of the required source components", () => {
    const first = requiredExternalPrivacyCoverage("external.payment.provider");
    const second = requiredExternalPrivacyCoverage("external.payment.provider");
    expect(first.inventoryVersion).toBe(EXTERNAL_PRIVACY_COVERAGE_INVENTORY_VERSION);
    expect(first.componentKeys).toEqual(expect.arrayContaining(["payment_transactions", "provider_events"]));
    first.componentKeys.pop();
    expect(second.componentKeys).toContain("provider_events");
  });
});
