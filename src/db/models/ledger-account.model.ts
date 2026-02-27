/**
 * 4.5: Ledger account model for double-entry accounting.
 */

import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";

const ledgerAccountSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 200 },
    accountType: {
      type: String,
      enum: ["asset", "liability", "revenue", "expense"],
      required: true,
    },
    code: { type: String, required: true, unique: true, maxlength: 20 },
    description: { type: String, maxlength: 500 },
    currency: { type: String, default: "NGN" },
    isActive: { type: Boolean, default: true },
  },
  { ...timestamped, collection: "ledgerAccounts" },
);

export type LedgerAccountDoc = InferSchemaType<typeof ledgerAccountSchema> & { _id: Types.ObjectId };

export const LedgerAccountModel: any =
  mongoose.models.LedgerAccount ?? mongoose.model("LedgerAccount", ledgerAccountSchema);
