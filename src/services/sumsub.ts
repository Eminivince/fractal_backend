import crypto from "crypto";
import { env } from "../config/env.js";

const SUMSUB_BASE = "https://api.sumsub.com";

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
  const res = await fetch(`${SUMSUB_BASE}${path}`, {
    method,
    headers,
    body: bodyStr,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sumsub ${method} ${path} failed (${res.status}): ${text}`);
  }
  return (await res.json()) as T;
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

export interface SumsubAccessToken {
  token: string;
  userId: string;
}

export async function generateAccessToken(
  externalUserId: string,
  levelName?: string,
): Promise<SumsubAccessToken> {
  const level = levelName ?? env.SUMSUB_LEVEL_NAME ?? "basic-kyc-level";
  const path = `/resources/accessTokens?userId=${encodeURIComponent(externalUserId)}&levelName=${encodeURIComponent(level)}`;
  return sumsubRequest<SumsubAccessToken>("POST", path);
}

export function verifySumsubWebhookSignature(
  rawBody: string,
  signature: string,
): boolean {
  const secret = env.SUMSUB_WEBHOOK_SECRET ?? env.SUMSUB_SECRET_KEY;
  if (!secret) return false;
  const digest256 = crypto
    .createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
  if (digest256 === signature) return true;
  const digest512 = crypto
    .createHmac("sha512", secret)
    .update(rawBody)
    .digest("hex");
  return digest512 === signature;
}
