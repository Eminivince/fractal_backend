import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";

const deletionRequestSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "completed"],
      default: "pending",
      index: true,
    },
    reason: { type: String, trim: true, maxlength: 2000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    reviewNotes: { type: String, trim: true, maxlength: 2000 },
    completedAt: { type: Date },
  },
  { ...timestamped, collection: "deletionRequests" },
);

export type DeletionRequestDoc = InferSchemaType<typeof deletionRequestSchema> & { _id: Types.ObjectId };

export const DeletionRequestModel: any =
  mongoose.models.DeletionRequest ?? mongoose.model("DeletionRequest", deletionRequestSchema);
