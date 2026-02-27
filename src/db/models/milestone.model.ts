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

const milestoneSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    name: { type: String, required: true },
    percent: { type: Number, required: true },
    status: {
      type: String,
      enum: milestoneStatuses,
      default: "not_started",
      index: true,
    },
    evidenceDocs: [
      {
        docId: { type: String, required: true },
        filename: { type: String, required: true },
      },
    ],
    verifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    verifiedAt: { type: Date },
  },
  { ...timestamped, collection: "milestones" },
);

milestoneSchema.plugin(softDeletePlugin);

export type MilestoneDoc = InferSchemaType<typeof milestoneSchema> & { _id: Types.ObjectId };

export const MilestoneModel: any =
  mongoose.models.Milestone ?? mongoose.model("Milestone", milestoneSchema);
