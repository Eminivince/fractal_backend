import type mongoose from "mongoose";
import { env } from "../config/env.js";
import { emitUserEvent } from "./event-bus.js";
import {
  ApplicationModel,
  DistributionModel,
  MilestoneModel,
  NotificationModel,
  OfferingModel,
  ProfessionalWorkOrderModel,
  SubscriptionModel,
  TaskModel,
  TrancheModel,
  UserModel,
} from "../db/models.js";
import type { AuthUser } from "../types.js";
import type { EntityType } from "../utils/constants.js";
import { hasAnyEmailTransportConfigured, sendEmailWithFallback } from "./email.js";

interface EventInput {
  entityType: EntityType;
  entityId: string;
  action: string;
  notes?: string;
  diff?: unknown;
}

interface Recipient {
  userId: string;
  email?: string;
  name?: string;
}

export interface NotificationEmailBatchResult {
  attempted: number;
  sent: number;
  failed: number;
}

const ADMIN_OPERATOR_ROLES = ["admin", "operator"] as const;

function toId(value: unknown): string | undefined {
  if (!value) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  if (typeof value === "object" && "toString" in value && typeof value.toString === "function") {
    const resolved = value.toString();
    if (resolved && resolved !== "[object Object]") return resolved;
  }
  return undefined;
}

function toEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length > 0 ? email : undefined;
}

function toName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim();
  return name.length > 0 ? name : undefined;
}

function humanizeAction(action: string): string {
  const spaced = action
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!spaced) return "Workflow update";
  return `${spaced[0]?.toUpperCase() ?? ""}${spaced.slice(1)}`;
}

function buildTitle(input: EventInput): string {
  return humanizeAction(input.action);
}

function buildMessage(input: EventInput): string {
  const notes = input.notes?.trim();
  if (notes) return notes.slice(0, 500);
  return `${humanizeAction(input.action)} for ${input.entityType} ${input.entityId}`.slice(0, 500);
}

async function findActiveUsers(filter: Record<string, unknown>, session?: mongoose.ClientSession): Promise<Recipient[]> {
  const query = UserModel.find({
    ...filter,
    status: "active",
  })
    .select("_id email name")
    .lean();
  if (session) query.session(session);

  const rows = (await query) as Array<Record<string, unknown>>;
  const users: Recipient[] = [];
  for (const row of rows) {
    const userId = toId(row._id);
    if (!userId) continue;
    users.push({
      userId,
      email: toEmail(row.email),
      name: toName(row.name),
    });
  }
  return users;
}

function addRecipients(target: Map<string, Recipient>, recipients: Recipient[]) {
  for (const recipient of recipients) {
    if (!recipient.userId) continue;
    if (!target.has(recipient.userId)) target.set(recipient.userId, recipient);
  }
}

async function addUsersByRoles(
  target: Map<string, Recipient>,
  roles: readonly string[],
  session?: mongoose.ClientSession,
) {
  const users = await findActiveUsers({ role: { $in: [...roles] } }, session);
  addRecipients(target, users);
}

async function addUsersByIds(target: Map<string, Recipient>, userIds: string[], session?: mongoose.ClientSession) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  const users = await findActiveUsers({ _id: { $in: uniqueIds } }, session);
  addRecipients(target, users);
}

async function addIssuerUsersByBusinessId(
  target: Map<string, Recipient>,
  businessId?: string,
  session?: mongoose.ClientSession,
) {
  if (!businessId) return;
  const users = await findActiveUsers({ role: "issuer", businessId }, session);
  addRecipients(target, users);
}

async function addInvestorsForOffering(
  target: Map<string, Recipient>,
  offeringId?: string,
  session?: mongoose.ClientSession,
) {
  if (!offeringId) return;
  const query = SubscriptionModel.find({ offeringId }).select("investorUserId").lean();
  if (session) query.session(session);
  const rows = (await query) as Array<Record<string, unknown>>;
  const investorIds = rows.map((row) => toId(row.investorUserId)).filter((id): id is string => Boolean(id));
  await addUsersByIds(target, investorIds, session);
}

