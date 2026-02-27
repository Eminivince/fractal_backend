import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { riskFlagTaxonomy, stages, workOrderStatuses } from "../../utils/constants.js";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const professionalWorkOrderSchema = new Schema(
  {
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: "Application",
      required: true,
      index: true,
    },
    taskId: {
      type: Schema.Types.ObjectId,
      ref: "Task",
      required: true,
      index: true,
    },
    businessId: {
      type: Schema.Types.ObjectId,
      ref: "Business",
      required: true,
      index: true,
    },
    professionalId: {
      type: Schema.Types.ObjectId,
      ref: "Professional",
      required: true,
      index: true,
    },
    assigneeUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    category: {
      type: String,
      enum: ["legal", "valuation", "inspection", "trustee", "servicing"],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: workOrderStatuses,
      default: "assigned",
      index: true,
    },
    priority: {
      type: String,
      enum: ["low", "normal", "high"],
      default: "normal",
      index: true,
    },
    instructions: { type: String, required: true },
    dueAt: { type: Date },
    acceptedAt: { type: Date },
    startedAt: { type: Date },
    submittedAt: { type: Date },
    completedAt: { type: Date },
    slaBreachedAt: { type: Date },
    declineReason: { type: String },
    withdrawReason: { type: String },
    withdrawnAt: { type: Date },
    operatorDecision: {
      type: String,
      enum: ["accepted", "rejected", "needs_changes"],
    },
    operatorNotes: { type: String },
    // PR-03: Conflict of interest declaration
    coiDeclaredAt: { type: Date },
    coiDeclaration: { type: String, enum: ["no_conflict", "conflict_flagged"] },
    coiNotes: { type: String },
    outcome: {
      recommendation: {
        type: String,
        enum: ["approved", "declined", "needs_info"],
      },
      summary: { type: String },
      // PR-18: Structured risk flag taxonomy
      riskFlags: [{ type: String, enum: [...riskFlagTaxonomy] }],
      riskFlagNotes: { type: String },
      deliverables: [
        {
          type: { type: String },
          filename: { type: String },
          mimeType: { type: String },
          storageKey: { type: String },
          uploadedAt: { type: Date },
        },
      ],
    },
    // PR-17: Outcome history for revision cycles
    outcomeHistory: [
      {
        submittedAt: { type: Date },
        submittedBy: { type: Schema.Types.ObjectId, ref: "User" },
        recommendation: { type: String, enum: ["approved", "declined", "needs_info"] },
        summary: { type: String },
        riskFlags: [{ type: String }],
        riskFlagNotes: { type: String },
        deliverables: [
          {
            type: { type: String },
            filename: { type: String },
            mimeType: { type: String },
            storageKey: { type: String },
            uploadedAt: { type: Date },
          },
        ],
        operatorRejectionNotes: { type: String },
      },
    ],
    linkedReviewRoundId: {
      type: Schema.Types.ObjectId,
      ref: "ApplicationReviewRound",
    },
    linkedReviewItemIds: [{
      type: Schema.Types.ObjectId,
      ref: "ApplicationReviewItem",
    }],
    qualityScore: { type: Number, min: 1, max: 5 },
    qualityReview: { type: String },
    scoredBy: { type: Schema.Types.ObjectId, ref: "User" },
    scoredAt: { type: Date },
    stageTag: { type: String, enum: stages },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { ...timestamped, collection: "professionalWorkOrders" },
);
professionalWorkOrderSchema.index({ applicationId: 1, status: 1 });
professionalWorkOrderSchema.index({ assigneeUserId: 1, status: 1, dueAt: 1 });
professionalWorkOrderSchema.index({ professionalId: 1, status: 1 });
professionalWorkOrderSchema.index({ taskId: 1, status: 1 });

professionalWorkOrderSchema.plugin(softDeletePlugin);

export type ProfessionalWorkOrderDoc = InferSchemaType<
  typeof professionalWorkOrderSchema
> & { _id: Types.ObjectId };

export const ProfessionalWorkOrderModel: any =
  mongoose.models.ProfessionalWorkOrder ??
  mongoose.model("ProfessionalWorkOrder", professionalWorkOrderSchema);
