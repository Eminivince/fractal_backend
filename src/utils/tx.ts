import mongoose from "mongoose";
import { env } from "../config/env.js";

function isTransactionUnsupported(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;

  const maybeError = error as {
    code?: number;
    codeName?: string;
    message?: string;
  };

  if (maybeError.code === 20 || maybeError.codeName === "IllegalOperation") {
    return true;
  }

  const message = typeof maybeError.message === "string" ? maybeError.message : "";
  return (
    message.includes("Transaction numbers are only allowed on a replica set member or mongos") ||
    message.includes("transactions are not supported")
  );
}

export async function runInTransaction<T>(fn: (session: mongoose.ClientSession) => Promise<T>): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result: T | undefined;
    try {
      await session.withTransaction(async () => {
        result = await fn(session);
      });
      if (result !== undefined) return result;
    } catch (error) {
      if (!isTransactionUnsupported(error)) throw error;
      // In production, atomicity is a hard requirement for financial writes.
      // Degrading to a non-transactional path silently loses the all-or-nothing
      // guarantee, so fail loudly instead — the deployment MUST use a replica set.
      if (env.NODE_ENV === "production") {
        throw new Error(
          "[tx] MongoDB transactions are unavailable but NODE_ENV=production. " +
            "A replica-set (or mongos) connection is required for atomic financial writes.",
        );
      }
      console.warn(
        "[tx] MongoDB transactions are unavailable; executing operation without transaction session (non-production only).",
      );
      return fn(null as unknown as mongoose.ClientSession);
    }

    return fn(null as unknown as mongoose.ClientSession);
  } finally {
    await session.endSession();
  }
}
