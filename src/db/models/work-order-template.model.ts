import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

// PR-14: Work order template for reusable instruction sets
const workOrderTemplateSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      enum: ["legal", "valuation", "inspection", "trustee", "servicing"],
      required: true,
      index: true,
    },
    instructions: { type: String, required: true, trim: true },
    requiredDeliverableTypes: [{ type: String, trim: true }],
    standardSlaDays: { type: Number },
    priority: {
      type: String,
      enum: ["low", "normal", "high"],
      default: "normal",
    },
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    isActive: { type: Boolean, default: true, index: true },
  },
  { ...timestamped, collection: "work_order_templates" },
);

workOrderTemplateSchema.plugin(softDeletePlugin);

export type WorkOrderTemplateDoc = InferSchemaType<typeof workOrderTemplateSchema> & { _id: Types.ObjectId };

export const WorkOrderTemplateModel: any =
  mongoose.models.WorkOrderTemplate ??
  mongoose.model("WorkOrderTemplate", workOrderTemplateSchema);
