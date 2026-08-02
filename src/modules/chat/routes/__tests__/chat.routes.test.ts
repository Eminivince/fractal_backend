import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ roomFind: vi.fn(), roomFindOne: vi.fn(), roomCreate: vi.fn(), roomFindById: vi.fn(), roomUpdate: vi.fn(), messageFind: vi.fn(), messageCreate: vi.fn(), messageUpdate: vi.fn(), userFind: vi.fn(), userFindById: vi.fn(), offeringFind: vi.fn(), subscriptionFind: vi.fn(), subscriptionFindById: vi.fn(), applicationFind: vi.fn(), workOrderFind: vi.fn(), workOrderFindById: vi.fn(), emit: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ ApplicationModel: { findById: mocks.applicationFind }, ChatMessageModel: { find: mocks.messageFind, create: mocks.messageCreate, updateMany: mocks.messageUpdate }, ChatRoomModel: { find: mocks.roomFind, findOne: mocks.roomFindOne, create: mocks.roomCreate, findById: mocks.roomFindById, findByIdAndUpdate: mocks.roomUpdate }, OfferingModel: { findById: mocks.offeringFind }, ProfessionalWorkOrderModel: { find: mocks.workOrderFind, findById: mocks.workOrderFindById }, SubscriptionModel: { find: mocks.subscriptionFind, findById: mocks.subscriptionFindById }, UserModel: { find: mocks.userFind, findById: mocks.userFindById } }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../services/event-bus.js", () => ({ emitUserEvent: mocks.emit }));
import { chatRoutes } from "../chat.routes.js";

const userId = "507f1f77bcf86cd799439011"; const otherUserId = "507f1f77bcf86cd799439012"; const roomId = "507f1f77bcf86cd799439013";
let app: ReturnType<typeof Fastify>;
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const room = (participants: Types.ObjectId[] = [new Types.ObjectId(userId), new Types.ObjectId(otherUserId)]) => ({ _id: new Types.ObjectId(roomId), participantIds: participants, entityType: "offering", entityId: "offering-1", type: "group" });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset(); mocks.serialize.mockImplementation((value: unknown) => value);
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId, role: "investor" }; }); await app.register(chatRoutes);
});
afterEach(async () => { await app.close(); });

