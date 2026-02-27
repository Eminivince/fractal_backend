import { EventEmitter } from "node:events";

/**
 * In-process event bus for real-time SSE fan-out.
 * Each connected client subscribes to `user:<userId>` events.
 */
export const eventBus = new EventEmitter();

// Allow up to 5000 concurrent SSE connections without emitting warnings.
eventBus.setMaxListeners(5000);

export function emitUserEvent(userId: string, payload: Record<string, unknown>): void {
  eventBus.emit(`user:${userId}`, payload);
}
