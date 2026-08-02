import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const instances: Array<{
    connect: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  }> = [];
  const Redis = vi.fn(function Redis() {
    const instance = {
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
    };
    instances.push(instance);
    return instance;
  });

  return {
    Redis,
    instances,
    env: { REDIS_URL: "redis://localhost:6379", NODE_ENV: "test" },
  };
});

vi.mock("ioredis", () => ({ Redis: mocks.Redis }));
vi.mock("../../config/env.js", () => ({ env: mocks.env }));

import {
  connectRedis,
  disconnectRedis,
  getRedis,
  getRedisSubscriber,
} from "../redis.js";

beforeEach(async () => {
  await disconnectRedis();
  mocks.Redis.mockClear();
  mocks.instances.length = 0;
  Object.assign(mocks.env, {
    REDIS_URL: "redis://localhost:6379",
    NODE_ENV: "test",
  });
});

afterEach(async () => {
  await disconnectRedis();
  vi.restoreAllMocks();
});

describe("Redis connection lifecycle", () => {
  it("does not create clients when Redis is optional and no URL is configured", async () => {
    mocks.env.REDIS_URL = "";

    await connectRedis();

    expect(mocks.Redis).not.toHaveBeenCalled();
    expect(getRedis()).toBeNull();
    expect(getRedisSubscriber()).toBeNull();
  });

  it("requires a Redis URL in production", async () => {
    mocks.env.REDIS_URL = "";
    mocks.env.NODE_ENV = "production";

    await expect(connectRedis()).rejects.toThrow("REDIS_URL is required in production");
  });

  it("connects independent command and subscriber clients, then disconnects both", async () => {
    await connectRedis();

    expect(mocks.Redis).toHaveBeenCalledTimes(2);
    expect(mocks.Redis).toHaveBeenNthCalledWith(1, "redis://localhost:6379", {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    expect(mocks.instances[0]?.connect).toHaveBeenCalledOnce();
    expect(mocks.instances[1]?.connect).toHaveBeenCalledOnce();
    expect(getRedis()).toBe(mocks.instances[0]);
    expect(getRedisSubscriber()).toBe(mocks.instances[1]);

    await disconnectRedis();

    expect(mocks.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(mocks.instances[1]?.disconnect).toHaveBeenCalledOnce();
    expect(getRedis()).toBeNull();
    expect(getRedisSubscriber()).toBeNull();
  });

  it("cleans up partially created clients and continues without Redis outside production", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.Redis.mockImplementationOnce(function Redis() {
      const instance = {
        connect: vi.fn().mockRejectedValue(new Error("connection refused")),
        disconnect: vi.fn(),
      };
      mocks.instances.push(instance);
      return instance;
    } as any);

    await connectRedis();

    expect(mocks.instances).toHaveLength(1);
    expect(mocks.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      "[redis] Failed to connect — running without Redis:",
      "connection refused",
    );
    expect(getRedis()).toBeNull();
    expect(getRedisSubscriber()).toBeNull();
  });

  it("fails closed and clears clients when a production connection fails", async () => {
    mocks.env.NODE_ENV = "production";
    mocks.Redis.mockImplementationOnce(function Redis() {
      const instance = {
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      };
      mocks.instances.push(instance);
      return instance;
    } as any).mockImplementationOnce(function Redis() {
      const instance = {
        connect: vi.fn().mockRejectedValue(new Error("subscriber unavailable")),
        disconnect: vi.fn(),
      };
      mocks.instances.push(instance);
      return instance;
    } as any);

    await expect(connectRedis()).rejects.toThrow("Redis connection failed in production");

    expect(mocks.instances[0]?.disconnect).toHaveBeenCalledOnce();
    expect(mocks.instances[1]?.disconnect).toHaveBeenCalledOnce();
    expect(getRedis()).toBeNull();
    expect(getRedisSubscriber()).toBeNull();
  });
});
