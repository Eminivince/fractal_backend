import { createHash } from "node:crypto";
import { stableJsonStringify } from "../../../utils/idempotency.js";

export const PRIVACY_PACKAGE_JSON_FORMAT_V1 =
  "application/vnd.fractal.privacy-package+json;version=1" as const;
export const PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2 =
  "application/vnd.fractal.privacy-package+tar;version=2" as const;

const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const MAX_ARCHIVE_ARTIFACTS = 1_000;
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

const artifactExtensionByMediaType = {
  "application/json": "json",
  "application/octet-stream": "bin",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/tiff": "tiff",
  "image/webp": "webp",
  "text/csv": "csv",
  "video/mp4": "mp4",
  "video/webm": "webm",
} as const;

type SupportedArtifactMediaType = keyof typeof artifactExtensionByMediaType;

export type PrivacyPackageArtifactInput = {
  sourceKey: string;
  componentKey: string;
  mediaType: SupportedArtifactMediaType;
  content: Buffer;
};

export type PrivacyPackageArtifactManifestItem = {
  sourceKey: string;
  componentKey: string;
  path: string;
  mediaType: SupportedArtifactMediaType;
  byteCount: number;
  sha256: string;
};

export type PrivacyPackageArchiveResult = {
  buffer: Buffer;
  artifactManifest: PrivacyPackageArtifactManifestItem[];
};

export type ParsedPrivacyPackageArchive = {
  packageDocument: Record<string, unknown>;
  artifacts: Array<PrivacyPackageArtifactManifestItem & { content: Buffer }>;
};

export class PrivacyPackageArchiveError extends Error {}

export type PrivacyArtifactArchiveResult = {
  buffer: Buffer;
  artifactManifest: PrivacyPackageArtifactManifestItem[];
};

export type ParsedPrivacyArtifactArchive = {
  document: Record<string, unknown>;
  artifacts: Array<PrivacyPackageArtifactManifestItem & { content: Buffer }>;
};

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPlainObject(
  value: unknown,
  message: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PrivacyPackageArchiveError(message);
  }
}

function assertSafeArtifactInput(artifact: PrivacyPackageArtifactInput): void {
  if (!/^[a-z][a-z0-9._-]{2,199}$/.test(artifact.sourceKey)) {
    throw new PrivacyPackageArchiveError("An artifact source key is invalid");
  }
  if (!/^[a-z][a-z0-9_]{2,119}$/.test(artifact.componentKey)) {
    throw new PrivacyPackageArchiveError("An artifact component key is invalid");
  }
  if (!(artifact.mediaType in artifactExtensionByMediaType)) {
    throw new PrivacyPackageArchiveError("An artifact media type is not approved");
  }
  if (!Buffer.isBuffer(artifact.content) || artifact.content.byteLength < 1) {
    throw new PrivacyPackageArchiveError("An artifact must contain binary data");
  }
}

function writeAscii(
  target: Buffer,
  offset: number,
  length: number,
  value: string,
): void {
  if (!/^[\x00\x20-\x7e]*$/.test(value) || Buffer.byteLength(value, "ascii") > length) {
    throw new PrivacyPackageArchiveError("A TAR header value is invalid");
  }
  target.write(value, offset, length, "ascii");
}

function octalField(value: number, length: number): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PrivacyPackageArchiveError("A TAR numeric value is invalid");
  }
  const octal = value.toString(8);
  if (octal.length > length - 1) {
    throw new PrivacyPackageArchiveError("A TAR numeric value exceeds its field");
  }
  return `${octal.padStart(length - 1, "0")}\0`;
}

function isCanonicalArchivePath(path: string, documentPath: string): boolean {
  return path === documentPath
    || /^artifacts\/[0-9a-f]{64}\.[a-z0-9]{1,10}$/.test(path);
}

