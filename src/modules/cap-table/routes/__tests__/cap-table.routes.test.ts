import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ offeringFindById: vi.fn(), ledgerFind: vi.fn(), userFind: vi.fn(), authorize: vi.fn(), scope: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ OfferingModel: { findById: mocks.offeringFindById }, LedgerEntryModel: { find: mocks.ledgerFind }, UserModel: { find: mocks.userFind } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/scope.js", () => ({ assertIssuerBusinessScope: mocks.scope }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));

import { capTableRoutes } from "../cap-table.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "issuer";
const lean = (value: unknown) => ({ lean: vi.fn().mockResolvedValue(value) });
beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined); mocks.scope.mockReturnValue(undefined); mocks.serialize.mockImplementation((value: unknown) => value); role = "issuer";
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "issuer-1", role }; });
  await app.register(capTableRoutes);
});
afterEach(async () => { await app.close(); });

describe("cap-table routes", () => {
  function readyModels() {
    mocks.offeringFindById.mockReturnValue(lean({ _id: "offering-1", businessId: "business-1", name: "Income Fund", terms: { raiseAmount: 200 } }));
    mocks.ledgerFind.mockReturnValue({ select: vi.fn(() => lean([
      { accountRef: "investor:investor-1", direction: "credit", amount: { toString: () => "100" } },
      { accountRef: "investor:investor-1", direction: "debit", amount: { toString: () => "25" } },
      { accountRef: "investor:investor-2", direction: "credit", amount: { toString: () => "50" } },
      { accountRef: "platform:fees", direction: "credit", amount: { toString: () => "99" } },
    ])) });
    mocks.userFind.mockReturnValue({ select: vi.fn(() => lean([{ _id: "investor-1", name: "One", email: "one@example.com" }, { _id: "investor-2", name: "Two", email: "two@example.com" }])) });
  }

  it("returns net holder positions only to the authorized issuer scope", async () => {
    readyModels();
    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/cap-table" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.objectContaining({ offeringId: "offering-1", holderCount: 2, totalAllocated: 125, holders: [expect.objectContaining({ investorUserId: "investor-1", units: 75, pctOfRaise: 37.5 }), expect.objectContaining({ investorUserId: "investor-2", units: 50, pctOfHolders: 40 })] }));
    expect(mocks.scope).toHaveBeenCalledWith(expect.objectContaining({ role: "issuer" }), "business-1");
  });

  it("exports the same governed holder view as CSV", async () => {
    readyModels();
    const response = await app.inject({ method: "GET", url: "/v1/offerings/offering-1/cap-table?format=csv" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/csv");
    expect(response.body).toContain("investorUserId,name,email,units,pctOfRaise,pctOfHolders");
    expect(response.body).toContain("investor-1,One,one@example.com,75,37.5,60");
  });

  it("blocks investors and reports unknown offerings", async () => {
    role = "investor";
    await expect(app.inject({ method: "GET", url: "/v1/offerings/offering-1/cap-table" })).resolves.toMatchObject({ statusCode: 403 });
    role = "issuer";
    mocks.offeringFindById.mockReturnValue(lean(null));
    await expect(app.inject({ method: "GET", url: "/v1/offerings/missing/cap-table" })).resolves.toMatchObject({ statusCode: 404 });
  });
});
