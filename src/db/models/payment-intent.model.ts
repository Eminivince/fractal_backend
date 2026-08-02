import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const paymentIntentStatuses = [
  "pending",
  "amount_matched",
  "amount_mismatch",
  "expired",
  "cancelled",
] as const;

const paymentMethods = ["checkout", "dva", "bank_transfer"] as const;

const paymentIntentSchema = new Schema(
  {
    subscriptionId: {
      type: Schema.Types.ObjectId,
      ref: "Subscription",
      required: true,
      index: true,
    },
    offeringId: {
      type: Schema.Types.ObjectId,
      ref: "Offering",
      required: true,
      index: true,
    },
    investorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    // Store in kobo (integer) to avoid floating-point precision issues
    expectedAmountKobo: { type: Number, required: true },
    currency: { type: String, default: "NGN", maxlength: 5 },
    // Paystack reference for this payment — unique per intent
    paystackReference: { type: String, unique: true, sparse: true },
    // DVA account number if paying via dedicated virtual account
    dvaAccountNumber: { type: String, sparse: true },
    method: { type: String, enum: paymentMethods, required: true },
    status: {
      type: String,
      enum: paymentIntentStatuses,
      default: "pending",
      index: true,
    },
    // Populated from webhook — the actual amount received in kobo
    receivedAmountKobo: { type: Number },
    // When the received amount was verified against expected
    matchedAt: { type: Date },
    // Auto-expire stale intents (e.g. +24h from creation)
    expiresAt: { type: Date, index: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "payment_intents" },
);

// For looking up intent by subscription + reference
paymentIntentSchema.index(
  { subscriptionId: 1, paystackReference: 1 },
  { unique: true, sparse: true },
);
// For the sweep worker: find pending intents older than threshold
paymentIntentSchema.index({ status: 1, createdAt: 1 });

paymentIntentSchema.plugin(softDeletePlugin);

export type PaymentIntentDoc = InferSchemaType<typeof paymentIntentSchema> & {
  _id: Types.ObjectId;
};

export const PaymentIntentModel: any =
  mongoose.models.PaymentIntent ??
  mongoose.model("PaymentIntent", paymentIntentSchema);
