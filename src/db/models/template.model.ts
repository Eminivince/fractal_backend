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

const templateSchema = new Schema(
  {
    code: { type: String, enum: ["A", "B"], required: true, unique: true },
    name: { type: String, required: true },
    checklistItems: [
      {
        key: { type: String, required: true },
        label: { type: String, required: true },
        requiredStage: { type: String, enum: ["Intake", "Diligence", "Structuring", "Compliance"], required: true },
      },
    ],
    termSchema: [
      {
        key: { type: String, required: true },
        label: { type: String, required: true },
        type: { type: String, enum: ["number", "string", "enum", "array", "date"], required: true },
        required: { type: Boolean, default: false },
        options: [{ type: String }],
      },
    ],
    enabled: { type: Boolean, default: true, index: true },
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, default: Date.now },
  },
  { ...timestamped, collection: "templates" },
);

templateSchema.plugin(softDeletePlugin);

export type TemplateDoc = InferSchemaType<typeof templateSchema> & { _id: Types.ObjectId };

export const TemplateModel: any =
  mongoose.models.Template ?? mongoose.model("Template", templateSchema);
