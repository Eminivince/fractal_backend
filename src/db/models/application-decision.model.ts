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

const applicationDecisionSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true, unique: true, index: true },
    reviewRoundId: { type: Schema.Types.ObjectId, ref: "ApplicationReviewRound" },
    decision: { type: String, enum: ["approved", "rejected"], required: true, index: true },
    reasonCode: { type: String },
    notes: { type: String },
    decidedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    decidedAt: { type: Date, required: true, default: Date.now },
  },
  { ...timestamped, collection: "applicationDecisions" },
);

applicationDecisionSchema.plugin(softDeletePlugin);

export type ApplicationDecisionDoc = InferSchemaType<typeof applicationDecisionSchema> & { _id: Types.ObjectId };

export const ApplicationDecisionModel: any =
  mongoose.models.ApplicationDecision ?? mongoose.model("ApplicationDecision", applicationDecisionSchema);
