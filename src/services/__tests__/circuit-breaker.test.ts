import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBreaker, getBreakerStats } from "../circuit-breaker.js";

afterEach(() => vi.restoreAllMocks());

describe("external service circuit breakers", () => {
  it("reuses a breaker by name and exposes its state", async () => {
    const name = `provider-${randomUUID()}`;
    const fn = vi.fn().mockResolvedValue("ok");
    const first = createBreaker(name, fn, { volumeThreshold: 1 });
    const second = createBreaker(name, vi.fn().mockResolvedValue("different"));
    expect(second).toBe(first);
    await expect(first.fire("request")).resolves.toBe("ok");
    expect(getBreakerStats()[name]).toMatchObject({ state: "closed" });
  });

  it("reports open, half-open, and recovered breaker transitions", () => {
    const name = `provider-${randomUUID()}`;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const breaker = createBreaker(name, vi.fn().mockResolvedValue("ok"));

    breaker.emit("open");
    breaker.emit("halfOpen");
    breaker.emit("close");

    expect(warn).toHaveBeenCalledWith(`[circuit-breaker:${name}] OPEN — requests will be short-circuited`);
    expect(info).toHaveBeenCalledWith(`[circuit-breaker:${name}] HALF-OPEN — testing recovery`);
    expect(info).toHaveBeenCalledWith(`[circuit-breaker:${name}] CLOSED — recovered`);
  });
});
