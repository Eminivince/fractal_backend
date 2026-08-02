/**
 * B6: Deep health check endpoint.
 * Verifies connectivity to all critical dependencies.
 */

import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { getRedis } from "../db/redis.js";
import { getPostgres } from "../db/postgres.js";
import { env } from "../config/env.js";

interface HealthCheck {
  status: "ok" | "degraded" | "down";
  latencyMs?: number;
  message?: string;
}

async function checkMongo(): Promise<HealthCheck> {
  const start = performance.now();
  try {
    if (mongoose.connection.readyState !== 1) {
      return { status: "down", message: "Not connected" };
    }
    await mongoose.connection.db!.admin().ping();
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { status: "down", latencyMs: Math.round(performance.now() - start), message: "Unavailable" };
  }
}

async function checkRedis(): Promise<HealthCheck> {
  const redis = getRedis();
  if (!redis) {
    return env.NODE_ENV === "production"
      ? { status: "down", message: "Not configured" }
      : { status: "degraded", message: "Not configured" };
  }

  const start = performance.now();
  try {
    const pong = await redis.ping();
    return pong === "PONG"
      ? { status: "ok", latencyMs: Math.round(performance.now() - start) }
      : { status: "degraded", latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { status: "down", latencyMs: Math.round(performance.now() - start), message: "Unavailable" };
  }
}

async function checkPostgres(): Promise<HealthCheck> {
  const postgres = getPostgres();
  if (!postgres) {
    return env.POSTGRES_REQUIRED
      ? { status: "down", message: "Not configured" }
      : { status: "degraded", message: "Not configured" };
  }

  const start = performance.now();
  try {
    await postgres.query("SELECT 1");
    return { status: "ok", latencyMs: Math.round(performance.now() - start) };
  } catch {
    return { status: "down", latencyMs: Math.round(performance.now() - start), message: "Unavailable" };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  // Liveness: is the process up and able to respond? No dependency checks.
  // Orchestrators use this to decide whether to RESTART the container.
  app.get("/livez", async (_req, reply) => {
    return reply.code(200).send({ status: "ok", uptimeSec: Math.round(process.uptime()) });
  });

  // Readiness: are critical dependencies healthy enough to serve traffic?
  // Load balancers use this to decide whether to ROUTE traffic. 503 when not ready.
  app.get("/readyz", async (_req, reply) => {
    const [mongo, redis, postgres] = await Promise.all([checkMongo(), checkRedis(), checkPostgres()]);
    // Mongo is always required; Redis is also required for production workers.
    const ready = mongo.status === "ok" && redis.status !== "down";
    const postgresReady = postgres.status !== "down";
    return reply.code(ready && postgresReady ? 200 : 503).send({ ready: ready && postgresReady, checks: { mongo, redis, postgres } });
  });

  // Detailed health is intentionally local and cheap. Provider availability is
  // monitored through provider-specific metrics/reconciliation, not probe traffic.
  app.get("/health", async (_req, reply) => {
    const [mongo, redis, postgres] = await Promise.all([checkMongo(), checkRedis(), checkPostgres()]);

    const checks = { mongo, redis, postgres };
    const ok = mongo.status === "ok" && redis.status !== "down" && postgres.status !== "down";
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });
}
