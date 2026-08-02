import { beforeEach, describe, expect, it, vi } from "vitest";

const createQueue = vi.hoisted(() => vi.fn());
const processEmails = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ NOTIFICATION_EMAIL_POLL_INTERVAL_MS: 60_000 }));

vi.mock("../../../services/queue.js", () => ({ createQueue }));
vi.mock("../../../services/notifications.js", () => ({ processPendingNotificationEmails: processEmails }));
vi.mock("../../../config/env.js", () => ({ env }));

import { startNotificationQueue } from "../notification.queue.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("notification queue", () => {
  it("returns an inert handle when Redis is unavailable", async () => {
    createQueue.mockReturnValue(null);
    const handle = startNotificationQueue(log);
    await handle.triggerNow();
    handle.stop();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Redis not available"));
  });

  it("processes a scheduled batch and reports delivery results", async () => {
    let processor: (() => Promise<void>) | undefined;
    createQueue.mockImplementation((_name: string, handler: () => Promise<void>) => {
      processor = handler;
      return { worker: { close: vi.fn().mockResolvedValue(undefined) }, queue: { close: vi.fn().mockResolvedValue(undefined), add: vi.fn().mockResolvedValue(undefined) } };
    });
    processEmails.mockResolvedValue({ attempted: 3, sent: 2, failed: 1 });
    startNotificationQueue(log);
    await processor?.();
    expect(processEmails).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith("[queue:notifications] sent=2 failed=1");
    expect(createQueue).toHaveBeenCalledWith("notifications", expect.any(Function), { repeatEveryMs: 60_000 });
  });

  it("starts, triggers, and closes the queue handle", async () => {
    const workerClose = vi.fn().mockResolvedValue(undefined);
    const queueClose = vi.fn().mockResolvedValue(undefined);
    const add = vi.fn().mockResolvedValue(undefined);
    createQueue.mockReturnValue({ worker: { close: workerClose }, queue: { close: queueClose, add } });
    const handle = startNotificationQueue(log);
    await handle.triggerNow();
    handle.stop();
    expect(add).toHaveBeenCalledWith("manual-trigger", {}, { priority: 1 });
    expect(workerClose).toHaveBeenCalledOnce();
    expect(queueClose).toHaveBeenCalledOnce();
    expect(log.info).toHaveBeenCalledWith("[queue:notifications] BullMQ notification worker started");
  });
});
