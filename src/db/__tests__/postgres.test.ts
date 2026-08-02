import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  instances: [] as Array<{ query: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn>; connect: ReturnType<typeof vi.fn> }> ,
  Pool: vi.fn(function Pool() {
    const instance = { query: vi.fn().mockResolvedValue({ rows: [] }), end: vi.fn().mockResolvedValue(undefined), connect: vi.fn() };
    mocks.instances.push(instance);
    return instance;
  }),
  env: { DATABASE_URL: "postgres://localhost/fractal", POSTGRES_POOL_SIZE: 12, POSTGRES_SSL: false, POSTGRES_REQUIRED: false },
}));

vi.mock("pg", () => ({ Pool: mocks.Pool }));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));

import { connectPostgres, disconnectPostgres, getPostgres, postgresQuery, requirePostgres, withPostgresTransaction } from "../postgres.js";

beforeEach(async () => {
  await disconnectPostgres();
  mocks.instances.length = 0; mocks.Pool.mockClear();
  Object.assign(mocks.env, { DATABASE_URL: "postgres://localhost/fractal", POSTGRES_POOL_SIZE: 12, POSTGRES_SSL: false, POSTGRES_REQUIRED: false });
});
afterEach(async () => { await disconnectPostgres(); vi.restoreAllMocks(); });

describe("PostgreSQL connection adapter", () => {
  it("treats an absent optional database as unavailable and requires it when requested", async () => {
    mocks.env.DATABASE_URL = "";
    await connectPostgres();
    expect(getPostgres()).toBeNull();
    await expect(connectPostgres({ required: true })).rejects.toThrow("DATABASE_URL is required for this runtime");
    expect(() => requirePostgres()).toThrow("PostgreSQL is not connected");
  });

  it("connects once with security settings and disconnects cleanly", async () => {
    mocks.env.POSTGRES_SSL = true;
    await connectPostgres(); await connectPostgres();
    expect(mocks.Pool).toHaveBeenCalledOnce();
    expect(mocks.Pool).toHaveBeenCalledWith({ connectionString: "postgres://localhost/fractal", max: 12, ssl: { rejectUnauthorized: true } });
    expect(mocks.instances[0]?.query).toHaveBeenCalledWith("SELECT 1");
    expect(getPostgres()).toBe(mocks.instances[0]);
    await disconnectPostgres(); await disconnectPostgres();
    expect(mocks.instances[0]?.end).toHaveBeenCalledOnce();
  });

  it("cleans up failed optional connections and fails required connections", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.Pool.mockImplementationOnce(function Pool() {
      const instance = { query: vi.fn().mockRejectedValue(new Error("down")), end: vi.fn().mockResolvedValue(undefined), connect: vi.fn() };
      mocks.instances.push(instance); return instance;
    } as any);
    await connectPostgres();
    expect(mocks.instances[0]?.end).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    mocks.Pool.mockImplementationOnce(function Pool() {
      const instance = { query: vi.fn().mockRejectedValue(new Error("down")), end: vi.fn().mockResolvedValue(undefined), connect: vi.fn() };
      mocks.instances.push(instance); return instance;
    } as any);
    await expect(connectPostgres({ required: true })).rejects.toThrow("down");
    expect(mocks.instances[1]?.end).toHaveBeenCalledOnce();
  });

  it("commits successful transactions and forwards query values", async () => {
    await connectPostgres();
    const client = { query: vi.fn().mockResolvedValue(undefined), release: vi.fn() };
    mocks.instances[0]?.connect.mockResolvedValue(client);
    mocks.instances[0]?.query.mockResolvedValue({ rows: [{ id: "row-1" }] });
    await expect(withPostgresTransaction(async (transactionClient) => { expect(transactionClient).toBe(client); return "done"; })).resolves.toBe("done");
    expect(client.query).toHaveBeenNthCalledWith(1, "BEGIN"); expect(client.query).toHaveBeenNthCalledWith(2, "COMMIT"); expect(client.release).toHaveBeenCalledOnce();
    await expect(postgresQuery("SELECT * FROM rows WHERE id=$1", ["row-1"])).resolves.toEqual({ rows: [{ id: "row-1" }] });
    expect(mocks.instances[0]?.query).toHaveBeenLastCalledWith("SELECT * FROM rows WHERE id=$1", ["row-1"]);
    await postgresQuery("SELECT 1"); expect(mocks.instances[0]?.query).toHaveBeenLastCalledWith("SELECT 1", undefined);
  });

  it("rolls back and releases when a transaction or rollback fails", async () => {
    await connectPostgres();
    const client = { query: vi.fn().mockImplementation((sql: string) => sql === "ROLLBACK" ? Promise.reject(new Error("rollback down")) : Promise.resolve(undefined)), release: vi.fn() };
    mocks.instances[0]?.connect.mockResolvedValue(client);
    await expect(withPostgresTransaction(async () => { throw new Error("work failed"); })).rejects.toThrow("work failed");
    expect(client.query).toHaveBeenCalledWith("ROLLBACK"); expect(client.release).toHaveBeenCalledOnce();
  });
});
