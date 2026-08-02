/**
 * B12: Circuit breaker for external services (Paystack, Sumsub).
 * Uses opossum for graceful degradation when services are down.
 */

import CircuitBreaker from "opossum";

const DEFAULT_OPTIONS = {
  timeout: 10_000,
  errorThresholdPercentage: 50,
  resetTimeout: 30_000,
  volumeThreshold: 5,
};

const breakers = new Map<string, CircuitBreaker>();

export function createBreaker<T>(
  name: string,
  fn: (...args: any[]) => Promise<T>,
  opts?: Partial<typeof DEFAULT_OPTIONS>,
): CircuitBreaker {
  const existing = breakers.get(name);
  if (existing) return existing;

  const breaker = new CircuitBreaker(fn, { ...DEFAULT_OPTIONS, ...opts, name });

  breaker.on("open", () => console.warn(`[circuit-breaker:${name}] OPEN — requests will be short-circuited`));
  breaker.on("halfOpen", () => console.info(`[circuit-breaker:${name}] HALF-OPEN — testing recovery`));
  breaker.on("close", () => console.info(`[circuit-breaker:${name}] CLOSED — recovered`));

  breakers.set(name, breaker);
  return breaker;
}

export function getBreakerStats(): Record<string, { state: string; stats: any }> {
  const result: Record<string, { state: string; stats: any }> = {};
  for (const [name, breaker] of breakers) {
    result[name] = {
      state: breaker.opened ? "open" : breaker.halfOpen ? "half-open" : "closed",
      stats: breaker.stats,
    };
  }
  return result;
}
