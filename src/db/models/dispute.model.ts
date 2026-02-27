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

const disputeSchema = new Schema(
  {
    entityType: {
      type: String,
      enum: ["application", "offering", "subscription", "distribution", "milestone", "tranche", "work_order", "professional"],
      required: true,
      index: true,
    },
    entityId: { type: String, required: true, index: true },
    reason: { type: String, required: true, trim: true, maxlength: 2000 },
    details: { type: String, trim: true, maxlength: 5000 },
    status: {
      type: String,
      enum: ["open", "investigating", "resolved", "dismissed"],
      default: "open",
      index: true,
    },
    // PR-27: Dispute type for professional disputes
    disputeType: {
      type: String,
      enum: ["invoice_dispute", "payment_dispute", "score_dispute", "assignment_dispute", "other"],
      index: true,
    },
    raisedBy: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: "User", index: true },
    resolutionNote: { type: String, trim: true, maxlength: 5000 },
    resolvedAt: { type: Date },
  },
  { ...timestamped, collection: "disputes" },
);

disputeSchema.plugin(softDeletePlugin);

export type DisputeDoc = InferSchemaType<typeof disputeSchema> & { _id: Types.ObjectId };

export const DisputeModel: any =
  mongoose.models.Dispute ?? mongoose.model("Dispute", disputeSchema);
