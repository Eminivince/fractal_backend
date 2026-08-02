import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ keyCreate: vi.fn(), keyFind: vi.fn(), keyFindOne: vi.fn(), hookCreate: vi.fn(), hookFind: vi.fn(), hookDelete: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ ApiKeyModel: { create: mocks.keyCreate, find: mocks.keyFind, findOne: mocks.keyFindOne }, IssuerWebhookModel: { create: mocks.hookCreate, find: mocks.hookFind, findOneAndDelete: mocks.hookDelete } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { developerRoutes } from "../developer.routes.js";

let app: ReturnType<typeof Fastify>; let role = "issuer"; let businessId: string | undefined = "business-1";
const lean = (value: unknown) => ({ select: vi.fn(() => ({ sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) })) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset(); mocks.authorize.mockReturnValue(undefined); mocks.appendEvent.mockResolvedValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); role = "issuer"; businessId = "business-1";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role, businessId }; }); await app.register(developerRoutes);
});
afterEach(async () => { await app.close(); });

describe("issuer developer routes", () => {
  it("creates a one-time API key while storing only a digest", async () => {
    mocks.keyCreate.mockResolvedValueOnce({ _id: "key-1", createdAt: new Date(date) }); const response = await app.inject({ method: "POST", url: "/v1/issuer/api-keys", payload: { name: "Reporting integration" } });
    const body = response.json(); expect(response.statusCode).toBe(200); expect(body.key).toMatch(/^fk_live_[a-f0-9]{48}$/); expect(mocks.keyCreate).toHaveBeenCalledWith(expect.objectContaining({ businessId: "business-1", name: "Reporting integration", keyHash: expect.stringMatching(/^[a-f0-9]{64}$/) })); expect(mocks.keyCreate.mock.calls[0][0].keyHash).not.toBe(body.key); expect(mocks.appendEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "ApiKeyCreated" }));
  });

  it("lists and revokes only the issuer business API keys", async () => {
    mocks.keyFind.mockReturnValueOnce(lean([{ _id: "key-1", name: "Reporting" }])); expect((await app.inject({ method: "GET", url: "/v1/issuer/api-keys" })).json()).toEqual({ data: [{ _id: "key-1", name: "Reporting" }] }); const key = { name: "Reporting", save: vi.fn().mockResolvedValue(undefined) }; mocks.keyFindOne.mockResolvedValueOnce(key);
    const response = await app.inject({ method: "DELETE", url: "/v1/issuer/api-keys/key-1" }); expect(response.statusCode).toBe(200); expect(key).toMatchObject({ revokedAt: expect.any(Date) }); expect(key.save).toHaveBeenCalledOnce(); mocks.keyFindOne.mockResolvedValueOnce(null); await expect(app.inject({ method: "DELETE", url: "/v1/issuer/api-keys/missing" })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("creates, lists, and deletes one-time webhook secrets", async () => {
    mocks.hookCreate.mockResolvedValueOnce({ _id: "hook-1", url: "https://issuer.example/hooks", events: ["offering.opened"], active: true }); const created = await app.inject({ method: "POST", url: "/v1/issuer/webhooks", payload: { url: "https://issuer.example/hooks", events: ["offering.opened"] } }); expect(created.statusCode).toBe(200); expect(created.json().secret).toMatch(/^whsec_[a-f0-9]{48}$/);
    mocks.hookFind.mockReturnValueOnce(lean([{ _id: "hook-1", url: "https://issuer.example/hooks" }])); expect((await app.inject({ method: "GET", url: "/v1/issuer/webhooks" })).json()).toEqual({ data: [{ _id: "hook-1", url: "https://issuer.example/hooks" }] }); mocks.hookDelete.mockResolvedValueOnce({ url: "https://issuer.example/hooks" }); await expect(app.inject({ method: "DELETE", url: "/v1/issuer/webhooks/hook-1" })).resolves.toMatchObject({ statusCode: 200 }); mocks.hookDelete.mockResolvedValueOnce(null); await expect(app.inject({ method: "DELETE", url: "/v1/issuer/webhooks/missing" })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("blocks non-issuers, incomplete business profiles, and invalid inputs", async () => {
    role = "investor"; await expect(app.inject({ method: "GET", url: "/v1/issuer/api-keys" })).resolves.toMatchObject({ statusCode: 403 }); role = "issuer"; businessId = undefined; await expect(app.inject({ method: "GET", url: "/v1/issuer/webhooks" })).resolves.toMatchObject({ statusCode: 422 }); businessId = "business-1"; await expect(app.inject({ method: "POST", url: "/v1/issuer/webhooks", payload: { url: "invalid", events: [] } })).resolves.toMatchObject({ statusCode: 400 });
  });
});

const date = "2026-07-29T00:00:00.000Z";
