import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";
import {
  MalwareDetectedError,
  MalwareScannerUnavailableError,
  scanBufferWithClamAv,
} from "./malware-scanner.js";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
// Base64 expands binary data by roughly 4/3. Bound the *encoded* input before
// decoding so a request cannot force an oversized transient allocation.
const MAX_BASE64_UPLOAD_CHARS = Math.ceil(MAX_UPLOAD_BYTES * (4 / 3)) + 4;
const MAX_DATA_URI_PREFIX_CHARS = 512;
const DEFAULT_MIME_TYPE = "application/octet-stream";

const ALLOWED_DOCUMENT_MIME_TYPES = new Set([
  "application/zip",
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/tiff",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-outlook",
  "image/vnd.dwg",
]);

interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  kmsKeyId?: string;
  forcePathStyle: boolean;
}

interface CloudinaryConfig {
  cloudName: string;
  apiKey: string;
  apiSecret: string;
  uploadFolder?: string;
}

function sanitizeFilename(name: string): string {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed) return "document.bin";
  const normalized = trimmed
    .replace(/[^a-z0-9.\-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "document.bin";
}

export function decodeDocumentBase64(input: string): Buffer {
  const trimmed = input.trim();
  if (trimmed.length > MAX_BASE64_UPLOAD_CHARS + MAX_DATA_URI_PREFIX_CHARS) {
    throw new HttpError(422, `File exceeds max size of ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`);
  }

  const dataUri = /^data:[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+;base64,/i.exec(trimmed);
  if (/^data:/i.test(trimmed) && !dataUri) {
    throw new HttpError(422, "Invalid base64 data URI");
  }
  const payload = dataUri ? trimmed.slice(dataUri[0].length) : trimmed;
  const normalized = payload.replace(/\s+/g, "");
  if (!normalized) throw new HttpError(422, "contentBase64 payload is empty");
  if (normalized.length > MAX_BASE64_UPLOAD_CHARS) {
    throw new HttpError(422, `File exceeds max size of ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`);
  }
  if (
    normalized.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)
  ) {
    throw new HttpError(422, "Invalid base64 payload");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.toString("base64") !== normalized) throw new HttpError(422, "Invalid base64 payload");

  if (!buffer.length) throw new HttpError(422, "Decoded file is empty");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      422,
      `File exceeds max size of ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`,
    );
  }

  return buffer;
}

function startsWith(buffer: Buffer, signature: readonly number[]): boolean {
  return signature.every((byte, index) => buffer[index] === byte);
}

