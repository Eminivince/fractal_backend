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

const reconciliationIssueSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, ref: "ReconciliationRun", required: true, index: true },
    issueType: {
      type: String,
      enum: ["missing_ledger", "amount_mismatch", "orphan_ledger"],
      required: true,
      index: true,
    },
    externalRef: { type: String, index: true },
    entityType: { type: String, enum: entityTypes },
    entityId: { type: String },
    expectedAmount: { type: Schema.Types.Decimal128 },
    actualAmount: { type: Schema.Types.Decimal128 },
    message: { type: String, required: true },
    status: { type: String, enum: ["open", "resolved"], default: "open", index: true },
    resolvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    resolvedAt: { type: Date },
    resolutionNote: { type: String },
  },
  { ...timestamped, collection: "reconciliationIssues" },
);

reconciliationIssueSchema.plugin(softDeletePlugin);

export type ReconciliationIssueDoc = InferSchemaType<typeof reconciliationIssueSchema> & { _id: Types.ObjectId };

export const ReconciliationIssueModel: any =
  mongoose.models.ReconciliationIssue ?? mongoose.model("ReconciliationIssue", reconciliationIssueSchema);
