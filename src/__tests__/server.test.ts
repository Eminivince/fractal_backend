import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  app: {
    close: vi.fn(),
    listen: vi.fn(),
    log: { info: vi.fn() },
  },
  buildApp: vi.fn(),
  closeAllQueues: vi.fn(),
  connectMongo: vi.fn(),
  connectPostgres: vi.fn(),
  connectRedis: vi.fn(),
  disconnectMongo: vi.fn(),
  disconnectPostgres: vi.fn(),
  disconnectRedis: vi.fn(),
}));

vi.mock("../app.js", () => ({ buildApp: mocks.buildApp }));
vi.mock("../config/env.js", () => ({ env: { PORT: 4100 } }));
vi.mock("../db/mongo.js", () => ({ connectMongo: mocks.connectMongo, disconnectMongo: mocks.disconnectMongo }));
vi.mock("../db/postgres.js", () => ({ connectPostgres: mocks.connectPostgres, disconnectPostgres: mocks.disconnectPostgres }));
vi.mock("../db/redis.js", () => ({ connectRedis: mocks.connectRedis, disconnectRedis: mocks.disconnectRedis }));
vi.mock("../services/queue.js", () => ({ closeAllQueues: mocks.closeAllQueues }));

async function flushAsyncWork() {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function expectCallBefore(first: { mock: { invocationCallOrder: number[] } }, second: { mock: { invocationCallOrder: number[] } }) {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]!);
}

describe("API server process", () => {
  const signalHandlers: Record<string, () => void> = {};
  let exitSpy: any;
  let processOnSpy: any;
  let consoleErrorSpy: any;

  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(mocks)) {
      if (typeof mock === "function" && "mockReset" in mock) mock.mockReset();
    }
    mocks.app.close.mockReset();
    mocks.app.listen.mockReset();
    mocks.app.log.info.mockReset();
    mocks.connectMongo.mockResolvedValue(undefined);
    mocks.connectRedis.mockResolvedValue(undefined);
    mocks.connectPostgres.mockResolvedValue(undefined);
    mocks.buildApp.mockResolvedValue(mocks.app);
    mocks.app.listen.mockResolvedValue(undefined);
    mocks.closeAllQueues.mockResolvedValue(undefined);
    mocks.app.close.mockResolvedValue(undefined);
    mocks.disconnectMongo.mockResolvedValue(undefined);
    mocks.disconnectPostgres.mockResolvedValue(undefined);
    mocks.disconnectRedis.mockResolvedValue(undefined);
    for (const key of Object.keys(signalHandlers)) delete signalHandlers[key];
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: () => void) => {
      signalHandlers[String(event)] = listener;
      return process;
    }) as never);
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    processOnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  it("connects dependencies, listens on the configured port, and closes in a safe order", async () => {
    await import("../server.js");
    await flushAsyncWork();

    expectCallBefore(mocks.connectMongo, mocks.connectRedis);
    expectCallBefore(mocks.connectRedis, mocks.connectPostgres);
    expect(mocks.app.listen).toHaveBeenCalledWith({ port: 4100, host: "0.0.0.0" });
    expect(signalHandlers.SIGINT).toBeTypeOf("function");
    expect(signalHandlers.SIGTERM).toBeTypeOf("function");

    signalHandlers.SIGTERM!();
    await flushAsyncWork();

    expectCallBefore(mocks.closeAllQueues, mocks.app.close);
    expectCallBefore(mocks.app.close, mocks.disconnectRedis);
    expectCallBefore(mocks.disconnectRedis, mocks.disconnectPostgres);
    expectCallBefore(mocks.disconnectPostgres, mocks.disconnectMongo);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("reports a startup failure and exits with a non-zero status", async () => {
    const failure = new Error("MongoDB is unavailable");
    mocks.connectMongo.mockRejectedValueOnce(failure);

    await import("../server.js");
    await flushAsyncWork();

    expect(consoleErrorSpy).toHaveBeenCalledWith(failure);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(mocks.app.listen).not.toHaveBeenCalled();
  });
});
