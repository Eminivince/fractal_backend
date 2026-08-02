import { describe, expect, it } from "vitest";
import {
  buildPrivacyExternalSnapshotArchiveV2,
  parsePrivacyExternalSnapshotArchiveV2,
  PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2,
} from "../privacy-external-snapshot-archive.js";

const sourceKey = "external.identity_verification.provider";

describe("external privacy snapshot archive version 2", () => {
  it("binds canonical records and binary artifacts in deterministic TAR bytes", () => {
    const input = {
      sourceKey,
      records: [{ componentKey: "applicant_profile", data: { id: "applicant-1" } }],
      artifacts: [{
        sourceKey,
        componentKey: "identity_documents",
        mediaType: "image/jpeg" as const,
        content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }],
    };
    const first = buildPrivacyExternalSnapshotArchiveV2(input);
    const second = buildPrivacyExternalSnapshotArchiveV2(input);
    expect(first.buffer.equals(second.buffer)).toBe(true);

    const parsed = parsePrivacyExternalSnapshotArchiveV2(first.buffer);
    expect(parsed.sourceKey).toBe(sourceKey);
    expect(parsed.records).toEqual(input.records);
    expect(parsed.artifacts).toHaveLength(1);
    expect(parsed.artifacts[0]?.content).toEqual(input.artifacts[0]?.content);
    expect(first.artifactManifest).toEqual(parsed.artifacts.map(({ content: _content, ...item }) => item));
  });

  it("rejects a changed archive and a cross-source artifact", () => {
    expect(() => buildPrivacyExternalSnapshotArchiveV2({
      sourceKey,
      records: [],
      artifacts: [{
        sourceKey: "external.resend.delivery",
        componentKey: "identity_documents",
        mediaType: "image/jpeg",
        content: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
      }],
    })).toThrow("does not match");

    const built = buildPrivacyExternalSnapshotArchiveV2({
      sourceKey,
      records: [],
      artifacts: [],
    });
    expect(PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2).toBe(
      "application/vnd.fractal.privacy-external-snapshot+tar;version=2",
    );
    expect(parsePrivacyExternalSnapshotArchiveV2(built.buffer).canonicalContent).toBe(
      `{"records":[],"sourceKey":"${sourceKey}"}`,
    );
    const changed = Buffer.from(built.buffer);
    changed[600] ^= 1;
    expect(() => parsePrivacyExternalSnapshotArchiveV2(changed)).toThrow();
  });
});
