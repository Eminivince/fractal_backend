import { createHash, createHmac } from "node:crypto";
import { crc32 } from "node:zlib";
import { fromBufferPromise, type Entry, type ZipFile } from "yauzl";
import type { PrivacyPackageArtifactInput } from "../modules/privacy/domain/privacy-package-archive.js";

const SUMSUB_BASE_URL = "https://api.sumsub.com";
const MAXIMUM_DOCUMENTS = 250;
const ACTION_PAGE_LIMIT = 1_000;
const MAXIMUM_PROVIDER_EXPORT_ENTRIES = 2;
const MAXIMUM_PROVIDER_EXPORT_COMPRESSION_RATIO = 200;

export const SUMSUB_PRIVACY_ADAPTER_KEY = "fractal.external.sumsub-privacy";
export const SUMSUB_PRIVACY_ADAPTER_VERSION = "1.0.0";
export const SUMSUB_PRIVACY_OUTPUT_FIELDS = [
  "applicant_profile",
  "review_results",
  "identity_documents",
  "biometric_media",
  "questionnaire_and_consent",
  "device_and_network_metadata",
  "screening_and_watchlist_results",
  "provider_export_artifacts",
] as const;

type JsonObject = Record<string, unknown>;
type RequestFunction = (input: string, init: RequestInit) => Promise<Response>;

export type SumsubPrivacyReference = {
  applicantId: string;
  externalUserId: string;
  inspectionId: string;
};

export type SumsubProviderExportArtifact = {
  reportReference: string;
  applicantId: string;
  externalUserId: string;
  entryCount: 1;
  generatedAt: string;
  downloadedAt: string;
  sensitiveTier: "higher_sensitive_data";
  content: Buffer;
  sha256: string;
  settingsSha256: string;
  malwareScanEvidenceSha256: string;
};

export type SumsubPrivacyCollection = {
  records: JsonObject[];
  artifacts: PrivacyPackageArtifactInput[];
};

export type SumsubProviderExportArchiveEvidence = {
  reportFileName: string;
  settingsFileName: string;
  reportColumns: string[];
  sensitiveColumns: string[];
  entryCount: 1;
};

export class SumsubPrivacyAdapterError extends Error {
  constructor(
    message: string,
    readonly category:
      | "invalid_input"
      | "correlation_mismatch"
      | "provider_failed"
      | "provider_response_invalid"
      | "provider_response_too_large"
      | "provider_export_missing",
  ) {
    super(message);
    this.name = "SumsubPrivacyAdapterError";
  }
}

function boundedIdentifier(value: string, label: string, maximum = 512): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new SumsubPrivacyAdapterError(`${label} is invalid.`, "invalid_input");
  }
  return normalized;
}

function exactSha256(value: string, label: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new SumsubPrivacyAdapterError(`${label} must be a lowercase SHA-256 value.`, "invalid_input");
  }
  return value;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function asObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SumsubPrivacyAdapterError(`${label} is not a JSON object.`, "provider_response_invalid");
  }
  return value as JsonObject;
}

function asObjectArray(value: unknown, label: string): JsonObject[] {
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new SumsubPrivacyAdapterError(`${label} is not a JSON object array.`, "provider_response_invalid");
  }
  return value as JsonObject[];
}

function parseProviderTime(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new SumsubPrivacyAdapterError(`${label} is invalid.`, "invalid_input");
  }
  return new Date(time).toISOString();
}

function supportedMediaType(value: string | null): PrivacyPackageArtifactInput["mediaType"] {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType === "image/jpg") return "image/jpeg";
  if (
    mediaType === "application/json"
    || mediaType === "application/octet-stream"
    || mediaType === "application/pdf"
    || mediaType === "application/zip"
    || mediaType === "text/csv"
    || mediaType === "image/gif"
    || mediaType === "image/jpeg"
    || mediaType === "image/png"
    || mediaType === "image/tiff"
    || mediaType === "image/webp"
    || mediaType === "video/mp4"
    || mediaType === "video/webm"
  ) {
    return mediaType;
  }
  throw new SumsubPrivacyAdapterError("Sumsub returned an unsupported artifact media type.", "provider_response_invalid");
}

