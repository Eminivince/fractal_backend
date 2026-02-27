import type mongoose from "mongoose";
import { AnchorModel } from "../db/models.js";
import type { EntityType } from "./constants.js";
import { hashPayload } from "./idempotency.js";

interface CreateAnchorInput {
  entityType: EntityType;
  entityId: string;
  eventType: string;
  payload: unknown;
  anchorStatus?: "pending" | "anchored" | "failed";
  chainRef?: string;
  txHash?: string;
}

export async function createAnchorRecord(
  input: CreateAnchorInput,
  session?: mongoose.ClientSession,
): Promise<{ id: string; canonicalHash: string }> {
  const canonicalHash = hashPayload({
    entityType: input.entityType,
    entityId: input.entityId,
    eventType: input.eventType,
    payload: input.payload,
  });

  const [anchor] = await AnchorModel.create(
    [
      {
        entityType: input.entityType,
        entityId: input.entityId,
        eventType: input.eventType,
        canonicalHash,
        anchorStatus: input.anchorStatus ?? "pending",
        chainRef: input.chainRef,
        txHash: input.txHash,
        anchoredAt: input.anchorStatus === "anchored" ? new Date() : undefined,
        payload: input.payload,
      },
    ],
    { session },
  );

  return { id: String(anchor._id), canonicalHash };
}

export async function hasAnchor(entityType: EntityType, entityId: string, eventType: string): Promise<boolean> {
  const row = await AnchorModel.findOne({ entityType, entityId, eventType }).lean();
  return Boolean(row);
}
