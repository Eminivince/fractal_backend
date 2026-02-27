/**
 * 2.4: AML / Sanctions screening via Sumsub addon.
 * Triggers AML checks when KYC is approved and handles results via webhook.
 */

import crypto from "node:crypto";
import { env } from "../config/env.js";

const SUMSUB_BASE = "https://api.sumsub.com";

function createSignature(ts: number, method: string, path: string, body?: string): string {
  if (!env.SUMSUB_SECRET_KEY) throw new Error("SUMSUB_SECRET_KEY is not configured");
  const data = `${ts}${method.toUpperCase()}${path}${body ?? ""}`;
  return crypto.createHmac("sha256", env.SUMSUB_SECRET_KEY).update(data).digest("hex");
}

function sumsubHeaders(method: string, path: string, body?: string): Record<string, string> {
  if (!env.SUMSUB_APP_TOKEN) throw new Error("SUMSUB_APP_TOKEN is not configured");
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

/** Initiate an AML screening check for an already-created Sumsub applicant. */
export async function initiateAmlCheck(applicantId: string): Promise<{ inspectionId: string }> {
  const path = `/resources/applicants/${applicantId}/amlScreening`;
  const headers = sumsubHeaders("POST", path);
  const res = await fetch(`${SUMSUB_BASE}${path}`, { method: "POST", headers });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Sumsub AML check failed (${res.status}): ${text}`);
  }
  return (await res.json()) as { inspectionId: string };
}

/** Parse AML result from Sumsub webhook event. */
export function parseAmlWebhookResult(event: {
  type: string;
  applicantId: string;
  reviewResult?: {
    reviewAnswer: "GREEN" | "RED";
    rejectLabels?: string[];
  };
}): { status: "clear" | "flagged" | "rejected" } | null {
  if (event.type !== "applicantReviewed") return null;

  const answer = event.reviewResult?.reviewAnswer;
  if (answer === "GREEN") return { status: "clear" };

  // Check if specifically AML-related
  const labels = event.reviewResult?.rejectLabels ?? [];
  const amlLabels = ["SANCTIONS_LIST", "PEP", "ADVERSE_MEDIA", "AML"];
  const hasAmlLabel = labels.some((l) => amlLabels.some((a) => l.toUpperCase().includes(a)));

  if (hasAmlLabel) return { status: "rejected" };
  if (answer === "RED") return { status: "flagged" };

  return null;
}
