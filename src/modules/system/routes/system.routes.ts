import type { FastifyInstance, FastifyRequest } from "fastify";
import mongoose from "mongoose";
import { env } from "../../../config/env.js";
import {
  hasAnyEmailTransportConfigured,
  isResendConfigured,
  isSmtpConfigured,
} from "../../../services/email.js";
import { authorize } from "../../../utils/rbac.js";

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
          name: "Resend",
          key: "resend",
          status: isResendConfigured() ? "Configured" : "Not Configured",
          detail: isResendConfigured()
            ? "Primary email credentials are configured; use delivery evidence for live health"
            : "RESEND_API_KEY or verified EMAIL_FROM missing",
        },
        {
          name: "SMTP",
          key: "smtp",
          status: isSmtpConfigured() ? "Configured" : "Not Configured",
          detail: isSmtpConfigured()
            ? "Local-development fallback is configured"
            : "Local-development SMTP fallback is not configured",
        },
        {
          name: "Email Pipeline",
          key: "email_pipeline",
          status: env.NOTIFICATION_EMAIL_ENABLED
            ? hasAnyEmailTransportConfigured()
              ? "Configured"
              : "Down"
            : "Disabled",
          detail: env.NOTIFICATION_EMAIL_ENABLED
            ? "Notification worker enabled"
            : "NOTIFICATION_EMAIL_ENABLED is false",
        },
        {
          name: "Anchoring Worker",
          key: "anchor_worker",
          status: env.ANCHOR_WORKER_ENABLED ? "Enabled" : "Disabled",
          detail: env.ANCHOR_WORKER_ENABLED
            ? "Anchor worker enabled"
            : "ANCHOR_WORKER_ENABLED is false",
        },
        {
          name: "Reconciliation Worker",
          key: "reconciliation_worker",
          status: env.RECONCILIATION_WORKER_ENABLED ? "Enabled" : "Disabled",
          detail: env.RECONCILIATION_WORKER_ENABLED
            ? "Reconciliation worker enabled"
            : "RECONCILIATION_WORKER_ENABLED is false",
        },
      ];
    },
  );
}