describe("chat routes", () => {
  it("lists only rooms that contain the authenticated participant", async () => {
    mocks.roomFind.mockReturnValueOnce({ sort: vi.fn(() => lean([{ _id: roomId }])) }); const response = await app.inject({ method: "GET", url: "/v1/chat/rooms?entityType=offering&entityId=offering-1" });
    expect(response.statusCode).toBe(200); expect(mocks.roomFind).toHaveBeenCalledWith(expect.objectContaining({ entityType: "offering", entityId: "offering-1", participantIds: expect.any(Types.ObjectId) }));
  });

  it("returns an existing group room and creates an idempotent direct room", async () => {
    mocks.roomFindOne.mockReturnValueOnce(lean({ _id: roomId, type: "group" })); expect((await app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "offering", entityId: "offering-1", type: "group" } })).json()).toMatchObject({ type: "group" });
    mocks.roomFindOne.mockReturnValueOnce(lean(null)); mocks.userFindById.mockImplementation((id: Types.ObjectId) => lean({ name: id.toString() === userId ? "Investor" : "Operator" })); mocks.roomCreate.mockResolvedValueOnce({ toObject: () => ({ _id: roomId, name: "Investor & Operator", type: "direct" }) }); const direct = await app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "offering", entityId: "offering-1", type: "direct", targetUserId: otherUserId } });
    expect(direct.statusCode).toBe(200); expect(mocks.roomCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "direct", name: "Investor & Operator", participantIds: expect.any(Array) }));
  });

  it("creates an offering group room from active issuer, operator, and investor participants", async () => {
    mocks.roomFindOne.mockReturnValueOnce(lean(null)); mocks.userFind.mockReturnValueOnce(lean([{ _id: new Types.ObjectId(otherUserId) }])).mockReturnValueOnce(lean([{ _id: new Types.ObjectId(userId) }])); mocks.offeringFind.mockReturnValueOnce(lean({ _id: "offering-1", businessId: "business-1" })); mocks.subscriptionFind.mockReturnValueOnce(lean([{ investorUserId: new Types.ObjectId("507f1f77bcf86cd799439014") }])); mocks.roomCreate.mockResolvedValueOnce({ toObject: () => ({ _id: roomId, type: "group" }) });
    const response = await app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "offering", entityId: "offering-1", type: "group" } });
    expect(response.statusCode).toBe(200); expect(mocks.roomCreate).toHaveBeenCalledWith(expect.objectContaining({ type: "group", name: "offering #ring-1", participantIds: expect.arrayContaining([expect.any(Types.ObjectId)]) }));
  });

  it("resolves application, subscription, and work-order group participants", async () => {
    mocks.roomFindOne.mockReturnValueOnce(lean(null)); mocks.userFind.mockReturnValueOnce(lean([{ _id: new Types.ObjectId(otherUserId) }])).mockReturnValueOnce(lean([{ _id: new Types.ObjectId(userId) }])); mocks.applicationFind.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.workOrderFind.mockReturnValueOnce(lean([{ assigneeUserId: new Types.ObjectId("507f1f77bcf86cd799439014") }])); mocks.roomCreate.mockResolvedValueOnce({ toObject: () => ({}) }); await expect(app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "application", entityId: "application-1", type: "group" } })).resolves.toMatchObject({ statusCode: 200 });
    mocks.roomFindOne.mockReturnValueOnce(lean(null)); mocks.userFind.mockReturnValueOnce(lean([{ _id: new Types.ObjectId(otherUserId) }])).mockReturnValueOnce(lean([{ _id: new Types.ObjectId(userId) }])); mocks.subscriptionFindById.mockReturnValueOnce(lean({ investorUserId: new Types.ObjectId("507f1f77bcf86cd799439014"), offeringId: "offering-1" })); mocks.offeringFind.mockReturnValueOnce(lean({ businessId: "business-1" })); mocks.roomCreate.mockResolvedValueOnce({ toObject: () => ({}) }); await expect(app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "subscription", entityId: "subscription-1", type: "group" } })).resolves.toMatchObject({ statusCode: 200 });
    mocks.roomFindOne.mockReturnValueOnce(lean(null)); mocks.userFind.mockReturnValueOnce(lean([{ _id: new Types.ObjectId(otherUserId) }])); mocks.workOrderFindById.mockReturnValueOnce(lean({ assigneeUserId: new Types.ObjectId("507f1f77bcf86cd799439014"), createdBy: new Types.ObjectId(userId) })); mocks.roomCreate.mockResolvedValueOnce({ toObject: () => ({}) }); await expect(app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "work_order", entityId: "work-order-1", type: "group" } })).resolves.toMatchObject({ statusCode: 200 });
  });

  it("rejects direct rooms without a target user", async () => {
    await expect(app.inject({ method: "POST", url: "/v1/chat/rooms", payload: { entityType: "offering", entityId: "offering-1", type: "direct" } })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("shows room participants only to room participants", async () => {
    mocks.roomFindById.mockReturnValueOnce(lean(room())); mocks.userFind.mockReturnValueOnce(lean([{ _id: userId, name: "Investor" }, { _id: otherUserId, name: "Operator" }])); const response = await app.inject({ method: "GET", url: `/v1/chat/rooms/${roomId}` }); expect(response.statusCode).toBe(200); expect(response.json().participants).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Investor" }), expect.objectContaining({ name: "Operator" })]));
    mocks.roomFindById.mockReturnValueOnce(lean(room([new Types.ObjectId(otherUserId)]))); await expect(app.inject({ method: "GET", url: `/v1/chat/rooms/${roomId}` })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("paginates messages and prevents non-participants from reading them", async () => {
    mocks.roomFindById.mockReturnValueOnce(lean(room())); mocks.messageFind.mockReturnValueOnce({ sort: vi.fn(() => ({ limit: vi.fn(() => lean([{ _id: "message-1" }])) })) }); const response = await app.inject({ method: "GET", url: `/v1/chat/rooms/${roomId}/messages?before=2026-07-29T00:00:00.000Z&limit=10` }); expect(response.statusCode).toBe(200); expect(mocks.messageFind).toHaveBeenCalledWith(expect.objectContaining({ createdAt: { $lt: new Date("2026-07-29T00:00:00.000Z") } }));
    mocks.roomFindById.mockReturnValueOnce(lean(room([new Types.ObjectId(otherUserId)]))); await expect(app.inject({ method: "GET", url: `/v1/chat/rooms/${roomId}/messages` })).resolves.toMatchObject({ statusCode: 403 });
  });

  it("sends a message, updates the room, and emits to other participants", async () => {
    mocks.roomFindById.mockReturnValueOnce(lean(room())); mocks.userFindById.mockReturnValueOnce(lean({ name: "Investor" })); mocks.messageCreate.mockResolvedValueOnce({ toObject: () => ({ _id: "message-1", roomId, senderId: userId, senderName: "Investor", senderRole: "investor", text: "Please provide the latest update.", createdAt: new Date() }) }); mocks.roomUpdate.mockResolvedValueOnce(undefined);
    const response = await app.inject({ method: "POST", url: `/v1/chat/rooms/${roomId}/messages`, payload: { text: "Please provide the latest update." } });
    expect(response.statusCode).toBe(200); expect(mocks.roomUpdate).toHaveBeenCalledWith(roomId, expect.objectContaining({ lastMessageAt: expect.any(Date) })); expect(mocks.emit).toHaveBeenCalledWith(otherUserId, expect.objectContaining({ type: "chat_message", roomId }));
  });

  it("marks unread room messages as read for the caller", async () => {
    mocks.roomFindById.mockReturnValueOnce(lean(room())); mocks.messageUpdate.mockResolvedValueOnce({ modifiedCount: 2 }); const response = await app.inject({ method: "POST", url: `/v1/chat/rooms/${roomId}/read` });
    expect(response.statusCode).toBe(200); expect(mocks.messageUpdate).toHaveBeenCalledWith(expect.objectContaining({ "readBy.userId": { $ne: expect.any(Types.ObjectId) } }), expect.objectContaining({ $push: expect.anything() }));
  });
});