async function readBoundedBody(response: Response, maximumBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && (!/^[0-9]+$/.test(declaredLength) || Number(declaredLength) > maximumBytes)) {
    throw new SumsubPrivacyAdapterError("Sumsub response exceeds the approved byte limit.", "provider_response_too_large");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      length += result.value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel();
        throw new SumsubPrivacyAdapterError("Sumsub response exceeds the approved byte limit.", "provider_response_too_large");
      }
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, length);
}

async function requestSumsub(input: {
  appToken: string;
  secretKey: string;
  path: string;
  timeoutMs: number;
  maximumBytes: number;
  request: RequestFunction;
  nowSeconds: number;
}): Promise<{ body: Buffer; mediaType: string | null }> {
  const signature = createHmac("sha256", input.secretKey)
    .update(`${input.nowSeconds}GET${input.path}`)
    .digest("hex");
  let response: Response;
  try {
    response = await input.request(`${SUMSUB_BASE_URL}${input.path}`, {
      method: "GET",
      headers: {
        Accept: "*/*",
        "X-App-Token": input.appToken,
        "X-App-Access-Ts": String(input.nowSeconds),
        "X-App-Access-Sig": signature,
      },
      redirect: "error",
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch {
    throw new SumsubPrivacyAdapterError("Sumsub request could not be completed.", "provider_failed");
  }
  if (!response.ok) {
    throw new SumsubPrivacyAdapterError(`Sumsub request failed with status ${response.status}.`, "provider_failed");
  }
  return {
    body: await readBoundedBody(response, input.maximumBytes),
    mediaType: response.headers.get("content-type"),
  };
}

function parseJson(body: Buffer, label: string): JsonObject {
  try {
    return asObject(JSON.parse(body.toString("utf8")), label);
  } catch (error) {
    if (error instanceof SumsubPrivacyAdapterError) throw error;
    throw new SumsubPrivacyAdapterError(`${label} is not valid JSON.`, "provider_response_invalid");
  }
}

function providerExportError(message: string): SumsubPrivacyAdapterError {
  return new SumsubPrivacyAdapterError(message, "provider_export_missing");
}

function assertSafeProviderExportFile(entry: Entry): void {
  const fileName = entry.fileName;
  if (
    !fileName
    || Buffer.byteLength(fileName, "utf8") > 240
    || fileName !== fileName.normalize("NFC")
    || fileName.trim() !== fileName
    || fileName === "."
    || fileName === ".."
    || /[/\\\u0000-\u001f\u007f]/.test(fileName)
    || fileName.endsWith("/")
    || entry.isEncrypted()
    || ![0, 8].includes(entry.compressionMethod)
    || entry.uncompressedSize < 1
    || entry.compressedSize < 1
    || entry.uncompressedSize > 100 * 1024 * 1024
    || entry.uncompressedSize / entry.compressedSize > MAXIMUM_PROVIDER_EXPORT_COMPRESSION_RATIO
  ) {
    throw providerExportError("The Sumsub export archive contains an unsafe or unsupported file.");
  }
  const hostSystem = entry.versionMadeBy >>> 8;
  const unixFileType = (entry.externalFileAttributes >>> 16) & 0o170000;
  if (
    (hostSystem === 3 && unixFileType !== 0 && unixFileType !== 0o100000)
    || (entry.externalFileAttributes & 0x10) !== 0
  ) {
    throw providerExportError("The Sumsub export archive must contain regular files only.");
  }
}

async function readProviderExportEntry(
  zipFile: ZipFile,
  entry: Entry,
  maximumBytes: number,
): Promise<Buffer> {
  if (entry.uncompressedSize > maximumBytes) {
    throw providerExportError("The Sumsub export archive exceeds the approved byte limit.");
  }
  const stream = await zipFile.openReadStreamPromise(entry);
  const chunks: Buffer[] = [];
  let byteCount = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    byteCount += bytes.byteLength;
    if (byteCount > maximumBytes || byteCount > entry.uncompressedSize) {
      stream.destroy();
      throw providerExportError("The Sumsub export archive exceeds the approved byte limit.");
    }
    chunks.push(bytes);
  }
  const content = Buffer.concat(chunks, byteCount);
  if (
    content.byteLength !== entry.uncompressedSize
    || (crc32(content) >>> 0) !== (entry.crc32 >>> 0)
  ) {
    throw providerExportError("The Sumsub export archive file failed its integrity check.");
  }
  return content;
}

function decodeProviderExportText(content: Buffer, label: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    if (text.includes("\0")) throw new Error("NUL is not permitted");
    return text.startsWith("\uFEFF") ? text.slice(1) : text;
  } catch {
    throw providerExportError(`${label} must use valid UTF-8.`);
  }
}

function parseCsvRows(content: Buffer): string[][] {
  const text = decodeProviderExportText(content, "The Sumsub report");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let afterQuote = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    if (quoted) {
      if (character === "\"") {
        if (text[index + 1] === "\"") {
          cell += "\"";
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (afterQuote && ![",", "\r", "\n"].includes(character)) {
      throw providerExportError("The Sumsub report CSV has invalid text after a quoted value.");
    }
    if (character === "\"" && cell.length === 0 && !afterQuote) {
      quoted = true;
      continue;
    }
    if (character === ",") {
      row.push(cell);
      cell = "";
      afterQuote = false;
      continue;
    }
    if (character === "\r" || character === "\n") {
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      afterQuote = false;
      continue;
    }
    if (character === "\"") {
      throw providerExportError("The Sumsub report CSV has an invalid quote.");
    }
    cell += character;
  }
  if (quoted) {
    throw providerExportError("The Sumsub report CSV has an unterminated quoted value.");
  }
  if (row.length || cell.length || afterQuote) {
    row.push(cell);
    rows.push(row);
  }
  while (rows.length && rows.at(-1)?.every((value) => value === "")) rows.pop();
  if (rows.length !== 2) {
    throw providerExportError("The Sumsub report must contain one header and one applicant row.");
  }
  if (rows[0]!.length < 2 || rows[1]!.length !== rows[0]!.length) {
    throw providerExportError("The Sumsub report CSV column shape is invalid.");
  }
  return rows;
}

const sensitiveSumsubExportColumns = new Set([
  "addressState",
  "age",
  "ageAtVerification",
  "country",
  "countryOfBirth",
  "dateOfBirth",
  "email",
  "firstName",
  "firstNameEn",
  "ipCountry",
  "gender",
  "lastName",
  "lastNameEn",
  "middleName",
  "middleNameEn",
  "nationality",
  "phone",
  "placeOfBirth",
  "stateOfBirth",
  "tin",
  "lastPoiDate",
  "lastPoaDate",
]);

export async function parseSumsubProviderExportArchive(input: {
  content: Buffer;
  applicantId: string;
  externalUserId: string;
  settingsSha256: string;
  maximumBytes: number;
}): Promise<SumsubProviderExportArchiveEvidence> {
  const applicantId = boundedIdentifier(input.applicantId, "Sumsub applicant ID");
  const externalUserId = boundedIdentifier(input.externalUserId, "Sumsub external user ID");
  const settingsSha256 = exactSha256(input.settingsSha256, "Sumsub export settings SHA-256");
  if (
    !Buffer.isBuffer(input.content)
    || input.content.byteLength < 22
    || input.content.byteLength > input.maximumBytes
    || input.maximumBytes < 1_024
    || input.maximumBytes > 100 * 1024 * 1024
  ) {
    throw providerExportError("The Sumsub export archive size is invalid.");
  }

  let zipFile: ZipFile | undefined;
  try {
    zipFile = await fromBufferPromise(input.content, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true,
    });
    const files: Array<{ fileName: string; content: Buffer }> = [];
    let expandedBytes = 0;
    const names = new Set<string>();
    for await (const entry of zipFile.eachEntry()) {
      if (files.length >= MAXIMUM_PROVIDER_EXPORT_ENTRIES) {
        throw providerExportError("The Sumsub export archive must contain exactly two files.");
      }
      assertSafeProviderExportFile(entry);
      const normalizedName = entry.fileName.toLowerCase();
      if (names.has(normalizedName)) {
        throw providerExportError("The Sumsub export archive contains duplicate file names.");
      }
      names.add(normalizedName);
      const remainingBytes = input.maximumBytes - expandedBytes;
      const content = await readProviderExportEntry(zipFile, entry, remainingBytes);
      expandedBytes += content.byteLength;
      files.push({ fileName: entry.fileName, content });
    }
    if (files.length !== MAXIMUM_PROVIDER_EXPORT_ENTRIES) {
      throw providerExportError("The Sumsub export archive must contain one report and one settings file.");
    }
    const reports = files.filter((file) => file.fileName.toLowerCase().endsWith(".csv"));
    const settingsFiles = files.filter((file) =>
      !file.fileName.toLowerCase().endsWith(".csv")
      && /settings?/.test(file.fileName.toLowerCase()));
    if (reports.length !== 1 || settingsFiles.length !== 1) {
      throw providerExportError("The Sumsub export archive must contain one CSV report and one settings file.");
    }
    const report = reports[0]!;
    const settings = settingsFiles[0]!;
    if (sha256(settings.content) !== settingsSha256) {
      throw providerExportError("The Sumsub export settings file does not match its recorded SHA-256.");
    }
    const [columns, values] = parseCsvRows(report.content);
    if (new Set(columns).size !== columns.length) {
      throw providerExportError("The Sumsub report contains duplicate columns.");
    }
    const applicantIndex = columns.indexOf("applicantId");
    const externalUserIndex = columns.indexOf("externalUserId");
    if (
      applicantIndex < 0
      || externalUserIndex < 0
      || values![applicantIndex] !== applicantId
      || values![externalUserIndex] !== externalUserId
    ) {
      throw new SumsubPrivacyAdapterError(
        "The Sumsub report does not match the immutable applicant correlation.",
        "correlation_mismatch",
      );
    }
    const sensitiveColumns = columns.filter((column) =>
      sensitiveSumsubExportColumns.has(column));
    if (!sensitiveColumns.length) {
      throw providerExportError("The Sumsub report does not prove higher-sensitive export access.");
    }
    return {
      reportFileName: report.fileName,
      settingsFileName: settings.fileName,
      reportColumns: columns,
      sensitiveColumns,
      entryCount: 1,
    };
  } catch (error) {
    if (error instanceof SumsubPrivacyAdapterError) throw error;
    throw providerExportError("The Sumsub export archive is invalid.");
  } finally {
    zipFile?.close();
  }
}

export async function collectSumsubPrivacyRecords(input: {
  appToken: string;
  secretKey: string;
  reference: SumsubPrivacyReference;
  providerExport: SumsubProviderExportArtifact;
  timeoutMs: number;
  maximumRecords: number;
  maximumBytes: number;
  maximumArtifacts: number;
  request?: RequestFunction;
  now?: Date;
}): Promise<SumsubPrivacyCollection> {
  const appToken = boundedIdentifier(input.appToken, "Sumsub privacy app token");
  const secretKey = boundedIdentifier(input.secretKey, "Sumsub privacy secret key");
  const applicantId = boundedIdentifier(input.reference.applicantId, "Sumsub applicant ID");
  const externalUserId = boundedIdentifier(input.reference.externalUserId, "Sumsub external user ID");
  const inspectionId = boundedIdentifier(input.reference.inspectionId, "Sumsub inspection ID");
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 120_000) {
    throw new SumsubPrivacyAdapterError("Sumsub timeout is invalid.", "invalid_input");
  }
  if (!Number.isInteger(input.maximumRecords) || input.maximumRecords < 8 || input.maximumRecords > 100_000) {
    throw new SumsubPrivacyAdapterError("Sumsub record limit is invalid.", "invalid_input");
  }
  if (!Number.isInteger(input.maximumBytes) || input.maximumBytes < 1_024 || input.maximumBytes > 100 * 1024 * 1024) {
    throw new SumsubPrivacyAdapterError("Sumsub byte limit is invalid.", "invalid_input");
  }
  if (!Number.isInteger(input.maximumArtifacts) || input.maximumArtifacts < 1 || input.maximumArtifacts > 1_000) {
    throw new SumsubPrivacyAdapterError("Sumsub artifact limit is invalid.", "invalid_input");
  }
  const reportReference = boundedIdentifier(input.providerExport.reportReference, "Sumsub export report reference", 200);
  const reportSha256 = exactSha256(input.providerExport.sha256, "Sumsub export SHA-256");
  const settingsSha256 = exactSha256(input.providerExport.settingsSha256, "Sumsub export settings SHA-256");
  const malwareScanEvidenceSha256 = exactSha256(
    input.providerExport.malwareScanEvidenceSha256,
    "Sumsub export malware-scan evidence SHA-256",
  );
  const archiveEvidence = await parseSumsubProviderExportArchive({
    content: input.providerExport.content,
    applicantId,
    externalUserId,
    settingsSha256,
    maximumBytes: input.maximumBytes,
  });
  if (
    input.providerExport.sensitiveTier !== "higher_sensitive_data"
    || input.providerExport.entryCount !== 1
    || input.providerExport.applicantId !== applicantId
    || input.providerExport.externalUserId !== externalUserId
    || input.providerExport.content.byteLength < 1
    || !(
      input.providerExport.content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
      || input.providerExport.content.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    )
    || sha256(input.providerExport.content) !== reportSha256
  ) {
    throw new SumsubPrivacyAdapterError(
      "A verified higher-sensitive Sumsub export archive is required.",
      "provider_export_missing",
    );
  }
  const request = input.request ?? fetch;
  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1_000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
    throw new SumsubPrivacyAdapterError("Sumsub request time is invalid.", "invalid_input");
  }
  let remainingBytes = input.maximumBytes - input.providerExport.content.byteLength;
  if (remainingBytes < 1) {
    throw new SumsubPrivacyAdapterError("Sumsub export exceeds the approved byte limit.", "provider_response_too_large");
  }
  const json = async (path: string, label: string) => {
    const result = await requestSumsub({
      appToken,
      secretKey,
      path,
      timeoutMs: input.timeoutMs,
      maximumBytes: remainingBytes,
      request,
      nowSeconds,
    });
    remainingBytes -= result.body.byteLength;
    return parseJson(result.body, label);
  };

  const encodedApplicantId = encodeURIComponent(applicantId);
  const applicant = await json(`/resources/applicants/${encodedApplicantId}/one`, "Sumsub applicant response");
  if (
    applicant.id !== applicantId
    || applicant.externalUserId !== externalUserId
    || applicant.inspectionId !== inspectionId
  ) {
    throw new SumsubPrivacyAdapterError(
      "Sumsub applicant correlation does not match the immutable application.",
      "correlation_mismatch",
    );
  }
  const reviewHistory = await json(
    `/resources/applicants/${encodedApplicantId}/review/history`,
    "Sumsub review-history response",
  );
  const verificationSteps = await json(
    `/resources/applicants/${encodedApplicantId}/requiredIdDocsStatus`,
    "Sumsub verification-step response",
  );
  const documentMetadata = await json(
    `/resources/applicants/${encodedApplicantId}/metadata/resources`,
    "Sumsub document-metadata response",
  );
  const consents = await json(
    `/resources/applicants/${encodedApplicantId}/acceptedAgreements`,
    "Sumsub consent response",
  );
  const ipChecks = await json(
    `/resources/checks/latest?type=IP_CHECK&applicantId=${encodedApplicantId}`,
    "Sumsub IP-check response",
  );
  const applicantActions = await json(
    `/resources/applicantActions/-;applicantId=${encodedApplicantId}?limit=${ACTION_PAGE_LIMIT}&offset=0`,
    "Sumsub applicant-action response",
  );
  const amlCase = await json(
    `/resources/api/applicants/${encodedApplicantId}/amlCase`,
    "Sumsub AML-case response",
  );

  const documents = asObjectArray(documentMetadata.items, "Sumsub document metadata items");
  if (documents.length > MAXIMUM_DOCUMENTS || documents.length + 1 > input.maximumArtifacts) {
    throw new SumsubPrivacyAdapterError("Sumsub returned too many document artifacts.", "provider_response_too_large");
  }
  if (
    typeof documentMetadata.totalItems !== "number"
    || !Number.isInteger(documentMetadata.totalItems)
    || documentMetadata.totalItems !== documents.length
  ) {
    throw new SumsubPrivacyAdapterError("Sumsub document metadata is incomplete.", "provider_response_invalid");
  }
  const actions = Array.isArray(applicantActions.items)
    ? asObjectArray(applicantActions.items, "Sumsub applicant actions")
    : Array.isArray(applicantActions.list)
      ? asObjectArray(applicantActions.list, "Sumsub applicant actions")
      : [];
  const actionTotal = applicantActions.totalItems;
  if (
    typeof actionTotal === "number"
    && (!Number.isInteger(actionTotal) || actionTotal !== actions.length)
  ) {
    throw new SumsubPrivacyAdapterError("Sumsub applicant actions require another page.", "provider_response_invalid");
  }
  if (actions.length >= ACTION_PAGE_LIMIT && actionTotal === undefined) {
    throw new SumsubPrivacyAdapterError("Sumsub applicant actions may be truncated.", "provider_response_invalid");
  }

  const artifacts: PrivacyPackageArtifactInput[] = [{
    sourceKey: "external.identity_verification.provider",
    componentKey: "provider_export_artifacts",
    mediaType: "application/zip",
    content: input.providerExport.content,
  }];
  const seenImageIds = new Set<string>();
  for (const document of documents) {
    const imageId = boundedIdentifier(String(document.id ?? ""), "Sumsub image ID", 160);
    if (seenImageIds.has(imageId)) {
      throw new SumsubPrivacyAdapterError("Sumsub returned a duplicate image ID.", "provider_response_invalid");
    }
    seenImageIds.add(imageId);
    const result = await requestSumsub({
      appToken,
      secretKey,
      path: `/resources/inspections/${encodeURIComponent(inspectionId)}/resources/${encodeURIComponent(imageId)}`,
      timeoutMs: input.timeoutMs,
      maximumBytes: remainingBytes,
      request,
      nowSeconds,
    });
    remainingBytes -= result.body.byteLength;
    if (result.body.byteLength < 1) {
      throw new SumsubPrivacyAdapterError("Sumsub returned an empty document artifact.", "provider_response_invalid");
    }
    const idDocDef = document.idDocDef && typeof document.idDocDef === "object"
      ? document.idDocDef as JsonObject
      : {};
    const documentType = String(idDocDef.idDocType ?? "").toUpperCase();
    const componentKey = (
      documentType.includes("SELFIE")
      || documentType.includes("VIDEO")
      || String(document.source ?? "").toLowerCase() === "liveness"
    ) ? "biometric_media" : "identity_documents";
    artifacts.push({
      sourceKey: "external.identity_verification.provider",
      componentKey,
      mediaType: supportedMediaType(result.mediaType),
      content: result.body,
    });
  }

  const records: JsonObject[] = [
    { componentKey: "applicant_profile", data: applicant },
    { componentKey: "review_results", history: reviewHistory, verificationSteps },
    { componentKey: "identity_documents", metadata: documents.filter((document) => {
      const type = String((document.idDocDef as JsonObject | undefined)?.idDocType ?? "").toUpperCase();
      return !type.includes("SELFIE") && !type.includes("VIDEO") && String(document.source ?? "").toLowerCase() !== "liveness";
    }) },
    { componentKey: "biometric_media", metadata: documents.filter((document) => {
      const type = String((document.idDocDef as JsonObject | undefined)?.idDocType ?? "").toUpperCase();
      return type.includes("SELFIE") || type.includes("VIDEO") || String(document.source ?? "").toLowerCase() === "liveness";
    }) },
    { componentKey: "questionnaire_and_consent", consents, applicantActions: actions },
    { componentKey: "device_and_network_metadata", ipChecks },
    { componentKey: "screening_and_watchlist_results", amlCase },
    {
      componentKey: "provider_export_artifacts",
      reportReference,
      generatedAt: parseProviderTime(input.providerExport.generatedAt, "Sumsub export generation time"),
      downloadedAt: parseProviderTime(input.providerExport.downloadedAt, "Sumsub export download time"),
      sensitiveTier: input.providerExport.sensitiveTier,
      entryCount: input.providerExport.entryCount,
      sha256: reportSha256,
      byteCount: input.providerExport.content.byteLength,
      settingsSha256,
      malwareScanEvidenceSha256,
      reportFileName: archiveEvidence.reportFileName,
      settingsFileName: archiveEvidence.settingsFileName,
      reportColumns: archiveEvidence.reportColumns,
      sensitiveColumns: archiveEvidence.sensitiveColumns,
    },
  ];
  if (records.length > input.maximumRecords) {
    throw new SumsubPrivacyAdapterError("Sumsub record count exceeds the approved limit.", "provider_response_too_large");
  }
  return { records, artifacts };
}
