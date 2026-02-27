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

const escrowReceiptSchema = new Schema(
  {
    externalRef: { type: String, required: true, unique: true },
    source: { type: String, enum: ["bank", "onchain", "provider"], required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    payerRef: { type: String },
    currency: { type: String, default: "NGN" },
    status: { type: String, enum: ["pending", "confirmed", "failed"], default: "confirmed", index: true },
    occurredAt: { type: Date, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "escrowReceipts" },
);

escrowReceiptSchema.plugin(softDeletePlugin);

export type EscrowReceiptDoc = InferSchemaType<typeof escrowReceiptSchema> & { _id: Types.ObjectId };

export const EscrowReceiptModel: any =
  mongoose.models.EscrowReceipt ?? mongoose.model("EscrowReceipt", escrowReceiptSchema);
