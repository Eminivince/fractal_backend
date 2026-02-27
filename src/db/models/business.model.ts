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
import { guardBusiness } from "../plugins/cascade.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const businessSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 200 },
    type: {
      type: String,
      enum: ["property_owner", "developer", "spv_manager"],
      required: true,
    },
    kybStatus: {
      type: String,
      enum: ["draft", "submitted", "in_review", "approved", "rejected"],
      default: "draft",
      index: true,
    },
    registrationProfile: {
      legalName: { type: String, trim: true, maxlength: 200 },
      tradingName: { type: String, trim: true, maxlength: 200 },
      registrationNumber: { type: String, trim: true, maxlength: 500 },
      taxId: { type: String, trim: true, maxlength: 500 },
      incorporationDate: { type: Date },
      website: { type: String, trim: true, maxlength: 2000 },
      summary: { type: String, trim: true, maxlength: 5000 },
      contact: {
        email: { type: String, trim: true, lowercase: true, maxlength: 320 },
        phone: { type: String, trim: true, maxlength: 50 },
      },
      address: {
        country: { type: String, trim: true, maxlength: 500 },
        state: { type: String, trim: true, maxlength: 500 },
        city: { type: String, trim: true, maxlength: 500 },
        addressLine1: { type: String, trim: true, maxlength: 500 },
        addressLine2: { type: String, trim: true, maxlength: 500 },
        postalCode: { type: String, trim: true, maxlength: 500 },
      },
      representative: {
        fullName: { type: String, trim: true, maxlength: 200 },
        title: { type: String, trim: true, maxlength: 200 },
        email: { type: String, trim: true, lowercase: true, maxlength: 320 },
        phone: { type: String, trim: true, maxlength: 50 },
        idNumber: { type: String, trim: true, maxlength: 500 },
      },
    },
    // I-01: Ultimate Beneficial Owners (UBOs) — required by CAMA 2020 / FCCPA
    ubos: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        fullName: { type: String, required: true, trim: true, maxlength: 200 },
        dateOfBirth: { type: Date },
        nationality: { type: String, trim: true, maxlength: 200 },
        address: { type: String, trim: true, maxlength: 500 },
        ownershipPct: { type: Number, required: true },
        controlBasis: {
          type: String,
          enum: ["shares", "voting_rights", "appointment_power", "significant_influence", "other"],
          default: "shares",
        },
        isPep: { type: Boolean, default: false },
        idDocumentRef: { type: String, trim: true, maxlength: 500 },
        addedAt: { type: Date, default: () => new Date() },
      },
    ],
    // I-02: Full director list
    directors: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        fullName: { type: String, required: true, trim: true, maxlength: 200 },
        title: { type: String, trim: true, maxlength: 200 },
        nationality: { type: String, trim: true, maxlength: 200 },
        isPep: { type: Boolean, default: false },
        idDocumentRef: { type: String, trim: true, maxlength: 500 },
        addedAt: { type: Date, default: () => new Date() },
      },
    ],
    // I-03: Shareholder / ownership structure
    shareholders: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        name: { type: String, required: true, trim: true, maxlength: 200 },
        ownershipPct: { type: Number, required: true },
        isEntity: { type: Boolean, default: false },
        entityUboChainRequired: { type: Boolean, default: false },
        addedAt: { type: Date, default: () => new Date() },
      },
    ],
    registrationSubmittedAt: { type: Date },
    registrationReviewedAt: { type: Date },
    registrationApprovedAt: { type: Date },
    registrationRejectedAt: { type: Date },
    kybReviewedBy: { type: Schema.Types.ObjectId, ref: "User" },
    kybReviewNotes: { type: String, maxlength: 2000 },
    documents: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        type: { type: String, required: true, maxlength: 500 },
        filename: { type: String, required: true, maxlength: 500 },
        mimeType: { type: String, maxlength: 500 },
        storageKey: { type: String, required: true, maxlength: 500 },
        uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        uploadedAt: { type: Date, required: true },
        // I-05: Document expiry tracking
        validUntil: { type: Date },
      },
    ],
    payoutBankAccount: {
      bankName: { type: String, trim: true, maxlength: 200 },
      accountNumber: { type: String, trim: true, maxlength: 500 },
      accountName: { type: String, trim: true, maxlength: 200 },
      routingCode: { type: String, trim: true, maxlength: 500 },
      currency: { type: String, trim: true, default: "NGN", maxlength: 500 },
      updatedAt: { type: Date },
    },
    riskTier: { type: String, enum: ["low", "medium", "high"], default: "medium", index: true },
    status: { type: String, enum: ["active", "disabled"], default: "active", index: true },
  },
  { ...timestamped, collection: "businesses" },
);

// 8.1: Compound indexes
businessSchema.index({ kybStatus: 1, createdAt: -1 });
businessSchema.index({ riskTier: 1, status: 1 });

// 8.2: Referential integrity — prevent deletion if active applications exist
businessSchema.plugin(guardBusiness());

businessSchema.plugin(softDeletePlugin);

export type BusinessDoc = InferSchemaType<typeof businessSchema> & { _id: Types.ObjectId };

export const BusinessModel: any =
  mongoose.models.Business ?? mongoose.model("Business", businessSchema);
