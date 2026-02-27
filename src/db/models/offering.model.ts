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
import { guardOffering } from "../plugins/cascade.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const offeringSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true },
    businessId: { type: Schema.Types.ObjectId, ref: "Business", required: true, index: true },
    templateCode: { type: String, enum: ["A", "B"], required: true, index: true },
    name: { type: String, required: true, maxlength: 200 },
    summary: { type: String, required: true, maxlength: 5000 },
    status: { type: String, enum: offeringStatuses, default: "draft", index: true },
    opensAt: { type: Date, required: true, index: true },
    closesAt: { type: Date, required: true },
    // 2.7: Structured terms schema (replaces Schema.Types.Mixed)
    terms: {
      returnType: { type: String, enum: ["fixed", "variable", "revenue_share"], required: true },
      annualRate: { type: Schema.Types.Decimal128 },
      paymentFrequency: { type: String, enum: ["monthly", "quarterly", "semi_annual", "annual"] },
      maturityMonths: { type: Number },
      defaultProvisions: { type: String, maxlength: 2000 },
      investorRights: { type: String, maxlength: 2000 },
      currency: { type: String, default: "NGN", maxlength: 500 },
    },
    // 4.3: Jurisdiction tracking
    jurisdiction: { type: String },
    // 4.2: Minimum risk tier for subscription eligibility
    minimumRiskTier: { type: Number, min: 0, max: 5, default: 0 },
    // 5.3: Offering documents
    documents: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        docType: { type: String, enum: ["prospectus", "risk_disclosure", "legal", "supplemental"], required: true },
        label: { type: String, required: true },
        storageKey: { type: String, required: true },
        uploadedAt: { type: Date, default: () => new Date() },
        version: { type: Number, default: 1 },
      },
    ],
    economicPolicy: {
      version: { type: Number, required: true, default: 1 },
      policyType: { type: String, required: true, default: "generic" },
      config: { type: Schema.Types.Mixed, required: true, default: {} },
      canonicalHash: { type: String },
      validatedAt: { type: Date },
    },
    disclosurePack: {
      status: { type: String, enum: ["missing", "ready"], default: "missing" },
      documentIds: [{ type: String }],
    },
    feeSnapshot: {
      setupFee: { type: Schema.Types.Decimal128, required: true },
      platformFeePct: { type: Schema.Types.Decimal128, required: true },
      servicingFeePct: { type: Schema.Types.Decimal128, required: true },
    },
    // I-12: Independent asset valuation
    valuation: {
      amount: { type: Schema.Types.Decimal128 },
      date: { type: Date },
      expiresAt: { type: Date },
      reportDocumentId: { type: String },
      valuedBy: { type: String },
    },
    // I-17: Legal instrument type classification
    instrumentType: {
      type: String,
      enum: ["debt_note", "revenue_share", "equity", "hybrid"],
    },
    metrics: {
      raiseAmount: { type: Schema.Types.Decimal128, required: true },
      // I-18: Soft cap / minimum viable raise
      softCap: { type: Schema.Types.Decimal128 },
      subscribedAmount: { type: Schema.Types.Decimal128, required: true },
      investorCount: { type: Number, default: 0 },
      // I-19: Oversubscription tracking
      isOversubscribed: { type: Boolean, default: false },
      oversubscriptionPolicy: {
        type: String,
        enum: ["pro_rata", "first_come_first_served", "waitlist"],
        default: "first_come_first_served",
      },
      maxSingleInvestorPct: { type: Number },
      // I-22: Per-investor max ticket cap
      maxTicket: { type: Schema.Types.Decimal128 },
    },
    // I-21: Private / invitation-only offering mode
    isPrivate: { type: Boolean, default: false },
    investorWhitelistUserIds: [{ type: Schema.Types.ObjectId, ref: "User" }],
    // I-14: Credit enhancement / guarantee disclosure
    creditEnhancement: {
      type: { type: String, enum: ["personal_guarantee", "bank_guarantee", "insurance_backed", "collateral", "sinking_fund", "none"], default: "none" },
      description: { type: String, trim: true },
      guarantorName: { type: String, trim: true },
      disclosedAt: { type: Date },
    },
    // I-25: Cancellation
    cancellationReason: { type: String, trim: true },
    // I-47: Conflicts of interest disclosure
    conflictsOfInterest: { type: String, trim: true },
    conflictsDisclosedAt: { type: Date },
    // I-48: Issuer track record disclosure
    issuerTrackRecord: {
      completedProjects: { type: Number, min: 0 },
      totalCapitalRaised: { type: Schema.Types.Decimal128 },
      yearsExperience: { type: Number, min: 0 },
      priorDefaultCount: { type: Number, min: 0, default: 0 },
      teamBackground: { type: String, trim: true },
      notableProjects: { type: String, trim: true },
      disclosedAt: { type: Date },
    },
    // I-49: Risk factors section
    riskFactors: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        category: {
          type: String,
          enum: ["market", "liquidity", "regulatory", "project", "counterparty", "other"],
          required: true,
        },
        description: { type: String, required: true, trim: true },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    cancelledAt: { type: Date },
    revisionRequests: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        reason: { type: String, required: true },
        requestedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        requestedAt: { type: Date, default: () => new Date() },
      },
    ],
    images: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        storageKey: { type: String, required: true },
        filename: { type: String, required: true },
        mimeType: { type: String, required: true },
        bytes: { type: Number, required: true },
        order: { type: Number, required: true, default: 0 },
        uploadedAt: { type: Date, default: () => new Date() },
      },
    ],
    exitWorkflow: {
      issuerAcknowledgedAt: { type: Date },
      issuerAcknowledgedBy: { type: Schema.Types.ObjectId, ref: "User" },
      acknowledgeNotes: { type: String },
      investorsNotifiedAt: { type: Date },
      investorsNotifiedBy: { type: Schema.Types.ObjectId, ref: "User" },
      finalReportGeneratedAt: { type: Date },
    },
  },
  { ...timestamped, collection: "offerings" },
);

// 8.1: Compound indexes
offeringSchema.index({ businessId: 1, status: 1 });
offeringSchema.index({ applicationId: 1 });

// 8.2: Referential integrity — prevent deletion if active subscriptions exist
offeringSchema.plugin(guardOffering());

offeringSchema.plugin(softDeletePlugin);

export type OfferingDoc = InferSchemaType<typeof offeringSchema> & { _id: Types.ObjectId };

export const OfferingModel: any =
  mongoose.models.Offering ?? mongoose.model("Offering", offeringSchema);
