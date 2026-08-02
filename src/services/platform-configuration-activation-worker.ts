import { env } from "../config/env.js";
import { activateDuePlatformConfigurationVersions } from "../platform/postgres-platform-configuration.js";

export interface PlatformConfigurationActivationLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

/**
 * Polling is protected by the process-wide worker lease and every activation
 * additionally locks/rechecks durable state. A restart can safely revisit a
 * due row; only an approved scheduled version can change the active projection.
 */
export function startPlatformConfigurationActivationWorker(input: { logger: PlatformConfigurationActivationLogger }): { stop: () => void } {
  let running = false;
  let stopped = false;
  const activate = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const outcome = await activateDuePlatformConfigurationVersions(new Date(), env.PLATFORM_CONFIGURATION_ACTIVATION_BATCH_SIZE);
      if (outcome.activated || outcome.failed || outcome.alreadyTerminal) {
        input.logger.info(outcome, "Platform configuration activation cycle completed");
      }
    } catch (error) {
      input.logger.error({ err: error }, "Platform configuration activation cycle failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void activate(), env.PLATFORM_CONFIGURATION_ACTIVATION_INTERVAL_MS);
  timer.unref();
  void activate();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
