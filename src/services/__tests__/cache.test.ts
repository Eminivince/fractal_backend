import { beforeEach, describe, expect, it, vi } from "vitest";

const getRedis = vi.hoisted(() => vi.fn());
vi.mock("../../db/redis.js", () => ({ getRedis }));

import { cacheGet, cacheInvalidate, cacheSet, cacheable } from "../cache.js";

beforeEach(() => vi.clearAllMocks());

describe("cache service", () => {
  it("falls back safely when Redis is unavailable", async () => {
    getRedis.mockReturnValue(null);
    await expect(cacheGet("key")).resolves.toBeNull();
    await expect(cacheSet("key", { value: 1 }, 60)).resolves.toBeUndefined();
    await expect(cacheInvalidate()).resolves.toBeUndefined();
  });

  it("reads, writes, and invalidates JSON cache values", async () => {
    const redis = { get: vi.fn().mockResolvedValue('{"value":1}'), setex: vi.fn().mockResolvedValue("OK"), del: vi.fn().mockResolvedValue(2) };
    getRedis.mockReturnValue(redis);
    await expect(cacheGet<{ value: number }>("key")).resolves.toEqual({ value: 1 });
    await cacheSet("key", { value: 2 }, 30);
    await cacheInvalidate("key", "other");
    expect(redis.setex).toHaveBeenCalledWith("key", 30, '{"value":2}');
    expect(redis.del).toHaveBeenCalledWith("key", "other");
  });

  it("contains malformed cache data and Redis errors", async () => {
    const redis = { get: vi.fn().mockResolvedValue("not-json"), setex: vi.fn().mockRejectedValue(new Error("down")), del: vi.fn().mockRejectedValue(new Error("down")) };
    getRedis.mockReturnValue(redis);
    await expect(cacheGet("key")).resolves.toBeNull();
    await expect(cacheSet("key", { value: 1 }, 30)).resolves.toBeUndefined();
    await expect(cacheInvalidate("key")).resolves.toBeUndefined();
  });

  it("returns cached values or fetches and stores a cache miss", async () => {
    const redis = { get: vi.fn().mockResolvedValueOnce('"cached"').mockResolvedValueOnce(null), setex: vi.fn().mockResolvedValue("OK") };
    getRedis.mockReturnValue(redis);
    const fetcher = vi.fn().mockResolvedValue("fresh");
    await expect(cacheable("key", 10, fetcher)).resolves.toBe("cached");
    await expect(cacheable("other", 10, fetcher)).resolves.toBe("fresh");
    expect(fetcher).toHaveBeenCalledOnce();
    expect(redis.setex).toHaveBeenCalledWith("other", 10, '"fresh"');
  });
});
