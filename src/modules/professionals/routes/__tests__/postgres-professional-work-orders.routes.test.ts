import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HttpError } from "../../../../utils/errors.js";
import { postgresProfessionalWorkOrderRoutes } from "../postgres-professional-work-orders.routes.js";

let app: ReturnType<typeof Fastify>;
let role = "investor";
beforeEach(async () => {
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error instanceof HttpError ? error.statusCode : error.name === "ZodError" ? 400 : 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role, sessionId: "session-1" }; });
  await app.register(postgresProfessionalWorkOrderRoutes);
});
afterEach(async () => { await app.close(); });

describe("PostgreSQL professional work-order routes", () => {
  it("keeps operational finance exceptions behind operator or administrator access", async () => {
    for (const request of [
      { method: "GET", url: "/v1/control/professional-payout-exceptions" },
      { method: "GET", url: "/v1/control/professional-payout-recipient-recovery-cases" },
      { method: "GET", url: "/v1/control/professional-finance-exceptions" },
      { method: "POST", url: "/v1/control/professional-finance-exceptions", payload: {} },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(expect.objectContaining({ message: "Operator or admin role required" }));
    }
  });

  it("keeps professional workspace actions behind a professional role", async () => {
    for (const request of [
      { method: "GET", url: "/v1/professional/work-orders" },
      { method: "GET", url: "/v1/professional/payments" },
      { method: "POST", url: "/v1/professional/work-orders/00000000-0000-4000-8000-000000000001/response", payload: { response: "accept" } },
      { method: "POST", url: "/v1/professional/firms/00000000-0000-4000-8000-000000000001/payout-profile", payload: { bankCode: "058", accountNumber: "0123456789" } },
    ] as const) {
      const response = await app.inject(request);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual(expect.objectContaining({ message: "Professional role required" }));
    }
  });
});
