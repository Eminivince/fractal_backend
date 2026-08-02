import { env } from "../config/env.js";
import { Resend } from "resend";

export type EmailProvider = "resend" | "nodemailer";

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
  idempotencyKey?: string;
}

export type EmailResult =
  | {
      status: "sent";
      provider: EmailProvider;
      providerMessageId: string;
    }
  | {
      status: "skipped" | "failed";
      error: string;
    };

const NODEMAILER_MODULE = "nodemailer";

function resendSenderEmail(): string | undefined {
  return env.EMAIL_FROM;
}

function smtpSenderEmail(): string | undefined {
  return env.SMTP_FROM ?? env.EMAIL_FROM;
}

export function isResendConfigured(): boolean {
  return Boolean(env.RESEND_API_KEY && resendSenderEmail());
}

export function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && smtpSenderEmail());
}

export function hasAnyEmailTransportConfigured(): boolean {
  return isResendConfigured() || isSmtpConfigured();
}

function validatedIdempotencyKey(payload: EmailPayload): string | undefined {
  const key = payload.idempotencyKey?.trim();
  if (!key) return undefined;
  if (key.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new Error("Email idempotency key is invalid");
  }
  return key;
}

async function sendWithResend(payload: EmailPayload): Promise<string> {
  const from = resendSenderEmail();
  if (!env.RESEND_API_KEY || !from) throw new Error("Resend is not configured");
  const idempotencyKey = validatedIdempotencyKey(payload);

  const result = await new Resend(env.RESEND_API_KEY).emails.send({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  }, idempotencyKey ? { idempotencyKey } : undefined);

  if (result.error) {
    throw new Error(`Resend request failed: ${result.error.message}`);
  }
  const providerMessageId = result.data?.id?.trim();
  if (!providerMessageId) {
    throw new Error("Resend accepted the request without a message ID");
  }
  return providerMessageId;
}

async function sendWithSmtp(payload: EmailPayload): Promise<string> {
  const from = smtpSenderEmail();
  if (!from || !env.SMTP_HOST || !env.SMTP_USER || !env.SMTP_PASS) {
    throw new Error("SMTP transport is not configured");
  }

  const nodemailerModule = (await import(NODEMAILER_MODULE).catch(() => null)) as
    | {
        default?: { createTransport: (options: Record<string, unknown>) => any };
        createTransport?: (options: Record<string, unknown>) => any;
      }
    | null;

  if (!nodemailerModule) {
    throw new Error("nodemailer package is not installed");
  }

  const createTransport =
    nodemailerModule.default?.createTransport ?? nodemailerModule.createTransport;
  if (!createTransport) {
    throw new Error("nodemailer createTransport is unavailable");
  }

  const transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    auth: {
      user: env.SMTP_USER,
      pass: env.SMTP_PASS,
    },
  });

  const result = await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });
  const providerMessageId = typeof result?.messageId === "string"
    ? result.messageId.trim()
    : "";
  if (!providerMessageId) {
    throw new Error("SMTP accepted the request without a message ID");
  }
  return providerMessageId;
}

function readError(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 700);
  return "Unknown email error";
}

export async function sendEmailWithFallback(payload: EmailPayload): Promise<EmailResult> {
  if (!env.NOTIFICATION_EMAIL_ENABLED) {
    return {
      status: "skipped",
      error: "NOTIFICATION_EMAIL_ENABLED is false",
    };
  }

  if (env.NODE_ENV === "production" && !payload.idempotencyKey) {
    return {
      status: "failed",
      error: "Production email requires a stable idempotency key",
    };
  }

  const failures: string[] = [];

  if (isResendConfigured()) {
    try {
      const providerMessageId = await sendWithResend(payload);
      return {
        status: "sent",
        provider: "resend",
        providerMessageId,
      };
    } catch (error) {
      failures.push(readError(error));
      if (env.NODE_ENV === "production") {
        return {
          status: "failed",
          error: failures.join(" | ").slice(0, 900),
        };
      }
    }
  }

  if (env.NODE_ENV !== "production" && isSmtpConfigured()) {
    try {
      const providerMessageId = await sendWithSmtp(payload);
      return {
        status: "sent",
        provider: "nodemailer",
        providerMessageId,
      };
    } catch (error) {
      failures.push(readError(error));
    }
  }

  if (failures.length > 0) {
    return {
      status: "failed",
      error: failures.join(" | ").slice(0, 900),
    };
  }

  return {
    status: "skipped",
    error: "No email transport configured",
  };
}
