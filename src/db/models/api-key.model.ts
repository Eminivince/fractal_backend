import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";

const apiKeySchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    name: { type: String, required: true, trim: true, maxlength: 120 },
    // Display-only prefix (e.g. "fk_live_a1b2"). The full key is shown once at creation.
    prefix: { type: String, required: true },
    // SHA-256 hash of the full secret key; the raw key is never stored.
    keyHash: { type: String, required: true, unique: true, index: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
    lastUsedAt: { type: Date },
    revokedAt: { type: Date },
  },
  { ...timestamped, collection: "apiKeys" },
);

export type ApiKeyDoc = InferSchemaType<typeof apiKeySchema> & { _id: Types.ObjectId };

export const ApiKeyModel: any =
  mongoose.models.ApiKey ?? mongoose.model("ApiKey", apiKeySchema);
