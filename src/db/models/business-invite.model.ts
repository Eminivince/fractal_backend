import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const businessInviteSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    // I-62: Expanded roles — finance (disbursements/distributions), legal (documents/KYB), viewer (read-only)
    role: { type: String, enum: ["owner", "member", "finance", "legal", "viewer"], required: true, default: "member" },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    token: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "cancelled"],
      default: "pending",
      index: true,
    },
    expiresAt: { type: Date, required: true },
    acceptedAt: { type: Date },
    acceptedByUserId: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { ...timestamped, collection: "businessInvites" },
);

businessInviteSchema.plugin(softDeletePlugin);

export type BusinessInviteDoc = InferSchemaType<typeof businessInviteSchema> & { _id: Types.ObjectId };

export const BusinessInviteModel: any =
  mongoose.models.BusinessInvite ?? mongoose.model("BusinessInvite", businessInviteSchema);
