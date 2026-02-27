import mongoose from "mongoose";

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
      console.warn(
        "[tx] MongoDB transactions are unavailable; executing operation without transaction session.",
      );
      return fn(null as unknown as mongoose.ClientSession);
    }

    return fn(null as unknown as mongoose.ClientSession);
  } finally {
    await session.endSession();
  }
}
