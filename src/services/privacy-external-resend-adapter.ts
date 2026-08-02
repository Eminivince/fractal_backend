import { z } from "zod";
import type { ResendPrivacyDeliveryReference } from "../platform/postgres-resend-privacy-references.js";

export const RESEND_PRIVACY_ADAPTER_KEY = "fractal.external.resend.delivery";
export const RESEND_PRIVACY_ADAPTER_VERSION = "1.0.0";

const resendRecordSchema = z.object({
  id: z.string().trim().min(3).max(500),
  to: z.array(z.string().email()).min(1).max(25),
  created_at: z.string().datetime({ offset: true }),
  last_event: z.string().trim().regex(/^[a-z][a-z0-9._-]{1,63}$/),
}).passthrough();

export type ResendPrivacyRecord = {
  createdAt: string;
  lastEvent: string;
};

export class ResendPrivacyAdapterError extends Error {}

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

async function readBoundedJson(
  response: Response,
  maximumBytes: number,
): Promise<{ value: unknown; bytes: number }> {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw new ResendPrivacyAdapterError("Resend returned a non-JSON response");
  }
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new ResendPrivacyAdapterError("Resend response exceeds the byte limit");
  }
  if (!response.body) {
    throw new ResendPrivacyAdapterError("Resend returned an empty response");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    total += part.value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new ResendPrivacyAdapterError("Resend response exceeds the byte limit");
    }
    chunks.push(part.value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)),
      bytes: total,
    };
  } catch {
    throw new ResendPrivacyAdapterError("Resend returned invalid JSON");
  }
}

async function retrieveOne(input: {
  apiKey: string;
  reference: ResendPrivacyDeliveryReference;
  timeoutMs: number;
  maximumBytes: number;
  fetchImplementation: FetchImplementation;
}): Promise<{ record: ResendPrivacyRecord; bytes: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await input.fetchImplementation(
      `https://api.resend.com/emails/${encodeURIComponent(input.reference.providerMessageId)}`,
      {
        method: "GET",
        redirect: "error",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${input.apiKey}`,
        },
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new ResendPrivacyAdapterError("Resend did not return the requested delivery");
    }
    const bounded = await readBoundedJson(response, input.maximumBytes);
    const parsed = resendRecordSchema.safeParse(bounded.value);
    if (!parsed.success) {
      throw new ResendPrivacyAdapterError("Resend returned an invalid delivery record");
    }
    const expectedRecipient = normalizeEmail(input.reference.recipientEmail);
    if (
      parsed.data.id !== input.reference.providerMessageId
      || parsed.data.to.length !== 1
      || normalizeEmail(parsed.data.to[0]!) !== expectedRecipient
    ) {
      throw new ResendPrivacyAdapterError(
        "Resend record did not match the exact delivery reference",
      );
    }
    return {
      record: {
        createdAt: parsed.data.created_at,
        lastEvent: parsed.data.last_event,
      },
      bytes: bounded.bytes,
    };
  } catch (error) {
    if (error instanceof ResendPrivacyAdapterError) throw error;
    if (controller.signal.aborted) {
      throw new ResendPrivacyAdapterError("Resend request exceeded the time limit");
    }
    throw new ResendPrivacyAdapterError("Resend request failed");
  } finally {
    clearTimeout(timer);
  }
}

export async function collectResendPrivacyRecords(input: {
  apiKey: string;
  references: readonly ResendPrivacyDeliveryReference[];
  timeoutMs: number;
  maximumRecords: number;
  maximumBytes: number;
  fetchImplementation?: FetchImplementation;
}): Promise<ResendPrivacyRecord[]> {
  if (!input.apiKey.startsWith("re_")) {
    throw new ResendPrivacyAdapterError("A valid Resend API key is required");
  }
  if (
    !Number.isInteger(input.maximumRecords)
    || input.maximumRecords < 1
    || input.references.length > input.maximumRecords
  ) {
    throw new ResendPrivacyAdapterError("Resend record count exceeds the limit");
  }
  if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 500 || input.timeoutMs > 120_000) {
    throw new ResendPrivacyAdapterError("Resend time limit is invalid");
  }
  if (!Number.isInteger(input.maximumBytes) || input.maximumBytes < 1_024) {
    throw new ResendPrivacyAdapterError("Resend byte limit is invalid");
  }
  const duplicateReferences = new Set(
    input.references.map((reference) => reference.providerMessageId),
  );
  if (duplicateReferences.size !== input.references.length) {
    throw new ResendPrivacyAdapterError("Resend delivery references must be unique");
  }
  const records: ResendPrivacyRecord[] = [];
  const deadline = Date.now() + input.timeoutMs;
  let totalBytes = 0;
  for (const reference of [...input.references].sort((left, right) =>
    left.providerMessageId.localeCompare(right.providerMessageId))) {
    const remainingTimeMs = deadline - Date.now();
    const remainingBytes = input.maximumBytes - totalBytes;
    if (remainingTimeMs <= 0) {
      throw new ResendPrivacyAdapterError("Resend request exceeded the time limit");
    }
    if (remainingBytes <= 0) {
      throw new ResendPrivacyAdapterError("Resend response exceeds the byte limit");
    }
    const retrieved = await retrieveOne({
      apiKey: input.apiKey,
      reference,
      timeoutMs: remainingTimeMs,
      maximumBytes: remainingBytes,
      fetchImplementation: input.fetchImplementation ?? fetch,
    });
    totalBytes += retrieved.bytes;
    records.push(retrieved.record);
  }
  return records;
}
