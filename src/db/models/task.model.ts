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

const taskSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true, index: true },
    stage: { type: String, enum: ["Diligence", "Structuring"], required: true },
    category: { type: String, enum: ["inspection", "valuation", "legal", "servicing"], required: true },
    assignedProfessionalId: { type: Schema.Types.ObjectId, ref: "Professional", index: true },
    assignedAt: { type: Date },
    status: {
      type: String,
      enum: ["open", "in_progress", "completed", "rejected"],
      default: "open",
      index: true,
    },
    slaDays: { type: Number, required: true },
    evidenceDocs: [
      {
        docId: { type: String, required: true },
        filename: { type: String, required: true },
      },
    ],
    completedAt: { type: Date },
  },
  { ...timestamped, collection: "tasks" },
);

taskSchema.plugin(softDeletePlugin);

export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: Types.ObjectId };

export const TaskModel: any =
  mongoose.models.Task ?? mongoose.model("Task", taskSchema);
