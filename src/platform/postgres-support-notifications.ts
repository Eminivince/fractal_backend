import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import type { EmailPayload, EmailResult } from "../services/email.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";

type NotificationType =
  | "opened"
  | "staff_reply"
  | "waiting_requester"
  | "resolved"
  | "closed"
  | "reopened";
type Claimed = {
  id: string;
  caseId: string;
  caseReference: string;
  recipientIdentityId: string;
  recipientStatus: "active" | "disabled";
  email: string;
  notificationType: NotificationType;
  attempts: number;
};
export type SupportNotificationDelivery = {
  id: string;
  caseEventSequence: number;
  notificationType: NotificationType;
  channel: "email";
  status: "requested" | "failed" | "sent" | "terminal" | "cancelled";
  attempts: number;
  provider: string | null;
  requestedAt: string;
  sentAt: string | null;
  terminalAt: string | null;
};

export async function enqueueSupportNotification(
  client: PoolClient,
  input: {
    caseId: string;
    caseEventSequence: number;
    recipientIdentityId: string;
    notificationType: NotificationType;
  },
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO fractal.support_case_notification_deliveries (id,case_id,case_event_sequence,recipient_identity_id,notification_type) VALUES ($1,$2,$3,$4,$5)`,
    [
      id,
      input.caseId,
      input.caseEventSequence,
      input.recipientIdentityId,
      input.notificationType,
    ],
  );
  return id;
}

export async function readSupportNotificationDeliveries(
  client: PoolClient,
  caseId: string,
): Promise<SupportNotificationDelivery[]> {
  const result = await client.query<{
    id: string;
    case_event_sequence: number;
    notification_type: NotificationType;
    channel: "email";
    status: SupportNotificationDelivery["status"];
    attempts: number;
    provider: string | null;
    requested_at: Date;
    sent_at: Date | null;
    terminal_at: Date | null;
  }>(
    `SELECT id,case_event_sequence,notification_type,channel,status,attempts,provider,requested_at,sent_at,terminal_at FROM fractal.support_case_notification_deliveries WHERE case_id=$1 ORDER BY case_event_sequence,id`,
    [caseId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    caseEventSequence: row.case_event_sequence,
    notificationType: row.notification_type,
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    provider: row.provider,
    requestedAt: row.requested_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    terminalAt: row.terminal_at?.toISOString() ?? null,
  }));
}

async function claim(workerId: string): Promise<Claimed[]> {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      case_id: string;
      reference: string;
      recipient_identity_id: string;
      identity_status: "active" | "disabled";
      email: string;
      notification_type: NotificationType;
      attempts: number;
    }>(
      `WITH candidates AS (SELECT id FROM fractal.support_case_notification_deliveries WHERE status IN ('requested','failed') AND next_attempt_at<=now() AND (claimed_at IS NULL OR claimed_at<now()-($1*interval '1 second')) ORDER BY requested_at,id FOR UPDATE SKIP LOCKED LIMIT $2) UPDATE fractal.support_case_notification_deliveries delivery SET claimed_at=now(),claimed_by=$3,attempts=delivery.attempts+1,updated_at=now() FROM candidates,fractal.support_cases support_case,fractal.identities identity WHERE delivery.id=candidates.id AND support_case.id=delivery.case_id AND identity.id=delivery.recipient_identity_id RETURNING delivery.id,delivery.case_id,support_case.reference,delivery.recipient_identity_id,identity.status AS identity_status,identity.email,delivery.notification_type,delivery.attempts`,
      [
        env.AUTH_EMAIL_DELIVERY_CLAIM_TIMEOUT_SECONDS,
        env.AUTH_EMAIL_DELIVERY_BATCH_SIZE,
        workerId,
      ],
    );
    return result.rows.map((row) => ({
      id: row.id,
      caseId: row.case_id,
      caseReference: row.reference,
      recipientIdentityId: row.recipient_identity_id,
      recipientStatus: row.identity_status,
      email: row.email,
      notificationType: row.notification_type,
      attempts: row.attempts,
    }));
  });
}

function payload(item: Claimed): EmailPayload {
  const url = `${(env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "")}/help`;
  const label = item.notificationType.replaceAll("_", " ");
  return {
    to: item.email,
    subject: `Fractal support case ${item.caseReference} updated`,
    text: `Your Fractal support case ${item.caseReference} has an update (${label}). Sign in to view the retained case timeline: ${url}\n\nThis email intentionally contains no case description or message content.`,
    html: `<p>Your Fractal support case <strong>${item.caseReference}</strong> has an update (${label}).</p><p><a href="${url}">Sign in to view the retained case timeline</a>.</p><p>This email intentionally contains no case description or message content.</p>`,
    idempotencyKey: `fractal-support-${item.id}`,
  };
}

export async function dispatchPendingSupportNotifications(input: {
  workerId?: string;
  send: (payload: EmailPayload) => Promise<EmailResult>;
  logger: {
    info: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
  };
}) {
  const workerId = input.workerId ?? randomUUID();
  const items = await claim(workerId);
  for (const item of items) {
    try {
      if (item.recipientStatus !== "active") {
        await withPostgresTransaction(async (client) => {
          await client.query(
            `UPDATE fractal.support_case_notification_deliveries SET status='cancelled',cancelled_at=now(),claimed_at=NULL,claimed_by=NULL,last_error_code='recipient_inactive',updated_at=now() WHERE id=$1 AND claimed_by=$2`,
            [item.id, workerId],
          );
          await appendPostgresAuditEvent(client, {
            scopeKey: `support-case:${item.caseId}`,
            actorType: "worker",
            action: "support.notification.cancelled",
            entityType: "support_case_notification_delivery",
            entityId: item.id,
            payload: {
              notificationType: item.notificationType,
              reason: "recipient_inactive",
            },
          });
        });
        continue;
      }
      const result = await input.send(payload(item));
      if (result.status !== "sent")
        throw new Error(result.error ?? "transport rejected delivery");
      await withPostgresTransaction(async (client) => {
        const updated = await client.query(
          `UPDATE fractal.support_case_notification_deliveries
              SET status='sent',provider=$3,provider_message_id=$4,sent_at=now(),
                  claimed_at=NULL,claimed_by=NULL,last_error_code=NULL,updated_at=now()
            WHERE id=$1 AND claimed_by=$2 AND status IN ('requested','failed')`,
          [item.id, workerId, result.provider, result.providerMessageId],
        );
        if (updated.rowCount !== 1)
          throw new Error("Support notification claim was lost");
        await appendPostgresAuditEvent(client, {
          scopeKey: `support-case:${item.caseId}`,
          actorType: "worker",
          action: "support.notification.sent",
          entityType: "support_case_notification_delivery",
          entityId: item.id,
          payload: {
            notificationType: item.notificationType,
            attempts: item.attempts,
            provider: result.provider,
          },
        });
      });
      input.logger.info(
        { deliveryId: item.id, notificationType: item.notificationType },
        "Support notification delivered",
      );
    } catch (error) {
      const terminal = item.attempts >= env.AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS;
      const delay = Math.min(
        3600,
        env.AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS *
          2 ** Math.max(0, item.attempts - 1),
      );
      await withPostgresTransaction(async (client) => {
        await client.query(
          `UPDATE fractal.support_case_notification_deliveries SET status=CASE WHEN $3 THEN 'terminal' ELSE 'failed' END,terminal_at=CASE WHEN $3 THEN now() ELSE NULL END,next_attempt_at=CASE WHEN $3 THEN next_attempt_at ELSE $4 END,claimed_at=NULL,claimed_by=NULL,last_error_code=CASE WHEN $3 THEN 'delivery_terminal' ELSE 'delivery_retry_scheduled' END,updated_at=now() WHERE id=$1 AND claimed_by=$2 AND status IN ('requested','failed')`,
          [item.id, workerId, terminal, new Date(Date.now() + delay * 1000)],
        );
        await appendPostgresAuditEvent(client, {
          scopeKey: `support-case:${item.caseId}`,
          actorType: "worker",
          action: terminal
            ? "support.notification.terminal"
            : "support.notification.retry_scheduled",
          entityType: "support_case_notification_delivery",
          entityId: item.id,
          payload: {
            notificationType: item.notificationType,
            attempts: item.attempts,
          },
        });
      });
      input.logger.error(
        {
          err: error,
          deliveryId: item.id,
          notificationType: item.notificationType,
          terminal,
        },
        "Support notification delivery failed",
      );
    }
  }
  return items.length;
}

export function startSupportNotificationDispatcher(input: {
  send: (payload: EmailPayload) => Promise<EmailResult>;
  logger: {
    info: (obj: unknown, message?: string) => void;
    error: (obj: unknown, message?: string) => void;
  };
}) {
  let running = false,
    stopped = false;
  const workerId = randomUUID();
  const run = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchPendingSupportNotifications({ ...input, workerId });
    } catch (error) {
      input.logger.error(
        { err: error },
        "Support notification dispatcher failed",
      );
    } finally {
      running = false;
    }
  };
  const timer = setInterval(
    () => void run(),
    env.AUTH_EMAIL_DELIVERY_INTERVAL_MS,
  );
  timer.unref();
  void run();
  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
