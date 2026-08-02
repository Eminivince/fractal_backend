import { beforeEach, describe, expect, it, vi } from "vitest";
const find = vi.hoisted(() => vi.fn()); const update = vi.hoisted(() => vi.fn()); const notify = vi.hoisted(() => vi.fn());
vi.mock("../../db/models.js", () => ({ BusinessModel: { find, findByIdAndUpdate: update } })); vi.mock("../../services/notifications.js", () => ({ createNotificationsFromEvent: notify }));
import { startDocumentExpiryWorker } from "../document-expiry.worker.js";
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
beforeEach(() => { find.mockReset(); update.mockReset(); notify.mockReset(); log.info.mockReset(); log.warn.mockReset(); log.error.mockReset(); });
describe("document expiry worker", () => {
  it("warns for expiring documents and flags approved businesses with expired documents", async () => { const now = Date.now(); find.mockReturnValue({ lean: vi.fn().mockResolvedValue([{ _id: "business-1", kybStatus: "approved", documents: [{ type: "certificate", filename: "certificate.pdf", validUntil: new Date(now - 1000) }, { type: "tax", validUntil: new Date(now + 86_400_000) }, {}] }]) }); const h = startDocumentExpiryWorker(log); await h.triggerNow(); h.stop(); expect(update).toHaveBeenCalledWith("business-1", { kybStatus: "needs_renewal" }); expect(notify).toHaveBeenCalledTimes(2); expect(log.warn).toHaveBeenCalled(); });
  it("reports query failures", async () => { find.mockReturnValue({ lean: vi.fn().mockRejectedValue(new Error("database failed")) }); const h = startDocumentExpiryWorker(log); await h.triggerNow(); h.stop(); expect(log.error).toHaveBeenCalledWith(expect.any(Error), "[document-expiry-worker] error"); });
});
