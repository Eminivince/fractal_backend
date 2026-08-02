import { beforeEach, describe, expect, it, vi } from "vitest";

const hasTransport = vi.hoisted(() => vi.fn());
const processEmails = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ NOTIFICATION_EMAIL_ENABLED: false, NOTIFICATION_EMAIL_POLL_INTERVAL_MS: 1_000 }));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../email.js", () => ({ hasAnyEmailTransportConfigured: hasTransport }));
vi.mock("../notifications.js", () => ({ processPendingNotificationEmails: processEmails }));

import { startNotificationWorker } from "../notification-worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  env.NOTIFICATION_EMAIL_ENABLED = false;
  hasTransport.mockReturnValue(false);
});

describe("notification worker", () => {
  it("stays inactive when email notifications are disabled", async () => {
    const handle = startNotificationWorker(log);
    await handle.triggerNow();
    handle.stop();
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
    expect(processEmails).not.toHaveBeenCalled();
  });

  it("stays inactive without a configured email transport", async () => {
    env.NOTIFICATION_EMAIL_ENABLED = true;
    const handle = startNotificationWorker(log);
    await handle.triggerNow();
    handle.stop();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("no Resend or SMTP transport"));
    expect(processEmails).not.toHaveBeenCalled();
  });

  it("processes batches, reports delivery results, and releases its lock", async () => {
    env.NOTIFICATION_EMAIL_ENABLED = true;
    hasTransport.mockReturnValue(true);
    processEmails
      .mockResolvedValueOnce({ attempted: 3, sent: 2, failed: 1 })
      .mockResolvedValueOnce({ attempted: 1, sent: 0, failed: 0 });
    const handle = startNotificationWorker(log);
    await handle.triggerNow();
    await handle.triggerNow();
    handle.stop();
    expect(processEmails).toHaveBeenCalledTimes(2);
    expect(log.info).toHaveBeenCalledWith("Notification email batch: attempted=3 sent=2 failed=1");
    expect(log.info).toHaveBeenCalledWith("Notification worker started (interval=1000ms)");
  });

  it("does not run two pending batches at the same time", async () => {
    env.NOTIFICATION_EMAIL_ENABLED = true;
    hasTransport.mockReturnValue(true);
    let complete: ((result: unknown) => void) | undefined;
    processEmails.mockReturnValue(new Promise((resolve) => { complete = resolve; }));
    const handle = startNotificationWorker(log);
    const first = handle.triggerNow();
    await handle.triggerNow();
    expect(processEmails).toHaveBeenCalledOnce();
    complete?.({ attempted: 0, sent: 0, failed: 0 });
    await first;
    handle.stop();
  });

  it("runs the configured interval callback", async () => {
    vi.useFakeTimers();
    try {
      env.NOTIFICATION_EMAIL_ENABLED = true;
      hasTransport.mockReturnValue(true);
      processEmails.mockResolvedValue({ attempted: 0, sent: 0, failed: 0 });
      const handle = startNotificationWorker(log);
      await vi.advanceTimersByTimeAsync(1_000);
      handle.stop();
      expect(processEmails).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
