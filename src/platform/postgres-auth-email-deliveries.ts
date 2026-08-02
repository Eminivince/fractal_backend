import { createHash, createHmac, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import type { EmailPayload, EmailResult } from "../services/email.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";

export const authEmailDeliveryTypes = ["email_verification", "password_reset", "administrator_activation"] as const;
export type AuthEmailDeliveryType = (typeof authEmailDeliveryTypes)[number];
const userRequestedAuthEmailDeliveryTypes = ["email_verification", "password_reset"] as const;
type UserRequestedAuthEmailDeliveryType = (typeof userRequestedAuthEmailDeliveryTypes)[number];

type DeliveryStatus = "requested" | "failed" | "sent" | "terminal";

export interface ClaimedAuthEmailDelivery {
  id: string;
  identityId: string;
  deliveryType: AuthEmailDeliveryType;
  attempts: number;
  requestedAt: Date;
}

/**
 * Aggregate-only operational state. This intentionally contains neither
 * recipient addresses nor bearer material, so it is safe to attach to worker
 * logs and monitoring signals.
 */
export interface AuthEmailDeliveryHealth {
  pendingCount: number;
  terminalCount: number;
  oldestPendingAgeSeconds: number | null;
}

export interface AuthEmailDeliveryLogger {
  info: (obj: unknown, message?: string) => void;
  error: (obj: unknown, message?: string) => void;
}

export class AuthEmailDeliveryError extends Error {}

const RESEND_COOLDOWN_MS = 60_000;
const EMAIL_VERIFICATION_OTP_TTL_MS = 10 * 60 * 1_000;
const PASSWORD_RESET_TTL_MS = 60 * 60 * 1_000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function deliveryTtlMs(deliveryType: AuthEmailDeliveryType): number {
  return deliveryType === "email_verification"
    ? EMAIL_VERIFICATION_OTP_TTL_MS
    : PASSWORD_RESET_TTL_MS;
}

function stableDeliverySecret(
  delivery: Pick<ClaimedAuthEmailDelivery, "id" | "deliveryType">,
): string {
  const digest = createHmac(
    "sha256",
    env.EMAIL_DELIVERY_SECRET_KEY ?? env.JWT_SECRET,
  )
    .update("fractal-auth-email-delivery-v1")
    .update("\0")
    .update(delivery.id)
    .update("\0")
    .update(delivery.deliveryType)
    .digest();
  if (delivery.deliveryType === "email_verification") {
    return (digest.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
  }
  return digest.toString("hex");
}

function appUrl(path: string): string {
  const base = (env.APP_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
  return `${base}${path}`;
}

function isAuthEmailDeliveryType(value: string): value is AuthEmailDeliveryType {
  return (authEmailDeliveryTypes as readonly string[]).includes(value);
}

async function appendRequestedAudit(client: PoolClient, input: {
  deliveryId: string;
  identityId: string;
  deliveryType: AuthEmailDeliveryType;
  reused: boolean;
}): Promise<void> {
  await appendPostgresAuditEvent(client, {
    scopeKey: `identity:${input.identityId}`,
    actorId: input.identityId,
    actorType: "user",
    action: input.reused ? "identity.auth_email_delivery.requeued" : "identity.auth_email_delivery.requested",
    entityType: "auth_email_delivery",
    entityId: input.deliveryId,
    payload: { deliveryType: input.deliveryType },
  });
}

/**
 * This helper is called while native account creation is still in its database
 * transaction. It guarantees that an account is never committed without an
 * initial verification-delivery command.
 */
export async function enqueueInitialEmailVerificationDelivery(
  client: PoolClient,
  identityId: string,
): Promise<string> {
  const deliveryId = randomUUID();
  await client.query(
    `INSERT INTO fractal.auth_email_deliveries (id, identity_id, delivery_type, status)
     VALUES ($1, $2, 'email_verification', 'requested')`,
    [deliveryId, identityId],
  );
  await appendRequestedAudit(client, {
    deliveryId,
    identityId,
    deliveryType: "email_verification",
    reused: false,
  });
  return deliveryId;
}

/**
 * Administrator activation is produced only by the sealed bootstrap or the
 * two-person recovery ceremony. It deliberately has no public request helper:
 * knowing an administrator's address must never be enough to enqueue it.
 */
export async function enqueueAdministratorActivationDelivery(
  client: PoolClient,
  identityId: string,
): Promise<string> {
  const deliveryId = randomUUID();
  await client.query(
    `INSERT INTO fractal.auth_email_deliveries (id, identity_id, delivery_type, status)
     VALUES ($1, $2, 'administrator_activation', 'requested')`,
    [deliveryId, identityId],
  );
  await appendPostgresAuditEvent(client, {
    scopeKey: `identity:${identityId}`,
    actorType: "operator",
    action: "identity.administrator_activation.requested",
    entityType: "auth_email_delivery",
    entityId: deliveryId,
    payload: { deliveryType: "administrator_activation" },
  });
  return deliveryId;
}

/**
 * Requests a durable delivery without exposing whether an account exists. A
 * recent or in-flight request is reused so UI retries cannot create a mail
 * flood or repeatedly invalidate a previous verification code.
 */
export async function requestAuthEmailDelivery(input: {
  identityId: string;
  deliveryType: UserRequestedAuthEmailDeliveryType;
}): Promise<{ deliveryId: string | null; queued: boolean }> {
  const identityId = input.identityId.trim();
  if (!identityId || !(userRequestedAuthEmailDeliveryTypes as readonly string[]).includes(input.deliveryType)) {
    throw new AuthEmailDeliveryError("A valid identity and auth-email delivery type are required");
  }

  return withPostgresTransaction(async (client) => {
    const identity = await client.query<{
      id: string;
      status: "active" | "disabled";
      email_verified_at: Date | null;
    }>(
      `SELECT id, status, email_verified_at
         FROM fractal.identities
        WHERE id = $1
        FOR UPDATE`,
      [identityId],
    );
    const row = identity.rows[0];
    if (!row || row.status !== "active") return { deliveryId: null, queued: false };
    if (input.deliveryType === "email_verification" && row.email_verified_at) {
      return { deliveryId: null, queued: false };
    }

    const latest = await client.query<{
      id: string;
      status: DeliveryStatus;
      requested_at: Date;
    }>(
      `SELECT id, status, requested_at
         FROM fractal.auth_email_deliveries
        WHERE identity_id = $1 AND delivery_type = $2
        ORDER BY requested_at DESC, id DESC
        LIMIT 1
        FOR UPDATE`,
      [identityId, input.deliveryType],
    );
    const existing = latest.rows[0];
    if (existing && existing.requested_at.getTime() > Date.now() - RESEND_COOLDOWN_MS) {
      return { deliveryId: existing.id, queued: existing.status !== "sent" && existing.status !== "terminal" };
    }

    if (existing && (existing.status === "requested" || existing.status === "failed")) {
      await client.query(
        `UPDATE fractal.auth_email_deliveries
            SET status = 'requested', claimed_at = NULL, claimed_by = NULL,
                next_attempt_at = now(), last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [existing.id],
      );
      await appendRequestedAudit(client, {
        deliveryId: existing.id,
        identityId,
        deliveryType: input.deliveryType,
        reused: true,
      });
      return { deliveryId: existing.id, queued: true };
    }

    const deliveryId = randomUUID();
    await client.query(
      `INSERT INTO fractal.auth_email_deliveries (id, identity_id, delivery_type, status)
       VALUES ($1, $2, $3, 'requested')`,
      [deliveryId, identityId, input.deliveryType],
    );
    await appendRequestedAudit(client, {
      deliveryId,
      identityId,
      deliveryType: input.deliveryType,
      reused: false,
    });
    return { deliveryId, queued: true };
  });
}

/**
 * Returns the current actionable queue state. A terminal row stops being
 * actionable as soon as a later resend/reset command exists for the same
 * identity and delivery type, so historical failures do not create a
 * permanent alert.
 */
export async function getAuthEmailDeliveryHealth(input: {
  identityId?: string;
} = {}): Promise<AuthEmailDeliveryHealth> {
  const identityId = input.identityId?.trim();
  const result = await requirePostgres().query<{
    pending_count: number;
    terminal_count: number;
    oldest_pending_age_seconds: number | null;
  }>(
    `WITH latest AS (
       SELECT DISTINCT ON (identity_id, delivery_type)
              status, requested_at
         FROM fractal.auth_email_deliveries
         ${identityId ? "WHERE identity_id = $1" : ""}
        ORDER BY identity_id, delivery_type, requested_at DESC, id DESC
     )
     SELECT
       COUNT(*) FILTER (WHERE status IN ('requested', 'failed'))::integer AS pending_count,
       COUNT(*) FILTER (WHERE status = 'terminal')::integer AS terminal_count,
       FLOOR(EXTRACT(EPOCH FROM now() - MIN(requested_at) FILTER (WHERE status IN ('requested', 'failed'))))::integer
         AS oldest_pending_age_seconds
       FROM latest`,
    identityId ? [identityId] : [],
  );
  const row = result.rows[0];
  return {
    pendingCount: row?.pending_count ?? 0,
    terminalCount: row?.terminal_count ?? 0,
    oldestPendingAgeSeconds: row?.oldest_pending_age_seconds ?? null,
  };
}

export async function claimAuthEmailDeliveries(input: {
  workerId: string;
  limit: number;
  claimTimeoutSeconds: number;
}): Promise<ClaimedAuthEmailDelivery[]> {
  if (input.limit <= 0) return [];
  return withPostgresTransaction(async (client) => {
    const result = await client.query<{
      id: string;
      identity_id: string;
      delivery_type: string;
      attempts: number;
      requested_at: Date;
    }>(
      `WITH candidates AS (
         SELECT id
           FROM fractal.auth_email_deliveries
          WHERE status IN ('requested', 'failed')
            AND next_attempt_at <= now()
            AND (claimed_at IS NULL OR claimed_at < now() - ($1 * interval '1 second'))
          ORDER BY requested_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE fractal.auth_email_deliveries delivery
          SET claimed_at = now(), claimed_by = $3, attempts = delivery.attempts + 1,
              updated_at = now()
         FROM candidates
        WHERE delivery.id = candidates.id
       RETURNING delivery.id, delivery.identity_id, delivery.delivery_type,
                 delivery.attempts, delivery.requested_at`,
      [input.claimTimeoutSeconds, input.limit, input.workerId],
    );
    return result.rows.map((row) => {
      if (!isAuthEmailDeliveryType(row.delivery_type)) {
        throw new AuthEmailDeliveryError("Stored auth-email delivery type is invalid");
      }
      return {
        id: row.id,
        identityId: row.identity_id,
        deliveryType: row.delivery_type,
        attempts: row.attempts,
        requestedAt: row.requested_at,
      };
    });
  });
}

async function loadClaimedDelivery(input: {
  deliveryId: string;
  workerId: string;
}): Promise<{ email: string; status: "active" | "disabled"; emailVerified: boolean }> {
  const result = await requirePostgres().query<{
    email: string;
    status: "active" | "disabled";
    email_verified_at: Date | null;
  }>(
    `SELECT identity.email, identity.status, identity.email_verified_at
       FROM fractal.auth_email_deliveries delivery
       JOIN fractal.identities identity ON identity.id = delivery.identity_id
      WHERE delivery.id = $1
        AND delivery.claimed_by = $2
        AND delivery.status IN ('requested', 'failed')`,
    [input.deliveryId, input.workerId],
  );
  const delivery = result.rows[0];
  if (!delivery) throw new AuthEmailDeliveryError("Auth-email delivery is no longer claimed by this worker");
  return {
    email: delivery.email,
    status: delivery.status,
    emailVerified: Boolean(delivery.email_verified_at),
  };
}

async function markAuthEmailDeliverySent(input: {
  delivery: ClaimedAuthEmailDelivery;
  workerId: string;
  result: Extract<EmailResult, { status: "sent" }>;
}): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{ identity_id: string }>(
      `UPDATE fractal.auth_email_deliveries
          SET status = 'sent', sent_at = now(), claimed_at = NULL, claimed_by = NULL,
              last_error = NULL, provider = $3, provider_message_id = $4,
              updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status IN ('requested', 'failed')
        RETURNING identity_id`,
      [
        input.delivery.id,
        input.workerId,
        input.result.provider,
        input.result.providerMessageId,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new AuthEmailDeliveryError("Auth-email delivery cannot be marked sent");
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${row.identity_id}`,
      actorType: "worker",
      action: "identity.auth_email_delivery.sent",
      entityType: "auth_email_delivery",
      entityId: input.delivery.id,
      payload: {
        deliveryType: input.delivery.deliveryType,
        attempts: input.delivery.attempts,
        provider: input.result.provider,
      },
    });
  });
}

async function markAuthEmailDeliveryForRetry(input: {
  delivery: ClaimedAuthEmailDelivery;
  workerId: string;
  retryAt: Date;
  terminal: boolean;
}): Promise<void> {
  await withPostgresTransaction(async (client) => {
    const result = await client.query<{ identity_id: string }>(
      `UPDATE fractal.auth_email_deliveries
          SET status = CASE WHEN $4 THEN 'terminal' ELSE 'failed' END,
              claimed_at = NULL, claimed_by = NULL,
              next_attempt_at = CASE WHEN $4 THEN next_attempt_at ELSE $3 END,
              terminal_at = CASE WHEN $4 THEN now() ELSE NULL END,
              last_error = CASE WHEN $4 THEN 'delivery could not be completed' ELSE 'delivery retry scheduled' END,
              updated_at = now()
        WHERE id = $1 AND claimed_by = $2 AND status IN ('requested', 'failed')
        RETURNING identity_id`,
      [input.delivery.id, input.workerId, input.retryAt, input.terminal],
    );
    const row = result.rows[0];
    if (!row) throw new AuthEmailDeliveryError("Auth-email delivery is no longer claimed by this worker");
    await appendPostgresAuditEvent(client, {
      scopeKey: `identity:${row.identity_id}`,
      actorType: "worker",
      action: input.terminal ? "identity.auth_email_delivery.terminal" : "identity.auth_email_delivery.retry_scheduled",
      entityType: "auth_email_delivery",
      entityId: input.delivery.id,
      payload: { deliveryType: input.delivery.deliveryType, attempts: input.delivery.attempts },
    });
  });
}

async function cancelClaimedAuthEmailDelivery(input: {
  delivery: ClaimedAuthEmailDelivery;
  workerId: string;
}): Promise<void> {
  await markAuthEmailDeliveryForRetry({
    delivery: input.delivery,
    workerId: input.workerId,
    retryAt: new Date(),
    terminal: true,
  });
}

async function recordEmailVerificationToken(input: {
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<boolean> {
  const result = await requirePostgres().query(
    `UPDATE fractal.identities
        SET email_verification_token_hash = $2,
            email_verification_expires_at = $3,
            updated_at = now()
      WHERE id = $1 AND status = 'active' AND email_verified_at IS NULL`,
    [input.identityId, input.tokenHash, input.expiresAt],
  );
  return result.rowCount === 1;
}

async function recordPasswordResetToken(input: {
  identityId: string;
  tokenHash: string;
  expiresAt: Date;
  purpose: "password_reset" | "administrator_activation";
}): Promise<boolean> {
  const result = await requirePostgres().query(
    `UPDATE fractal.identities
        SET password_reset_token_hash = $2,
            password_reset_expires_at = $3,
            password_reset_purpose = $4,
            updated_at = now()
      WHERE id = $1 AND status = 'active'`,
    [input.identityId, input.tokenHash, input.expiresAt, input.purpose],
  );
  return result.rowCount === 1;
}

function emailPayload(input: {
  deliveryId: string;
  deliveryType: AuthEmailDeliveryType;
  email: string;
  secret: string;
  expiresAt: Date;
}): EmailPayload {
  const expiry = input.expiresAt.toISOString();
  const idempotencyKey = `fractal-auth-${input.deliveryId}`;
  if (input.deliveryType === "email_verification") {
    return {
      to: input.email,
      subject: "Your Fractal verification code",
      text: `Your Fractal verification code is ${input.secret}. It expires at ${expiry}. Do not share this code.`,
      html: `<p>Your Fractal verification code is:</p><p style="font-size:24px;font-weight:700;letter-spacing:0.18em"><strong>${input.secret}</strong></p><p>It expires at ${expiry}. Do not share this code.</p>`,
      idempotencyKey,
    };
  }
  const administratorActivation = input.deliveryType === "administrator_activation";
  const link = appUrl(`/account/reset?token=${input.secret}${administratorActivation ? "&activation=administrator" : ""}`);
  if (administratorActivation) {
    return {
      to: input.email,
      subject: "Activate your Fractal administrator account",
      text: `Activate your administrator account and create its password using this one-time link before ${expiry}: ${link}\n\nAfter activation, sign in and enroll an authenticator before performing privileged actions. If you were not expecting this message, do not use the link and contact the approved security channel.`,
      html: `<p>Activate your Fractal administrator account and create its password using this one-time link before ${expiry}:</p><p><a href="${link}">${link}</a></p><p>After activation, sign in and enroll an authenticator before performing privileged actions.</p><p>If you were not expecting this message, do not use the link and contact the approved security channel.</p>`,
      idempotencyKey,
    };
  }
  return {
    to: input.email,
    subject: "Reset your Fractal password",
    text: `Reset your password using this link before ${expiry}: ${link}\n\nIf you did not request this, ignore this email.`,
    html: `<p>Reset your password using this link before ${expiry}:</p><p><a href="${link}">${link}</a></p><p>If you did not request this, you can safely ignore it.</p>`,
    idempotencyKey,
  };
}

export async function dispatchPendingAuthEmailDeliveries(input: {
  workerId?: string;
  send: (payload: EmailPayload) => Promise<EmailResult>;
  logger: AuthEmailDeliveryLogger;
}): Promise<number> {
  const workerId = input.workerId ?? randomUUID();
  const deliveries = await claimAuthEmailDeliveries({
    workerId,
    limit: env.AUTH_EMAIL_DELIVERY_BATCH_SIZE,
    claimTimeoutSeconds: env.AUTH_EMAIL_DELIVERY_CLAIM_TIMEOUT_SECONDS,
  });

  for (const delivery of deliveries) {
    try {
      const identity = await loadClaimedDelivery({ deliveryId: delivery.id, workerId });
      if (
        identity.status !== "active"
        || (delivery.deliveryType === "email_verification" && identity.emailVerified)
      ) {
        await cancelClaimedAuthEmailDelivery({ delivery, workerId });
        continue;
      }

      const expiresAt = new Date(
        delivery.requestedAt.getTime() + deliveryTtlMs(delivery.deliveryType),
      );
      if (expiresAt.getTime() <= Date.now()) {
        await cancelClaimedAuthEmailDelivery({ delivery, workerId });
        continue;
      }
      const secret = stableDeliverySecret(delivery);
      const tokenRecorded = delivery.deliveryType === "email_verification"
        ? await recordEmailVerificationToken({
            identityId: delivery.identityId,
            tokenHash: hashToken(secret),
            expiresAt,
          })
        : await recordPasswordResetToken({
            identityId: delivery.identityId,
            tokenHash: hashToken(secret),
            expiresAt,
            purpose: delivery.deliveryType === "administrator_activation" ? "administrator_activation" : "password_reset",
          });
      if (!tokenRecorded) {
        await cancelClaimedAuthEmailDelivery({ delivery, workerId });
        continue;
      }

      const result = await input.send(emailPayload({
        deliveryId: delivery.id,
        deliveryType: delivery.deliveryType,
        email: identity.email,
        secret,
        expiresAt,
      }));
      if (result.status !== "sent") {
        throw new AuthEmailDeliveryError(result.error ?? "Authentication email transport did not accept delivery");
      }
      await markAuthEmailDeliverySent({ delivery, workerId, result });
      input.logger.info({ deliveryId: delivery.id, deliveryType: delivery.deliveryType }, "Authentication email delivered");
    } catch (error) {
      const terminal = delivery.attempts >= env.AUTH_EMAIL_DELIVERY_MAX_ATTEMPTS;
      const delaySeconds = Math.min(
        60 * 60,
        env.AUTH_EMAIL_DELIVERY_RETRY_BASE_SECONDS * 2 ** Math.max(0, delivery.attempts - 1),
      );
      await markAuthEmailDeliveryForRetry({
        delivery,
        workerId,
        retryAt: new Date(Date.now() + delaySeconds * 1_000),
        terminal,
      });
      input.logger.error(
        { err: error, deliveryId: delivery.id, deliveryType: delivery.deliveryType, terminal, delaySeconds },
        "Authentication email delivery failed",
      );
    }
  }
  return deliveries.length;
}

export function startAuthEmailDeliveryDispatcher(input: {
  send: (payload: EmailPayload) => Promise<EmailResult>;
  logger: AuthEmailDeliveryLogger;
}): { stop: () => void } {
  let running = false;
  let stopped = false;
  let lastHealthSignalAt = 0;
  const workerId = randomUUID();
  const dispatch = async () => {
    if (running || stopped) return;
    running = true;
    try {
      await dispatchPendingAuthEmailDeliveries({ ...input, workerId });
      const now = Date.now();
      if (now - lastHealthSignalAt >= env.AUTH_EMAIL_DELIVERY_HEALTH_LOG_INTERVAL_MS) {
        lastHealthSignalAt = now;
        const health = await getAuthEmailDeliveryHealth();
        const pendingTooOld = (health.oldestPendingAgeSeconds ?? 0) >= env.AUTH_EMAIL_DELIVERY_MAX_PENDING_AGE_SECONDS;
        if (health.terminalCount > 0 || pendingTooOld) {
          input.logger.error(
            { ...health, maxPendingAgeSeconds: env.AUTH_EMAIL_DELIVERY_MAX_PENDING_AGE_SECONDS },
            "Authentication email delivery requires operational attention",
          );
        }
      }
    } catch (error) {
      input.logger.error({ err: error }, "Authentication email dispatcher failed");
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void dispatch(), env.AUTH_EMAIL_DELIVERY_INTERVAL_MS);
  timer.unref();
  void dispatch();
  return { stop: () => { stopped = true; clearInterval(timer); } };
}
