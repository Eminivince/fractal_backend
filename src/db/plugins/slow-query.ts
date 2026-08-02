/**
 * B15: Slow query monitoring plugin.
 * Wraps Mongoose Query.exec() to measure duration and warn on slow queries.
 */

import mongoose from "mongoose";
import { env } from "../../config/env.js";

export function registerSlowQueryPlugin(): void {
  const threshold = env.MONGODB_SLOW_QUERY_THRESHOLD_MS;
  const originalExec = mongoose.Query.prototype.exec;

  mongoose.Query.prototype.exec = async function (this: any) {
    const start = performance.now();
    const result = await originalExec.call(this);
    const duration = Math.round(performance.now() - start);

    if (duration > threshold) {
      const collection = this.mongooseCollection?.name ?? "unknown";
      const op = this.op ?? "unknown";
      const filter = JSON.stringify(this.getFilter?.() ?? {});
      console.warn(
        `[slow-query] ${collection}.${op} took ${duration}ms (threshold: ${threshold}ms) filter=${filter}`,
      );
    }

    return result;
  };
}
