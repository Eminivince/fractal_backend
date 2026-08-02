import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ configById: vi.fn(), authorize: vi.fn(), audit: vi.fn(), decimal: vi.fn((value: number) => `decimal:${value}`), serialize: vi.fn((value: unknown) => value) }));
vi.mock("../../../../db/models.js", () => ({ PlatformConfigModel: { findById: mocks.configById } }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
vi.mock("../../../../utils/audit.js", () => ({ appendEvent: mocks.audit }));
vi.mock("../../../../utils/decimal.js", () => ({ toDecimal: mocks.decimal }));
vi.mock("../../../../utils/serialize.js", () => ({ serialize: mocks.serialize }));

import { platformRoutes } from "../platform.routes.js";

let app: ReturnType<typeof Fastify>;

function config(overrides: Record<string, unknown> = {}) {
  return { _id: "platform_config", featureFlags: {}, complianceRules: {}, feeConfig: {}, save: vi.fn().mockResolvedValue(undefined), toObject: vi.fn(function (this: Record<string, unknown>) { return { ...this }; }), ...overrides } as any;
}

beforeEach(async () => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.authorize.mockReturnValue(undefined);
  mocks.audit.mockResolvedValue(undefined);
  mocks.decimal.mockImplementation((value: number) => `decimal:${value}`);
  mocks.serialize.mockImplementation((value: unknown) => value);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "admin-1", role: "admin" }; });
  await app.register(platformRoutes);
});

afterEach(async () => { await app.close(); });

describe("platform routes", () => {
  it("reads the governed configuration and public content, or returns an empty object when absent", async () => {
    mocks.configById.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue({ _id: "platform_config", featureFlags: { enableTemplateB: true } }) });
    await expect(app.inject({ method: "GET", url: "/v1/platform/config" })).resolves.toMatchObject({ statusCode: 200, json: expect.any(Function) });
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "platform");
    mocks.configById.mockReturnValueOnce({ lean: vi.fn().mockResolvedValue(null) });
    const none = await app.inject({ method: "GET", url: "/v1/platform/content" });
    expect(none.json()).toEqual({});
  });

  it("updates compliance and fee values as decimals and writes an audit event", async () => {
    const current = config();
    mocks.configById.mockResolvedValueOnce(current);
    const response = await app.inject({ method: "PUT", url: "/v1/platform/config", payload: { complianceRules: { requireKycToView: true, requireKycToSubscribe: true, transferModeDefault: "whitelist", defaultLockupDays: 30, minInvestmentByTemplate: { A: 100, B: 200 } }, feeConfig: { setupFee: 10, platformFeePct: 2.5, servicingFeePct: 1 }, featureFlags: { enableTemplateB: true, enableStablecoinPayouts: false, enableSecondaryTransfers: true }, feeOverrides: { byTemplate: {}, byBusiness: { "business-1": { platformFeePct: 2 } }, byOffering: {} } } });
    expect(response.statusCode).toBe(200);
    expect(current.complianceRules.minInvestmentByTemplate).toEqual({ A: "decimal:100", B: "decimal:200" });
    expect(current.feeConfig).toEqual({ setupFee: "decimal:10", platformFeePct: "decimal:2.5", servicingFeePct: "decimal:1" });
    expect(current.updatedBy).toBe("admin-1");
    expect(current.save).toHaveBeenCalledOnce();
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "Platform config updated" }));
  });

  it("updates content only after valid content validation and reports a missing configuration", async () => {
    const current = config();
    mocks.configById.mockResolvedValueOnce(current);
    const response = await app.inject({ method: "PUT", url: "/v1/platform/content", payload: { heroHeadline: "Invest with confidence", heroSubtext: "Governed investment access", ctas: ["View offerings"], howItWorks: ["Complete verification"], faqs: [{ q: "Who can invest?", a: "Eligible investors can invest." }] } });
    expect(response.statusCode).toBe(200);
    expect(current.contentConfig).toMatchObject({ heroHeadline: "Invest with confidence" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "Platform content updated" }));
    mocks.configById.mockResolvedValueOnce(null);
    await expect(app.inject({ method: "PUT", url: "/v1/platform/content", payload: { heroHeadline: "x", heroSubtext: "y", ctas: [], howItWorks: [], faqs: [] } })).resolves.toMatchObject({ statusCode: 400 });
  });

  it("publishes the regulatory disclosure without authentication", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/platform/regulatory-status" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ platformName: "Fractal", country: "Nigeria", regulatoryStatus: "operating_under_exemption" });
  });
});
