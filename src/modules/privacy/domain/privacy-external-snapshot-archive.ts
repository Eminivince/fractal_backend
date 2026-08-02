import {
  buildPrivacyArtifactArchive,
  parsePrivacyArtifactArchive,
  type PrivacyPackageArtifactInput,
  type PrivacyPackageArtifactManifestItem,
} from "./privacy-package-archive.js";
import { stableJsonStringify } from "../../../utils/idempotency.js";

export const PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2 =
  "application/vnd.fractal.privacy-external-snapshot+tar;version=2" as const;

export type PrivacyExternalSnapshotArchive = {
  buffer: Buffer;
  artifactManifest: PrivacyPackageArtifactManifestItem[];
};

export type ParsedPrivacyExternalSnapshotArchive = {
  sourceKey: string;
  records: Record<string, unknown>[];
  canonicalContent: string;
  artifacts: Array<PrivacyPackageArtifactManifestItem & { content: Buffer }>;
};

export class PrivacyExternalSnapshotArchiveError extends Error {}

function assertSourceKey(value: unknown): asserts value is string {
  if (
    typeof value !== "string"
    || !/^[a-z][a-z0-9._-]{2,199}$/.test(value)
  ) {
    throw new PrivacyExternalSnapshotArchiveError("The snapshot source key is invalid.");
  }
}

function assertRecords(value: unknown): asserts value is Record<string, unknown>[] {
  if (
    !Array.isArray(value)
    || value.length > 100_000
    || value.some((record) =>
      !record || typeof record !== "object" || Array.isArray(record))
  ) {
    throw new PrivacyExternalSnapshotArchiveError("The snapshot records are invalid.");
  }
}

export function buildPrivacyExternalSnapshotArchiveV2(input: {
  sourceKey: string;
  records: Record<string, unknown>[];
  artifacts: readonly PrivacyPackageArtifactInput[];
}): PrivacyExternalSnapshotArchive {
  assertSourceKey(input.sourceKey);
  assertRecords(input.records);
  if (input.artifacts.some((artifact) => artifact.sourceKey !== input.sourceKey)) {
    throw new PrivacyExternalSnapshotArchiveError(
      "A snapshot artifact does not match the snapshot source.",
    );
  }
  return buildPrivacyArtifactArchive({
    documentPath: "snapshot.json",
    document: {
      schemaVersion: "fractal-privacy-external-snapshot-v2",
      canonicalFormat: PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2,
      sourceKey: input.sourceKey,
      records: input.records,
    },
    artifacts: input.artifacts,
  });
}

export function parsePrivacyExternalSnapshotArchiveV2(
  buffer: Buffer,
): ParsedPrivacyExternalSnapshotArchive {
  try {
    const parsed = parsePrivacyArtifactArchive({
      buffer,
      documentPath: "snapshot.json",
    });
    const document = parsed.document;
    if (
      Object.keys(document).sort().join(",")
        !== "artifactManifest,canonicalFormat,records,schemaVersion,sourceKey"
      || document.schemaVersion !== "fractal-privacy-external-snapshot-v2"
      || document.canonicalFormat !== PRIVACY_EXTERNAL_SNAPSHOT_ARCHIVE_FORMAT_V2
    ) {
      throw new PrivacyExternalSnapshotArchiveError(
        "The external snapshot document is not canonical version 2 data.",
      );
    }
    assertSourceKey(document.sourceKey);
    assertRecords(document.records);
    if (parsed.artifacts.some((artifact) => artifact.sourceKey !== document.sourceKey)) {
      throw new PrivacyExternalSnapshotArchiveError(
        "An external snapshot artifact has the wrong source.",
      );
    }
    return {
      sourceKey: document.sourceKey,
      records: document.records,
      canonicalContent: stableJsonStringify({
        sourceKey: document.sourceKey,
        records: document.records,
      }),
      artifacts: parsed.artifacts,
    };
  } catch (error) {
    if (error instanceof PrivacyExternalSnapshotArchiveError) throw error;
    throw new PrivacyExternalSnapshotArchiveError(
      "The external snapshot archive is invalid.",
    );
  }
}
