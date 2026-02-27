import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../config/env.js";
import { HttpError } from "../utils/errors.js";

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const DEFAULT_MIME_TYPE = "application/octet-stream";

interface S3Config {
  bucket: string;
  region: string;
  endpoint?: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
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

function decodeBase64(input: string): Buffer {
  const payload = input.includes(",") ? input.split(",").pop() ?? "" : input;
  const normalized = payload.replace(/\s+/g, "");
  if (!normalized) throw new HttpError(422, "contentBase64 payload is empty");

  let buffer: Buffer;
  try {
    buffer = Buffer.from(normalized, "base64");
  } catch {
    throw new HttpError(422, "Invalid base64 payload");
  }

  if (!buffer.length) throw new HttpError(422, "Decoded file is empty");
  if (buffer.length > MAX_UPLOAD_BYTES) {
    throw new HttpError(
      422,
      `File exceeds max size of ${Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024))}MB`,
    );
  }

  return buffer;
}

function normalizeMimeType(mimeType?: string): string {
  const normalized = mimeType?.trim().toLowerCase();
  if (!normalized) return DEFAULT_MIME_TYPE;
  return normalized;
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
  const absolutePath = path.resolve(
    process.cwd(),
    env.FILE_STORAGE_DIR,
    params.objectKey,
  );
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
    const absolutePath = path.resolve(process.cwd(), env.FILE_STORAGE_DIR, objectKey);
    try {
      const buffer = await readFile(absolutePath);
      return { buffer };
    } catch {
      throw new HttpError(404, "File not found in local storage");
    }
  }

  throw new HttpError(422, `Unsupported storageKey format: ${storageKey}`);
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
  const buffer = decodeBase64(params.contentBase64);
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
  const buffer = decodeBase64(params.contentBase64);
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
  const buffer = decodeBase64(params.contentBase64);
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
  const buffer = decodeBase64(params.contentBase64);
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
  const buffer = decodeBase64(params.contentBase64);
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
  const buffer = decodeBase64(params.contentBase64);
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
