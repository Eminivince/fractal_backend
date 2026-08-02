import { describe, expect, it } from "vitest";
import {
  PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
  PRIVACY_PACKAGE_JSON_FORMAT_V1,
} from "../privacy-package-archive.js";
import {
  parsePrivacyPackagePolicy,
  validatePrivacyPackagePolicy,
} from "../privacy-package-policy.js";

function commonPolicy() {
  return {
    policyReference: "PRIVACY-PACKAGE-NG-001",
    policyName: "Nigeria authenticated privacy package policy",
    identityAssurance: "authenticated_verified_email_session",
    deliveryChannel: "authenticated_register",
    allowInternalIncompletePreparation: true,
    maximumRecords: 100_000,
    maximumBytes: 100 * 1024 * 1024,
    packageRetentionHours: 24,
    requesterRetrievalHours: 1,
  } as const;
}

describe("privacy package policy", () => {
  it("keeps historical JSON policy version 1 valid", () => {
    const policy = parsePrivacyPackagePolicy({
      ...commonPolicy(),
      canonicalFormat: PRIVACY_PACKAGE_JSON_FORMAT_V1,
    });
    expect(policy).toMatchObject({
      canonicalFormat: PRIVACY_PACKAGE_JSON_FORMAT_V1,
    });
    expect("maximumArtifacts" in policy).toBe(false);
  });

  it("requires an exact artifact limit for archive policy version 2", () => {
    expect(parsePrivacyPackagePolicy({
      ...commonPolicy(),
      schemaVersion: "privacy-package-policy-v2",
      canonicalFormat: PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
      maximumArtifacts: 250,
    })).toMatchObject({
      schemaVersion: "privacy-package-policy-v2",
      canonicalFormat: PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
      maximumArtifacts: 250,
    });
    expect(validatePrivacyPackagePolicy({
      ...commonPolicy(),
      schemaVersion: "privacy-package-policy-v2",
      canonicalFormat: PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
    })).toContain("canonicalFormat: Archive packages require policy version 2 and an artifact limit.");
  });

  it("rejects archive fields in JSON policy version 1", () => {
    expect(validatePrivacyPackagePolicy({
      ...commonPolicy(),
      canonicalFormat: PRIVACY_PACKAGE_JSON_FORMAT_V1,
      maximumArtifacts: 1,
    })).toContain("canonicalFormat: JSON package policy version 1 cannot contain archive policy fields.");
  });
});
