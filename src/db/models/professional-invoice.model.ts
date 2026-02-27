import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const professionalInvoiceSchema = new Schema(
  {
    workOrderId: {
      type: Schema.Types.ObjectId,
      ref: "ProfessionalWorkOrder",
      required: true,
      index: true,
      unique: true,
    },
    professionalId: {
      type: Schema.Types.ObjectId,
      ref: "Professional",
      required: true,
      index: true,
    },
    applicationId: {
      type: Schema.Types.ObjectId,
      ref: "Application",
      required: true,
      index: true,
    },
    pricingModel: { type: String, enum: ["flat", "pct"], required: true },
    pricingAmount: { type: Schema.Types.Decimal128, required: true },
    // PR-20: Base value for percentage pricing
    baseValue: { type: Schema.Types.Decimal128 },
    computedAmount: { type: Schema.Types.Decimal128, required: true },
    // PR-24: Tax fields
    vatAmount: { type: Schema.Types.Decimal128, default: 0 },
    whtAmount: { type: Schema.Types.Decimal128, default: 0 },
    netPayable: { type: Schema.Types.Decimal128 },
    currency: { type: String, default: "NGN" },
    status: {
      type: String,
      enum: ["pending", "paid", "cancelled"],
      default: "pending",
      index: true,
    },
    notes: { type: String },
    paidAt: { type: Date },
    paidRef: { type: String },
    paidAmount: { type: Schema.Types.Decimal128 },
    // PR-22: Receipt confirmation + dispute tracking
    receiptConfirmedAt: { type: Date },
    paymentDisputed: { type: Boolean, default: false },
    disputeNotes: { type: String },
    disputeRaisedAt: { type: Date },
    expectedAmount: { type: Schema.Types.Decimal128 },
  },
  { ...timestamped, collection: "professionalInvoices" },
);

professionalInvoiceSchema.plugin(softDeletePlugin);

export type ProfessionalInvoiceDoc = InferSchemaType<typeof professionalInvoiceSchema> & {
  _id: Types.ObjectId;
};

export const ProfessionalInvoiceModel: any =
  mongoose.models.ProfessionalInvoice ??
  mongoose.model("ProfessionalInvoice", professionalInvoiceSchema);
