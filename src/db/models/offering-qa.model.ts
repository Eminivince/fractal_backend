// I-40: Offering Q&A — public question and answer feature for investor due diligence
import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const offeringQASchema = new Schema(
  {
    offeringId: { type: Schema.Types.ObjectId, ref: "Offering", required: true, index: true },
    // The investor (or anonymous) who asked
    askedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
    question: { type: String, required: true, trim: true, maxlength: 2000 },
    // Answer from issuer or operator
    answer: { type: String, trim: true, maxlength: 5000 },
    answeredBy: { type: Schema.Types.ObjectId, ref: "User" },
    answeredAt: { type: Date },
    // All Q&A is public by default (prevents selective disclosure)
    isPublic: { type: Boolean, default: true },
    // Operator/issuer can mark a question as off-topic / spam
    isHidden: { type: Boolean, default: false },
    hiddenReason: { type: String, trim: true },
  },
  { ...timestamped, collection: "offering_qa" },
);

offeringQASchema.plugin(softDeletePlugin);

export type OfferingQADoc = InferSchemaType<typeof offeringQASchema> & {
  _id: Types.ObjectId;
};

export const OfferingQAModel: any =
  mongoose.models.OfferingQA ?? mongoose.model("OfferingQA", offeringQASchema);
