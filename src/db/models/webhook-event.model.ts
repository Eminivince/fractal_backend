/**
 * B13: Webhook event storage for retry/replay.
 */

import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";

const webhookEventSchema = new Schema(
  {
    provider: { type: String, required: true, enum: ["paystack", "sumsub"], index: true },
    eventType: { type: String, required: true },
    externalId: { type: String, required: true },
    rawPayload: { type: String, required: true },
    signature: { type: String },
    receivedAt: { type: Date, required: true, default: () => new Date(), index: true },
    processedAt: { type: Date },
    status: {
      type: String,
      enum: ["received", "processed", "failed"],
      default: "received",
      index: true,
    },
    errorMessage: { type: String },
    replayCount: { type: Number, default: 0 },
  },
  { ...timestamped, collection: "webhookEvents" },
);

webhookEventSchema.index({ provider: 1, externalId: 1 }, { unique: true });

export type WebhookEventDoc = InferSchemaType<typeof webhookEventSchema> & { _id: Types.ObjectId };

export const WebhookEventModel: any =
  mongoose.models.WebhookEvent ?? mongoose.model("WebhookEvent", webhookEventSchema);
