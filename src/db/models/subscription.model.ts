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

const subscriptionSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    investorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    status: {
      type: String,
      enum: subscriptionStatuses,
      default: "committed",
      index: true,
    },
    externalReceiptRef: { type: String, index: true },
    paystackReference: { type: String, index: true, sparse: true },
    allocationBatchId: { type: String, index: true },
    // I-50: Investor cooling-off period — subscription is cancellable without penalty until this date
    cancellableUntil: { type: Date },
    allocationConfirmedAt: { type: Date },
  },
  { ...timestamped, collection: "subscriptions" },
);

// 8.1: Compound indexes
subscriptionSchema.index({ offeringId: 1, investorUserId: 1 });
subscriptionSchema.index({ offeringId: 1, status: 1 });

subscriptionSchema.plugin(softDeletePlugin);

export type SubscriptionDoc = InferSchemaType<typeof subscriptionSchema> & { _id: Types.ObjectId };

export const SubscriptionModel: any =
  mongoose.models.Subscription ?? mongoose.model("Subscription", subscriptionSchema);
