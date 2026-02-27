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

const applicationReviewItemSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true, index: true },
    roundId: { type: Schema.Types.ObjectId, ref: "ApplicationReviewRound", required: true, index: true },
    itemType: {
      type: String,
      enum: ["checklist", "document", "task", "field", "milestone", "other"],
      required: true,
      index: true,
    },
    itemKey: { type: String, required: true },
    title: { type: String, required: true },
    stageTag: { type: String, enum: stages },
    required: { type: Boolean, default: true },
    requestMessage: { type: String, required: true },
    status: { type: String, enum: ["open", "responded", "verified", "rejected"], default: "open", index: true },
    sourceType: {
      type: String,
      enum: ["application_review", "work_order"],
      default: "application_review",
      index: true,
    },
    sourceId: { type: Schema.Types.ObjectId, index: true },
    sourceMeta: { type: Schema.Types.Mixed, default: {} },
    requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    requestedAt: { type: Date, required: true, default: Date.now },
    responseMessage: { type: String },
    responseMeta: { type: Schema.Types.Mixed, default: {} },
    respondedBy: { type: Schema.Types.ObjectId, ref: "User" },
    respondedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
    reviewNotes: { type: String },
  },
  { ...timestamped, collection: "applicationReviewItems" },
);
applicationReviewItemSchema.index({ roundId: 1, status: 1 });
applicationReviewItemSchema.index({ applicationId: 1, itemType: 1, itemKey: 1 });
applicationReviewItemSchema.index({ sourceType: 1, sourceId: 1 });

applicationReviewItemSchema.plugin(softDeletePlugin);

export type ApplicationReviewItemDoc = InferSchemaType<typeof applicationReviewItemSchema> & { _id: Types.ObjectId };

export const ApplicationReviewItemModel: any =
  mongoose.models.ApplicationReviewItem ?? mongoose.model("ApplicationReviewItem", applicationReviewItemSchema);
