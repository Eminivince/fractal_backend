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

const investorProfileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User", required: true, unique: true },
    kycStatus: {
      type: String,
      enum: ["draft", "submitted", "in_review", "approved", "rejected"],
      default: "draft",
      index: true,
    },
    eligibility: {
      type: String,
      enum: ["retail", "sophisticated", "institutional"],
      default: "retail",
    },
    documents: [
      {
        docId: { type: String, required: true },
        type: { type: String, required: true },
        filename: { type: String, required: true },
        mimeType: { type: String },
        storageKey: { type: String },
        uploadedAt: { type: Date },
      },
    ],
    bankAccount: {
      accountNumber: { type: String },
      bankCode: { type: String },
      accountName: { type: String },
      recipientCode: { type: String },
      verifiedAt: { type: Date },
    },
    // 2.4: AML / Sanctions screening status
    amlStatus: {
      type: String,
      enum: ["pending", "clear", "flagged", "rejected"],
      default: "pending",
    },
    amlCheckedAt: { type: Date },
    // 4.1: Accredited investor verification
    accreditationStatus: {
      type: String,
      enum: ["unverified", "pending", "verified", "expired"],
      default: "unverified",
    },
    accreditationDocs: [
      {
        docType: { type: String, required: true },
        storageKey: { type: String, required: true },
        uploadedAt: { type: Date, default: () => new Date() },
        expiresAt: { type: Date },
      },
    ],
    accreditationVerifiedAt: { type: Date },
    accreditationVerifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
    // 4.3: Jurisdiction
    jurisdiction: { type: String, maxlength: 200 },
    // 4.4: KYC re-verification tracking
    kycApprovedAt: { type: Date },
    sumsubApplicantId: { type: String, index: true, sparse: true },
    sumsubExternalUserId: { type: String },
    sumsubReviewAnswer: { type: String, enum: ["GREEN", "RED", null] },
    sumsubRejectLabels: [{ type: String }],
    sumsubReviewedAt: { type: Date },
  },
  { ...timestamped, collection: "investorProfiles" },
);

investorProfileSchema.plugin(softDeletePlugin);

export type InvestorProfileDoc = InferSchemaType<typeof investorProfileSchema> & { _id: Types.ObjectId };

export const InvestorProfileModel: any =
  mongoose.models.InvestorProfile ?? mongoose.model("InvestorProfile", investorProfileSchema);
