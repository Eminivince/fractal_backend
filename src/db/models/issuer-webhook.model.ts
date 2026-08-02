import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";

const issuerWebhookSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    url: { type: String, required: true, trim: true },
    // HMAC-SHA256 signing secret (sent as X-Fractal-Signature header on delivery).
    secret: { type: String, required: true },
    // Event types to deliver, or ["*"] for all.
    events: { type: [String], default: ["*"] },
    active: { type: Boolean, default: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastDeliveryAt: { type: Date },
    lastDeliveryStatus: { type: String },
    failureCount: { type: Number, default: 0 },
  },
  { ...timestamped, collection: "issuerWebhooks" },
);

export type IssuerWebhookDoc = InferSchemaType<typeof issuerWebhookSchema> & { _id: Types.ObjectId };

export const IssuerWebhookModel: any =
  mongoose.models.IssuerWebhook ?? mongoose.model("IssuerWebhook", issuerWebhookSchema);
