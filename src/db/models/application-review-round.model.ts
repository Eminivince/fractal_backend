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

const applicationReviewRoundSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true, index: true },
    roundNumber: { type: Number, required: true },
    status: { type: String, enum: ["open", "closed", "cancelled"], default: "open", index: true },
    stageTag: { type: String, enum: stages },
    summary: { type: String },
    dueAt: { type: Date },
    openedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    openedAt: { type: Date, required: true, default: Date.now },
    closedBy: { type: Schema.Types.ObjectId, ref: "User" },
    closedAt: { type: Date },
  },
  { ...timestamped, collection: "applicationReviewRounds" },
);
applicationReviewRoundSchema.index({ applicationId: 1, roundNumber: 1 }, { unique: true });

applicationReviewRoundSchema.plugin(softDeletePlugin);

export type ApplicationReviewRoundDoc = InferSchemaType<typeof applicationReviewRoundSchema> & { _id: Types.ObjectId };

export const ApplicationReviewRoundModel: any =
  mongoose.models.ApplicationReviewRound ?? mongoose.model("ApplicationReviewRound", applicationReviewRoundSchema);
