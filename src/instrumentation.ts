/**
 * Process instrumentation, preloaded via `node --import`.
 * Must run before any other module so it can patch the runtime.
 *  - Sentry error tracking (gated by SENTRY_DSN)
 *  - OpenTelemetry tracing (gated by OTEL_ENABLED)
 */

import { env } from "./config/env.js";

// ── Sentry (error tracking) ──────────────────────────────────────────────────
if (env.SENTRY_DSN) {
  const Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: env.SENTRY_DSN,
    environment: env.NODE_ENV,
    tracesSampleRate: env.SENTRY_TRACES_SAMPLE_RATE,
  });
  console.info("[sentry] error tracking initialized");
}

if (env.OTEL_ENABLED) {
  const { NodeSDK } = await import("@opentelemetry/sdk-node");
  const { getNodeAutoInstrumentations } = await import("@opentelemetry/auto-instrumentations-node");
  const { OTLPTraceExporter } = await import("@opentelemetry/exporter-trace-otlp-http");

  const sdk = new NodeSDK({
    serviceName: "fractal-api",
    traceExporter: new OTLPTraceExporter({
      url: env.OTEL_EXPORTER_OTLP_ENDPOINT || "http://localhost:4318/v1/traces",
    }),
    instrumentations: [
      getNodeAutoInstrumentations({
        "@opentelemetry/instrumentation-fs": { enabled: false },
      }),
    ],
  });

  sdk.start();
  console.info("[otel] OpenTelemetry tracing initialized");

  process.on("SIGTERM", () => {
    sdk.shutdown().catch(console.error);
  });
}
