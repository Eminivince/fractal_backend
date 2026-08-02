/**
 * Event bus — re-exports from durable-event-bus (B5).
 * Preserves import paths for all existing consumers.
 */

export { eventBus, emitUserEvent, onUserEvent } from "./durable-event-bus.js";
