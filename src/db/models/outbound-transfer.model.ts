import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const outboundTransferStatuses = ["pending", "success", "failed", "reversed"] as const;

const outboundTransferEntityTypes = [
  "distribution_line",
  "refund",
  "tranche_release",
  "fund_release",
] as const;

const outboundTransferSchema = new Schema(
  {
    // Paystack's transfer_code — unique identifier for the transfer
    transferCode: { type: String, unique: true, required: true },
    // Our idempotent reference sent to Paystack
    reference: { type: String, unique: true, required: true },
    // Paystack recipient code for the destination bank account
    recipientCode: { type: String, required: true },
    // Amount in kobo (integer) — avoids float precision issues
    amountKobo: { type: Number, required: true },
    currency: { type: String, default: "NGN", maxlength: 5 },
    reason: { type: String, trim: true, maxlength: 500 },
    // Lifecycle status — ONLY transitions via webhook or sweep worker
    status: {
      type: String,
      enum: outboundTransferStatuses,
      default: "pending",
      index: true,
    },
    // What business entity this transfer belongs to
    entityType: {
      type: String,
      enum: outboundTransferEntityTypes,
      required: true,
    },
    // The _id of the distribution line, subscription (for refunds), or tranche
    entityId: { type: String, required: true, index: true },
    // Raw status string from Paystack webhook/API
    paystackStatus: { type: String },
    failureReason: { type: String, trim: true, maxlength: 1000 },
    // When the bank confirmed settlement
    settledAt: { type: Date },
    // When a successful transfer was reversed by the bank
    reversedAt: { type: Date },
    // When we received the Paystack webhook for this transfer
    webhookReceivedAt: { type: Date },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "outbound_transfers" },
);

// For looking up transfers by business entity
outboundTransferSchema.index({ entityType: 1, entityId: 1 });
// For the sweep worker: find pending transfers older than threshold
outboundTransferSchema.index({ status: 1, createdAt: 1 });

outboundTransferSchema.plugin(softDeletePlugin);

export type OutboundTransferDoc = InferSchemaType<typeof outboundTransferSchema> & {
  _id: Types.ObjectId;
};

export const OutboundTransferModel: any =
  mongoose.models.OutboundTransfer ??
  mongoose.model("OutboundTransfer", outboundTransferSchema);