function createTarHeader(path: string, size: number, documentPath: string): Buffer {
  if (
    !isCanonicalArchivePath(path, documentPath)
    || Buffer.byteLength(path, "ascii") > 100
  ) {
    throw new PrivacyPackageArchiveError("A TAR entry path is invalid");
  }
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  writeAscii(header, 0, 100, path);
  writeAscii(header, 100, 8, octalField(0o600, 8));
  writeAscii(header, 108, 8, octalField(0, 8));
  writeAscii(header, 116, 8, octalField(0, 8));
  writeAscii(header, 124, 12, octalField(size, 12));
  writeAscii(header, 136, 12, octalField(0, 12));
  header.fill(0x20, 148, 156);
  header[156] = "0".charCodeAt(0);
  writeAscii(header, 257, 6, "ustar");
  writeAscii(header, 263, 2, "00");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(
    header,
    148,
    8,
    `${checksum.toString(8).padStart(6, "0")}\0 `,
  );
  return header;
}

function encodeTar(
  entries: readonly { path: string; content: Buffer }[],
  documentPath: string,
): Buffer {
  const chunks: Buffer[] = [];
  let totalBytes = TAR_END_BYTES;
  for (const entry of entries) {
    const paddingBytes =
      (TAR_BLOCK_BYTES - (entry.content.byteLength % TAR_BLOCK_BYTES))
      % TAR_BLOCK_BYTES;
    totalBytes += TAR_BLOCK_BYTES + entry.content.byteLength + paddingBytes;
    if (totalBytes > MAX_ARCHIVE_BYTES) {
      throw new PrivacyPackageArchiveError("The privacy package archive exceeds the byte limit");
    }
    chunks.push(createTarHeader(entry.path, entry.content.byteLength, documentPath));
    chunks.push(entry.content);
    if (paddingBytes) chunks.push(Buffer.alloc(paddingBytes));
  }
  chunks.push(Buffer.alloc(TAR_END_BYTES));
  return Buffer.concat(chunks, totalBytes);
}

function readAscii(buffer: Buffer, offset: number, length: number): string {
  return buffer
    .subarray(offset, offset + length)
    .toString("ascii")
    .replace(/\0.*$/s, "");
}

function parseOctalField(
  buffer: Buffer,
  offset: number,
  length: number,
): number {
  const value = readAscii(buffer, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) {
    throw new PrivacyPackageArchiveError("A TAR numeric field is invalid");
  }
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) {
    throw new PrivacyPackageArchiveError("A TAR numeric field exceeds the safe limit");
  }
  return parsed;
}

function parseTar(buffer: Buffer, documentPath: string): Map<string, Buffer> {
  if (
    !Buffer.isBuffer(buffer)
    || buffer.byteLength < TAR_END_BYTES
    || buffer.byteLength > MAX_ARCHIVE_BYTES
    || buffer.byteLength % TAR_BLOCK_BYTES !== 0
  ) {
    throw new PrivacyPackageArchiveError("The privacy package TAR length is invalid");
  }
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset < buffer.byteLength) {
    const header = buffer.subarray(offset, offset + TAR_BLOCK_BYTES);
    if (header.every((byte) => byte === 0)) {
      if (
        buffer.byteLength - offset < TAR_END_BYTES
        || buffer.subarray(offset).some((byte) => byte !== 0)
      ) {
        throw new PrivacyPackageArchiveError("The privacy package TAR end marker is invalid");
      }
      return entries;
    }
    if (
      readAscii(header, 257, 6) !== "ustar"
      || readAscii(header, 263, 2) !== "00"
      || ![0, "0".charCodeAt(0)].includes(header[156]!)
    ) {
      throw new PrivacyPackageArchiveError("The privacy package TAR entry type is invalid");
    }
    const expectedChecksum = parseOctalField(header, 148, 8);
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const actualChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (expectedChecksum !== actualChecksum) {
      throw new PrivacyPackageArchiveError("The privacy package TAR checksum is invalid");
    }
    const path = readAscii(header, 0, 100);
    if (
      !isCanonicalArchivePath(path, documentPath)
      || entries.has(path)
    ) {
      throw new PrivacyPackageArchiveError("The privacy package TAR path is unsafe or duplicated");
    }
    const size = parseOctalField(header, 124, 12);
    const contentStart = offset + TAR_BLOCK_BYTES;
    const contentEnd = contentStart + size;
    const nextOffset =
      contentStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
    if (
      contentEnd > buffer.byteLength - TAR_END_BYTES
      || nextOffset > buffer.byteLength - TAR_END_BYTES
    ) {
      throw new PrivacyPackageArchiveError("The privacy package TAR entry exceeds the archive");
    }
    if (buffer.subarray(contentEnd, nextOffset).some((byte) => byte !== 0)) {
      throw new PrivacyPackageArchiveError("The privacy package TAR padding is invalid");
    }
    entries.set(path, Buffer.from(buffer.subarray(contentStart, contentEnd)));
    if (entries.size > MAX_ARCHIVE_ARTIFACTS + 1) {
      throw new PrivacyPackageArchiveError("The privacy package TAR has too many entries");
    }
    offset = nextOffset;
  }
  throw new PrivacyPackageArchiveError("The privacy package TAR has no end marker");
}

