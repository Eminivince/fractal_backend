import { env } from "../config/env.js";
import { publishDuePlatformContent } from "../platform/postgres-platform-content.js";

export function startPlatformContentPublicationWorker(input: { logger: { info: (object: unknown, message?: string) => void; error: (object: unknown, message?: string) => void } }) {
  let running = false; let stopped = false;
  const publish = async () => {
    if (running || stopped) return; running = true;
    try { const outcome = await publishDuePlatformContent(new Date(), env.PLATFORM_CONTENT_PUBLICATION_BATCH_SIZE); if (outcome.published || outcome.failed || outcome.alreadyTerminal) input.logger.info(outcome, "Platform legal-content publication cycle completed"); }
    catch (error) { input.logger.error({ err: error }, "Platform legal-content publication cycle failed"); }
    finally { running = false; }
  };
  const timer = setInterval(() => void publish(), env.PLATFORM_CONTENT_PUBLICATION_INTERVAL_MS); timer.unref(); void publish();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
