import { beforeEach, describe, expect, it, vi } from "vitest";

const find = vi.hoisted(() => vi.fn());
const appendEvent = vi.hoisted(() => vi.fn());
const notify = vi.hoisted(() => vi.fn());

vi.mock("../../db/models.js", () => ({ OfferingModel: { find } }));
vi.mock("../../utils/audit.js", () => ({ appendEvent }));
vi.mock("../../services/notifications.js", () => ({ createNotificationsFromEvent: notify }));

import { startOfferingClosureWorker } from "../offering-closure.worker.js";

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;

beforeEach(() => vi.clearAllMocks());

describe("offering closure worker", () => {
  it("closes expired offerings and writes audit and notification records", async () => {
    const offering: any = { _id: "offering-1", name: "Lagos Property Fund", status: "open", save: vi.fn().mockResolvedValue(undefined) };
    find.mockResolvedValue([offering]);
    appendEvent.mockResolvedValue(undefined);
    notify.mockResolvedValue(undefined);
    const worker = startOfferingClosureWorker(log);
    await worker.triggerNow();
    worker.stop();
    expect(offering).toMatchObject({ status: "closed" });
    expect(offering.save).toHaveBeenCalledOnce();
    expect(appendEvent).toHaveBeenCalledWith(expect.objectContaining({ userId: "system" }), expect.objectContaining({ entityId: "offering-1", action: "OfferingClosed" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ userId: "system" }), expect.objectContaining({ notes: expect.stringContaining("Lagos Property Fund") }));
    expect(log.info).toHaveBeenCalledWith("[offering-closure] Closed 1 offerings");
  });

  it("contains outer errors and runs the hourly schedule", async () => {
    vi.useFakeTimers();
    try {
      find.mockRejectedValue(new Error("Database unavailable"));
      const worker = startOfferingClosureWorker(log);
      await worker.triggerNow();
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      worker.stop();
      expect(log.error).toHaveBeenCalledWith(expect.any(Error), "[offering-closure-worker] error");
      expect(find).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
