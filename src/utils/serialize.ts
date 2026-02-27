import mongoose from "mongoose";

function deepConvert(input: unknown): unknown {
  if (input instanceof mongoose.Types.Decimal128) return input.toString();
  if (input instanceof mongoose.Types.ObjectId) return input.toString();
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.map((item) => deepConvert(item));

  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      out[key] = deepConvert(value);
    }
    return out;
  }

  return input;
}

export function serialize<T>(doc: T): T {
  return deepConvert(doc) as T;
}
