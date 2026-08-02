import { describe, expect, it } from "vitest";
import {
  buildPrivacyPackageArchiveV2,
  parsePrivacyPackageArchiveV2,
  PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
  PrivacyPackageArchiveError,
  type PrivacyPackageArtifactInput,
} from "../privacy-package-archive.js";

function document() {
  return {
    schemaVersion: "fractal-privacy-package-v2",
    canonicalFormat: PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
    deliveryReference: "PRD-20260727-ARCHIVE1",
    sections: [],
  };
}

function artifacts(): PrivacyPackageArtifactInput[] {
  return [{
    sourceKey: "external.identity_verification.provider",
    componentKey: "biometric_media",
    mediaType: "image/jpeg",
    content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  }, {
    sourceKey: "external.identity_verification.provider",
    componentKey: "identity_documents",
    mediaType: "application/pdf",
    content: Buffer.from("%PDF-1.7\ncontrolled test document\n%%EOF", "utf8"),
  }];
}

describe("privacy package archive version 2", () => {
  it("creates deterministic canonical TAR bytes and restores every artifact", () => {
    const first = buildPrivacyPackageArchiveV2({
      packageDocument: document(),
      artifacts: artifacts(),
    });
    const second = buildPrivacyPackageArchiveV2({
      packageDocument: document(),
      artifacts: [...artifacts()].reverse(),
    });
    expect(first.buffer.equals(second.buffer)).toBe(true);
    expect(first.buffer.byteLength % 512).toBe(0);
    expect(first.artifactManifest.map((item) => item.componentKey)).toEqual([
      "biometric_media",
      "identity_documents",
    ]);

    const parsed = parsePrivacyPackageArchiveV2(first.buffer);
    expect(parsed.packageDocument).toMatchObject({
      schemaVersion: "fractal-privacy-package-v2",
      canonicalFormat: PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2,
      artifactManifest: first.artifactManifest,
    });
    expect(parsed.artifacts.map((item) => ({
      componentKey: item.componentKey,
      content: item.content,
    }))).toEqual([
      {
        componentKey: "biometric_media",
        content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      },
      {
        componentKey: "identity_documents",
        content: Buffer.from("%PDF-1.7\ncontrolled test document\n%%EOF", "utf8"),
      },
    ]);
  });

  it("rejects changed artifact bytes and changed manifest bindings", () => {
    const built = buildPrivacyPackageArchiveV2({
      packageDocument: document(),
      artifacts: artifacts(),
    });
    const changedArtifact = Buffer.from(built.buffer);
    const artifactOffset = changedArtifact.indexOf(
      Buffer.from("%PDF-1.7\ncontrolled test document\n%%EOF", "utf8"),
    );
    expect(artifactOffset).toBeGreaterThan(0);
    changedArtifact[artifactOffset + 10] ^= 1;
    expect(() => parsePrivacyPackageArchiveV2(changedArtifact))
      .toThrow("does not match its manifest");

    const changedManifest = Buffer.from(built.buffer);
    const declaredHash = Buffer.from(
      built.artifactManifest[0]!.sha256,
      "ascii",
    );
    const manifestHashOffset = changedManifest.indexOf(declaredHash);
    expect(manifestHashOffset).toBeGreaterThan(0);
    changedManifest[manifestHashOffset] = declaredHash[0] === 0x61 ? 0x62 : 0x61;
    expect(() => parsePrivacyPackageArchiveV2(changedManifest))
      .toThrow(PrivacyPackageArchiveError);
  });

  it("rejects duplicate bindings and unapproved media types", () => {
    const duplicate = artifacts()[0]!;
    expect(() => buildPrivacyPackageArchiveV2({
      packageDocument: document(),
      artifacts: [duplicate, { ...duplicate, content: Buffer.from(duplicate.content) }],
    })).toThrow("duplicate artifact binding");
    expect(() => buildPrivacyPackageArchiveV2({
      packageDocument: document(),
      artifacts: [{
        ...duplicate,
        mediaType: "text/html",
      } as unknown as PrivacyPackageArtifactInput],
    })).toThrow("media type");
    expect(() => parsePrivacyPackageArchiveV2(Buffer.alloc(1_024)))
      .toThrow(PrivacyPackageArchiveError);
  });
});
