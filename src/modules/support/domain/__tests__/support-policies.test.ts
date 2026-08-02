import { describe, expect, it } from "vitest";
import {
  parseSupportCaseDataPolicy,
  validateSupportCaseDataPolicy,
} from "../support-data-policy.js";
import {
  parseSupportCaseServicePolicy,
  targetForSupportCase,
  validateSupportCaseServicePolicy,
} from "../support-service-policy.js";

const classifications = {
  general: { retentionDays: 365 },
  personal_data: { retentionDays: 365 },
  financial_record: { retentionDays: 730 },
  identity_document: { retentionDays: 365 },
  security_sensitive: { retentionDays: 730 },
};

const dataPolicy = {
  policyReference: "SUP-DATA-001",
  policyName: "Support case evidence data policy",
  maximumBytes: 1024,
  allowedMimeTypes: ["application/pdf", "image/png"],
  classifications,
};

const target = {
  priority: "p2",
  acknowledgementMinutes: 60,
  resolutionMinutes: 480,
  escalationMinutesBeforeResolution: 120,
} as const;

const servicePolicy = {
  policyReference: "SUP-SLA-001",
  policyName: "Support case service level policy",
  impactTargets: {
    question: target,
    blocked: { ...target, priority: "p1" },
    financial_or_legal_risk: { ...target, priority: "p1" },
    security_or_privacy_concern: { ...target, priority: "p1" },
  },
  categoryOverrides: [{
    category: "payment_status",
    reportedImpact: "question",
    target: { ...target, priority: "p3" },
  }],
};

describe("support data policy", () => {
  it("parses a complete policy and reports no validation errors", () => {
    expect(parseSupportCaseDataPolicy(dataPolicy)).toEqual(dataPolicy);
    expect(validateSupportCaseDataPolicy(dataPolicy)).toEqual([]);
  });

  it("reports missing classification rules, unsafe sizes, and duplicate MIME types", () => {
    const errors = validateSupportCaseDataPolicy({
      ...dataPolicy,
      maximumBytes: 0,
      allowedMimeTypes: ["application/pdf", "application/pdf"],
      classifications: { general: { retentionDays: 0 } },
    });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("maximumBytes"),
      expect.stringContaining("allowedMimeTypes"),
      expect.stringContaining("classifications"),
    ]));
    expect(() => parseSupportCaseDataPolicy({})).toThrow();
  });
});

describe("support service policy", () => {
  it("parses a valid policy and selects a precise override before the impact target", () => {
    const parsed = parseSupportCaseServicePolicy(servicePolicy);
    expect(validateSupportCaseServicePolicy(servicePolicy)).toEqual([]);
    expect(targetForSupportCase(parsed, "payment_status", "question")).toEqual({ ...target, priority: "p3" });
    expect(targetForSupportCase(parsed, "account_access", "blocked")).toEqual({ ...target, priority: "p1" });
  });

  it("reports invalid target timing and duplicate category-impact overrides", () => {
    const errors = validateSupportCaseServicePolicy({
      ...servicePolicy,
      impactTargets: {
        ...servicePolicy.impactTargets,
        question: { ...target, escalationMinutesBeforeResolution: 480 },
      },
      categoryOverrides: [
        ...servicePolicy.categoryOverrides,
        { ...servicePolicy.categoryOverrides[0] },
      ],
    });
    expect(errors).toEqual(expect.arrayContaining([
      expect.stringContaining("escalationMinutesBeforeResolution"),
      expect.stringContaining("categoryOverrides.1"),
    ]));
    expect(() => parseSupportCaseServicePolicy({})).toThrow();
  });
});
