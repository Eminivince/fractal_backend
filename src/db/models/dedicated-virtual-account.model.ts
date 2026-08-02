import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const dedicatedVirtualAccountSchema = new Schema(
  {
    investorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      unique: true,
    },
    // Paystack customer code (created before DVA assignment)
    paystackCustomerCode: { type: String, required: true, index: true },
    bankName: { type: String, required: true, trim: true },
    bankCode: { type: String, required: true, trim: true },
    // The NUBAN account number assigned by Paystack
    accountNumber: { type: String, required: true, unique: true },
    accountName: { type: String, required: true, trim: true },
    assignedAt: { type: Date, required: true },
    active: { type: Boolean, default: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "dedicated_virtual_accounts" },
);

dedicatedVirtualAccountSchema.plugin(softDeletePlugin);

export type DedicatedVirtualAccountDoc = InferSchemaType<
  typeof dedicatedVirtualAccountSchema
> & { _id: Types.ObjectId };

export const DedicatedVirtualAccountModel: any =
  mongoose.models.DedicatedVirtualAccount ??
  mongoose.model("DedicatedVirtualAccount", dedicatedVirtualAccountSchema);