function parseArtifactManifest(
  value: unknown,
): PrivacyPackageArtifactManifestItem[] {
  if (!Array.isArray(value) || value.length > MAX_ARCHIVE_ARTIFACTS) {
    throw new PrivacyPackageArchiveError("The privacy package artifact manifest is invalid");
  }
  return value.map((item) => {
    assertPlainObject(item, "A privacy package artifact manifest item is invalid");
    if (
      Object.keys(item).sort().join(",")
        !== "byteCount,componentKey,mediaType,path,sha256,sourceKey"
      || typeof item.sourceKey !== "string"
      || !/^[a-z][a-z0-9._-]{2,199}$/.test(item.sourceKey)
      || typeof item.componentKey !== "string"
      || !/^[a-z][a-z0-9_]{2,119}$/.test(item.componentKey)
      || typeof item.mediaType !== "string"
      || !(item.mediaType in artifactExtensionByMediaType)
      || typeof item.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(item.sha256)
      || typeof item.path !== "string"
      || item.path !== `artifacts/${item.sha256}.${
        artifactExtensionByMediaType[item.mediaType as SupportedArtifactMediaType]
      }`
      || !Number.isSafeInteger(item.byteCount)
      || (item.byteCount as number) < 1
    ) {
      throw new PrivacyPackageArchiveError("A privacy package artifact manifest item is invalid");
    }
    return item as PrivacyPackageArtifactManifestItem;
  });
}

export function buildPrivacyPackageArchiveV2(input: {
  packageDocument: Record<string, unknown>;
  artifacts: readonly PrivacyPackageArtifactInput[];
}): PrivacyPackageArchiveResult {
  assertPlainObject(input.packageDocument, "The privacy package document is invalid");
  if (
    input.packageDocument.schemaVersion !== "fractal-privacy-package-v2"
    || input.packageDocument.canonicalFormat !== PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2
    || "artifactManifest" in input.packageDocument
  ) {
    throw new PrivacyPackageArchiveError("The privacy package version 2 document is invalid");
  }
  return buildPrivacyArtifactArchive({
    documentPath: "package.json",
    document: input.packageDocument,
    artifacts: input.artifacts,
  });
}

