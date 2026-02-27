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

export async function appendEvent(
  actor: AuthUser,
  input: EventInput,
  session?: mongoose.ClientSession,
) {
  await EventLogModel.create(
    [
      {
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        actorUserId: actor.userId,
        roleAtTime: actor.role,
        timestamp: new Date(),
        notes: input.notes,
        diff: input.diff,
      },
    ],
    { session },
  );

  await createNotificationsFromEvent(actor, input, session);
}
