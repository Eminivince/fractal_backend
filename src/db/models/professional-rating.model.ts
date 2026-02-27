/**
 * 10.1: Professional ratings model.
 */

import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const professionalRatingSchema = new Schema(
  {
    professionalId: { type: Schema.Types.ObjectId, ref: "Professional", required: true, index: true },
    ratedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    workOrderId: { type: Schema.Types.ObjectId, ref: "ProfessionalWorkOrder", required: true },
    score: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, maxlength: 2000 },
  },
  { ...timestamped, collection: "professionalRatings" },
);

professionalRatingSchema.index({ professionalId: 1, ratedBy: 1, workOrderId: 1 }, { unique: true });

professionalRatingSchema.plugin(softDeletePlugin);

export type ProfessionalRatingDoc = InferSchemaType<typeof professionalRatingSchema> & { _id: Types.ObjectId };

export const ProfessionalRatingModel: any =
  mongoose.models.ProfessionalRating ?? mongoose.model("ProfessionalRating", professionalRatingSchema);
