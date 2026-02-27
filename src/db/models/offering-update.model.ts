// I-39: Offering investor updates / announcements feed
import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const offeringUpdateSchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    category: {
      type: String,
      enum: ["operational", "financial", "regulatory", "milestone", "general"],
      default: "general",
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    // For pinned/important updates
    isPinned: { type: Boolean, default: false },
  },
  { ...timestamped, collection: "offering_updates" },
);

offeringUpdateSchema.plugin(softDeletePlugin);

export type OfferingUpdateDoc = InferSchemaType<typeof offeringUpdateSchema> & {
  _id: Types.ObjectId;
};

export const OfferingUpdateModel: any =
  mongoose.models.OfferingUpdate ??
  mongoose.model("OfferingUpdate", offeringUpdateSchema);
