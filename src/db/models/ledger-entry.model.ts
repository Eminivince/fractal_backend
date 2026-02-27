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

const ledgerEntrySchema = new Schema(
  {
    ledgerType: {
      type: String,
      enum: ["escrow", "ownership", "distribution", "tranche", "redemption", "fee"],
      required: true,
      index: true,
    },
    accountRef: { type: String, required: true, index: true },
    direction: { type: String, enum: ["debit", "credit"], required: true },
    amount: { type: Schema.Types.Decimal128, required: true },
    currency: { type: String, default: "NGN" },
    entityType: { type: String, enum: entityTypes, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    externalRef: { type: String, index: true },
    idempotencyKey: { type: String, index: true },
    postedAt: { type: Date, required: true, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "ledgerEntries" },
);
ledgerEntrySchema.index({ idempotencyKey: 1, ledgerType: 1, accountRef: 1 }, { sparse: true });
// 8.1: Compound index for entity lookups
ledgerEntrySchema.index({ entityType: 1, entityId: 1, createdAt: -1 });

export type LedgerEntryDoc = InferSchemaType<typeof ledgerEntrySchema> & { _id: Types.ObjectId };

export const LedgerEntryModel: any =
  mongoose.models.LedgerEntry ?? mongoose.model("LedgerEntry", ledgerEntrySchema);
