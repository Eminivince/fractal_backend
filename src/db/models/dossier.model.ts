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

const dossierSchema = new Schema(
  {
    applicationId: { type: Schema.Types.ObjectId, ref: "Application", required: true, unique: true },
    structuredData: { type: Schema.Types.Mixed, default: {} },
    documents: [
      {
        _id: { type: Schema.Types.ObjectId, auto: true },
        type: { type: String, required: true },
        filename: { type: String, required: true },
        mimeType: { type: String },
        storageKey: { type: String, required: true },
        uploadedBy: { type: Schema.Types.ObjectId, ref: "User", required: true },
        uploadedAt: { type: Date, required: true },
        stageTag: { type: String, enum: stages, required: true },
        version: { type: Number, required: true, default: 1 },
        isLatest: { type: Boolean, required: true, default: true },
        supersedes: { type: Schema.Types.ObjectId, default: null },
      },
    ],
    hashes: [
      {
        algo: { type: String, required: true },
        hash: { type: String, required: true },
        createdAt: { type: Date, required: true },
      },
    ],
  },
  { ...timestamped, collection: "dossiers" },
);

dossierSchema.plugin(softDeletePlugin);

export type DossierDoc = InferSchemaType<typeof dossierSchema> & { _id: Types.ObjectId };

export const DossierModel: any =
  mongoose.models.Dossier ?? mongoose.model("Dossier", dossierSchema);
