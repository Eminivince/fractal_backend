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

const eventLogSchema = new Schema(
  {
    entityType: {
      type: String,
      enum: entityTypes,
      required: true,
    },
    entityId: { type: String, required: true },
    action: { type: String, required: true },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    roleAtTime: { type: String, enum: roles, required: true },
    timestamp: { type: Date, required: true, index: true },
    notes: { type: String },
    diff: { type: Schema.Types.Mixed },
  },
  { collection: "eventLogs" },
);
eventLogSchema.index({ entityType: 1, entityId: 1 });

export type EventLogDoc = InferSchemaType<typeof eventLogSchema> & { _id: Types.ObjectId };

export const EventLogModel: any =
  mongoose.models.EventLog ?? mongoose.model("EventLog", eventLogSchema);