async function readBusinessIdFromApplicationId(
  applicationId?: string,
  session?: mongoose.ClientSession,
): Promise<string | undefined> {
  if (!applicationId) return undefined;
  const query = ApplicationModel.findById(applicationId).select("businessId").lean();
  if (session) query.session(session);
  const app = (await query) as Record<string, unknown> | null;
  return toId(app?.businessId);
}

async function readBusinessIdFromOfferingId(
  offeringId?: string,
  session?: mongoose.ClientSession,
): Promise<string | undefined> {
  if (!offeringId) return undefined;
  const query = OfferingModel.findById(offeringId).select("businessId").lean();
  if (session) query.session(session);
  const offering = (await query) as Record<string, unknown> | null;
  return toId(offering?.businessId);
}

async function readOfferingIdFromEntity(
  entityType: EventInput["entityType"],
  entityId: string,
  session?: mongoose.ClientSession,
): Promise<string | undefined> {
  if (entityType === "offering") return entityId;

  if (entityType === "distribution") {
    const query = DistributionModel.findById(entityId).select("offeringId").lean();
    if (session) query.session(session);
    const row = (await query) as Record<string, unknown> | null;
    return toId(row?.offeringId);
  }

  if (entityType === "milestone") {
    const query = MilestoneModel.findById(entityId).select("offeringId").lean();
    if (session) query.session(session);
    const row = (await query) as Record<string, unknown> | null;
    return toId(row?.offeringId);
  }

  if (entityType === "tranche") {
    const query = TrancheModel.findById(entityId).select("offeringId").lean();
    if (session) query.session(session);
    const row = (await query) as Record<string, unknown> | null;
    return toId(row?.offeringId);
  }

  return undefined;
}

async function readWorkOrderRecipientContext(
  workOrderId: string,
  session?: mongoose.ClientSession,
): Promise<{
  businessId?: string;
  assigneeUserId?: string;
  createdBy?: string;
}> {
  const query = ProfessionalWorkOrderModel.findById(workOrderId)
    .select("businessId assigneeUserId createdBy")
    .lean();
  if (session) query.session(session);
  const row = (await query) as Record<string, unknown> | null;
  return {
    businessId: toId(row?.businessId),
    assigneeUserId: toId(row?.assigneeUserId),
    createdBy: toId(row?.createdBy),
  };
}

async function resolveRecipients(
  actor: AuthUser,
  input: EventInput,
  session?: mongoose.ClientSession,
): Promise<Recipient[]> {
  const recipients = new Map<string, Recipient>();

  await addUsersByRoles(recipients, ADMIN_OPERATOR_ROLES, session);

  if (input.entityType === "application") {
    const businessId = await readBusinessIdFromApplicationId(input.entityId, session);
    await addIssuerUsersByBusinessId(recipients, businessId, session);
  } else if (input.entityType === "offering") {
    const businessId = await readBusinessIdFromOfferingId(input.entityId, session);
    await addIssuerUsersByBusinessId(recipients, businessId, session);
    await addInvestorsForOffering(recipients, input.entityId, session);
  } else if (input.entityType === "subscription") {
    const query = SubscriptionModel.findById(input.entityId).select("offeringId investorUserId").lean();
    if (session) query.session(session);
    const subscription = (await query) as Record<string, unknown> | null;
    const investorId = toId(subscription?.investorUserId);
    if (investorId) await addUsersByIds(recipients, [investorId], session);

    const offeringId = toId(subscription?.offeringId);
    if (offeringId) {
      const businessId = await readBusinessIdFromOfferingId(offeringId, session);
      await addIssuerUsersByBusinessId(recipients, businessId, session);
      await addInvestorsForOffering(recipients, offeringId, session);
    }
  } else if (input.entityType === "task") {
    const query = TaskModel.findById(input.entityId).select("applicationId").lean();
    if (session) query.session(session);
    const task = (await query) as Record<string, unknown> | null;
    const applicationId = toId(task?.applicationId);
    const businessId = await readBusinessIdFromApplicationId(applicationId, session);
    await addIssuerUsersByBusinessId(recipients, businessId, session);
  } else if (input.entityType === "work_order") {
    const context = await readWorkOrderRecipientContext(input.entityId, session);
    await addIssuerUsersByBusinessId(recipients, context.businessId, session);
    await addUsersByIds(
      recipients,
      [context.assigneeUserId ?? "", context.createdBy ?? ""],
      session,
    );
  } else if (input.entityType === "business") {
    await addIssuerUsersByBusinessId(recipients, input.entityId, session);
  } else if (input.entityType === "user") {
    await addUsersByIds(recipients, [input.entityId], session);
  } else {
    const offeringId = await readOfferingIdFromEntity(input.entityType, input.entityId, session);
    if (offeringId) {
      const businessId = await readBusinessIdFromOfferingId(offeringId, session);
      await addIssuerUsersByBusinessId(recipients, businessId, session);
      await addInvestorsForOffering(recipients, offeringId, session);
    }
  }

  recipients.delete(actor.userId);
  return [...recipients.values()];
}

