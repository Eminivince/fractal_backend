import type { FastifyInstance, FastifyRequest } from "fastify";
import { Types } from "mongoose";
import { z } from "zod";
import {
  ApplicationModel,
  ChatMessageModel,
  ChatRoomModel,
  OfferingModel,
  ProfessionalWorkOrderModel,
  SubscriptionModel,
  UserModel,
} from "../../../db/models.js";
import { HttpError } from "../../../utils/errors.js";
import { serialize } from "../../../utils/serialize.js";
import { emitUserEvent } from "../../../services/event-bus.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function resolveRoomParticipants(
  entityType: string,
  entityId: string,
): Promise<Types.ObjectId[]> {
  const participantSet = new Set<string>();

  // Always include all operators and admins
  const opsAndAdmins = await UserModel.find(
    { role: { $in: ["operator", "admin"] }, status: { $ne: "disabled" } },
    { _id: 1 },
  ).lean();
  for (const u of opsAndAdmins) participantSet.add(u._id.toString());

  if (entityType === "application") {
    const application = await ApplicationModel.findById(entityId).lean();
    if (application) {
      // All users in the issuer business
      const issuerUsers = await UserModel.find(
        { businessId: application.businessId },
        { _id: 1 },
      ).lean();
      for (const u of issuerUsers) participantSet.add(u._id.toString());

      // All professional work order assignees linked to this application
      const workOrders = await ProfessionalWorkOrderModel.find(
        { applicationId: application._id },
        { assigneeUserId: 1 },
      ).lean();
      for (const wo of workOrders) {
        if (wo.assigneeUserId) participantSet.add(wo.assigneeUserId.toString());
      }
    }
  } else if (entityType === "offering") {
    const offering = await OfferingModel.findById(entityId).lean();
    if (offering) {
      // All users in the issuer business
      const issuerUsers = await UserModel.find(
        { businessId: offering.businessId },
        { _id: 1 },
      ).lean();
      for (const u of issuerUsers) participantSet.add(u._id.toString());

      // All active investors with subscriptions for this offering
      const subscriptions = await SubscriptionModel.find(
        { offeringId: offering._id, status: { $ne: "cancelled" } },
        { investorUserId: 1 },
      ).lean();
      for (const sub of subscriptions) {
        if (sub.investorUserId) participantSet.add(sub.investorUserId.toString());
      }
    }
  } else if (entityType === "subscription") {
    const subscription = await SubscriptionModel.findById(entityId).lean();
    if (subscription) {
      // The investor
      if (subscription.investorUserId) {
        participantSet.add(subscription.investorUserId.toString());
      }
      // Issuer users via offering → businessId
      const offering = await OfferingModel.findById(subscription.offeringId).lean();
      if (offering) {
        const issuerUsers = await UserModel.find(
          { businessId: offering.businessId },
          { _id: 1 },
        ).lean();
        for (const u of issuerUsers) participantSet.add(u._id.toString());
      }
    }
  } else if (entityType === "work_order") {
    const workOrder = await ProfessionalWorkOrderModel.findById(entityId).lean();
    if (workOrder) {
      if (workOrder.assigneeUserId) participantSet.add(workOrder.assigneeUserId.toString());
      if (workOrder.createdBy) participantSet.add((workOrder.createdBy as Types.ObjectId).toString());
    }
  }

  return Array.from(participantSet)
    .filter((id) => Types.ObjectId.isValid(id))
    .map((id) => new Types.ObjectId(id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Routes
// ─────────────────────────────────────────────────────────────────────────────

const entityTypeEnum = z.enum(["application", "offering", "subscription", "work_order"]);

export async function chatRoutes(app: FastifyInstance) {
  // GET /v1/chat/rooms — list rooms the caller is a participant in
  app.get(
    "/v1/chat/rooms",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const query = z
        .object({
          entityType: entityTypeEnum.optional(),
          entityId: z.string().optional(),
        })
        .parse(request.query);

      const filter: Record<string, unknown> = {
        participantIds: new Types.ObjectId(request.authUser!.userId),
      };
      if (query.entityType) filter.entityType = query.entityType;
      if (query.entityId) filter.entityId = query.entityId;

      const rooms = await ChatRoomModel.find(filter)
        .sort({ lastMessageAt: -1 })
        .lean();

      return serialize(rooms);
    },
  );

  // POST /v1/chat/rooms — get-or-create a room
  app.post(
    "/v1/chat/rooms",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const body = z
        .object({
          entityType: entityTypeEnum,
          entityId: z.string().min(1),
          type: z.enum(["group", "direct"]),
          targetUserId: z.string().optional(),
        })
        .parse(request.body);

      const callerId = new Types.ObjectId(request.authUser!.userId);

      if (body.type === "group") {
        // Idempotent: one group room per (entityType, entityId)
        const existing = await ChatRoomModel.findOne({
          entityType: body.entityType,
          entityId: body.entityId,
          type: "group",
        }).lean();
        if (existing) return serialize(existing);

        const participantIds = await resolveRoomParticipants(body.entityType, body.entityId);
        const room = await ChatRoomModel.create({
          entityType: body.entityType,
          entityId: body.entityId,
          type: "group",
          name: `${body.entityType} #${body.entityId.slice(-6)}`,
          participantIds,
        });
        return serialize(room.toObject());
      } else {
        // Direct room
        if (!body.targetUserId) throw new HttpError(400, "targetUserId required for direct rooms");

        const targetId = new Types.ObjectId(body.targetUserId);
        // Sort pair so (A,B) == (B,A)
        const pair = [callerId, targetId].sort((a, b) =>
          a.toString().localeCompare(b.toString()),
        );

        const existing = await ChatRoomModel.findOne({
          entityType: body.entityType,
          entityId: body.entityId,
          type: "direct",
          directPair: { $all: pair, $size: 2 },
        }).lean();
        if (existing) return serialize(existing);

        // Resolve names
        const [callerUser, targetUser] = await Promise.all([
          UserModel.findById(callerId).lean(),
          UserModel.findById(targetId).lean(),
        ]);

        const callerName = (callerUser as any)?.name ?? "User";
        const targetName = (targetUser as any)?.name ?? "User";

        const room = await ChatRoomModel.create({
          entityType: body.entityType,
          entityId: body.entityId,
          type: "direct",
          directPair: pair,
          name: `${callerName} & ${targetName}`,
          participantIds: pair,
        });
        return serialize(room.toObject());
      }
    },
  );

  // GET /v1/chat/rooms/:roomId — room detail + participants
  app.get(
    "/v1/chat/rooms/:roomId",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { roomId } = z.object({ roomId: z.string() }).parse(request.params);
      const callerId = request.authUser!.userId;

      const room = await ChatRoomModel.findById(roomId).lean();
      if (!room) throw new HttpError(404, "Room not found");

      const isParticipant = (room.participantIds as Types.ObjectId[]).some(
        (id) => id.toString() === callerId,
      );
      if (!isParticipant) throw new HttpError(403, "Not a participant in this room");

      // Fetch participant user details
      const participants = await UserModel.find(
        { _id: { $in: room.participantIds } },
        { _id: 1, name: 1, role: 1, email: 1 },
      ).lean();

      return serialize({ ...room, participants });
    },
  );

  // GET /v1/chat/rooms/:roomId/messages — paginated messages
  app.get(
    "/v1/chat/rooms/:roomId/messages",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { roomId } = z.object({ roomId: z.string() }).parse(request.params);
      const query = z
        .object({
          before: z.string().optional(),
          limit: z.coerce.number().int().positive().max(100).default(50),
        })
        .parse(request.query);

      const callerId = request.authUser!.userId;

      const room = await ChatRoomModel.findById(roomId).lean();
      if (!room) throw new HttpError(404, "Room not found");

      const isParticipant = (room.participantIds as Types.ObjectId[]).some(
        (id) => id.toString() === callerId,
      );
      if (!isParticipant) throw new HttpError(403, "Not a participant in this room");

      const filter: Record<string, unknown> = { roomId: new Types.ObjectId(roomId) };
      if (query.before) {
        filter.createdAt = { $lt: new Date(query.before) };
      }

      const messages = await ChatMessageModel.find(filter)
        .sort({ createdAt: -1 })
        .limit(query.limit)
        .lean();

      return serialize(messages);
    },
  );

  // POST /v1/chat/rooms/:roomId/messages — send a message
  app.post(
    "/v1/chat/rooms/:roomId/messages",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { roomId } = z.object({ roomId: z.string() }).parse(request.params);
      const body = z.object({ text: z.string().min(1).max(4000) }).parse(request.body);

      const caller = request.authUser!;

      const room = await ChatRoomModel.findById(roomId).lean();
      if (!room) throw new HttpError(404, "Room not found");

      const callerId = new Types.ObjectId(caller.userId);
      const isParticipant = (room.participantIds as Types.ObjectId[]).some(
        (id) => id.toString() === caller.userId,
      );
      if (!isParticipant) throw new HttpError(403, "Not a participant in this room");

      // Resolve sender name
      const senderUser = await UserModel.findById(callerId, { name: 1 }).lean();
      const senderName = (senderUser as any)?.name ?? "Unknown";

      const message = await ChatMessageModel.create({
        roomId: new Types.ObjectId(roomId),
        senderId: callerId,
        senderRole: caller.role,
        senderName,
        text: body.text,
        readBy: [{ userId: callerId, readAt: new Date() }],
      });

      // Update lastMessageAt on the room
      await ChatRoomModel.findByIdAndUpdate(roomId, { lastMessageAt: new Date() });

      const msgObj = message.toObject();

      // Fan out via SSE to all other participants
      const payload = {
        type: "chat_message",
        roomId: room._id.toString(),
        message: serialize({
          id: msgObj._id,
          roomId: msgObj.roomId,
          senderId: msgObj.senderId,
          senderName: msgObj.senderName,
          senderRole: msgObj.senderRole,
          text: msgObj.text,
          createdAt: msgObj.createdAt,
        }),
      };

      for (const participantId of room.participantIds as Types.ObjectId[]) {
        if (participantId.toString() !== caller.userId) {
          emitUserEvent(participantId.toString(), payload);
        }
      }

      return serialize(msgObj);
    },
  );

  // POST /v1/chat/rooms/:roomId/read — mark all messages as read
  app.post(
    "/v1/chat/rooms/:roomId/read",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      const { roomId } = z.object({ roomId: z.string() }).parse(request.params);
      const callerId = new Types.ObjectId(request.authUser!.userId);

      const room = await ChatRoomModel.findById(roomId).lean();
      if (!room) throw new HttpError(404, "Room not found");

      const isParticipant = (room.participantIds as Types.ObjectId[]).some(
        (id) => id.toString() === callerId.toString(),
      );
      if (!isParticipant) throw new HttpError(403, "Not a participant in this room");

      // Add caller to readBy on all unread messages
      await ChatMessageModel.updateMany(
        {
          roomId: new Types.ObjectId(roomId),
          "readBy.userId": { $ne: callerId },
        },
        {
          $push: { readBy: { userId: callerId, readAt: new Date() } },
        },
      );

      return { ok: true };
    },
  );
}
