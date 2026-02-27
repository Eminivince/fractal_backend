import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

// PR-42: Professional firm team member model
const professionalTeamMemberSchema = new Schema(
  {
    professionalId: { type: Schema.Types.ObjectId, ref: "Professional", required: true, index: true },
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    role: {
      type: String,
      enum: ["owner", "partner", "associate", "admin"],
      required: true,
    },
    invitedBy: { type: Schema.Types.ObjectId, ref: "User" },
    inviteEmail: { type: String, trim: true, lowercase: true },
    invitedAt: { type: Date },
    joinedAt: { type: Date },
    status: {
      type: String,
      enum: ["invited", "active", "removed"],
      default: "invited",
      index: true,
    },
  },
  { ...timestamped, collection: "professional_team_members" },
);

professionalTeamMemberSchema.index({ professionalId: 1, userId: 1 }, { unique: true });

professionalTeamMemberSchema.plugin(softDeletePlugin);

export type ProfessionalTeamMemberDoc = InferSchemaType<typeof professionalTeamMemberSchema> & { _id: Types.ObjectId };

export const ProfessionalTeamMemberModel: any =
  mongoose.models.ProfessionalTeamMember ??
  mongoose.model("ProfessionalTeamMember", professionalTeamMemberSchema);
