import { describe, expect, it, vi } from "vitest";

import { registerFinancialLogger } from "../financial-logger.js";

describe("financial logger", () => {
  it("does not log a route that is not a financial operation", async () => {
    let hook: ((request: any, reply: any, payload: unknown, done: (error: Error | null, value?: unknown) => void) => void) | undefined;
    await registerFinancialLogger({ addHook: (_name: string, handler: typeof hook) => { hook = handler; } } as any);
    const done = vi.fn(); const log = { info: vi.fn() };
    hook!({ method: "GET", url: "/v1/health", body: {}, log }, { statusCode: 200 }, { ok: true }, done);
    expect(log.info).not.toHaveBeenCalled();
    expect(done).toHaveBeenCalledWith(null, { ok: true });
  });

  it("logs a financial route with nested sensitive fields redacted and account values masked", async () => {
    let hook: ((request: any, reply: any, payload: unknown, done: (error: Error | null, value?: unknown) => void) => void) | undefined;
    await registerFinancialLogger({ addHook: (_name: string, handler: typeof hook) => { hook = handler; } } as any);
    const done = vi.fn(); const log = { info: vi.fn() };
    hook!({ method: "POST", routeOptions: { url: "/v1/subscriptions/:id/initiate-payment" }, body: { password: "secret", accountNumber: "1234567890", nested: [{ accessToken: "token", accountNumber: "4321" }] }, correlationId: "correlation-1", authUser: { userId: "user-1" }, log }, { statusCode: 201 }, { ok: true }, done);
    expect(log.info).toHaveBeenCalledWith({ audit: "financial", correlationId: "correlation-1", method: "POST", route: "/v1/subscriptions/:id/initiate-payment", userId: "user-1", requestBody: { password: "[REDACTED]", accountNumber: "****7890", nested: [{ accessToken: "[REDACTED]", accountNumber: "4321" }] }, statusCode: 201 }, "financial-audit");
    expect(done).toHaveBeenCalledWith(null, { ok: true });
  });

  it("matches parameterized financial routes and uses safe anonymous metadata", async () => {
    let hook: ((request: any, reply: any, payload: unknown, done: (error: Error | null, value?: unknown) => void) => void) | undefined;
    await registerFinancialLogger({ addHook: (_name: string, handler: typeof hook) => { hook = handler; } } as any);
    const done = vi.fn(); const log = { info: vi.fn() };
    hook!({ method: "POST", url: "/v1/subscriptions/subscription-1/cancel", body: { pin: "1234" }, log }, { statusCode: 204 }, null, done);
    expect(log.info).toHaveBeenCalledWith(expect.objectContaining({ route: "/v1/subscriptions/subscription-1/cancel", userId: "anonymous", requestBody: { pin: "[REDACTED]" } }), "financial-audit");
  });
});
