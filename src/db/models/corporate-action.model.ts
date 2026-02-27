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

const corporateActionSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    type: {
      type: String,
      enum: ["pause", "unpause", "extend_close", "close", "redemption", "forced_transfer"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: ["draft", "pending_approval", "approved", "executed", "rejected"],
      default: "draft",
      index: true,
    },
    payload: { type: Schema.Types.Mixed, default: {} },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    executedAt: { type: Date },
  },
  { ...timestamped, collection: "corporateActions" },
);

corporateActionSchema.plugin(softDeletePlugin);

export type CorporateActionDoc = InferSchemaType<typeof corporateActionSchema> & { _id: Types.ObjectId };

export const CorporateActionModel: any =
  mongoose.models.CorporateAction ?? mongoose.model("CorporateAction", corporateActionSchema);
