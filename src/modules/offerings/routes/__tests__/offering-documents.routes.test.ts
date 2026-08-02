import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ byId: vi.fn(), authorize: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ OfferingModel: { findById: mocks.byId } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
import { offeringDocumentRoutes } from "../offering-documents.routes.js";

let role = "issuer"; let businessId = "business-1"; let app: ReturnType<typeof Fastify>;
function offering(overrides: Record<string, unknown> = {}) { return { _id: "offering-1", businessId, status: "draft", documents: [], save: vi.fn().mockResolvedValue(undefined), ...overrides } as any; }
beforeEach(async () => {
  mocks.byId.mockReset(); mocks.authorize.mockReset().mockReturnValue(undefined); mocks.serialize.mockReset().mockImplementation((value: unknown) => value); role = "issuer"; businessId = "business-1";
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role, businessId }; }); await app.register(offeringDocumentRoutes);
});
afterEach(async () => { await app.close(); });

describe("offering document routes", () => {
  it("adds a versioned document inside the issuer's offering scope", async () => {
    const current = offering(); mocks.byId.mockResolvedValueOnce(current);
    const response = await app.inject({ method: "POST", url: "/v1/offerings/offering-1/documents", payload: { docType: "prospectus", label: "Offering memorandum", storageKey: "offerings/offering-1/memorandum.pdf" } });
    expect(response.statusCode).toBe(200); expect(current.documents[0]).toMatchObject({ docType: "prospectus", version: 1, uploadedAt: expect.any(Date) }); expect(current.save).toHaveBeenCalledOnce();
  });

  it("lists the document register and returns empty data when it is not set", async () => {
    mocks.byId.mockReturnValueOnce({ select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({ _id: "offering-1", documents: [{ _id: "doc-1" }] }) })) });
    expect((await app.inject({ method: "GET", url: "/v1/offerings/offering-1/documents" })).json()).toEqual([{ _id: "doc-1" }]);
    mocks.byId.mockReturnValueOnce({ select: vi.fn(() => ({ lean: vi.fn().mockResolvedValue({ _id: "offering-1" }) })) });
    expect((await app.inject({ method: "GET", url: "/v1/offerings/offering-1/documents" })).json()).toEqual([]);
  });

  it("removes only a matching document from a draft offering", async () => {
    const current = offering({ documents: [{ _id: "doc-1" }, { _id: "doc-2" }] }); mocks.byId.mockResolvedValueOnce(current);
    const response = await app.inject({ method: "DELETE", url: "/v1/offerings/offering-1/documents/doc-1" });
    expect(response.statusCode).toBe(200); expect(current.documents).toEqual([{ _id: "doc-2" }]); expect(current.save).toHaveBeenCalledOnce();
  });

  it("blocks missing, non-draft, out-of-scope, and unknown documents", async () => {
    mocks.byId.mockResolvedValueOnce(null); await expect(app.inject({ method: "POST", url: "/v1/offerings/missing/documents", payload: { docType: "legal", label: "Legal", storageKey: "key" } })).resolves.toMatchObject({ statusCode: 404 });
    mocks.byId.mockResolvedValueOnce(offering({ businessId: "other-business" })); await expect(app.inject({ method: "POST", url: "/v1/offerings/offering-1/documents", payload: { docType: "legal", label: "Legal", storageKey: "key" } })).resolves.toMatchObject({ statusCode: 403 });
    mocks.byId.mockResolvedValueOnce(offering({ status: "open", documents: [{ _id: "doc-1" }] })); await expect(app.inject({ method: "DELETE", url: "/v1/offerings/offering-1/documents/doc-1" })).resolves.toMatchObject({ statusCode: 422 });
    mocks.byId.mockResolvedValueOnce(offering({ businessId: "other-business", documents: [{ _id: "doc-1" }] })); await expect(app.inject({ method: "DELETE", url: "/v1/offerings/offering-1/documents/doc-1" })).resolves.toMatchObject({ statusCode: 403 });
    mocks.byId.mockResolvedValueOnce(offering()); await expect(app.inject({ method: "DELETE", url: "/v1/offerings/offering-1/documents/missing" })).resolves.toMatchObject({ statusCode: 404 });
  });
});
