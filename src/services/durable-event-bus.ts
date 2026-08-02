/**
 * Best-effort live-delivery adapter for persisted notifications and chat
 * messages. Redis pub/sub is deliberately not a durable business-event bus:
 * recipients can always re-fetch their persisted state after reconnecting.
 *
 * Local EventEmitter delivery exists only for development and tests. Production
 * startup requires Redis and never silently narrows delivery to one process.
 */

import { EventEmitter } from "node:events";
import { env } from "../config/env.js";
import { getRedis, getRedisSubscriber } from "../db/redis.js";

const localBus = new EventEmitter();
localBus.setMaxListeners(5000);

const subscribedChannels = new Set<string>();

export function emitUserEvent(userId: string, payload: Record<string, unknown>): void {
  const channel = `user:${userId}`;
  const redis = getRedis();

  if (redis) {
    void redis.publish(channel, JSON.stringify(payload)).catch(() => {
      // Delivery is best-effort only; persisted notification/chat records are
      // authoritative and are recovered by the client on its next fetch.
      if (env.NODE_ENV !== "production") localBus.emit(channel, payload);
    });
  } else if (env.NODE_ENV !== "production") {
    localBus.emit(channel, payload);
  }
}

export function onUserEvent(userId: string, listener: (payload: Record<string, unknown>) => void): () => void {
  const channel = `user:${userId}`;
  const sub = getRedisSubscriber();

  if (sub) {
    if (!subscribedChannels.has(channel)) {
      subscribedChannels.add(channel);
      sub.subscribe(channel).catch(() => {});
    }

    const handler = (ch: string, message: string) => {
      if (ch === channel) {
        try {
          listener(JSON.parse(message));
        } catch {}
      }
    };
    sub.on("message", handler);

    return () => {
      sub.off("message", handler);
    };
  }

  // Local fallback is intentionally unavailable in production. A production
  // process cannot start without Redis; if Redis later disconnects, readiness
  // removes it from service and clients re-fetch persisted state.
  if (env.NODE_ENV === "production") return () => {};

  // Development/test fallback: in-memory delivery.
  localBus.on(channel, listener);
  return () => {
    localBus.off(channel, listener);
  };
}

// Re-export the local bus for backward compatibility
export const eventBus = localBus;
