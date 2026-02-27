import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { roles } from "../../utils/constants.js";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const professionalWorkOrderEventSchema = new Schema(
  {
    workOrderId: {
      type: Schema.Types.ObjectId,
      ref: "ProfessionalWorkOrder",
      required: true,
      index: true,
    },
    actorUserId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    actorRole: {
      type: String,
      enum: roles,
      required: true,
      index: true,
    },
    eventType: {
      type: String,
      required: true,
      index: true,
    },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  { ...timestamped, collection: "professionalWorkOrderEvents" },
);
professionalWorkOrderEventSchema.index({ workOrderId: 1, createdAt: -1 });

professionalWorkOrderEventSchema.plugin(softDeletePlugin);

export type ProfessionalWorkOrderEventDoc = InferSchemaType<
  typeof professionalWorkOrderEventSchema
> & { _id: Types.ObjectId };

export const ProfessionalWorkOrderEventModel: any =
  mongoose.models.ProfessionalWorkOrderEvent ??
  mongoose.model("ProfessionalWorkOrderEvent", professionalWorkOrderEventSchema);