export function buildPrivacyArtifactArchive(input: {
  documentPath: "package.json" | "snapshot.json";
  document: Record<string, unknown>;
  artifacts: readonly PrivacyPackageArtifactInput[];
}): PrivacyArtifactArchiveResult {
  assertPlainObject(input.document, "The privacy archive document is invalid");
  if ("artifactManifest" in input.document) {
    throw new PrivacyPackageArchiveError("The privacy archive document already has an artifact manifest");
  }
  if (input.artifacts.length > MAX_ARCHIVE_ARTIFACTS) {
    throw new PrivacyPackageArchiveError("The privacy archive has too many artifacts");
  }
  const boundArtifacts = input.artifacts.map((artifact) => {
    assertSafeArtifactInput(artifact);
    const digest = sha256(artifact.content);
    return {
      manifest: {
        sourceKey: artifact.sourceKey,
        componentKey: artifact.componentKey,
        path: `artifacts/${digest}.${artifactExtensionByMediaType[artifact.mediaType]}`,
        mediaType: artifact.mediaType,
        byteCount: artifact.content.byteLength,
        sha256: digest,
      } satisfies PrivacyPackageArtifactManifestItem,
      content: artifact.content,
    };
  }).sort((left, right) =>
    left.manifest.sourceKey.localeCompare(right.manifest.sourceKey)
    || left.manifest.componentKey.localeCompare(right.manifest.componentKey)
    || left.manifest.path.localeCompare(right.manifest.path));
  const manifest = boundArtifacts.map((artifact) => artifact.manifest);
  const logicalKeys = manifest.map((item) =>
    `${item.sourceKey}\0${item.componentKey}\0${item.sha256}`);
  if (new Set(logicalKeys).size !== logicalKeys.length) {
    throw new PrivacyPackageArchiveError("The privacy package has a duplicate artifact binding");
  }
  const documentContent = Buffer.from(stableJsonStringify({
    ...input.document,
    artifactManifest: manifest,
  }), "utf8");
  const artifactByPath = new Map<string, Buffer>();
  for (const artifact of boundArtifacts) {
    artifactByPath.set(artifact.manifest.path, artifact.content);
  }
  const buffer = encodeTar([
    { path: input.documentPath, content: documentContent },
    ...[...artifactByPath.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([path, content]) => ({ path, content })),
  ], input.documentPath);
  parsePrivacyArtifactArchive({ buffer, documentPath: input.documentPath });
  return { buffer, artifactManifest: manifest };
}

export function parsePrivacyPackageArchiveV2(
  buffer: Buffer,
): ParsedPrivacyPackageArchive {
  const parsed = parsePrivacyArtifactArchive({ buffer, documentPath: "package.json" });
  const packageDocument = parsed.document;
  if (
    packageDocument.schemaVersion !== "fractal-privacy-package-v2"
    || packageDocument.canonicalFormat !== PRIVACY_PACKAGE_ARCHIVE_FORMAT_V2
  ) {
    throw new PrivacyPackageArchiveError("The privacy package document is not canonical version 2 data");
  }
  return { packageDocument, artifacts: parsed.artifacts };
}

export function parsePrivacyArtifactArchive(input: {
  buffer: Buffer;
  documentPath: "package.json" | "snapshot.json";
}): ParsedPrivacyArtifactArchive {
  const entries = parseTar(input.buffer, input.documentPath);
  const documentContent = entries.get(input.documentPath);
  if (!documentContent) {
    throw new PrivacyPackageArchiveError("The privacy archive has no document");
  }
  let document: unknown;
  let documentText: string;
  try {
    documentText = new TextDecoder("utf-8", { fatal: true }).decode(documentContent);
    document = JSON.parse(documentText);
  } catch {
    throw new PrivacyPackageArchiveError("The privacy archive document is not valid JSON");
  }
  assertPlainObject(document, "The privacy archive document is invalid");
  if (stableJsonStringify(document) !== documentText) {
    throw new PrivacyPackageArchiveError("The privacy archive document is not canonical JSON");
  }
  const artifactManifest = parseArtifactManifest(document.artifactManifest);
  const referencedPaths = new Set(artifactManifest.map((item) => item.path));
  if (
    entries.size !== referencedPaths.size + 1
    || [...entries.keys()].some((path) =>
      path !== input.documentPath && !referencedPaths.has(path))
  ) {
    throw new PrivacyPackageArchiveError("The privacy archive has an undeclared or missing entry");
  }
  const artifacts = artifactManifest.map((item) => {
    const content = entries.get(item.path);
    if (
      !content
      || content.byteLength !== item.byteCount
      || sha256(content) !== item.sha256
    ) {
      throw new PrivacyPackageArchiveError("A privacy package artifact does not match its manifest");
    }
    return { ...item, content };
  });
  return { document, artifacts };
}
