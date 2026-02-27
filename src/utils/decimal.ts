import mongoose from "mongoose";

export function toDecimal(value: string | number | mongoose.Types.Decimal128) {
  if (value instanceof mongoose.Types.Decimal128) return value;
  return mongoose.Types.Decimal128.fromString(String(value));
}

export function decimalToString(value: unknown): unknown {
  if (value instanceof mongoose.Types.Decimal128) return value.toString();
  return value;
}
