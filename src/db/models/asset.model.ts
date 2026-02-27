import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import {
  applicationStatuses,
  distributionStatuses,
  entityTypes,
  milestoneStatuses,
  offeringStatuses,
  roles,
  stages,
  subscriptionStatuses,
  trancheStatuses,
} from "../../utils/constants.js";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const assetSchema = new Schema(
  {
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    type: { type: String, enum: ["real_estate"], default: "real_estate" },
    name: { type: String, required: true },
    location: {
      country: { type: String, required: true },
      state: { type: String, required: true },
      city: { type: String, required: true },
      addressLine: { type: String },
    },
    summary: { type: String, required: true },
    // I-11: Legal title structure for Nigerian real estate
    legalTitle: {
      titleType: {
        type: String,
        enum: [
          "certificate_of_occupancy",
          "governors_consent",
          "deed_of_assignment",
          "statutory_right_of_occupancy",
          "survey_plan",
          "letter_of_allocation",
          "other",
        ],
      },
      titleHolder: { type: String, trim: true },
      titleHolderRelationship: {
        type: String,
        enum: ["issuer", "spv", "third_party"],
      },
      hasEncumbrances: { type: Boolean, default: false },
      encumbranceDetails: { type: String, trim: true },
      landUse: {
        type: String,
        enum: ["residential", "commercial", "industrial", "mixed_use", "agricultural", "other"],
      },
      titleDocumentRef: { type: String, trim: true },
    },
    // I-12: Independent valuation
    valuation: {
      amount: { type: Schema.Types.Decimal128 },
      currency: { type: String, default: "NGN" },
      valuationDate: { type: Date },
      validUntil: { type: Date },
      valuedBy: { type: String, trim: true },
      reportDocumentRef: { type: String, trim: true },
      methodology: {
        type: String,
        enum: ["comparable_sales", "income_capitalization", "cost_approach", "other"],
      },
    },
  },
  { ...timestamped, collection: "assets" },
);

assetSchema.plugin(softDeletePlugin);

export type AssetDoc = InferSchemaType<typeof assetSchema> & { _id: Types.ObjectId };

export const AssetModel: any =
  mongoose.models.Asset ?? mongoose.model("Asset", assetSchema);
