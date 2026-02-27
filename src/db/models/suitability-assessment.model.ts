/**
 * 4.2: Investor suitability assessment model.
 * Tracks risk questionnaire responses and computed risk tiers.
 */

import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const suitabilityAssessmentSchema = new Schema(
  {
    investorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    responses: [
      {
        questionId: { type: String, required: true },
        answer: { type: Schema.Types.Mixed, required: true },
      },
    ],
    riskScore: { type: Number, required: true },
    riskTier: { type: Number, min: 0, max: 5, required: true },
    completedAt: { type: Date, required: true, default: () => new Date() },
    expiresAt: { type: Date, required: true },
  },
  { ...timestamped, collection: "suitabilityAssessments" },
);

suitabilityAssessmentSchema.index({ investorUserId: 1, completedAt: -1 });

suitabilityAssessmentSchema.plugin(softDeletePlugin);

export type SuitabilityAssessmentDoc = InferSchemaType<typeof suitabilityAssessmentSchema> & { _id: Types.ObjectId };

export const SuitabilityAssessmentModel: any =
  mongoose.models.SuitabilityAssessment ?? mongoose.model("SuitabilityAssessment", suitabilityAssessmentSchema);
