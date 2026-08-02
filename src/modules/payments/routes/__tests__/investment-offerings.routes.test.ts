import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({
  listPublic: vi.fn(),
  getPublic: vi.fn(),
  listOpen: vi.fn(),
  getOpen: vi.fn(),
  configuration: vi.fn(),
  authorize: vi.fn(),
}));

vi.mock("../../../../platform/postgres-investment-offerings.js", () => ({
  listPublicInvestmentOfferings: mocks.listPublic,
  getPublicInvestmentOffering: mocks.getPublic,
  listOpenInvestmentOfferings: mocks.listOpen,
  getOpenInvestmentOffering: mocks.getOpen,
}));
vi.mock("../../../../platform/postgres-platform-configuration.js", () => ({ readActivePlatformConfiguration: mocks.configuration }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));

import { investmentOfferingReadRoutes } from "../investment-offerings.routes.js";

const offering = {
  slug: "lagos-income-note", reference: "OFF-001", name: "Lagos income note", issuerName: "Fractal Holdings Ltd", assetName: "Lagos logistics asset", assetType: "Warehouse",
  assetClass: "infrastructure", countryCode: "NG", state: "Lagos", city: "Lagos", summary: "Governed infrastructure income offering.", thesis: "Long-term logistics demand.", currency: "NGN",
  capacityMinor: "1000000", minimumTicketMinor: 1000, targetReturnBps: 1200, termMonths: 36, riskSummary: "Capital is at risk.", incomeSource: "Lease income", structure: "Secured note", security: "Asset security",
  feeSummary: "See approved fee schedule.", nextMilestone: "Subscription close", opensAt: "2026-08-01T09:00:00.000Z", closesAt: "2026-12-01T17:00:00.000Z", publishedAt: "2026-07-28T09:00:00.000Z", publicationVersion: 1,
};

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.listPublic.mockResolvedValue([offering]);
  mocks.getPublic.mockResolvedValue(offering);
  mocks.listOpen.mockResolvedValue([offering]);
  mocks.getOpen.mockResolvedValue(offering);
  mocks.authorize.mockReturnValue(undefined);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => {
    const statusCode = error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500;
    return reply.status(statusCode).send({ message: error.message });
  });
  app.decorate("authenticate", async (request: { authUser?: unknown }) => {
    request.authUser = { userId: "investor-1", role: "investor", sessionId: "session-1" };
  });
  await app.register(investmentOfferingReadRoutes);
});

afterEach(async () => {
  await app.close();
});

describe("investment offering read routes", () => {
  it("uses the active governed catalogue page size and exposes its binding on public reads", async () => {
    mocks.configuration.mockResolvedValue({ versionId: "configuration-1", projectionVersion: 8, value: 24 });

    const response = await app.inject({ method: "GET", url: "/v1/public/investment-offerings" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-fractal-configuration-version"]).toBe("configuration-1");
    expect(response.headers["x-fractal-configuration-projection"]).toBe("8");
    expect(mocks.listPublic).toHaveBeenCalledWith(24);
    expect(response.json()).toEqual({ offerings: [offering] });
  });

  it("uses an explicit bounded public limit without reading configuration and rejects malformed limits", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/public/investment-offerings?limit=10" });
    expect(response.statusCode).toBe(200);
    expect(mocks.configuration).not.toHaveBeenCalled();
    expect(mocks.listPublic).toHaveBeenCalledWith(10);

    const invalid = await app.inject({ method: "GET", url: "/v1/public/investment-offerings?limit=0" });
    expect(invalid.statusCode).toBe(400);
  });

  it("serves an open public offering and does not disclose a missing, closed, or invalid slug", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/public/investment-offerings/lagos-income-note" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(mocks.getPublic).toHaveBeenCalledWith("lagos-income-note");
    expect(response.json()).toEqual(offering);

    mocks.getPublic.mockResolvedValueOnce(null);
    const missing = await app.inject({ method: "GET", url: "/v1/public/investment-offerings/not-open" });
    expect(missing.statusCode).toBe(404);
    const invalid = await app.inject({ method: "GET", url: "/v1/public/investment-offerings/Not-Valid" });
    expect(invalid.statusCode).toBe(400);
  });

  it("applies actor authorization to non-public offering registers and details", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/investment-offerings?limit=5" });
    expect(list.statusCode).toBe(200);
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "investor" }), "read", "offering");
    expect(mocks.listOpen).toHaveBeenCalledWith(5);

    const detail = await app.inject({ method: "GET", url: "/v1/investment-offerings/OFF-001" });
    expect(detail.statusCode).toBe(200);
    expect(mocks.getOpen).toHaveBeenCalledWith("OFF-001");
    mocks.getOpen.mockResolvedValueOnce(null);
    const missing = await app.inject({ method: "GET", url: "/v1/investment-offerings/closed" });
    expect(missing.statusCode).toBe(404);
  });
});
