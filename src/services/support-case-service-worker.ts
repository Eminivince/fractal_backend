import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { sweepSupportCaseServiceDeadlines } from "../platform/postgres-support-service-levels.js";

export interface SupportCaseServiceLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export function startSupportCaseServiceWorker(input: { logger: SupportCaseServiceLogger; workerId?: string }): { stop: () => void } {
  const workerId = input.workerId ?? randomUUID();
  let running = false;
  let stopped = false;
  const sweep = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await sweepSupportCaseServiceDeadlines({ workerId, limit: env.SUPPORT_SERVICE_SWEEP_BATCH_SIZE });
      if (result.acknowledgementBreaches || result.escalations || result.resolutionBreaches) {
        input.logger.info(result, "Support service deadline cycle recorded governed events");
      }
    } catch (error) {
      input.logger.error({ err: error }, "Support service deadline cycle failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void sweep(), env.SUPPORT_SERVICE_SWEEP_INTERVAL_MS);
  timer.unref();
  void sweep();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
