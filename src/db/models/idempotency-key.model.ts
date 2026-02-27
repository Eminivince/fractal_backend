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

const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    responseBody: { type: Schema.Types.Mixed, required: true },
    createdAt: { type: Date, required: true },
  },
  { collection: "idempotencyKeys" },
);
idempotencySchema.index({ key: 1, userId: 1, route: 1 }, { unique: true });

export type IdempotencyKeyDoc = InferSchemaType<typeof idempotencySchema> & { _id: Types.ObjectId };

export const IdempotencyKeyModel: any =
  mongoose.models.IdempotencyKey ?? mongoose.model("IdempotencyKey", idempotencySchema);
