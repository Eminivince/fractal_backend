import { describe, expect, it, vi } from "vitest";
import softDeletePlugin from "../soft-delete.js";

describe("soft-delete plugin", () => {
  it("registers the deletion field, index, query filters, methods, and statics", async () => {
    const hooks = new Map<string, Function>();
    const methods = new Map<string, Function>();
    const statics = new Map<string, Function>();
    const schema = {
      add: vi.fn(), index: vi.fn(),
      pre: vi.fn((name: string, hook: Function) => hooks.set(name, hook)),
      method: vi.fn((name: string, method: Function) => methods.set(name, method)),
      static: vi.fn((name: string, method: Function) => statics.set(name, method)),
    } as any;
    softDeletePlugin(schema);
    expect(schema.add).toHaveBeenCalledWith({ deletedAt: { type: Date, default: null } });
    expect(schema.index).toHaveBeenCalledWith({ deletedAt: 1 });
    expect(hooks.size).toBe(4);
    for (const hook of hooks.values()) {
      const query = { getFilter: () => ({}), where: vi.fn() };
      const next = vi.fn();
      hook.call(query, next);
      expect(query.where).toHaveBeenCalledWith({ deletedAt: null });
      expect(next).toHaveBeenCalledOnce();
      const custom = { getFilter: () => ({ deletedAt: { $ne: null } }), where: vi.fn() };
      hook.call(custom, next);
      expect(custom.where).not.toHaveBeenCalled();
    }
    const document = { deletedAt: null as Date | null, save: vi.fn().mockResolvedValue("saved") } as any;
    await expect(methods.get("softDelete")!.call(document)).resolves.toBe("saved");
    expect(document.deletedAt).toBeInstanceOf(Date);
    await expect(methods.get("restore")!.call(document)).resolves.toBe("saved");
    expect(document.deletedAt).toBeNull();
    expect(document.save).toHaveBeenCalledTimes(2);
    const model = { find: vi.fn().mockReturnValue("query") };
    expect(statics.get("findDeleted")!.call(model, { owner: "user-1" })).toBe("query");
    expect(model.find).toHaveBeenLastCalledWith({ owner: "user-1", deletedAt: { $ne: null } });
    expect(statics.get("findWithDeleted")!.call(model)).toBe("query");
    expect(model.find).toHaveBeenLastCalledWith({ deletedAt: { $exists: true } });
  });
});
