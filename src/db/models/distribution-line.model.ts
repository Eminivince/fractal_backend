// I-34: Per-investor distribution lines — required for individual entitlement tracking,
// reconciliation, and withholding tax computation.
import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const distributionLineSchema = new Schema(
  {
    distributionId: {
      type: Schema.Types.ObjectId,
      ref: "Distribution",
      required: true,
      index: true,
    },
    offeringId: {
      type: Schema.Types.ObjectId,
      ref: "Offering",
      required: true,
      index: true,
    },
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
    },
    investorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Investor's ownership share (proportion of total allocation)
    sharePercent: { type: Schema.Types.Decimal128, required: true },
    // Gross entitlement before fees and WHT
    grossAmount: { type: Schema.Types.Decimal128, required: true },
    // Servicing fee deducted
    servicingFeeAmount: { type: Schema.Types.Decimal128, required: true, default: 0 },
    // I-29: Withholding tax deducted
    whtPct: { type: Schema.Types.Decimal128, required: true, default: 10 },
    whtAmount: { type: Schema.Types.Decimal128, required: true, default: 0 },
    // Net amount payable to investor
    netAmount: { type: Schema.Types.Decimal128, required: true },
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["pending", "paid", "failed", "skipped"],
      default: "pending",
      index: true,
    },
    // Paystack or manual transfer reference
    paymentRef: { type: String, trim: true },
    paidAt: { type: Date },
    failureReason: { type: String, trim: true },
  },
  { ...timestamped, collection: "distribution_lines" },
);

distributionLineSchema.index({ distributionId: 1, investorUserId: 1 }, { unique: true });

distributionLineSchema.plugin(softDeletePlugin);

export type DistributionLineDoc = InferSchemaType<typeof distributionLineSchema> & {
  _id: Types.ObjectId;
};

export const DistributionLineModel: any =
  mongoose.models.DistributionLine ??
  mongoose.model("DistributionLine", distributionLineSchema);
