import { beforeEach, describe, expect, it, vi } from "vitest";

const getRedis = vi.hoisted(() => vi.fn());
const getRedisSubscriber = vi.hoisted(() => vi.fn());
const env = vi.hoisted(() => ({ NODE_ENV: "test" }));

vi.mock("../../config/env.js", () => ({ env }));
vi.mock("../../db/redis.js", () => ({ getRedis, getRedisSubscriber }));

import { emitUserEvent, eventBus, onUserEvent } from "../durable-event-bus.js";

beforeEach(() => {
  vi.clearAllMocks();
  env.NODE_ENV = "test";
  getRedis.mockReturnValue(null);
  getRedisSubscriber.mockReturnValue(null);
});

describe("durable event bus", () => {
  it("uses local delivery outside production when Redis is unavailable", () => {
    const listener = vi.fn();
    const unsubscribe = onUserEvent("user-local", listener);
    emitUserEvent("user-local", { type: "notification" });
    unsubscribe();
    expect(listener).toHaveBeenCalledWith({ type: "notification" });
  });

  it("does not use process-local delivery in production", () => {
    env.NODE_ENV = "production";
    const listener = vi.fn();
    const unsubscribe = onUserEvent("user-production", listener);
    emitUserEvent("user-production", { type: "notification" });
    unsubscribe();
    expect(listener).not.toHaveBeenCalled();
  });

  it("publishes to Redis and falls back locally after a development publish failure", async () => {
    const publish = vi.fn().mockResolvedValue(1);
    getRedis.mockReturnValue({ publish });
    emitUserEvent("user-redis", { type: "notification" });
    expect(publish).toHaveBeenCalledWith("user:user-redis", '{"type":"notification"}');

    const listener = vi.fn();
    const unsubscribe = onUserEvent("user-fallback", listener);
    publish.mockRejectedValueOnce(new Error("Redis disconnected"));
    emitUserEvent("user-fallback", { type: "notification" });
    await Promise.resolve();
    await Promise.resolve();
    unsubscribe();
    expect(listener).toHaveBeenCalledWith({ type: "notification" });
  });

  it("subscribes once to Redis messages, parses payloads, and unsubscribes listeners", async () => {
    const handlers = new Map<string, (channel: string, message: string) => void>();
    const subscriber = {
      subscribe: vi.fn().mockResolvedValue(undefined),
      on: vi.fn((event: string, handler: (channel: string, message: string) => void) => handlers.set(event, handler)),
      off: vi.fn(),
    };
    getRedisSubscriber.mockReturnValue(subscriber);
    const listener = vi.fn();
    const unsubscribe = onUserEvent("user-subscriber", listener);
    await Promise.resolve();
    const handler = handlers.get("message");
    handler?.("user:user-subscriber", '{"type":"notification"}');
    handler?.("user:other", '{"type":"ignored"}');
    handler?.("user:user-subscriber", "not-json");
    unsubscribe();
    expect(subscriber.subscribe).toHaveBeenCalledWith("user:user-subscriber");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({ type: "notification" });
    expect(subscriber.off).toHaveBeenCalledWith("message", expect.any(Function));
  });

  it("keeps the local EventEmitter available for compatibility", () => {
    expect(eventBus.listenerCount("user:missing")).toBe(0);
  });
});
