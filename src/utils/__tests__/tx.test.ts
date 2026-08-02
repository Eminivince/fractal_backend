import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  startSession: vi.fn(),
  env: { NODE_ENV: "test" },
}));

vi.mock("mongoose", () => ({ default: { startSession: mocks.startSession } }));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));

import { runInTransaction } from "../tx.js";

const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

beforeEach(() => {
  mocks.startSession.mockReset();
  mocks.env.NODE_ENV = "test";
  warn.mockClear();
});

afterAll(() => warn.mockRestore());

function session(withTransaction: (callback: () => Promise<void>) => Promise<void>) {
  return { withTransaction: vi.fn(withTransaction), endSession: vi.fn().mockResolvedValue(undefined) };
}

describe("runInTransaction", () => {
  it("returns a result from an atomic transaction and closes the session", async () => {
    const current = session(async (callback) => callback());
    mocks.startSession.mockResolvedValue(current);
    const operation = vi.fn().mockResolvedValue("saved");

    await expect(runInTransaction(operation as any)).resolves.toBe("saved");
    expect(operation).toHaveBeenCalledWith(current);
    expect(current.endSession).toHaveBeenCalledOnce();
  });

  it("uses the non-transaction session only when an atomic callback gives no result", async () => {
    const current = session(async (callback) => callback());
    mocks.startSession.mockResolvedValue(current);
    const operation = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValueOnce("fallback");

    await expect(runInTransaction(operation as any)).resolves.toBe("fallback");
    expect(operation).toHaveBeenNthCalledWith(1, current);
    expect(operation).toHaveBeenNthCalledWith(2, null);
  });

  it("uses a non-transaction session only outside production when MongoDB does not support transactions", async () => {
    const current = session(async () => { throw { code: 20, codeName: "IllegalOperation" }; });
    mocks.startSession.mockResolvedValue(current);
    const operation = vi.fn().mockResolvedValue("fallback");

    await expect(runInTransaction(operation as any)).resolves.toBe("fallback");
    expect(operation).toHaveBeenCalledWith(null);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("transactions are unavailable"));
  });

  it("fails closed in production when MongoDB cannot provide transactions", async () => {
    mocks.env.NODE_ENV = "production";
    const current = session(async () => { throw new Error("transactions are not supported by this server"); });
    mocks.startSession.mockResolvedValue(current);
    const operation = vi.fn();

    await expect(runInTransaction(operation as any)).rejects.toThrow("replica-set (or mongos) connection is required");
    expect(operation).not.toHaveBeenCalled();
    expect(current.endSession).toHaveBeenCalledOnce();
  });

  it("does not hide errors that are unrelated to transaction support", async () => {
    const current = session(async () => { throw new Error("database unavailable"); });
    mocks.startSession.mockResolvedValue(current);

    await expect(runInTransaction(vi.fn() as any)).rejects.toThrow("database unavailable");
    expect(current.endSession).toHaveBeenCalledOnce();
  });

  it("also recognizes MongoDB's IllegalOperation name", async () => {
    const current = session(async () => { throw { codeName: "IllegalOperation" }; });
    mocks.startSession.mockResolvedValue(current);

    await expect(runInTransaction(vi.fn().mockResolvedValue("fallback") as any)).resolves.toBe("fallback");
  });

  it("does not mistake an empty error value for unsupported transactions", async () => {
    const current = session(async () => { throw null; });
    mocks.startSession.mockResolvedValue(current);

    await expect(runInTransaction(vi.fn() as any)).rejects.toBeNull();
  });
});
