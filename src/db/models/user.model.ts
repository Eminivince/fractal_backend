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

const userSchema = new Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 320 },
    name: { type: String, required: true, trim: true, maxlength: 200 },
    role: { type: String, enum: roles, required: true, index: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business" },
    businessRole: {
      type: String,
      enum: ["owner", "member"],
    },
    professionalId: { type: Schema.Types.ObjectId, ref: "Professional", index: true },
    professionalMembershipRole: {
      type: String,
      enum: ["owner", "member"],
    },
    investorProfileId: { type: Schema.Types.ObjectId, ref: "InvestorProfile" },
    status: { type: String, enum: ["active", "disabled"], default: "active" },
    passwordHash: { type: String, required: false },
    passwordResetToken: { type: String },
    passwordResetExpires: { type: Date },
    tokenInvalidatedAt: { type: Date },
  },
  { ...timestamped, collection: "users" },
);

userSchema.plugin(softDeletePlugin);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };

export const UserModel: any =
  mongoose.models.User ?? mongoose.model("User", userSchema);
