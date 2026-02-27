import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import {
  applicationStatuses,
  distributionStatuses,
  entityTypes,
  milestoneStatuses,
  offeringStatuses,
  roles,
  stages,
  subscriptionStatuses,
  trancheStatuses,
} from "../../utils/constants.js";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const anchorSchema = new Schema(
  {
    entityType: { type: String, enum: entityTypes, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    eventType: { type: String, required: true, index: true },
    canonicalHash: { type: String, required: true },
    anchorStatus: { type: String, enum: ["pending", "processing", "anchored", "failed"], default: "pending", index: true },
    chainRef: { type: String },
    txHash: { type: String },
    anchoredAt: { type: Date },
    attempts: { type: Number, default: 0 },
    lastError: { type: String },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "anchors" },
);
anchorSchema.index({ entityType: 1, entityId: 1, eventType: 1, canonicalHash: 1 }, { unique: true });

anchorSchema.plugin(softDeletePlugin);

export type AnchorDoc = InferSchemaType<typeof anchorSchema> & { _id: Types.ObjectId };

export const AnchorModel: any =
  mongoose.models.Anchor ?? mongoose.model("Anchor", anchorSchema);
