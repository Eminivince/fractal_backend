import mongoose, { Schema, type InferSchemaType, type Types } from "mongoose";
import { roles } from "../../utils/constants.js";
import { timestamped } from "./_shared.js";
import softDeletePlugin from "../plugins/soft-delete.js";

const chatMessageSchema = new Schema(
  {
    roomId: { type: Schema.Types.ObjectId, ref: "ChatRoom", required: true, index: true },
    senderId: { type: Schema.Types.ObjectId, ref: "User", required: true, index: true },
    senderRole: { type: String, enum: roles, required: true },
    senderName: { type: String, required: true },
    text: { type: String, required: true, maxlength: 4000 },
    readBy: [
      {
        userId: { type: Schema.Types.ObjectId, ref: "User", required: true },
        readAt: { type: Date, required: true },
      },
    ],
  },
  { ...timestamped, collection: "chat_messages" },
);

chatMessageSchema.index({ roomId: 1, createdAt: -1 });

chatMessageSchema.plugin(softDeletePlugin);

export type ChatMessageDoc = InferSchemaType<typeof chatMessageSchema> & { _id: Types.ObjectId };

export const ChatMessageModel: any =
  mongoose.models.ChatMessage ?? mongoose.model("ChatMessage", chatMessageSchema);
