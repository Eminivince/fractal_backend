import { createHash } from "node:crypto";
import type mongoose from "mongoose";
import { EventLogModel } from "../db/models.js";
import type { EntityType } from "./constants.js";
import type { AuthUser } from "../types.js";
import { createNotificationsFromEvent } from "../services/notifications.js";

interface EventInput {
  entityType: EntityType;
  entityId: string;
  action: string;
  notes?: string;
  diff?: unknown;
}

const GENESIS_HASH = "0".repeat(64);

/** Deterministic content hash for an audit record, chained to the previous hash. */
function computeEventHash(core: Record<string, unknown>, prevHash: string): string {
  return createHash("sha256")
    .update(prevHash)
    .update(JSON.stringify(core))
    .digest("hex");
}

export async function appendEvent(
  actor: AuthUser,
  input: EventInput,
  session?: mongoose.ClientSession,
) {
  const timestamp = new Date();

  // Tamper-evident chain: link each record to the most recent prior event's hash.
  const last = await EventLogModel.findOne({})
    .sort({ _id: -1 })
    .select("hash")
    .session(session ?? null)
    .lean();
  const prevHash: string = last?.hash ?? GENESIS_HASH;

  const core = {
    entityType: input.entityType,
    entityId: input.entityId,
    action: input.action,
    actorUserId: actor.userId,
    roleAtTime: actor.role,
    timestamp: timestamp.toISOString(),
    notes: input.notes ?? null,
    diff: input.diff ?? null,
  };
  const hash = computeEventHash(core, prevHash);

  await EventLogModel.create(
    [
      {
        ...core,
        timestamp,
        notes: input.notes,
        diff: input.diff,
        hash,
        prevHash,
      },
    ],
    { session },
  );

  await createNotificationsFromEvent(actor, input, session);
}
