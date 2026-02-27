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

const trancheSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    milestoneId: { type: Schema.Types.ObjectId, ref: "Milestone", required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    status: {
      type: String,
      enum: trancheStatuses,
      default: "locked",
      index: true,
    },
    releasedBy: { type: Schema.Types.ObjectId, ref: "User" },
    releasedAt: { type: Date },
    payoutReceiptRefs: [{ type: String }],
    failedAt: { type: Date },
    reversedAt: { type: Date },
    reversalReason: { type: String },
  },
  { ...timestamped, collection: "tranches" },
);

trancheSchema.plugin(softDeletePlugin);

export type TrancheDoc = InferSchemaType<typeof trancheSchema> & { _id: Types.ObjectId };

export const TrancheModel: any =
  mongoose.models.Tranche ?? mongoose.model("Tranche", trancheSchema);
