import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ applicationFindById: vi.fn(), roundCreate: vi.fn(), roundFindOne: vi.fn(), roundFind: vi.fn(), itemCreate: vi.fn(), itemFindOne: vi.fn(), itemFind: vi.fn(), itemCount: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ ApplicationModel: { findById: mocks.applicationFindById }, ApplicationReviewRoundModel: { create: mocks.roundCreate, findOne: mocks.roundFindOne, find: mocks.roundFind }, ApplicationReviewItemModel: { create: mocks.itemCreate, findOne: mocks.itemFindOne, find: mocks.itemFind, countDocuments: mocks.itemCount } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { applicationReviewRoutes } from "../review.routes.js";

let app: ReturnType<typeof Fastify>; let role = "operator";
const object = (value: Record<string, unknown>): any => ({ ...value, toObject: () => value });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined); mocks.appendEvent.mockResolvedValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); role = "operator";
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role }; }); await app.register(applicationReviewRoutes);
});
afterEach(async () => { await app.close(); });

describe("application review routes", () => {
  it("creates a review round and moves an in-review application to needs-info", async () => {
    const application = { status: "in_review", save: vi.fn().mockResolvedValue(undefined) }; mocks.applicationFindById.mockResolvedValueOnce(application); mocks.roundCreate.mockResolvedValueOnce(object({ _id: "round-1", title: "Clarify ownership" }));
    const response = await app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds", payload: { title: "Clarify ownership", notes: "Please provide the register." } });
    expect(response.statusCode).toBe(200); expect(application).toMatchObject({ status: "needs_info" }); expect(application.save).toHaveBeenCalledOnce(); expect(mocks.roundCreate).toHaveBeenCalledWith(expect.objectContaining({ applicationId: "application-1", openedBy: "user-1", status: "open" })); expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "ReviewRoundCreated" }));
  });

  it("rejects unauthorized, invalid, and missing review-round requests", async () => {
    role = "issuer"; await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds", payload: { title: "Review" } })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator"; await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds", payload: { title: "" } })).resolves.toMatchObject({ statusCode: 400 });
    mocks.applicationFindById.mockResolvedValueOnce(null); await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds", payload: { title: "Review" } })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("adds open-round items and records issuer responses", async () => {
    mocks.roundFindOne.mockResolvedValueOnce({ status: "open" }); mocks.itemCreate.mockResolvedValueOnce(object({ _id: "item-1", question: "Who owns the asset?" }));
    const created = await app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/items", payload: { question: "Who owns the asset?", category: "ownership" } });
    expect(created.statusCode).toBe(200); expect(mocks.itemCreate).toHaveBeenCalledWith(expect.objectContaining({ status: "pending", askedBy: "user-1" }));
    role = "issuer"; const item = object({ _id: "item-1", status: "pending", save: vi.fn().mockResolvedValue(undefined) }); mocks.itemFindOne.mockResolvedValueOnce(item);
    const replied = await app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/items/item-1/respond", payload: { response: "The issuer owns the asset." } });
    expect(replied.statusCode).toBe(200); expect(item).toMatchObject({ status: "resolved", response: "The issuer owns the asset.", respondedBy: "user-1", respondedAt: expect.any(Date) }); expect(item.save).toHaveBeenCalledOnce();
  });

  it("blocks closed or missing items and investor responses", async () => {
    mocks.roundFindOne.mockResolvedValueOnce(null); await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/items", payload: { question: "Question" } })).resolves.toMatchObject({ statusCode: 404 });
    mocks.roundFindOne.mockResolvedValueOnce({ status: "closed" }); await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/items", payload: { question: "Question" } })).resolves.toMatchObject({ statusCode: 422 });
    role = "investor"; await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/items/item-1/respond", payload: { response: "Response" } })).resolves.toMatchObject({ statusCode: 403 });
    role = "issuer"; mocks.itemFindOne.mockResolvedValueOnce(null); await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/items/item-1/respond", payload: { response: "Response" } })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("closes a review round, returns a ready application to review, and lists rounds with items", async () => {
    const round = object({ _id: "round-1", status: "open", save: vi.fn().mockResolvedValue(undefined) }); mocks.roundFindOne.mockResolvedValueOnce(round); mocks.itemCount.mockResolvedValueOnce(0); const application = { status: "needs_info", save: vi.fn().mockResolvedValue(undefined) }; mocks.applicationFindById.mockResolvedValueOnce(application);
    const closed = await app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/close" });
    expect(closed.statusCode).toBe(200); expect(round).toMatchObject({ status: "closed", closedBy: "user-1", closedAt: expect.any(Date) }); expect(application).toMatchObject({ status: "in_review" }); expect(application.save).toHaveBeenCalledOnce();
    mocks.roundFind.mockReturnValueOnce({ sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue([{ _id: "round-1", title: "Ownership" }]) })) }); mocks.itemFind.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue([{ _id: "item-1" }]) });
    expect((await app.inject({ method: "GET", url: "/v1/applications/application-1/review-rounds" })).json()).toEqual([{ _id: "round-1", title: "Ownership", items: [{ _id: "item-1" }] }]);
  });

  it("blocks unauthorized close requests and reports a missing round", async () => {
    role = "issuer"; await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/close" })).resolves.toMatchObject({ statusCode: 403 });
    role = "operator"; mocks.roundFindOne.mockResolvedValueOnce(null); await expect(app.inject({ method: "POST", url: "/v1/applications/application-1/review-rounds/round-1/close" })).resolves.toMatchObject({ statusCode: 404 });
  });
});
