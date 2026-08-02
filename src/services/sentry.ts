/**
 * Thin Sentry wrapper. Initialization happens in instrumentation.ts (preloaded via
 * `node --import`). These helpers are safe no-ops when SENTRY_DSN is unset.
 */
import * as Sentry from "@sentry/node";
import { env } from "../config/env.js";

export function captureException(error: unknown): void {
  if (!env.SENTRY_DSN) return;
  Sentry.captureException(error);
}
