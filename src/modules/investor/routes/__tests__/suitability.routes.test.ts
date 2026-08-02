import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ create: vi.fn(), findOne: vi.fn(), audit: vi.fn(), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ SuitabilityAssessmentModel: { create: mocks.create, findOne: mocks.findOne } }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.audit }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));

import { suitabilityRoutes } from "../suitability.routes.js";

let role = "investor";
let app: ReturnType<typeof Fastify>;

function latestQuery(value: unknown) {
  return { sort: vi.fn(() => ({ lean: vi.fn().mockResolvedValue(value) })) };
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  role = "investor";
  mocks.audit.mockResolvedValue(undefined);
  mocks.serialize.mockImplementation((value: unknown) => value);
  mocks.create.mockImplementation(async (value: Record<string, unknown>) => ({ ...value, _id: "assessment-1", toObject: () => ({ ...value, _id: "assessment-1" }) }));
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "investor-1", role }; });
  await app.register(suitabilityRoutes);
});

afterEach(async () => { await app.close(); });

describe("suitability routes", () => {
  it("records a low-risk assessment with an expiry and complete audit evidence", async () => {
    const response = await app.inject({ method: "POST", url: "/v1/investor/suitability/submit", payload: { responses: [{ questionId: "experience", answer: "experienced" }, { questionId: "term", answer: "long_term" }] } });
    expect(response.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ investorUserId: "investor-1", riskScore: 2, riskTier: 1, expiresAt: expect.any(Date) }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({ userId: "investor-1" }), expect.objectContaining({ action: "SuitabilityAssessmentCompleted", notes: "riskTier:1 riskScore:2" }));
  });

  it("calculates high-risk answers into the highest risk tier", async () => {
    const highRiskAnswers = ["no_experience", "short_term", "high_risk_tolerance", "speculative", "cannot_afford_loss", "speculative", "high_risk_tolerance", "short_term", "no_experience", "cannot_afford_loss", "speculative"];
    const response = await app.inject({ method: "POST", url: "/v1/investor/suitability/submit", payload: { responses: highRiskAnswers.map((answer, index) => ({ questionId: `q-${index}`, answer })) } });
    expect(response.statusCode).toBe(200);
    expect(mocks.create).toHaveBeenLastCalledWith(expect.objectContaining({ riskScore: 22, riskTier: 5 }));
  });

  it("returns absent, valid, and expired assessment states", async () => {
    mocks.findOne.mockReturnValueOnce(latestQuery(null));
    await expect(app.inject({ method: "GET", url: "/v1/investor/suitability/status" })).resolves.toMatchObject({ statusCode: 200, json: expect.any(Function) });

    mocks.findOne.mockReturnValueOnce(latestQuery({ _id: "assessment-1", expiresAt: new Date(Date.now() + 60_000).toISOString() }));
    expect((await app.inject({ method: "GET", url: "/v1/investor/suitability/status" })).json()).toMatchObject({ valid: true, assessment: { _id: "assessment-1" } });

    mocks.findOne.mockReturnValueOnce(latestQuery({ _id: "assessment-1", expiresAt: new Date(Date.now() - 60_000).toISOString() }));
    expect((await app.inject({ method: "GET", url: "/v1/investor/suitability/status" })).json()).toMatchObject({ valid: false, assessment: { _id: "assessment-1" } });
  });

  it("rejects non-investors and malformed assessment input", async () => {
    role = "issuer";
    await expect(app.inject({ method: "POST", url: "/v1/investor/suitability/submit", payload: { responses: [{ questionId: "q", answer: "answer" }] } })).resolves.toMatchObject({ statusCode: 403 });
    role = "investor";
    await expect(app.inject({ method: "POST", url: "/v1/investor/suitability/submit", payload: { responses: [] } })).resolves.toMatchObject({ statusCode: 400 });
  });
});
