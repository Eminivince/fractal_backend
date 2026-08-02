import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../../utils/errors.js";

const mocks = vi.hoisted(() => ({ banks: vi.fn(), resolve: vi.fn(), env: { PAYSTACK_ENABLED: false } }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/paystack.js", () => ({ listPaystackBanks: mocks.banks, resolvePaystackAccount: mocks.resolve }));
import { paymentUtilRoutes } from "../payment-utils.routes.js";

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  mocks.banks.mockReset(); mocks.resolve.mockReset(); mocks.env.PAYSTACK_ENABLED = false;
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role: "investor" }; });
  await app.register(paymentUtilRoutes);
});
afterEach(async () => { await app.close(); });

describe("payment utility routes", () => {
  it("requires an enabled provider for bank data", async () => {
    await expect(app.inject({ method: "GET", url: "/v1/banks" })).resolves.toMatchObject({ statusCode: 422 });
    await expect(app.inject({ method: "POST", url: "/v1/bank-account/resolve", payload: { accountNumber: "0123456789", bankCode: "058" } })).resolves.toMatchObject({ statusCode: 422 });
  });

  it("returns active banks only in stable name order", async () => {
    mocks.env.PAYSTACK_ENABLED = true;
    mocks.banks.mockResolvedValue([{ name: "Zenith", code: "057", type: "nuban", active: true }, { name: "Access", code: "044", type: "nuban", active: true }, { name: "Disabled", code: "000", type: "nuban", active: false }]);
    const response = await app.inject({ method: "GET", url: "/v1/banks" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ name: "Access", code: "044", type: "nuban" }, { name: "Zenith", code: "057", type: "nuban" }]);
  });

  it("validates and resolves a bank account before it is registered", async () => {
    mocks.env.PAYSTACK_ENABLED = true; mocks.resolve.mockResolvedValue({ account_number: "0123456789", account_name: "Ada Lovelace" });
    const response = await app.inject({ method: "POST", url: "/v1/bank-account/resolve", payload: { accountNumber: "0123456789", bankCode: "058" } });
    expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ accountNumber: "0123456789", accountName: "Ada Lovelace", bankCode: "058" });
    expect(mocks.resolve).toHaveBeenCalledWith({ accountNumber: "0123456789", bankCode: "058" });
    await expect(app.inject({ method: "POST", url: "/v1/bank-account/resolve", payload: { accountNumber: "bad", bankCode: "058" } })).resolves.toMatchObject({ statusCode: 400 });
  });
});
