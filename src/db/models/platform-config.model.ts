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

const platformConfigSchema = new Schema(
  {
    _id: { type: String, default: "platform_config" },
    featureFlags: {
      enableTemplateB: { type: Boolean, default: true },
      enableStablecoinPayouts: { type: Boolean, default: false },
      enableSecondaryTransfers: { type: Boolean, default: false },
    },
    complianceRules: {
      requireKycToView: { type: Boolean, default: false },
      requireKycToSubscribe: { type: Boolean, default: true },
      transferModeDefault: { type: String, enum: ["whitelist", "open"], default: "whitelist" },
      defaultLockupDays: { type: Number, default: 90 },
      // I-50: Default cooling-off period in days (investors can cancel within this window)
      coolingOffDays: { type: Number, default: 14 },
      // I-52: Annual investment cap for retail investors (0 = no limit)
      retailAnnualInvestmentLimit: { type: Number, default: 0 },
      minInvestmentByTemplate: {
        A: { type: Schema.Types.Decimal128, required: true },
        B: { type: Schema.Types.Decimal128, required: true },
      },
    },
    feeConfig: {
      setupFee: { type: Schema.Types.Decimal128, required: true },
      platformFeePct: { type: Schema.Types.Decimal128, required: true },
      servicingFeePct: { type: Schema.Types.Decimal128, required: true },
    },
    feeOverrides: {
      byTemplate: { type: Schema.Types.Mixed, default: {} },
      byBusiness: { type: Schema.Types.Mixed, default: {} },
      byOffering: { type: Schema.Types.Mixed, default: {} },
    },
    contentConfig: {
      heroHeadline: {
        type: String,
        default: "Tokenization infrastructure for African real assets",
      },
      heroSubtext: {
        type: String,
        default:
          "From origination to distributions, Fractal gives issuers, investors, and operators a shared operational layer for compliant on-chain and off-chain asset programs.",
      },
      ctas: {
        type: [String],
        default: ["Issuer Portal", "Investor Portal", "Operator Console"],
      },
      howItWorks: {
        type: [String],
        default: [
          "Application Intake",
          "Asset Diligence",
          "Structuring",
          "Compliance Review",
          "Offering Issuance",
          "Investor Subscriptions",
          "Servicing & Distributions",
          "Exit & Reporting",
        ],
      },
      faqs: {
        type: [
          {
            q: { type: String, required: true },
            a: { type: String, required: true },
          },
        ],
        default: [
          {
            q: "Is this live for production investment?",
            a: "Not yet. This environment is intended for sandbox workflow validation.",
          },
          {
            q: "Which products are supported?",
            a: "Rental Yield Notes and Developer Inventory Financing templates are supported.",
          },
          {
            q: "How are compliance controls handled?",
            a: "Rules are configured in the admin console and enforced in route-level views.",
          },
        ],
      },
    },
    // 10.2: Multi-jurisdiction configuration
    jurisdictions: [
      {
        code: { type: String, required: true }, // e.g. "NG", "KE", "GH"
        name: { type: String, required: true },
        enabled: { type: Boolean, default: true },
        requiredDocs: [{ type: String }], // Required document types for this jurisdiction
        maxInvestmentAmount: { type: Schema.Types.Decimal128 }, // Per investor
        maxInvestmentCurrency: { type: String, default: "NGN" },
        eligibleInvestorTiers: [{ type: String }], // retail, sophisticated, institutional
        amlRequired: { type: Boolean, default: true },
        coolingOffDays: { type: Number }, // Override platform default
        regulatoryNotes: { type: String, maxlength: 2000 },
      },
    ],
    // Blockchain configuration
    blockchainConfig: {
      chainId: { type: Number, default: 80002 },
      rpcUrl: { type: String },
      explorerUrl: { type: String },
    },
    // 4.2: Suitability questionnaire configuration
    suitabilityQuestions: [
      {
        questionId: { type: String, required: true },
        question: { type: String, required: true },
        options: [{ type: String }],
        weight: { type: Number, default: 1 },
      },
    ],
    updatedBy: { type: Schema.Types.ObjectId, ref: "User" },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: "platformConfigs" },
);

export type PlatformConfigDoc = InferSchemaType<typeof platformConfigSchema>;

export const PlatformConfigModel: any =
  mongoose.models.PlatformConfig ?? mongoose.model("PlatformConfig", platformConfigSchema);
