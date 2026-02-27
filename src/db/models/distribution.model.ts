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

const distributionSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    period: { type: String, required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    status: {
      type: String,
      enum: distributionStatuses,
      default: "draft",
      index: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "User" },
    approvedAt: { type: Date },
    scheduledAt: { type: Date },
    payoutReceiptRefs: [{ type: String }],
    paidAt: { type: Date },
    reversalReason: { type: String },
    reversedAt: { type: Date },
    // I-33: Record date lifecycle
    announcementDate: { type: Date },
    recordDate: { type: Date },
    exDistributionDate: { type: Date },
    paymentDate: { type: Date },
    // I-29: Withholding Tax (WHT) — Nigeria: 10% on investment income
    whtPct: { type: Schema.Types.Decimal128, default: () => 10 },
    whtAmount: { type: Schema.Types.Decimal128 },
    netAmount: { type: Schema.Types.Decimal128 },
  },
  { ...timestamped, collection: "distributions" },
);
distributionSchema.index({ offeringId: 1, period: 1 }, { unique: true });

distributionSchema.plugin(softDeletePlugin);

export type DistributionDoc = InferSchemaType<typeof distributionSchema> & { _id: Types.ObjectId };

export const DistributionModel: any =
  mongoose.models.Distribution ?? mongoose.model("Distribution", distributionSchema);
