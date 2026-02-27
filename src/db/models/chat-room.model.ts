import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const chatRoomSchema = new Schema(
  {
    entityType: {
      type: String,
      enum: ["application", "offering", "subscription", "work_order"],
      required: true,
      index: true,
    },
    entityId: { type: String, required: true, index: true },
    type: { type: String, enum: ["group", "direct"], required: true },
    // For direct rooms only — sorted pair so (A,B) == (B,A)
    directPair: {
      type: [{ type: Schema.Types.ObjectId, ref: "User" }],
      sparse: true,
      index: true,
    },
    name: { type: String, required: true },
    participantIds: [{ type: Schema.Types.ObjectId, ref: "User", index: true }],
    lastMessageAt: { type: Date, index: true },
  },
  { ...timestamped, collection: "chat_rooms" },
);

// Compound index for entity lookup
chatRoomSchema.index({ entityType: 1, entityId: 1 });

// directPair index declared on field to avoid duplicates

chatRoomSchema.plugin(softDeletePlugin);

export type ChatRoomDoc = InferSchemaType<typeof chatRoomSchema> & { _id: Types.ObjectId };

export const ChatRoomModel: any =
  mongoose.models.ChatRoom ?? mongoose.model("ChatRoom", chatRoomSchema);
