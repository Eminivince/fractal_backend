import { createHash } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { IdempotencyKeyModel } from "../db/models.js";
import { HttpError } from "./errors.js";

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (!value || typeof value !== "object") return value;

  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  const out: Record<string, unknown> = {};
  for (const [key, raw] of entries) {
    out[key] = sortValue(raw);
  }
  return out;
}

export function stableJsonStringify(input: unknown): string {
  return JSON.stringify(sortValue(input));
}

export function hashPayload(payload: unknown): string {
  return createHash("sha256").update(stableJsonStringify(payload)).digest("hex");
}

export function readCommandId(headers: IncomingHttpHeaders): string | undefined {
  const raw = headers["x-command-id"];
  if (!raw) return undefined;
  const value = Array.isArray(raw) ? raw[0] : raw;
  const commandId = value?.trim();
  return commandId ? commandId : undefined;
}

interface IdempotencyOptions<T> {
  commandId?: string;
  userId: string;
  route: string;
  payload: unknown;
  execute: () => Promise<T>;
}

export async function runIdempotentCommand<T>({
  commandId,
  userId,
  route,
  payload,
  execute,
}: IdempotencyOptions<T>): Promise<T> {
  if (!commandId) return execute();

  const requestHash = hashPayload(payload);
  const existing = await IdempotencyKeyModel.findOne({
    key: commandId,
    userId,
    route,
  }).lean();

  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new HttpError(409, "Command ID already used with a different payload");
    }
    return existing.responseBody as T;
  }

  const responseBody = await execute();

  try {
    await IdempotencyKeyModel.create({
      key: commandId,
      userId,
      route,
      requestHash,
      responseBody,
      createdAt: new Date(),
    });
    return responseBody;
  } catch {
    const raced = await IdempotencyKeyModel.findOne({
      key: commandId,
      userId,
      route,
    }).lean();

    if (!raced) throw new HttpError(500, "Unable to persist idempotency record");
    if (raced.requestHash !== requestHash) {
      throw new HttpError(409, "Command ID already used with a different payload");
    }
    return raced.responseBody as T;
  }
}
