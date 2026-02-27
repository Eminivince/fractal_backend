/**
 * 5.7: Team invite model for business team management.
 */

import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const teamInviteSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 320 },
    role: { type: String, enum: ["owner", "member"], required: true },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    token: { type: String, required: true, unique: true, index: true },
    status: {
      type: String,
      enum: ["pending", "accepted", "expired", "cancelled"],
      default: "pending",
    },
    expiresAt: { type: Date, required: true },
  },
  { ...timestamped, collection: "teamInvites" },
);

teamInviteSchema.index({ businessId: 1, email: 1 });

teamInviteSchema.plugin(softDeletePlugin);

export type TeamInviteDoc = InferSchemaType<typeof teamInviteSchema> & { _id: Types.ObjectId };

export const TeamInviteModel: any =
  mongoose.models.TeamInvite ?? mongoose.model("TeamInvite", teamInviteSchema);
