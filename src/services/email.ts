import { env } from "../config/env.js";

export type EmailProvider = "sendgrid" | "nodemailer";

export interface EmailPayload {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface EmailResult {
  status: "sent" | "skipped" | "failed";
  provider?: EmailProvider;
  error?: string;
}

const SENDGRID_ENDPOINT = "https://api.sendgrid.com/v3/mail/send";
const NODEMAILER_MODULE = "nodemailer";

function senderEmail(): string | undefined {
  return env.EMAIL_FROM ?? env.SMTP_FROM;
}

export function isSendGridConfigured(): boolean {
  return Boolean(env.SENDGRID_API_KEY && senderEmail());
}

export function isSmtpConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && senderEmail());
}

export function hasAnyEmailTransportConfigured(): boolean {
  return isSendGridConfigured() || isSmtpConfigured();
}

async function sendWithSendGrid(payload: EmailPayload): Promise<void> {
  const from = senderEmail();
  if (!env.SENDGRID_API_KEY || !from) throw new Error("SendGrid is not configured");

  const response = await fetch(SENDGRID_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: payload.to }] }],
      from: { email: from },
      subject: payload.subject,
      content: [
        { type: "text/plain", value: payload.text },
        { type: "text/html", value: payload.html },
      ],
    }),
  });

  if (!response.ok) {
    const body = (await response.text()).slice(0, 400);
    throw new Error(`SendGrid request failed (${response.status}): ${body}`);
  }
}

async function sendWithSmtp(payload: EmailPayload): Promise<void> {
  const from = senderEmail();
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

  await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });
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

  const failures: string[] = [];

  if (isSendGridConfigured()) {
    try {
      await sendWithSendGrid(payload);
      return {
        status: "sent",
        provider: "sendgrid",
      };
    } catch (error) {
      failures.push(readError(error));
    }
  }

  if (isSmtpConfigured()) {
    try {
      await sendWithSmtp(payload);
      return {
        status: "sent",
        provider: "nodemailer",
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
