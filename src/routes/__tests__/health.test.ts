import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  mongoPing: vi.fn(), redisPing: vi.fn(), postgresQuery: vi.fn(), getRedis: vi.fn(), getPostgres: vi.fn(),
  connection: { readyState: 1, db: { admin: () => ({ ping: vi.fn() }) } },
  env: { NODE_ENV: "development", POSTGRES_REQUIRED: false },
}));
vi.mock("mongoose", () => ({ default: { connection: mocks.connection } }));
vi.mock("../../db/redis.js", () => ({ getRedis: mocks.getRedis }));
vi.mock("../../db/postgres.js", () => ({ getPostgres: mocks.getPostgres }));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));
import { healthRoutes } from "../health.js";

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  mocks.mongoPing.mockReset(); mocks.redisPing.mockReset(); mocks.postgresQuery.mockReset(); mocks.getRedis.mockReset(); mocks.getPostgres.mockReset();
  mocks.connection.readyState = 1;
  mocks.connection.db = { admin: () => ({ ping: mocks.mongoPing }) };
  mocks.mongoPing.mockResolvedValue(undefined); mocks.redisPing.mockResolvedValue("PONG"); mocks.postgresQuery.mockResolvedValue({ rows: [{ "?column?": 1 }] });
  mocks.getRedis.mockReturnValue({ ping: mocks.redisPing }); mocks.getPostgres.mockReturnValue({ query: mocks.postgresQuery });
  Object.assign(mocks.env, { NODE_ENV: "development", POSTGRES_REQUIRED: false });
  app = Fastify();
  await app.register(healthRoutes);
});
afterEach(async () => { await app.close(); });

describe("health routes", () => {
  it("returns liveness, readiness, and health success only when every required dependency is healthy", async () => {
    await expect(app.inject({ method: "GET", url: "/livez" })).resolves.toMatchObject({ statusCode: 200 });
    const ready = await app.inject({ method: "GET", url: "/readyz" });
    expect(ready.statusCode).toBe(200); expect(ready.json()).toMatchObject({ ready: true, checks: { mongo: { status: "ok" }, redis: { status: "ok" }, postgres: { status: "ok" } } });
    await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("reports safe degraded or down dependency states without claiming readiness", async () => {
    mocks.connection.readyState = 0; mocks.getRedis.mockReturnValue(undefined); mocks.getPostgres.mockReturnValue(undefined);
    mocks.env.NODE_ENV = "production"; mocks.env.POSTGRES_REQUIRED = true;
    await expect(app.inject({ method: "GET", url: "/readyz" })).resolves.toMatchObject({ statusCode: 503 });
    await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({ statusCode: 503 });
    mocks.connection.readyState = 1; mocks.mongoPing.mockRejectedValueOnce(new Error("Mongo unavailable"));
    mocks.getRedis.mockReturnValue({ ping: mocks.redisPing }); mocks.redisPing.mockResolvedValueOnce("unexpected");
    mocks.getPostgres.mockReturnValue({ query: mocks.postgresQuery }); mocks.postgresQuery.mockRejectedValueOnce(new Error("PostgreSQL unavailable"));
    const degraded = await app.inject({ method: "GET", url: "/health" });
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toMatchObject({ checks: { mongo: { status: "down" }, redis: { status: "degraded" }, postgres: { status: "down" } } });
    mocks.connection.readyState = 1; mocks.mongoPing.mockResolvedValue(undefined);
    mocks.env.NODE_ENV = "development"; mocks.env.POSTGRES_REQUIRED = false;
    mocks.getRedis.mockReturnValue(undefined); mocks.getPostgres.mockReturnValue(undefined);
    const optional = await app.inject({ method: "GET", url: "/health" });
    expect(optional.statusCode).toBe(200);
    expect(optional.json()).toMatchObject({ checks: { redis: { status: "degraded" }, postgres: { status: "degraded" } } });
    mocks.getRedis.mockReturnValue({ ping: mocks.redisPing }); mocks.redisPing.mockRejectedValueOnce(new Error("Redis unavailable"));
    mocks.getPostgres.mockReturnValue({ query: mocks.postgresQuery }); mocks.postgresQuery.mockResolvedValueOnce({ rows: [] });
    await expect(app.inject({ method: "GET", url: "/health" })).resolves.toMatchObject({ statusCode: 503 });
  });
});