export async function createNotificationsFromEvent(
  actor: AuthUser,
  input: EventInput,
  session?: mongoose.ClientSession,
) {
  const recipients = await resolveRecipients(actor, input, session);
  if (!recipients.length) return;

  const title = buildTitle(input);
  const message = buildMessage(input);
  const now = new Date();
  const emailTransportConfigured = hasAnyEmailTransportConfigured();

  const rows = recipients.map((recipient) => {
    const canAttemptEmail =
      env.NOTIFICATION_EMAIL_ENABLED && emailTransportConfigured && Boolean(recipient.email);

    return {
      recipientUserId: recipient.userId,
      recipientEmail: recipient.email,
      recipientName: recipient.name,
      actorUserId: actor.userId,
      actorRoleAtTime: actor.role,
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      title,
      message,
      notes: input.notes,
      metadata: input.diff !== undefined ? { diff: input.diff } : undefined,
      channels: {
        email: {
          status: canAttemptEmail ? "pending" : "skipped",
          attempts: 0,
          nextAttemptAt: canAttemptEmail ? now : undefined,
          lastError: canAttemptEmail
            ? undefined
            : recipient.email
              ? "Email transport not configured"
              : "Recipient has no email",
        },
      },
    };
  });

  await NotificationModel.create(rows, { session });

  // Real-time fan-out: push to each recipient's SSE stream immediately.
  for (const recipient of recipients) {
    emitUserEvent(recipient.userId, {
      type: "notification",
      entityType: input.entityType,
      entityId: input.entityId,
      action: input.action,
      title,
      message,
      notes: input.notes,
      createdAt: new Date().toISOString(),
    });
  }
}

function toEmailBody(notification: Record<string, unknown>): { subject: string; text: string; html: string } {
  const title = typeof notification.title === "string" ? notification.title : "Workflow update";
  const message = typeof notification.message === "string" ? notification.message : "A new workflow update is available.";
  const entityType = typeof notification.entityType === "string" ? notification.entityType : "entity";
  const entityId = typeof notification.entityId === "string" ? notification.entityId : "unknown";

  const subject = `[Fractal] ${title}`;
  const text = `${message}\n\nReference: ${entityType}:${entityId}\n`;
  const messageHtml = message
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br>");
  const html = [
    "<div style='font-family:Arial,Helvetica,sans-serif;line-height:1.5;color:#0f172a'>",
    `<h2 style='margin:0 0 12px'>${title}</h2>`,
    `<p style='margin:0 0 12px'>${messageHtml}</p>`,
    `<p style='margin:0;font-size:12px;color:#475569'>Reference: ${entityType}:${entityId}</p>`,
    "</div>",
  ].join("");

  return { subject, text, html };
}

