import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  autoInstrumentations: vi.fn(),
  env: { SENTRY_DSN: undefined as string | undefined, NODE_ENV: "test", SENTRY_TRACES_SAMPLE_RATE: 0.1, OTEL_ENABLED: false, OTEL_EXPORTER_OTLP_ENDPOINT: undefined as string | undefined },
  exporter: vi.fn(),
  sentryInit: vi.fn(),
  sdkInstances: [] as Array<{ start: ReturnType<typeof vi.fn>; shutdown: ReturnType<typeof vi.fn> }>,
}));

vi.mock("../config/env.js", () => ({ env: mocks.env }));
vi.mock("@sentry/node", () => ({ init: mocks.sentryInit }));
vi.mock("@opentelemetry/auto-instrumentations-node", () => ({ getNodeAutoInstrumentations: mocks.autoInstrumentations }));
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({ OTLPTraceExporter: mocks.exporter }));
vi.mock("@opentelemetry/sdk-node", () => ({
  NodeSDK: class {
    start = vi.fn();
    shutdown = vi.fn().mockResolvedValue(undefined);
    constructor() { mocks.sdkInstances.push(this); }
  },
}));

describe("process instrumentation", () => {
  const signalHandlers: Record<string, () => void> = {};
  let processOnSpy: any;
  let infoSpy: any;

  beforeEach(() => {
    vi.resetModules();
    mocks.sentryInit.mockReset(); mocks.autoInstrumentations.mockReset(); mocks.exporter.mockReset(); mocks.sdkInstances.splice(0);
    mocks.autoInstrumentations.mockReturnValue(["instrumentation"]);
    Object.assign(mocks.env, { SENTRY_DSN: undefined, NODE_ENV: "test", SENTRY_TRACES_SAMPLE_RATE: 0.1, OTEL_ENABLED: false, OTEL_EXPORTER_OTLP_ENDPOINT: undefined });
    for (const key of Object.keys(signalHandlers)) delete signalHandlers[key];
    processOnSpy = vi.spyOn(process, "on").mockImplementation(((event: string | symbol, listener: () => void) => { signalHandlers[String(event)] = listener; return process; }) as never);
    infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => { processOnSpy.mockRestore(); infoSpy.mockRestore(); });

  it("does not load optional telemetry when it is disabled", async () => {
    await import("../instrumentation.js");

    expect(mocks.sentryInit).not.toHaveBeenCalled();
    expect(mocks.sdkInstances).toHaveLength(0);
  });

  it("starts configured Sentry and OpenTelemetry, then drains telemetry on SIGTERM", async () => {
    Object.assign(mocks.env, { SENTRY_DSN: "https://public@example.test/1", NODE_ENV: "production", SENTRY_TRACES_SAMPLE_RATE: 0.25, OTEL_ENABLED: true, OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example.test/v1/traces" });

    await import("../instrumentation.js");

    expect(mocks.sentryInit).toHaveBeenCalledWith({ dsn: "https://public@example.test/1", environment: "production", tracesSampleRate: 0.25 });
    expect(mocks.exporter).toHaveBeenCalledWith({ url: "https://otel.example.test/v1/traces" });
    expect(mocks.autoInstrumentations).toHaveBeenCalledWith({ "@opentelemetry/instrumentation-fs": { enabled: false } });
    expect(mocks.sdkInstances).toHaveLength(1);
    expect(mocks.sdkInstances[0]!.start).toHaveBeenCalledOnce();
    signalHandlers.SIGTERM!();
    await Promise.resolve();
    expect(mocks.sdkInstances[0]!.shutdown).toHaveBeenCalledOnce();
  });

  it("uses the local collector endpoint when OpenTelemetry has no explicit endpoint", async () => {
    mocks.env.OTEL_ENABLED = true;

    await import("../instrumentation.js");

    expect(mocks.exporter).toHaveBeenCalledWith({ url: "http://localhost:4318/v1/traces" });
  });
});
