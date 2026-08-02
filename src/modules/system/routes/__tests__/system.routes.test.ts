import Fastify, { type FastifyError, type FastifyReply, type FastifyRequest } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(), resend: vi.fn(), smtp: vi.fn(), anyTransport: vi.fn(),
  connection: { readyState: 0 },
  env: { NOTIFICATION_EMAIL_ENABLED: true, ANCHOR_WORKER_ENABLED: true, RECONCILIATION_WORKER_ENABLED: true },
}));
vi.mock("mongoose", () => ({ default: { connection: mocks.connection } }));
vi.mock("../../../../config/env.js", () => ({ env: mocks.env }));
vi.mock("../../../../services/email.js", () => ({ isResendConfigured: mocks.resend, isSmtpConfigured: mocks.smtp, hasAnyEmailTransportConfigured: mocks.anyTransport }));
vi.mock("../../../../utils/rbac.js", () => ({ authorize: mocks.authorize }));
import { systemRoutes } from "../system.routes.js";

let app: ReturnType<typeof Fastify>;
beforeEach(async () => {
  mocks.authorize.mockReset(); mocks.resend.mockReset(); mocks.smtp.mockReset(); mocks.anyTransport.mockReset();
  mocks.connection.readyState = 1;
  Object.assign(mocks.env, { NOTIFICATION_EMAIL_ENABLED: true, ANCHOR_WORKER_ENABLED: true, RECONCILIATION_WORKER_ENABLED: true });
  mocks.resend.mockReturnValue(true); mocks.smtp.mockReturnValue(true); mocks.anyTransport.mockReturnValue(true);
  app = Fastify();
  app.setErrorHandler((error: FastifyError, _request: FastifyRequest, reply: FastifyReply) => reply.status(error.statusCode ?? 500).send({ message: error.message }));
  app.decorate("authenticate", async (request: { authUser?: unknown }) => { request.authUser = { userId: "user-1", role: "admin" }; });
  await app.register(systemRoutes);
});
afterEach(async () => { await app.close(); });

describe("system integration route", () => {
  it("reports connected and configured integrations", async () => {
    const response = await app.inject({ method: "GET", url: "/v1/system/integrations" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mongodb", status: "Connected" }),
      expect.objectContaining({ key: "resend", status: "Configured" }),
      expect.objectContaining({ key: "email_pipeline", status: "Configured" }),
      expect.objectContaining({ key: "anchor_worker", status: "Enabled" }),
    ]));
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ role: "admin" }), "read", "platform");
  });

  it("does not describe missing transports or disabled workers as healthy", async () => {
    mocks.connection.readyState = 0;
    mocks.resend.mockReturnValue(false); mocks.smtp.mockReturnValue(false); mocks.anyTransport.mockReturnValue(false);
    Object.assign(mocks.env, { NOTIFICATION_EMAIL_ENABLED: false, ANCHOR_WORKER_ENABLED: false, RECONCILIATION_WORKER_ENABLED: false });
    const response = await app.inject({ method: "GET", url: "/v1/system/integrations" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: "mongodb", status: "Down" }),
      expect.objectContaining({ key: "resend", status: "Not Configured" }),
      expect.objectContaining({ key: "smtp", status: "Not Configured" }),
      expect.objectContaining({ key: "email_pipeline", status: "Disabled" }),
      expect.objectContaining({ key: "reconciliation_worker", status: "Disabled" }),
    ]));
  });

  it("shows a down email pipeline when delivery is enabled without a usable transport", async () => {
    mocks.resend.mockReturnValue(false); mocks.smtp.mockReturnValue(false); mocks.anyTransport.mockReturnValue(false);
    const response = await app.inject({ method: "GET", url: "/v1/system/integrations" });
    expect(response.json()).toEqual(expect.arrayContaining([expect.objectContaining({ key: "email_pipeline", status: "Down" })]));
  });
});