function failureBackoffMs(attempts: number): number {
  const base = Math.max(1, attempts) * 30000;
  return Math.min(base, 5 * 60 * 1000);
}

export async function processPendingNotificationEmails(batchSize = 20): Promise<NotificationEmailBatchResult> {
  const result: NotificationEmailBatchResult = {
    attempted: 0,
    sent: 0,
    failed: 0,
  };

  for (let index = 0; index < batchSize; index += 1) {
    const now = new Date();
    const staleProcessingCutoff = new Date(Date.now() - 10 * 60 * 1000);

    const claimed = (await NotificationModel.findOneAndUpdate(
      {
        $or: [
          {
            "channels.email.status": "pending",
            $or: [
              { "channels.email.nextAttemptAt": { $exists: false } },
              { "channels.email.nextAttemptAt": { $lte: now } },
            ],
          },
          {
            "channels.email.status": "processing",
            "channels.email.lastAttemptAt": { $lt: staleProcessingCutoff },
          },
        ],
      },
      {
        $set: {
          "channels.email.status": "processing",
          "channels.email.lastAttemptAt": now,
          "channels.email.nextAttemptAt": now,
        },
        $inc: { "channels.email.attempts": 1 },
        $unset: { "channels.email.lastError": "" },
      },
      { sort: { createdAt: 1 }, new: true },
    ).lean()) as Record<string, unknown> | null;

    if (!claimed) break;
    result.attempted += 1;

    const id = toId(claimed._id);
    if (!id) continue;

    const recipientEmail = toEmail(claimed.recipientEmail);
    if (!recipientEmail) {
      await NotificationModel.findByIdAndUpdate(id, {
        $set: {
          "channels.email.status": "skipped",
          "channels.email.lastError": "Recipient has no email",
          "channels.email.lastAttemptAt": new Date(),
        },
        $unset: {
          "channels.email.nextAttemptAt": "",
          "channels.email.provider": "",
        },
      });
      continue;
    }

    const body = toEmailBody(claimed);
    const sendResult = await sendEmailWithFallback({
      to: recipientEmail,
      subject: body.subject,
      text: body.text,
      html: body.html,
    });

    if (sendResult.status === "sent") {
      result.sent += 1;
      await NotificationModel.findByIdAndUpdate(id, {
        $set: {
          "channels.email.status": "sent",
          "channels.email.provider": sendResult.provider,
          "channels.email.sentAt": new Date(),
          "channels.email.lastAttemptAt": new Date(),
        },
        $unset: {
          "channels.email.nextAttemptAt": "",
          "channels.email.lastError": "",
        },
      });
      continue;
    }

    if (sendResult.status === "skipped") {
      await NotificationModel.findByIdAndUpdate(id, {
        $set: {
          "channels.email.status": "skipped",
          "channels.email.lastError": sendResult.error ?? "Email delivery skipped",
          "channels.email.lastAttemptAt": new Date(),
        },
        $unset: {
          "channels.email.nextAttemptAt": "",
          "channels.email.provider": "",
        },
      });
      continue;
    }

    const attempts = Number(
      ((claimed.channels as Record<string, unknown> | undefined)?.email as Record<string, unknown> | undefined)
        ?.attempts ?? 1,
    );
    const exhausted = attempts >= env.NOTIFICATION_EMAIL_MAX_RETRIES;
    if (exhausted) result.failed += 1;

    await NotificationModel.findByIdAndUpdate(id, {
      $set: {
        "channels.email.status": exhausted ? "failed" : "pending",
        "channels.email.lastError": sendResult.error ?? "Email delivery failed",
        "channels.email.lastAttemptAt": new Date(),
        ...(exhausted ? {} : { "channels.email.nextAttemptAt": new Date(Date.now() + failureBackoffMs(attempts)) }),
      },
      ...(exhausted
        ? {
            $unset: {
              "channels.email.nextAttemptAt": "",
            },
          }
        : {}),
    });
  }

  return result;
}
