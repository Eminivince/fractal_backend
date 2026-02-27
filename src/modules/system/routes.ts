import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { env } from "../../config/env.js";
import {
  hasAnyEmailTransportConfigured,
  isSendGridConfigured,
  isSmtpConfigured,
} from "../../services/email.js";
import { authorize } from "../../utils/rbac.js";

export async function systemRoutes(app: FastifyInstance) {
  app.get(
    "/v1/system/integrations",
    { preHandler: [app.authenticate] },
    async (request: FastifyRequest) => {
      authorize(request.authUser, "read", "platform");

      const mongoConnected = mongoose.connection.readyState === 1;

      return [
        {
          name: "MongoDB",
          key: "mongodb",
          status: mongoConnected ? "Connected" : "Down",
          detail: mongoConnected ? "Primary database online" : "Database not connected",
        },
        {
          name: "SendGrid",
          key: "sendgrid",
          status: isSendGridConfigured() ? "Connected" : "Not Configured",
          detail: isSendGridConfigured()
            ? "Primary email provider configured"
            : "SENDGRID_API_KEY or sender email missing",
        },
        {
          name: "SMTP",
          key: "smtp",
          status: isSmtpConfigured() ? "Connected" : "Not Configured",
          detail: isSmtpConfigured()
            ? "Fallback email transport configured"
            : "SMTP fallback credentials missing",
        },
        {
          name: "Email Pipeline",
          key: "email_pipeline",
          status: env.NOTIFICATION_EMAIL_ENABLED
            ? hasAnyEmailTransportConfigured()
              ? "Connected"
              : "Down"
            : "Disabled",
          detail: env.NOTIFICATION_EMAIL_ENABLED
            ? "Notification worker enabled"
            : "NOTIFICATION_EMAIL_ENABLED is false",
        },
        {
          name: "Anchoring Worker",
          key: "anchor_worker",
          status: env.ANCHOR_WORKER_ENABLED ? "Connected" : "Disabled",
          detail: env.ANCHOR_WORKER_ENABLED
            ? "Anchor worker enabled"
            : "ANCHOR_WORKER_ENABLED is false",
        },
        {
          name: "Reconciliation Worker",
          key: "reconciliation_worker",
          status: env.RECONCILIATION_WORKER_ENABLED ? "Connected" : "Disabled",
          detail: env.RECONCILIATION_WORKER_ENABLED
            ? "Reconciliation worker enabled"
            : "RECONCILIATION_WORKER_ENABLED is false",
        },
      ];
    },
  );
}
