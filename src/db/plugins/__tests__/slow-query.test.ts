import mongoose from "mongoose";
import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ MONGODB_SLOW_QUERY_THRESHOLD_MS: 10 }));
vi.mock("../../../config/env.js", () => ({ env }));
import { registerSlowQueryPlugin } from "../slow-query.js";

let originalExec: typeof mongoose.Query.prototype.exec;
afterEach(() => { mongoose.Query.prototype.exec = originalExec; vi.restoreAllMocks(); });

describe("slow query monitoring", () => {
  it("returns fast query results without a warning", async () => {
    originalExec = vi.fn().mockResolvedValue({ ok: true }) as any;
    mongoose.Query.prototype.exec = originalExec;
    vi.spyOn(performance, "now").mockReturnValueOnce(100).mockReturnValueOnce(105);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerSlowQueryPlugin();
    await expect((mongoose.Query.prototype.exec as any).call({})).resolves.toEqual({ ok: true });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports a slow query with query metadata and safe fallbacks", async () => {
    originalExec = vi.fn().mockResolvedValue(["row"]) as any;
    mongoose.Query.prototype.exec = originalExec;
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(42);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerSlowQueryPlugin();
    await expect((mongoose.Query.prototype.exec as any).call({ mongooseCollection: { name: "users" }, op: "find", getFilter: () => ({ status: "active" }) })).resolves.toEqual(["row"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("users.find took 42ms"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('filter={"status":"active"}'));
  });

  it("uses unknown metadata when a query does not expose Mongoose fields", async () => {
    originalExec = vi.fn().mockResolvedValue(undefined) as any;
    mongoose.Query.prototype.exec = originalExec;
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(11);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerSlowQueryPlugin();
    await (mongoose.Query.prototype.exec as any).call({});
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("unknown.unknown"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("filter={}"));
  });
});
