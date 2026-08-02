import { Redis } from "ioredis";
import { env } from "../config/env.js";

let client: Redis | null = null;
let subscriber: Redis | null = null;

export async function connectRedis(): Promise<void> {
  if (!env.REDIS_URL) {
    if (env.NODE_ENV === "production") {
      throw new Error("REDIS_URL is required in production");
    }
    return;
  }

  let nextClient: Redis | null = null;
  let nextSubscriber: Redis | null = null;
  try {
    nextClient = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    await nextClient.connect();

    nextSubscriber = new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
    });
    await nextSubscriber.connect();
    client = nextClient;
    subscriber = nextSubscriber;
  } catch (err) {
    nextSubscriber?.disconnect();
    nextClient?.disconnect();
    client = null;
    subscriber = null;
    if (env.NODE_ENV === "production") {
      throw new Error("Redis connection failed in production", { cause: err });
    }
    console.warn("[redis] Failed to connect — running without Redis:", (err as Error).message);
  }
}

export async function disconnectRedis(): Promise<void> {
  if (subscriber) {
    subscriber.disconnect();
    subscriber = null;
  }
  if (client) {
    client.disconnect();
    client = null;
  }
}

export function getRedis(): Redis | null {
  return client;
}

export function getRedisSubscriber(): Redis | null {
  return subscriber;
}
