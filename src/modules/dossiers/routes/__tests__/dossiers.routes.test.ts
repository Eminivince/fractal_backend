import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ applicationFindById: vi.fn(), dossierFindOne: vi.fn(), dossierFindOneAndUpdate: vi.fn(), authorize: vi.fn(), appendEvent: vi.fn(), scope: vi.fn(), transaction: vi.fn(), serialize: vi.fn((value: unknown) => value), persist: vi.fn(), retrieve: vi.fn() }));
vi.mock("../../../../db/models.js", () => ({ ApplicationModel: { findById: mocks.applicationFindById }, DossierModel: { findOne: mocks.dossierFindOne, findOneAndUpdate: mocks.dossierFindOneAndUpdate } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.appendEvent }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.scope }));
vi.mock("../../../../utils/tx.js", () => ({ runInTransaction: mocks.transaction }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));
vi.mock("../../../../services/storage.js", () => ({ persistDossierBinary: mocks.persist, retrieveFile: mocks.retrieve }));
import { dossierRoutes } from "../dossiers.routes.js";

let app: ReturnType<typeof Fastify>;
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
const sessioned = (value: unknown) => ({ session: vi.fn().mockResolvedValue(value) });
const document = (value: Record<string, unknown>): any => ({ ...value, save: vi.fn().mockResolvedValue(undefined) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined); mocks.appendEvent.mockResolvedValue(undefined); mocks.scope.mockReturnValue(undefined); mocks.transaction.mockImplementation(async (callback: (session: string) => unknown) => callback("session-1")); mocks.serialize.mockImplementation((value: unknown) => value);
  app = Fastify(); app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role: "issuer", businessId: "business-1" }; }); await app.register(dossierRoutes);
});
afterEach(async () => { await app.close(); });

describe("dossier routes", () => {
  it("returns a dossier only inside its issuer business scope", async () => {
    mocks.applicationFindById.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.dossierFindOne.mockReturnValueOnce(lean({ _id: "dossier-1", documents: [] }));
    const response = await app.inject({ method: "GET", url: "/v1/applications/application-1/dossier" });
    expect(response.statusCode).toBe(200); expect(mocks.scope).toHaveBeenCalledWith(expect.anything(), "business-1");
    mocks.applicationFindById.mockReturnValueOnce(lean(null)); await expect(app.inject({ method: "GET", url: "/v1/applications/missing/dossier" })).resolves.toMatchObject({ statusCode: 404 });
  });

  it("uploads a new document version and updates the application checklist", async () => {
    const application = document({ _id: "application-1", businessId: "business-1", checklistState: [{ key: "incorporation", label: "Incorporation", status: "missing" }, { key: "bank_statement", label: "Bank statement", status: "provided" }] }); const dossier = document({ _id: "dossier-1", hashes: [], documents: [{ _id: "doc-1", type: "incorporation", version: 1, isLatest: true }] }); mocks.applicationFindById.mockReturnValueOnce(sessioned(application)); mocks.dossierFindOne.mockReturnValueOnce(sessioned(dossier)); mocks.persist.mockResolvedValueOnce({ storageKey: "dossiers/application-1/incorporation.pdf", sha256: "a".repeat(64) });
    const response = await app.inject({ method: "POST", url: "/v1/applications/application-1/dossier/documents", payload: { type: "incorporation", filename: "Incorporation.PDF", contentBase64: "dGVzdC1kb2N1bWVudA==", mimeType: "application/pdf", stageTag: "Intake" } });
    expect(response.statusCode).toBe(200); expect(dossier.documents).toEqual(expect.arrayContaining([expect.objectContaining({ type: "incorporation", version: 2, isLatest: true, supersedes: "doc-1", storageKey: "dossiers/application-1/incorporation.pdf" })])); expect(dossier.documents[0]).toMatchObject({ isLatest: false }); expect(application.checklistState).toEqual([{ key: "incorporation", label: "Incorporation", status: "provided" }, { key: "bank_statement", label: "Bank statement", status: "provided" }]); expect(application.save).toHaveBeenCalledWith({ session: "session-1" }); expect(dossier.save).toHaveBeenCalledWith({ session: "session-1" });
  });

  it("downloads dossier evidence or redirects to a controlled storage URL", async () => {
    const dossier = { documents: [{ _id: "doc-1", type: "incorporation", filename: "incorporation.pdf", mimeType: "application/pdf", storageKey: "dossiers/key" }] }; mocks.applicationFindById.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.dossierFindOne.mockReturnValueOnce(lean(dossier)); mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("file") });
    const download = await app.inject({ method: "GET", url: "/v1/applications/application-1/dossier/documents/doc-1" });
    expect(download.statusCode).toBe(200); expect(download.headers["content-type"]).toContain("application/pdf"); expect(download.body).toBe("file");
    mocks.applicationFindById.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.dossierFindOne.mockReturnValueOnce(lean(dossier)); mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.alloc(0), redirectUrl: "https://storage.example/dossier" }); const redirect = await app.inject({ method: "GET", url: "/v1/applications/application-1/dossier/documents/doc-1" }); expect(redirect.statusCode).toBe(302); expect(redirect.headers.location).toBe("https://storage.example/dossier");
  });

  it("returns a document's complete ascending version history", async () => {
    mocks.applicationFindById.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.dossierFindOne.mockReturnValueOnce(lean({ documents: [{ _id: "doc-2", type: "incorporation", version: 2 }, { _id: "doc-1", type: "incorporation", version: 1 }, { _id: "doc-3", type: "other", version: 1 }] }));
    expect((await app.inject({ method: "GET", url: "/v1/applications/application-1/dossier/documents/doc-2/history" })).json()).toEqual([{ _id: "doc-1", type: "incorporation", version: 1 }, { _id: "doc-2", type: "incorporation", version: 2 }]);
  });

  it("updates structured dossier data and reports missing dossiers", async () => {
    mocks.applicationFindById.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.dossierFindOneAndUpdate.mockReturnValueOnce(lean({ _id: "dossier-1", structuredData: { directorCount: 2 } }));
    const response = await app.inject({ method: "PATCH", url: "/v1/applications/application-1/dossier/structuredData", payload: { structuredData: { directorCount: 2 } } });
    expect(response.statusCode).toBe(200); expect(mocks.dossierFindOneAndUpdate).toHaveBeenCalledWith({ applicationId: "application-1" }, { structuredData: { directorCount: 2 } }, { new: true });
    mocks.applicationFindById.mockReturnValueOnce(lean({ _id: "application-1", businessId: "business-1" })); mocks.dossierFindOneAndUpdate.mockReturnValueOnce(lean(null)); await expect(app.inject({ method: "PATCH", url: "/v1/applications/application-1/dossier/structuredData", payload: { structuredData: {} } })).resolves.toMatchObject({ statusCode: 404 });
  });
});
