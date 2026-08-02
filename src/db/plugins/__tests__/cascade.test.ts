import mongoose from "mongoose";
import { describe, expect, it, vi } from "vitest";
import { guardBusiness, guardOffering, preventDeletionIfReferenced } from "../cascade.js";

function hookFor(plugin: ReturnType<typeof preventDeletionIfReferenced>) {
  const hooks = new Map<string, Function>();
  plugin({ pre: vi.fn((name: string, hook: Function) => hooks.set(name, hook)) } as any);
  return hooks;
}

describe("cascade deletion guard", () => {
  it("allows unscoped deletion checks and guards both query methods", async () => {
    const hooks = hookFor(guardBusiness());
    expect(hooks.size).toBe(2);
    const next = vi.fn(); await hooks.get("deleteOne")!.call({ getFilter: () => ({}) }, next);
    expect(next).toHaveBeenCalledWith();
    expect(guardOffering()).toBeTypeOf("function");
  });

  it("blocks active references, accepts safe references, and reports missing models", async () => {
    const model = vi.spyOn(mongoose, "model");
    const hooks = hookFor(preventDeletionIfReferenced("Business", [{ model: "Application", foreignKey: "businessId", excludeStatuses: ["withdrawn"] }]));
    model.mockReturnValue({ countDocuments: vi.fn().mockResolvedValue(2) } as any);
    const blocked = vi.fn(); await hooks.get("findOneAndDelete")!.call({ getFilter: () => ({ _id: "b1" }) }, blocked);
    expect((blocked.mock.calls[0]?.[0] as Error).message).toContain("Cannot delete Business (b1)");
    model.mockReturnValue({ countDocuments: vi.fn().mockResolvedValue(0) } as any);
    const allowed = vi.fn(); await hooks.get("deleteOne")!.call({ getQuery: () => ({ _id: "b1" }) }, allowed); expect(allowed).toHaveBeenCalledWith();
    model.mockImplementation(() => { throw new Error("missing"); }); const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const skipped = vi.fn(); await hooks.get("deleteOne")!.call({ getFilter: () => ({ _id: "b1" }) }, skipped); expect(warn).toHaveBeenCalled(); expect(skipped).toHaveBeenCalledWith();
    model.mockRestore();
  });
});
