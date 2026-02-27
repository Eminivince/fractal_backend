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

const reconciliationRunSchema = new Schema(
  {
    source: { type: String, enum: ["bank", "onchain", "provider", "manual"], required: true, index: true },
    status: { type: String, enum: ["ok", "mismatch", "failed"], required: true, index: true },
    checkedAt: { type: Date, required: true, index: true },
    matchedCount: { type: Number, default: 0 },
    mismatchCount: { type: Number, default: 0 },
    notes: { type: String },
  },
  { ...timestamped, collection: "reconciliationRuns" },
);

reconciliationRunSchema.plugin(softDeletePlugin);

export type ReconciliationRunDoc = InferSchemaType<typeof reconciliationRunSchema> & { _id: Types.ObjectId };

export const ReconciliationRunModel: any =
  mongoose.models.ReconciliationRun ?? mongoose.model("ReconciliationRun", reconciliationRunSchema);
