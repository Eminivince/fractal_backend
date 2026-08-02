import crypto from "crypto";
import { env } from "../config/env.js";
import { verifyHmacHexSignature } from "../utils/webhook-signature.js";

const SUMSUB_BASE = "https://api.sumsub.com";

export class SumsubRequestError extends Error {
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly statusCode: number | null,
    retryable?: boolean,
  ) {
    super(message);
    this.name = "SumsubRequestError";
    this.retryable = retryable ?? (statusCode === null || statusCode === 408 || statusCode === 429 || (statusCode !== null && statusCode >= 500));
  }
}

export class SumsubApplicantNotFoundError extends SumsubRequestError {
  constructor() {
    super("Sumsub applicant was not found", 404, false);
    this.name = "SumsubApplicantNotFoundError";
  }
}

function createSignature(
  ts: number,
  method: string,
  path: string,
  body?: string,
): string {
  if (!env.SUMSUB_SECRET_KEY)
    throw new Error("SUMSUB_SECRET_KEY is not configured");
  const data = `${ts}${method.toUpperCase()}${path}${body ?? ""}`;
  return crypto
    .createHmac("sha256", env.SUMSUB_SECRET_KEY)
    .update(data)
    .digest("hex");
}

function sumsubHeaders(
  method: string,
  path: string,
  body?: string,
): Record<string, string> {
  if (!env.SUMSUB_APP_TOKEN)
    throw new Error("SUMSUB_APP_TOKEN is not configured");
  const ts = Math.floor(Date.now() / 1000);
  const sig = createSignature(ts, method, path, body);
  return {
    "X-App-Token": env.SUMSUB_APP_TOKEN,
    "X-App-Access-Ts": String(ts),
    "X-App-Access-Sig": sig,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

async function sumsubRequest<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const bodyStr = body ? JSON.stringify(body) : undefined;
  const headers = sumsubHeaders(method, path, bodyStr);
  let res: Response;
  try {
    res = await fetch(`${SUMSUB_BASE}${path}`, {
      method,
      headers,
      body: bodyStr,
      signal: AbortSignal.timeout(env.SUMSUB_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new SumsubRequestError("Sumsub request timed out", null, true);
    }
    throw new SumsubRequestError("Sumsub request could not be completed", null, true);
  }
  if (!res.ok) {
    if (res.status === 404) throw new SumsubApplicantNotFoundError();
    // Provider bodies can contain PII or operational detail. Do not turn them
    // into API errors, persisted retry diagnostics, or logs by accident.
    throw new SumsubRequestError(`Sumsub ${method} request failed (${res.status})`, res.status);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new SumsubRequestError(`Sumsub ${method} response was invalid`, res.status, true);
  }
}

export interface SumsubApplicant {
  id: string;
  createdAt: string;
  inspectionId: string;
  externalUserId: string;
  review?: {
    reviewStatus: string;
    reviewResult?: {
      reviewAnswer: "GREEN" | "RED";
      rejectLabels?: string[];
      clientComment?: string;
    };
  };
}

export async function createApplicant(
  externalUserId: string,
  email: string,
): Promise<SumsubApplicant> {
  const levelName = env.SUMSUB_LEVEL_NAME ?? "basic-kyc-level";
  const path = `/resources/applicants?levelName=${encodeURIComponent(levelName)}`;
  return sumsubRequest<SumsubApplicant>("POST", path, {
    externalUserId,
    email,
  });
}

export async function getApplicant(
  applicantId: string,
): Promise<SumsubApplicant> {
  return sumsubRequest<SumsubApplicant>(
    "GET",
    `/resources/applicants/${applicantId}/one`,
  );
}

/** Looks up the canonical applicant before creating one during recovery. */
export async function getApplicantByExternalUserId(
  externalUserId: string,
): Promise<SumsubApplicant> {
  const userId = externalUserId.trim();
  if (!userId) throw new Error("Sumsub external user ID is required");
  return sumsubRequest<SumsubApplicant>(
    "GET",
    `/resources/applicants/-/byExternalUserId/${encodeURIComponent(userId)}`,
  );
}

/**
 * Reset an applicant's verification so they must re-submit KYC documents.
 * Used by the periodic re-verification worker when a KYC approval expires.
 */
export async function resetApplicant(applicantId: string): Promise<void> {
  await sumsubRequest<unknown>(
    "POST",
    `/resources/applicants/${applicantId}/reset`,
  );
}

export interface SumsubAccessToken {
  token: string;
  userId: string;
}

export const SUMSUB_SDK_ACCESS_TOKEN_PATH = "/resources/accessTokens/sdk";

/** Sumsub's current WebSDK access-token contract is a JSON body, not query parameters. */
export function sumsubSdkAccessTokenPayload(input: {
  externalUserId: string;
  levelName: string;
  ttlInSecs: number;
}): { userId: string; levelName: string; ttlInSecs: number } {
  const userId = input.externalUserId.trim();
  const levelName = input.levelName.trim();
  if (!userId || !levelName) throw new Error("Sumsub access token requires an external user ID and verification level");
  if (!Number.isInteger(input.ttlInSecs) || input.ttlInSecs < 60 || input.ttlInSecs > 3_600) {
    throw new Error("Sumsub access token TTL must be between 60 and 3600 seconds");
  }
  return { userId, levelName, ttlInSecs: input.ttlInSecs };
}

export async function generateAccessToken(
  externalUserId: string,
  levelName?: string,
): Promise<SumsubAccessToken> {
  const level = levelName ?? env.SUMSUB_LEVEL_NAME ?? "basic-kyc-level";
  return sumsubRequest<SumsubAccessToken>("POST", SUMSUB_SDK_ACCESS_TOKEN_PATH, sumsubSdkAccessTokenPayload({
    externalUserId,
    levelName: level,
    ttlInSecs: env.SUMSUB_SDK_TOKEN_TTL_SECONDS,
  }));
}

export function verifySumsubWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = env.SUMSUB_WEBHOOK_SECRET ?? env.SUMSUB_SECRET_KEY;
  if (!secret) return false;
  return verifyHmacHexSignature({
    payload: rawBody,
    signature,
    secret,
    algorithms: ["sha256", "sha512"],
  });
}
