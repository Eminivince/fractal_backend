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

const professionalSchema = new Schema(
  {
    category: {
      type: String,
      enum: ["inspector", "valuer", "lawyer", "trustee", "servicer"],
      required: true,
      index: true,
    },
    name: { type: String, required: true, maxlength: 200 },
    organizationType: {
      type: String,
      enum: ["individual", "firm"],
      default: "firm",
    },
    onboardingStatus: {
      type: String,
      enum: ["draft", "submitted", "in_review", "approved", "rejected"],
      default: "draft",
      index: true,
    },
    contactEmail: { type: String, lowercase: true, trim: true, maxlength: 320 },
    contactPhone: { type: String, trim: true, maxlength: 50 },
    website: { type: String, trim: true, maxlength: 2000 },
    regions: [{ type: String, required: true }],
    jurisdictions: [{ type: String, trim: true }],
    serviceCategories: [
      {
        type: String,
        enum: ["legal", "valuation", "inspection", "trustee", "servicing"],
      },
    ],
    licenseMeta: {
      licenseNumber: { type: String, trim: true },
      issuer: { type: String, trim: true },
      expiresAt: { type: Date },
      documentStorageKey: { type: String, trim: true },
    },
    // PR-04: Tax Identification Number for WHT
    tin: { type: String, trim: true },
    whtRate: { type: Number }, // 5 for individual, 10 for firm (percentage)
    // PR-24: VAT registration
    vatRegistered: { type: Boolean, default: false },
    vatNumber: { type: String, trim: true },
    // PR-29: Professional Indemnity Insurance
    piInsurance: {
      insurer: { type: String, trim: true },
      policyNumber: { type: String, trim: true },
      coverageAmount: { type: Schema.Types.Decimal128 },
      expiresAt: { type: Date },
      documentStorageKey: { type: String, trim: true },
    },
    // PR-05: Payout bank account
    payoutAccount: {
      bankName: { type: String, trim: true },
      accountNumber: { type: String, trim: true },
      accountName: { type: String, trim: true },
      paystackRecipientCode: { type: String, trim: true },
      updatedAt: { type: Date },
    },
    // PR-06: Notification preferences
    notificationPreferences: {
      email: {
        workOrderAssignments: { type: Boolean, default: true },
        statusChanges: { type: Boolean, default: true },
        reviewOutcomes: { type: Boolean, default: true },
      },
      inApp: {
        workOrderAssignments: { type: Boolean, default: true },
        statusChanges: { type: Boolean, default: true },
        reviewOutcomes: { type: Boolean, default: true },
      },
    },
    // PR-32: Disciplinary records
    disciplinaryRecord: [
      {
        type: {
          type: String,
          enum: ["warning", "formal_complaint", "sla_breach", "coi_violation", "suspension"],
        },
        reason: { type: String, trim: true },
        issuedBy: { type: Schema.Types.ObjectId, ref: "User" },
        issuedAt: { type: Date },
        resolvedAt: { type: Date },
        notes: { type: String, trim: true },
      },
    ],
    // PR-01: Credential documents (membership cert, CV, etc.)
    credentialDocs: {
      membership: { type: String, trim: true },
      cv: { type: String, trim: true },
      other: { type: String, trim: true },
    },
    // PR-10: Capacity management
    maxConcurrentWorkOrders: { type: Number, default: 5 },
    availabilityStatus: {
      type: String,
      enum: ["available", "busy", "unavailable"],
      default: "available",
    },
    // PR-31: Excluded businesses (COI register)
    excludedBusinessIds: [{ type: Schema.Types.ObjectId, ref: "Business" }],
    // PR-08: Suspension tracking
    suspensionReason: {
      type: String,
      enum: ["disciplinary", "license_lapsed", "conflict_found", "performance", "other"],
    },
    suspensionNotes: { type: String, maxlength: 2000 },
    suspendedAt: { type: Date },
    suspendedBy: { type: Schema.Types.ObjectId, ref: "User" },
    complianceNotes: { type: String, maxlength: 2000 },
    reviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    reviewedAt: { type: Date },
    slaDays: { type: Number, required: true },
    pricing: {
      model: { type: String, enum: ["flat", "pct"], required: true },
      amount: { type: Schema.Types.Decimal128, required: true },
    },
    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
    qualityScoreAvg: { type: Number, default: 0 },
    qualityScoreCount: { type: Number, default: 0 },
  },
  { ...timestamped, collection: "professionals" },
);
professionalSchema.index({ serviceCategories: 1 });
professionalSchema.index({ jurisdictions: 1 });

professionalSchema.plugin(softDeletePlugin);

export type ProfessionalDoc = InferSchemaType<typeof professionalSchema> & { _id: Types.ObjectId };

export const ProfessionalModel: any =
  mongoose.models.Professional ?? mongoose.model("Professional", professionalSchema);
