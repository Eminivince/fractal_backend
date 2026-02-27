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

const applicationSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    templateCode: { type: String, enum: ["A", "B"], required: true, index: true },
    workflowVersion: { type: Number, required: true, default: 1 },
    assetId: { type: Schema.Types.ObjectId, ref: "Asset", required: true },
    stage: { type: String, enum: stages, default: "Intake", index: true },
    status: { type: String, enum: applicationStatuses, default: "draft", index: true },
    checklistState: [
      {
        key: { type: String, required: true, maxlength: 200 },
        label: { type: String, required: true, maxlength: 200 },
        stage: { type: String, enum: ["Intake", "Diligence", "Structuring", "Compliance"], required: true },
        required: { type: Boolean, default: true },
        status: { type: String, enum: ["missing", "provided", "verified"], default: "missing" },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    milestones: [
      {
        name: { type: String, required: true },
        percent: { type: Number, required: true },
        targetDate: { type: Date, required: true },
      },
    ],
    submittedAt: { type: Date },
    approvedAt: { type: Date },
    rejectedAt: { type: Date },
    withdrawnAt: { type: Date },
  },
  { ...timestamped, collection: "applications" },
);

// 8.1: Compound indexes
applicationSchema.index({ businessId: 1, status: 1, createdAt: -1 });

applicationSchema.plugin(softDeletePlugin);

export type ApplicationDoc = InferSchemaType<typeof applicationSchema> & { _id: Types.ObjectId };

export const ApplicationModel: any =
  mongoose.models.Application ?? mongoose.model("Application", applicationSchema);