function detectBinaryFormat(buffer: Buffer): "pdf" | "jpeg" | "png" | "webp" | "gif" | "tiff" | "zip" | "ole" | "dwg" | null {
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "pdf";
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return "jpeg";
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "png";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "webp";
  if (buffer.subarray(0, 6).toString("ascii") === "GIF87a" || buffer.subarray(0, 6).toString("ascii") === "GIF89a") return "gif";
  if (startsWith(buffer, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buffer, [0x4d, 0x4d, 0x00, 0x2a])) return "tiff";
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buffer, [0x50, 0x4b, 0x05, 0x06])) return "zip";
  if (startsWith(buffer, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return "ole";
  if (buffer.subarray(0, 4).toString("ascii") === "AC10") return "dwg";
  return null;
}

function formatMatchesMimeType(format: NonNullable<ReturnType<typeof detectBinaryFormat>>, mimeType: string): boolean {
  switch (mimeType) {
    case "application/zip": return format === "zip";
    case "application/pdf": return format === "pdf";
    case "image/jpeg": return format === "jpeg";
    case "image/png": return format === "png";
    case "image/webp": return format === "webp";
    case "image/gif": return format === "gif";
    case "image/tiff": return format === "tiff";
    case "application/msword":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-outlook": return format === "ole";
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": return format === "zip";
    case "image/vnd.dwg": return format === "dwg";
    default: return false;
  }
}

export function validateDocumentBinaryType(buffer: Buffer, mimeType?: string): void {
  const declaredMimeType = mimeType?.trim().toLowerCase();
  const format = detectBinaryFormat(buffer);
  if (!format) throw new HttpError(422, "The uploaded file type could not be verified.");
  if (!declaredMimeType || declaredMimeType === DEFAULT_MIME_TYPE) return;
  if (!ALLOWED_DOCUMENT_MIME_TYPES.has(declaredMimeType)) {
    throw new HttpError(422, "This file type is not allowed.");
  }
  if (!formatMatchesMimeType(format, declaredMimeType)) {
    throw new HttpError(422, "The uploaded file content does not match its declared type.");
  }
}

/**
 * Every binary persistence entry point calls this before selecting a storage
 * provider. In production, configuration validation requires a scanner and
 * this function fails closed when it cannot attest the content.
 */
async function prepareDocumentBuffer(buffer: Buffer, mimeType?: string, requireScanner = false): Promise<Buffer> {
  validateDocumentBinaryType(buffer, mimeType);
  if (!env.MALWARE_SCAN_HOST) {
    if (requireScanner || env.MALWARE_SCAN_REQUIRED || env.NODE_ENV === "production") {
      throw new HttpError(503, "Document scanning is unavailable. The file was not stored.");
    }
    return buffer;
  }

  try {
    await scanBufferWithClamAv(buffer, {
      host: env.MALWARE_SCAN_HOST,
      port: env.MALWARE_SCAN_PORT,
      timeoutMs: env.MALWARE_SCAN_TIMEOUT_MS,
    });
  } catch (error) {
    if (error instanceof MalwareDetectedError) {
      throw new HttpError(422, "The uploaded file failed security screening and was not stored.");
    }
    if (error instanceof MalwareScannerUnavailableError) {
      throw new HttpError(503, "Document scanning is unavailable. The file was not stored.");
    }
    throw error;
  }

  return buffer;
}

async function prepareDocumentPayload(input: string, mimeType?: string, requireScanner = false): Promise<Buffer> {
  return prepareDocumentBuffer(decodeDocumentBase64(input), mimeType, requireScanner);
}

function normalizeMimeType(mimeType?: string): string {
  const normalized = mimeType?.trim().toLowerCase();
  if (!normalized) return DEFAULT_MIME_TYPE;
  return normalized;
}

function resolveLocalStoragePath(objectKey: string): string {
  if (!objectKey || objectKey.includes("\0") || path.isAbsolute(objectKey)) {
    throw new HttpError(422, "Invalid local storage key");
  }
  const storageRoot = path.resolve(process.cwd(), env.FILE_STORAGE_DIR);
  const absolutePath = path.resolve(storageRoot, objectKey);
  if (absolutePath !== storageRoot && !absolutePath.startsWith(`${storageRoot}${path.sep}`)) {
    throw new HttpError(422, "Invalid local storage key");
  }
  return absolutePath;
}

function assertSafeObjectKey(objectKey: string): void {
  if (!objectKey || objectKey.includes("\0") || objectKey.startsWith("/") || objectKey.split("/").some((part) => part === "..")) {
    throw new HttpError(422, "Invalid object storage key");
  }
}

function toObjectKey(scope: string, resourceId: string, filename: string): string {
  const safeFilename = sanitizeFilename(filename);
  const extension = path.extname(safeFilename);
  const basename = path.basename(safeFilename, extension);
  const uniqueName = `${Date.now()}_${randomBytes(4).toString("hex")}_${basename}${extension || ".bin"}`;

  const prefix = env.S3_KEY_PREFIX?.replace(/^\/+|\/+$/g, "");
  const base = path.posix.join(scope, resourceId, uniqueName);
  return prefix ? path.posix.join(prefix, base) : base;
}

function toHex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

function hmacSha256(
  key: string | Buffer,
  value: string,
  encoding: "hex" | "buffer" = "buffer",
): string | Buffer {
  const digest = createHmac("sha256", key).update(value, "utf8");
  return encoding === "hex" ? digest.digest("hex") : digest.digest();
}

function encodeRfc3986(input: string): string {
  return encodeURIComponent(input).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function encodeS3ObjectKey(key: string): string {
  return key
    .split("/")
    .map((segment) => encodeRfc3986(segment))
    .join("/");
}

function formatAmzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function resolveS3Config(): S3Config | null {
  if (!env.S3_BUCKET || !env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
    return null;
  }
  return {
    bucket: env.S3_BUCKET,
    region: env.S3_REGION,
    endpoint: env.S3_ENDPOINT,
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
    sessionToken: env.S3_SESSION_TOKEN,
    kmsKeyId: env.S3_KMS_KEY_ID,
    forcePathStyle: env.S3_FORCE_PATH_STYLE,
  };
}

function resolveCloudinaryConfig(): CloudinaryConfig | null {
  if (
    !env.CLOUDINARY_CLOUD_NAME ||
    !env.CLOUDINARY_API_KEY ||
    !env.CLOUDINARY_API_SECRET
  ) {
    return null;
  }
  return {
    cloudName: env.CLOUDINARY_CLOUD_NAME,
    apiKey: env.CLOUDINARY_API_KEY,
    apiSecret: env.CLOUDINARY_API_SECRET,
    uploadFolder: env.CLOUDINARY_UPLOAD_FOLDER,
  };
}

function buildS3RequestParts(config: S3Config, objectKey: string): {
  url: string;
  host: string;
  canonicalUri: string;
} {
  const endpoint = new URL(
    config.endpoint ?? `https://s3.${config.region}.amazonaws.com`,
  );
  const endpointPath =
    endpoint.pathname === "/"
      ? ""
      : endpoint.pathname.replace(/\/+$/g, "");
  const encodedObjectKey = encodeS3ObjectKey(objectKey);

  if (!config.forcePathStyle && endpointPath) {
    throw new HttpError(
      500,
      "S3 endpoint paths require S3_FORCE_PATH_STYLE=true",
    );
  }

  if (config.forcePathStyle) {
    const canonicalUri = `${endpointPath}/${config.bucket}/${encodedObjectKey}`
      .replace(/\/{2,}/g, "/")
      .replace(/^$/, "/");
    return {
      url: `${endpoint.origin}${canonicalUri}`,
      host: endpoint.host,
      canonicalUri,
    };
  }

  const host = `${config.bucket}.${endpoint.host}`;
  const canonicalUri = `${endpointPath}/${encodedObjectKey}`.replace(
    /\/{2,}/g,
    "/",
  );
  return {
    url: `${endpoint.protocol}//${host}${canonicalUri}`,
    host,
    canonicalUri,
  };
}

function getSigningKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
): Buffer {
  const kDate = hmacSha256(`AWS4${secretAccessKey}`, dateStamp) as Buffer;
  const kRegion = hmacSha256(kDate, region) as Buffer;
  const kService = hmacSha256(kRegion, "s3") as Buffer;
  return hmacSha256(kService, "aws4_request") as Buffer;
}

async function persistToS3(params: {
  objectKey: string;
  contentType: string;
  payload: Buffer;
}): Promise<string> {
  const config = resolveS3Config();
  if (!config) {
    throw new HttpError(
      500,
      "S3 storage selected but S3 credentials are incomplete",
    );
  }

  const request = buildS3RequestParts(config, params.objectKey);
  const now = new Date();
  const amzDate = formatAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = toHex(params.payload);

  const canonicalHeaderPairs: Array<[string, string]> = [
    ["host", request.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", amzDate],
  ];
  if (config.kmsKeyId) {
    canonicalHeaderPairs.push(["x-amz-server-side-encryption", "aws:kms"]);
    canonicalHeaderPairs.push(["x-amz-server-side-encryption-aws-kms-key-id", config.kmsKeyId]);
  }
  if (config.sessionToken) {
    canonicalHeaderPairs.push(["x-amz-security-token", config.sessionToken]);
  }

  const canonicalHeaders = canonicalHeaderPairs
    .map(([name, value]) => `${name}:${value}\n`)
    .join("");
  const signedHeaders = canonicalHeaderPairs.map(([name]) => name).join(";");

  const canonicalRequest = [
    "PUT",
    request.canonicalUri,
    "",
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    toHex(canonicalRequest),
  ].join("\n");

  const signature = hmacSha256(
    getSigningKey(config.secretAccessKey, dateStamp, config.region),
    stringToSign,
    "hex",
  ) as string;

  const headers: Record<string, string> = {
    Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "Content-Type": params.contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  if (config.sessionToken) {
    headers["x-amz-security-token"] = config.sessionToken;
  }
  if (config.kmsKeyId) {
    headers["x-amz-server-side-encryption"] = "aws:kms";
    headers["x-amz-server-side-encryption-aws-kms-key-id"] = config.kmsKeyId;
  }

  const response = await fetch(request.url, {
    method: "PUT",
    headers,
    body: new Uint8Array(params.payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new HttpError(
      502,
      `S3 upload failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
    );
  }

  return `s3://${config.bucket}/${params.objectKey}`;
}

async function persistToCloudinary(params: {
  objectKey: string;
  contentType: string;
  payload: Buffer;
}): Promise<string> {
  const config = resolveCloudinaryConfig();
  if (!config) {
    throw new HttpError(
      500,
      "Cloudinary storage selected but Cloudinary credentials are incomplete",
    );
  }

  const timestamp = Math.floor(Date.now() / 1000).toString();
  const publicId = params.objectKey.replace(/\.[a-z0-9]+$/i, "");
  const signatureParts = [
    config.uploadFolder ? `folder=${config.uploadFolder}` : null,
    `public_id=${publicId}`,
    `timestamp=${timestamp}`,
  ].filter((part): part is string => Boolean(part));
  const signaturePayload = signatureParts.join("&");
  const signature = createHash("sha1")
    .update(`${signaturePayload}${config.apiSecret}`)
    .digest("hex");

  const formData = new FormData();
  formData.set(
    "file",
    new Blob([new Uint8Array(params.payload)], { type: params.contentType }),
    path.posix.basename(params.objectKey),
  );
  formData.set("api_key", config.apiKey);
  formData.set("timestamp", timestamp);
  formData.set("signature", signature);
  formData.set("public_id", publicId);
  if (config.uploadFolder) {
    formData.set("folder", config.uploadFolder);
  }

  const response = await fetch(
    `https://api.cloudinary.com/v1_1/${encodeURIComponent(config.cloudName)}/auto/upload`,
    {
      method: "POST",
      body: formData,
    },
  );

  const payload = await response.json().catch(() => null);
  const secureUrl =
    payload && typeof payload === "object" && "secure_url" in payload
      ? (payload.secure_url as string)
      : null;

  if (!response.ok || !secureUrl) {
    const reason =
      payload &&
      typeof payload === "object" &&
      "error" in payload &&
      payload.error &&
      typeof payload.error === "object" &&
      "message" in payload.error &&
      typeof payload.error.message === "string"
        ? payload.error.message
        : `Cloudinary upload failed with status ${response.status}`;
    throw new HttpError(502, reason);
  }

  return secureUrl;
}

async function persistToLocal(params: {
  objectKey: string;
  payload: Buffer;
}): Promise<string> {
  const absolutePath = resolveLocalStoragePath(params.objectKey);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, params.payload);
  return `local://${params.objectKey}`;
}

/**
 * Retrieve a stored file by its storageKey.
 * - Cloudinary keys are URLs (https://): returns a redirect URL directly.
 * - S3 keys (s3://bucket/key): fetches the object and returns its buffer.
 * - Local keys (local://objectKey): reads from local filesystem.
 */
export async function retrieveFile(storageKey: string): Promise<{
  buffer: Buffer;
  redirectUrl?: string;
}> {
  // Cloudinary stores a full HTTPS URL — return it for redirect
  if (storageKey.startsWith("https://") || storageKey.startsWith("http://")) {
    return { buffer: Buffer.alloc(0), redirectUrl: storageKey };
  }

  if (storageKey.startsWith("s3://")) {
    const config = resolveS3Config();
    if (!config) throw new HttpError(500, "S3 credentials not configured");

    // s3://bucket/objectKey
    const withoutScheme = storageKey.slice("s3://".length);
    const slashIdx = withoutScheme.indexOf("/");
    const objectKey = slashIdx >= 0 ? withoutScheme.slice(slashIdx + 1) : withoutScheme;
    assertSafeObjectKey(objectKey);

    const request = buildS3RequestParts(config, objectKey);
    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"; // empty body

    const canonicalHeaderPairs: Array<[string, string]> = [
      ["host", request.host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", amzDate],
    ];
    if (config.sessionToken) {
      canonicalHeaderPairs.push(["x-amz-security-token", config.sessionToken]);
    }

    const canonicalHeaders = canonicalHeaderPairs.map(([n, v]) => `${n}:${v}\n`).join("");
    const signedHeaders = canonicalHeaderPairs.map(([n]) => n).join(";");

    const canonicalRequest = ["GET", request.canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, toHex(canonicalRequest)].join("\n");
    const signature = hmacSha256(getSigningKey(config.secretAccessKey, dateStamp, config.region), stringToSign, "hex") as string;

    const headers: Record<string, string> = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;

    const response = await fetch(request.url, { method: "GET", headers });
    if (!response.ok) {
      const body = await response.text();
      throw new HttpError(502, `S3 retrieval failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return { buffer: Buffer.from(arrayBuffer) };
  }

  if (storageKey.startsWith("local://")) {
    const objectKey = storageKey.slice("local://".length);
    const absolutePath = resolveLocalStoragePath(objectKey);
    try {
      const buffer = await readFile(absolutePath);
      return { buffer };
    } catch {
      throw new HttpError(404, "File not found in local storage");
    }
  }

  throw new HttpError(422, `Unsupported storageKey format: ${storageKey}`);
}

/**
 * Deletes an object only by its persisted storage key. S3 deletion is signed
 * with the same restricted bucket credentials as persistence; the bucket name
 * embedded in a key is checked so this cannot become an arbitrary S3 delete.
 * S3 and local deletion are idempotent for cleanup retries.
 */
export async function deleteStoredFile(storageKey: string): Promise<void> {
  if (storageKey.startsWith("s3://")) {
    const config = resolveS3Config();
    if (!config) throw new HttpError(500, "S3 credentials not configured");

    const withoutScheme = storageKey.slice("s3://".length);
    const slashIndex = withoutScheme.indexOf("/");
    const bucket = slashIndex >= 0 ? withoutScheme.slice(0, slashIndex) : "";
    const objectKey = slashIndex >= 0 ? withoutScheme.slice(slashIndex + 1) : "";
    if (bucket !== config.bucket) throw new HttpError(422, "S3 storage key bucket is not configured for this service");
    assertSafeObjectKey(objectKey);

    const request = buildS3RequestParts(config, objectKey);
    const now = new Date();
    const amzDate = formatAmzDate(now);
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const canonicalHeaderPairs: Array<[string, string]> = [
      ["host", request.host],
      ["x-amz-content-sha256", payloadHash],
      ["x-amz-date", amzDate],
    ];
    if (config.sessionToken) canonicalHeaderPairs.push(["x-amz-security-token", config.sessionToken]);
    const canonicalHeaders = canonicalHeaderPairs.map(([name, value]) => `${name}:${value}\n`).join("");
    const signedHeaders = canonicalHeaderPairs.map(([name]) => name).join(";");
    const credentialScope = `${dateStamp}/${config.region}/s3/aws4_request`;
    const canonicalRequest = ["DELETE", request.canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const stringToSign = ["AWS4-HMAC-SHA256", amzDate, credentialScope, toHex(canonicalRequest)].join("\n");
    const signature = hmacSha256(getSigningKey(config.secretAccessKey, dateStamp, config.region), stringToSign, "hex") as string;
    const headers: Record<string, string> = {
      Authorization: `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
    };
    if (config.sessionToken) headers["x-amz-security-token"] = config.sessionToken;

    const response = await fetch(request.url, { method: "DELETE", headers });
    if (!response.ok) {
      const body = await response.text();
      throw new HttpError(502, `S3 deletion failed with status ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return;
  }

  if (storageKey.startsWith("local://")) {
    const objectKey = storageKey.slice("local://".length);
    const absolutePath = resolveLocalStoragePath(objectKey);
    try {
      await unlink(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  // Cloudinary is rejected in production by environment validation. Keep an
  // explicit failure here rather than guessing a public ID from an HTTPS URL.
  throw new HttpError(422, "Storage-key provider does not support safe deletion");
}

/**
 * Persists a system-generated privacy package only to private storage. Public
 * media providers are never eligible; production configuration additionally
 * requires S3 with a customer-managed KMS key.
 */
export async function persistPrivacyPackageBinary(params: {
  deliveryId: string;
  content: Buffer;
  canonicalFormat: "application/vnd.fractal.privacy-package+json;version=1"
    | "application/vnd.fractal.privacy-package+tar;version=2";
}): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  if (!params.content.length || params.content.length > 100 * 1024 * 1024) {
    throw new HttpError(422, "Privacy package size is outside the governed storage limit.");
  }
  const isArchive = params.canonicalFormat
    === "application/vnd.fractal.privacy-package+tar;version=2";
  const objectKey = toObjectKey(
    "privacy-packages",
    params.deliveryId,
    isArchive ? "privacy-package.tar" : "privacy-package.json",
  );
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    storageKey = await persistToS3({
      objectKey,
      contentType: params.canonicalFormat,
      payload: params.content,
    });
  } else {
    if (env.NODE_ENV === "production") throw new HttpError(503, "Private privacy-package storage is unavailable.");
    storageKey = await persistToLocal({ objectKey, payload: params.content });
  }
  return { storageKey, sha256: toHex(params.content), bytes: params.content.byteLength };
}

/** Persist a subject-bound external privacy snapshot only to private storage. */
export async function persistPrivacyExternalSnapshotBinary(params: {
  snapshotId: string;
  content: Buffer;
}): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  if (!params.content.length || params.content.length > 100 * 1024 * 1024) {
    throw new HttpError(422, "External privacy snapshot size is outside the governed storage limit.");
  }
  const objectKey = toObjectKey("privacy-external-snapshots", params.snapshotId, "snapshot.json");
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    storageKey = await persistToS3({
      objectKey,
      contentType: "application/vnd.fractal.privacy-external-snapshot+json;version=1",
      payload: params.content,
    });
  } else {
    if (env.NODE_ENV === "production") {
      throw new HttpError(503, "Private external privacy snapshot storage is unavailable.");
    }
    storageKey = await persistToLocal({ objectKey, payload: params.content });
  }
  return { storageKey, sha256: toHex(params.content), bytes: params.content.byteLength };
}

/** Persist one malware-screened Sumsub provider export to private staging. */
export async function persistSumsubPrivacyExportBinary(params: {
  exportId: string;
  content: Buffer;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
  scanner: "clamav_instream";
  scannedAt: Date;
}> {
  if (!params.content.length || params.content.length > 100 * 1024 * 1024) {
    throw new HttpError(422, "Sumsub privacy export size is outside the governed storage limit.");
  }
  const buffer = await prepareDocumentBuffer(params.content, "application/zip", true);
  const scannedAt = new Date();
  const objectKey = toObjectKey("privacy-provider-exports", params.exportId, "sumsub-export.zip");
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    storageKey = await persistToS3({
      objectKey,
      contentType: "application/zip",
      payload: buffer,
    });
  } else {
    if (env.NODE_ENV === "production") {
      throw new HttpError(503, "Private Sumsub privacy-export storage is unavailable.");
    }
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }
  return {
    storageKey,
    sha256: toHex(buffer),
    bytes: buffer.byteLength,
    scanner: "clamav_instream",
    scannedAt,
  };
}

export async function persistDossierBinary(params: {
  applicationId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("dossiers", params.applicationId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);

  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try {
      storageKey = await persistToS3({
        objectKey,
        contentType,
        payload: buffer,
      });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "unknown S3 upload error";
      console.warn(
        `[storage] S3 upload failed, falling back to local storage: ${reason}`,
      );
      storageKey = await persistToLocal({
        objectKey,
        payload: buffer,
      });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try {
      storageKey = await persistToCloudinary({
        objectKey,
        contentType,
        payload: buffer,
      });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "unknown Cloudinary upload error";
      console.warn(
        `[storage] Cloudinary upload failed, falling back to local storage: ${reason}`,
      );
      storageKey = await persistToLocal({
        objectKey,
        payload: buffer,
      });
    }
  } else {
    storageKey = await persistToLocal({
      objectKey,
      payload: buffer,
    });
  }

  return {
    storageKey,
    sha256: toHex(buffer),
    bytes: buffer.byteLength,
  };
}

/** Support evidence may never use the non-production scanner bypass. */
export async function persistSupportAttachmentBinary(params: {
  caseId: string; filename: string; content: Buffer; mimeType: string;
}): Promise<{ storageKey: string; sha256: string; bytes: number; scanner: "clamav_instream"; scannedAt: Date }> {
  const buffer = await prepareDocumentBuffer(params.content, params.mimeType, true);
  const scannedAt = new Date();
  const objectKey = toObjectKey("support-case-attachments", params.caseId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try { storageKey = await persistToS3({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try { storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else storageKey = await persistToLocal({ objectKey, payload: buffer });
  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength, scanner: "clamav_instream", scannedAt };
}

/** Stores immutable evidence used by PostgreSQL-governed offering decisions. */
export async function persistGovernanceEvidenceBinary(params: {
  organizationId: string;
  offeringId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("governance-evidence", `${params.organizationId}/${params.offeringId}`, params.filename);
  const contentType = normalizeMimeType(params.mimeType);
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try { storageKey = await persistToS3({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try { storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }
  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

/** Stores immutable KYB and representative-authority evidence for one organization. */
export async function persistOrganizationVerificationEvidenceBinary(params: {
  organizationId: string;
  evidenceType: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey(
    "organization-verification-evidence",
    `${params.organizationId}/${params.evidenceType}`,
    params.filename,
  );
  const contentType = normalizeMimeType(params.mimeType);
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try { storageKey = await persistToS3({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try { storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }
  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

/** Stores source documents before an offering publication request is submitted. */
export async function persistOfferingPublicationEvidenceBinary(params: {
  organizationId: string;
  evidenceKind: "agreement" | "disclosure_bundle" | "asset_dossier";
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("offering-publication-evidence", `${params.organizationId}/${params.evidenceKind}`, params.filename);
  const contentType = normalizeMimeType(params.mimeType);
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try { storageKey = await persistToS3({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try { storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }
  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

/** Stores a governed organization-document version under its own object namespace. */
export async function persistOrganizationDocumentBinary(params: {
  organizationId: string;
  documentId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("organization-documents", `${params.organizationId}/${params.documentId}`, params.filename);
  const contentType = normalizeMimeType(params.mimeType);
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try { storageKey = await persistToS3({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try { storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }
  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

export async function persistBusinessBinary(params: {
  businessId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("businesses", params.businessId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);

  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try {
      storageKey = await persistToS3({
        objectKey,
        contentType,
        payload: buffer,
      });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "unknown S3 upload error";
      console.warn(
        `[storage] S3 upload failed, falling back to local storage: ${reason}`,
      );
      storageKey = await persistToLocal({
        objectKey,
        payload: buffer,
      });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try {
      storageKey = await persistToCloudinary({
        objectKey,
        contentType,
        payload: buffer,
      });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "unknown Cloudinary upload error";
      console.warn(
        `[storage] Cloudinary upload failed, falling back to local storage: ${reason}`,
      );
      storageKey = await persistToLocal({
        objectKey,
        payload: buffer,
      });
    }
  } else {
    storageKey = await persistToLocal({
      objectKey,
      payload: buffer,
    });
  }

  return {
    storageKey,
    sha256: toHex(buffer),
    bytes: buffer.byteLength,
  };
}

export async function persistKycBinary(params: {
  investorUserId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("kyc", params.investorUserId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);

  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try {
      storageKey = await persistToS3({ objectKey, contentType, payload: buffer });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      const reason = error instanceof Error ? error.message : "unknown S3 upload error";
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${reason}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try {
      storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      const reason = error instanceof Error ? error.message : "unknown Cloudinary upload error";
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${reason}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }

  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

export async function persistOfferingImage(params: {
  offeringId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("offering-images", params.offeringId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);

  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try {
      storageKey = await persistToS3({ objectKey, contentType, payload: buffer });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      const reason = error instanceof Error ? error.message : "unknown S3 upload error";
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${reason}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try {
      storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      const reason = error instanceof Error ? error.message : "unknown Cloudinary upload error";
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${reason}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }

  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

export async function persistProfessionalBinary(params: {
  professionalId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("professionals", params.professionalId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);

  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try {
      storageKey = await persistToS3({ objectKey, contentType, payload: buffer });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      const reason = error instanceof Error ? error.message : "unknown S3 upload error";
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${reason}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try {
      storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      const reason = error instanceof Error ? error.message : "unknown Cloudinary upload error";
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${reason}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }

  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}

export async function persistWorkOrderBinary(params: {
  workOrderId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{
  storageKey: string;
  sha256: string;
  bytes: number;
}> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey(
    "work-orders",
    params.workOrderId,
    params.filename,
  );
  const contentType = normalizeMimeType(params.mimeType);

  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try {
      storageKey = await persistToS3({
        objectKey,
        contentType,
        payload: buffer,
      });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "unknown S3 upload error";
      console.warn(
        `[storage] S3 upload failed, falling back to local storage: ${reason}`,
      );
      storageKey = await persistToLocal({
        objectKey,
        payload: buffer,
      });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try {
      storageKey = await persistToCloudinary({
        objectKey,
        contentType,
        payload: buffer,
      });
    } catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) {
        throw error;
      }
      const reason =
        error instanceof Error ? error.message : "unknown Cloudinary upload error";
      console.warn(
        `[storage] Cloudinary upload failed, falling back to local storage: ${reason}`,
      );
      storageKey = await persistToLocal({
        objectKey,
        payload: buffer,
      });
    }
  } else {
    storageKey = await persistToLocal({
      objectKey,
      payload: buffer,
    });
  }

  return {
    storageKey,
    sha256: toHex(buffer),
    bytes: buffer.byteLength,
  };
}

/** Restricted finance evidence has a distinct object namespace from ordinary work-order attachments. */
export async function persistProfessionalFinanceExceptionBinary(params: {
  financeExceptionCaseId: string;
  filename: string;
  contentBase64: string;
  mimeType?: string;
}): Promise<{ storageKey: string; sha256: string; bytes: number }> {
  const buffer = await prepareDocumentPayload(params.contentBase64, params.mimeType);
  const objectKey = toObjectKey("professional-finance-exceptions", params.financeExceptionCaseId, params.filename);
  const contentType = normalizeMimeType(params.mimeType);
  let storageKey: string;
  if (env.FILE_STORAGE_PROVIDER === "s3") {
    try { storageKey = await persistToS3({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] S3 upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else if (env.FILE_STORAGE_PROVIDER === "cloudinary") {
    try { storageKey = await persistToCloudinary({ objectKey, contentType, payload: buffer }); }
    catch (error) {
      if (!env.FILE_STORAGE_FALLBACK_TO_LOCAL) throw error;
      console.warn(`[storage] Cloudinary upload failed, falling back to local storage: ${error instanceof Error ? error.message : "unknown error"}`);
      storageKey = await persistToLocal({ objectKey, payload: buffer });
    }
  } else {
    storageKey = await persistToLocal({ objectKey, payload: buffer });
  }
  return { storageKey, sha256: toHex(buffer), bytes: buffer.byteLength };
}
