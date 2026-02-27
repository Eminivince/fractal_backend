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

const notificationSchema = new Schema(
  {
    recipientUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    recipientEmail: { type: String, lowercase: true, trim: true },
    recipientName: { type: String, maxlength: 200 },
    actorUserId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    actorRoleAtTime: { type: String, enum: roles, required: true },
    entityType: { type: String, enum: entityTypes, required: true, index: true },
    entityId: { type: String, required: true, index: true },
    action: { type: String, required: true, maxlength: 200 },
    title: { type: String, required: true, maxlength: 500 },
    message: { type: String, required: true, maxlength: 5000 },
    notes: { type: String, maxlength: 2000 },
    metadata: { type: Schema.Types.Mixed },
    readAt: { type: Date, index: true },
    channels: {
      email: {
        status: {
          type: String,
          enum: ["pending", "processing", "sent", "failed", "skipped"],
          default: "pending",
          index: true,
        },
        provider: { type: String, enum: ["sendgrid", "nodemailer"] },
        attempts: { type: Number, default: 0 },
        sentAt: { type: Date },
        lastAttemptAt: { type: Date },
        nextAttemptAt: { type: Date },
        lastError: { type: String },
      },
    },
  },
  { ...timestamped, collection: "notifications" },
);
// 8.1: Compound indexes
notificationSchema.index({ recipientUserId: 1, createdAt: -1 });
notificationSchema.index({ recipientUserId: 1, readAt: 1, createdAt: -1 });

notificationSchema.plugin(softDeletePlugin);

export type NotificationDoc = InferSchemaType<typeof notificationSchema> & { _id: Types.ObjectId };

export const NotificationModel: any =
  mongoose.models.Notification ?? mongoose.model("Notification", notificationSchema);
