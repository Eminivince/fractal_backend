import mongoose from "mongoose";
import { env } from "../config/env.js";
import { registerSlowQueryPlugin } from "./plugins/slow-query.js";

let connected = false;

export async function connectMongo() {
  if (connected) return;
  await mongoose.connect(env.MONGODB_URI, {
    maxPoolSize: env.MONGODB_POOL_SIZE,
    minPoolSize: Math.min(5, env.MONGODB_POOL_SIZE),
    maxIdleTimeMS: 30_000,
    socketTimeoutMS: 45_000,
    serverSelectionTimeoutMS: 10_000,
    // In production, do NOT build indexes at boot (blocking on large collections).
    // Indexes are created explicitly via migrate-mongo migrations. In dev/test we
    // keep autoIndex on for convenience.
    autoIndex: env.NODE_ENV !== "production",
  });

  // B15: Slow query monitoring
  if (env.MONGODB_SLOW_QUERY_LOG) {
    registerSlowQueryPlugin();
  }

  connected = true;
}

export async function disconnectMongo() {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}
