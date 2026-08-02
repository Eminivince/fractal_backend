import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resendSend, smtpSendMail, createTransport } = vi.hoisted(() => ({
  resendSend: vi.fn(),
  smtpSendMail: vi.fn(),
  createTransport: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: resendSend };
  },
}));

vi.mock("nodemailer", () => ({
  createTransport,
  default: { createTransport },
}));

import { env } from "../../config/env.js";
import {
  hasAnyEmailTransportConfigured,
  isResendConfigured,
  isSmtpConfigured,
  sendEmailWithFallback,
} from "../email.js";

const payload = {
  to: "recipient@example.test",
  subject: "Delivery test",
  text: "Delivery test",
  html: "<p>Delivery test</p>",
  idempotencyKey: "fractal-test-command-1",
};

describe("email delivery service", () => {
  const original = {
    NODE_ENV: env.NODE_ENV,
    NOTIFICATION_EMAIL_ENABLED: env.NOTIFICATION_EMAIL_ENABLED,
    EMAIL_FROM: env.EMAIL_FROM,
    RESEND_API_KEY: env.RESEND_API_KEY,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    SMTP_FROM: env.SMTP_FROM,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: env.SMTP_SECURE,
  };

  beforeEach(() => {
    resendSend.mockReset();
    smtpSendMail.mockReset();
    createTransport.mockReset();
    env.NODE_ENV = "production";
    env.NOTIFICATION_EMAIL_ENABLED = true;
    env.EMAIL_FROM = "secure@example.test";
    env.RESEND_API_KEY = "re_test_delivery_key";
    env.SMTP_HOST = undefined;
    env.SMTP_USER = undefined;
    env.SMTP_PASS = undefined;
    env.SMTP_FROM = undefined;
    env.SMTP_PORT = 587;
    env.SMTP_SECURE = false;
    createTransport.mockReturnValue({ sendMail: smtpSendMail });
  });

  afterEach(() => {
    Object.assign(env, original);
  });

  it("passes the stable key to Resend and returns the exact message ID", async () => {
    resendSend.mockResolvedValue({
      data: { id: "resend-message-1" },
      error: null,
    });
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "sent",
      provider: "resend",
      providerMessageId: "resend-message-1",
    });
    expect(resendSend).toHaveBeenCalledWith({
      from: "secure@example.test",
      to: "recipient@example.test",
      subject: "Delivery test",
      text: "Delivery test",
      html: "<p>Delivery test</p>",
    }, {
      idempotencyKey: "fractal-test-command-1",
    });
  });

  it("fails before provider access when a production key is missing", async () => {
    await expect(sendEmailWithFallback({
      ...payload,
      idempotencyKey: undefined,
    })).resolves.toEqual({
      status: "failed",
      error: "Production email requires a stable idempotency key",
    });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("fails closed when Resend fails or omits its message ID", async () => {
    resendSend.mockResolvedValueOnce({
      data: null,
      error: { message: "provider refusal" },
    });
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "failed",
      error: "Resend request failed: provider refusal",
    });
    resendSend.mockResolvedValueOnce({ data: {}, error: null });
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "failed",
      error: "Resend accepted the request without a message ID",
    });
  });

  it("does not contact a provider when delivery is disabled", async () => {
    env.NOTIFICATION_EMAIL_ENABLED = false;
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "skipped",
      error: "NOTIFICATION_EMAIL_ENABLED is false",
    });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("reports only complete, usable transport configurations", () => {
    expect(isResendConfigured()).toBe(true);
    expect(isSmtpConfigured()).toBe(false);
    expect(hasAnyEmailTransportConfigured()).toBe(true);

    env.RESEND_API_KEY = undefined;
    expect(isResendConfigured()).toBe(false);
    expect(hasAnyEmailTransportConfigured()).toBe(false);

    env.SMTP_HOST = "smtp.example.test";
    env.SMTP_USER = "mailer";
    env.SMTP_PASS = "secret";
    env.SMTP_FROM = "smtp@example.test";
    expect(isSmtpConfigured()).toBe(true);
    expect(hasAnyEmailTransportConfigured()).toBe(true);
  });

  it("rejects an unsafe Resend idempotency key before the provider request", async () => {
    await expect(sendEmailWithFallback({ ...payload, idempotencyKey: "bad key" })).resolves.toEqual({
      status: "failed",
      error: "Email idempotency key is invalid",
    });
    await expect(sendEmailWithFallback({ ...payload, idempotencyKey: "x".repeat(257) })).resolves.toEqual({
      status: "failed",
      error: "Email idempotency key is invalid",
    });
    expect(resendSend).not.toHaveBeenCalled();
  });

  it("uses SMTP only outside production after a Resend failure", async () => {
    env.NODE_ENV = "development";
    env.SMTP_HOST = "smtp.example.test";
    env.SMTP_USER = "mailer";
    env.SMTP_PASS = "secret";
    env.SMTP_FROM = "smtp@example.test";
    env.SMTP_PORT = 465;
    env.SMTP_SECURE = true;
    resendSend.mockResolvedValue({ data: null, error: { message: "Resend unavailable" } });
    smtpSendMail.mockResolvedValue({ messageId: " smtp-message-1 " });

    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "sent",
      provider: "nodemailer",
      providerMessageId: "smtp-message-1",
    });
    expect(createTransport).toHaveBeenCalledWith({
      host: "smtp.example.test",
      port: 465,
      secure: true,
      auth: { user: "mailer", pass: "secret" },
    });
    expect(smtpSendMail).toHaveBeenCalledWith({
      from: "smtp@example.test",
      to: payload.to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
  });

  it("returns safe SMTP and no-transport failures outside production", async () => {
    env.NODE_ENV = "development";
    env.RESEND_API_KEY = undefined;
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "skipped",
      error: "No email transport configured",
    });

    env.SMTP_HOST = "smtp.example.test";
    env.SMTP_USER = "mailer";
    env.SMTP_PASS = "secret";
    env.SMTP_FROM = "smtp@example.test";
    smtpSendMail.mockResolvedValue({ messageId: "" });
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "failed",
      error: "SMTP accepted the request without a message ID",
    });

    smtpSendMail.mockRejectedValue("network failed");
    await expect(sendEmailWithFallback(payload)).resolves.toEqual({
      status: "failed",
      error: "Unknown email error",
    });
  });
});
