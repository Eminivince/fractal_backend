import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const blockchainOpSchema = new Schema(
  {
    opType: {
      type: String,
      enum: [
        "deploy_token",
        "mint",
        "burn",
        "freeze",
        "unfreeze",
        "declare_distribution",
        "issue_kyc_claim",
        "lock_tokens",
        "batch_payout",
        "whitelist_investor",
        "set_investor_tier",
      ],
      required: true,
      index: true,
    },
    entityType: {
      type: String,
      enum: ["offering", "subscription", "distribution", "investor_profile"],
      required: true,
      index: true,
    },
    entityId: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "submitted", "confirmed", "failed"],
      default: "pending",
      index: true,
    },
    txHash: { type: String, index: true, sparse: true },
    submittedAt: { type: Date },
    confirmedAt: { type: Date },
    retryCount: { type: Number, default: 0 },
    error: { type: String },
    // Extra context for the worker to know what to do
    payload: { type: Schema.Types.Mixed, default: {} },
    chainId: { type: Number, default: 80002 },
  },
  { ...timestamped, collection: "blockchainOps" },
);

// 8.1: Compound indexes
blockchainOpSchema.index({ status: 1, createdAt: 1 });
blockchainOpSchema.index({ status: 1, retryCount: 1, createdAt: 1 });

blockchainOpSchema.plugin(softDeletePlugin);

export type BlockchainOpDoc = InferSchemaType<typeof blockchainOpSchema> & {
  _id: Types.ObjectId;
};

export const BlockchainOpModel: any =
  mongoose.models.BlockchainOp ??
  mongoose.model("BlockchainOp", blockchainOpSchema);
