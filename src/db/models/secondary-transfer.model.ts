import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";

const secondaryTransferSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    fromUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // seller
    toUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true }, // buyer
    units: { type: Schema.Types.Decimal128, required: true }, // position value (NGN) transferred
    pricePerUnit: { type: Schema.Types.Decimal128 },
    status: {
      type: String,
      enum: ["pending_approval", "executed", "rejected", "cancelled"],
      default: "pending_approval",
      index: true,
    },
    // Snapshot of the compliance checks performed at approval/execution.
    complianceChecks: { type: Schema.Types.Mixed, default: {} },
    reviewNotes: { type: String },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    executedAt: { type: Date },
    onchainEnqueued: { type: Boolean, default: false },
  },
  { ...timestamped, collection: "secondaryTransfers" },
);

secondaryTransferSchema.index({ offeringId: 1, status: 1 });

export type SecondaryTransferDoc = InferSchemaType<typeof secondaryTransferSchema> & {
  _id: Types.ObjectId;
};

export const SecondaryTransferModel: any =
  mongoose.models.SecondaryTransfer ??
  mongoose.model("SecondaryTransfer", secondaryTransferSchema);
