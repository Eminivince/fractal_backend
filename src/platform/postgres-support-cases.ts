import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import { parseSupportCaseServicePolicy, targetForSupportCase } from "../modules/support/domain/support-service-policy.js";
import { enqueueSupportNotification, readSupportNotificationDeliveries } from "./postgres-support-notifications.js";
import { readSupportCaseAttachments } from "./postgres-support-attachments.js";

export type SupportCaseStatus = "new" | "triaged" | "in_progress" | "waiting_requester" | "resolved" | "closed";
export type SupportCaseCategory = "account_access" | "identity_verification" | "investment_record" | "payment_status" | "organization" | "professional_work" | "security_concern" | "privacy_request" | "formal_complaint" | "other";
export type SupportCaseImpact = "question" | "blocked" | "financial_or_legal_risk" | "security_or_privacy_concern";
export type SupportCaseStaffAction = "triage" | "assign" | "start" | "wait_requester" | "reply" | "note" | "resolve" | "close" | "reopen";

export class SupportCaseError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_state" | "invalid_input") {
    super(message);
    this.name = "SupportCaseError";
  }
}

type CaseRow = {
  id: string; reference: string; requester_identity_id: string; requester_email: string; requester_legal_name: string;
  requester_role: string; category: SupportCaseCategory; reported_impact: SupportCaseImpact; subject: string; description: string;
  related_reference: string | null; occurred_at: Date; status: SupportCaseStatus; assigned_to_identity_id: string | null;
  assignee_email: string | null; assignee_legal_name: string | null; resolution_summary: string | null; version: number;
  created_at: Date; last_activity_at: Date;
  service_obligation_id: string | null; service_cycle_number: number | null; service_priority: "p1" | "p2" | "p3" | "p4" | null;
  service_policy_version_id: string | null; service_policy_version_number: number | null; service_policy_projection_version: number | null;
  service_policy_value_sha256: string | null; service_policy_reference: string | null; service_policy_name: string | null;
  service_acknowledgement_due_at: Date | null; service_escalation_due_at: Date | null; service_resolution_due_at: Date | null;
  service_acknowledged_at: Date | null; service_escalated_at: Date | null; service_resolution_met_at: Date | null;
  service_acknowledgement_breached_at: Date | null; service_resolution_breached_at: Date | null;
};

type EventRow = {
  id: string; sequence: number; event_type: string; from_status: SupportCaseStatus | null; to_status: SupportCaseStatus;
  from_assignee_identity_id: string | null; assignee_identity_id: string | null; assignee_legal_name: string | null;
  actor_identity_id: string; actor_email: string; actor_legal_name: string; visibility: "requester" | "internal";
  message: string; occurred_at: Date;
};

const caseSelect = `
  SELECT support_case.*, requester.email AS requester_email, requester.legal_name AS requester_legal_name,
         assignee.email AS assignee_email, assignee.legal_name AS assignee_legal_name,
         service_level.id AS service_obligation_id, service_level.cycle_number AS service_cycle_number,
         service_level.priority AS service_priority, service_level.policy_version_id AS service_policy_version_id,
         service_level.policy_version_number AS service_policy_version_number,
         service_level.policy_projection_version AS service_policy_projection_version,
         service_level.policy_value_sha256 AS service_policy_value_sha256,
         service_level.policy_reference AS service_policy_reference, service_level.policy_name AS service_policy_name,
         service_level.acknowledgement_due_at AS service_acknowledgement_due_at,
         service_level.escalation_due_at AS service_escalation_due_at,
         service_level.resolution_due_at AS service_resolution_due_at,
         service_level.acknowledged_at AS service_acknowledged_at,
         service_level.escalated_at AS service_escalated_at,
         service_level.resolution_met_at AS service_resolution_met_at,
         service_level.acknowledgement_breached_at AS service_acknowledgement_breached_at,
         service_level.resolution_breached_at AS service_resolution_breached_at
    FROM fractal.support_cases support_case
    JOIN fractal.identities requester ON requester.id = support_case.requester_identity_id
    LEFT JOIN fractal.identities assignee ON assignee.id = support_case.assigned_to_identity_id
    LEFT JOIN LATERAL (
      SELECT obligation.*,
             min(event.occurred_at) FILTER (WHERE event.event_type = 'acknowledgement_met') AS acknowledged_at,
             min(event.occurred_at) FILTER (WHERE event.event_type = 'escalated') AS escalated_at,
             min(event.occurred_at) FILTER (WHERE event.event_type = 'resolution_met') AS resolution_met_at,
             min(event.occurred_at) FILTER (WHERE event.event_type = 'acknowledgement_breached') AS acknowledgement_breached_at,
             min(event.occurred_at) FILTER (WHERE event.event_type = 'resolution_breached') AS resolution_breached_at
        FROM fractal.support_case_service_obligations obligation
        LEFT JOIN fractal.support_case_service_events event ON event.obligation_id = obligation.id
       WHERE obligation.case_id = support_case.id
       GROUP BY obligation.id
       ORDER BY obligation.cycle_number DESC
       LIMIT 1
    ) service_level ON TRUE`;

function mapCase(row: CaseRow) {
  return {
    id: row.id, reference: row.reference,
    requester: { id: row.requester_identity_id, email: row.requester_email, legalName: row.requester_legal_name, role: row.requester_role },
    category: row.category, reportedImpact: row.reported_impact, subject: row.subject, description: row.description,
    relatedReference: row.related_reference, occurredAt: row.occurred_at.toISOString(), status: row.status,
    assignee: row.assigned_to_identity_id && row.assignee_email && row.assignee_legal_name
      ? { id: row.assigned_to_identity_id, email: row.assignee_email, legalName: row.assignee_legal_name }
      : null,
    resolutionSummary: row.resolution_summary, version: row.version,
    createdAt: row.created_at.toISOString(), lastActivityAt: row.last_activity_at.toISOString(),
    serviceLevel: row.service_obligation_id ? {
      obligationId: row.service_obligation_id,
      cycleNumber: row.service_cycle_number!,
      priority: row.service_priority!,
      policy: {
        versionId: row.service_policy_version_id!, versionNumber: row.service_policy_version_number!,
        projectionVersion: row.service_policy_projection_version!, valueSha256: row.service_policy_value_sha256!,
        reference: row.service_policy_reference!, name: row.service_policy_name!,
      },
      acknowledgementDueAt: row.service_acknowledgement_due_at!.toISOString(),
      escalationDueAt: row.service_escalation_due_at!.toISOString(),
      resolutionDueAt: row.service_resolution_due_at!.toISOString(),
      acknowledgedAt: row.service_acknowledged_at?.toISOString() ?? null,
      escalatedAt: row.service_escalated_at?.toISOString() ?? null,
      resolutionMetAt: row.service_resolution_met_at?.toISOString() ?? null,
      acknowledgementBreachedAt: row.service_acknowledgement_breached_at?.toISOString() ?? null,
      resolutionBreachedAt: row.service_resolution_breached_at?.toISOString() ?? null,
    } : null,
  };
}

async function bindServiceObligation(client: PoolClient, input: {
  caseId: string; category: SupportCaseCategory; reportedImpact: SupportCaseImpact;
  sourceCaseEventSequence: number; openedAt: Date;
}) {
  const binding = await readActivePlatformConfigurationForBinding(client, "support.case.service_policy");
  if (!binding) return null;
  const policy = parseSupportCaseServicePolicy(binding.value);
  const target = targetForSupportCase(policy, input.category, input.reportedImpact);
  const cycle = await client.query<{ next_cycle: number }>(
    `SELECT COALESCE(max(cycle_number), 0) + 1 AS next_cycle FROM fractal.support_case_service_obligations WHERE case_id = $1`,
    [input.caseId],
  );
  const acknowledgementDueAt = new Date(input.openedAt.getTime() + target.acknowledgementMinutes * 60_000);
  const resolutionDueAt = new Date(input.openedAt.getTime() + target.resolutionMinutes * 60_000);
  const escalationDueAt = new Date(resolutionDueAt.getTime() - target.escalationMinutesBeforeResolution * 60_000);
  const obligationId = randomUUID();
  await client.query(
    `INSERT INTO fractal.support_case_service_obligations
       (id,case_id,cycle_number,source_case_event_sequence,policy_version_id,policy_version_number,
        policy_projection_version,policy_value_sha256,policy_reference,policy_name,priority,
        acknowledgement_due_at,escalation_due_at,resolution_due_at,opened_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)`,
    [obligationId, input.caseId, cycle.rows[0]!.next_cycle, input.sourceCaseEventSequence,
      binding.versionId, binding.versionNumber, binding.projectionVersion, binding.valueSha256,
      policy.policyReference, policy.policyName, target.priority, acknowledgementDueAt, escalationDueAt, resolutionDueAt, input.openedAt],
  );
  return obligationId;
}

async function activeServiceObligation(client: PoolClient, caseId: string) {
  const result = await client.query<{ id: string; acknowledgement_due_at: Date; resolution_due_at: Date }>(
    `SELECT obligation.id, obligation.acknowledgement_due_at, obligation.resolution_due_at
       FROM fractal.support_case_service_obligations obligation
      WHERE obligation.case_id = $1
      ORDER BY obligation.cycle_number DESC LIMIT 1 FOR SHARE`,
    [caseId],
  );
  return result.rows[0] ?? null;
}

async function appendMetServiceEvent(client: PoolClient, input: {
  caseId: string; eventType: "acknowledgement_met" | "resolution_met"; actorIdentityId: string; occurredAt: Date; caseEventSequence: number;
}) {
  const obligation = await activeServiceObligation(client, input.caseId);
  if (!obligation) return;
  const dueAt = input.eventType === "acknowledgement_met" ? obligation.acknowledgement_due_at : obligation.resolution_due_at;
  await client.query(
    `INSERT INTO fractal.support_case_service_events
       (id,obligation_id,event_type,actor_type,actor_identity_id,due_at,occurred_at,lateness_ms,evidence)
     VALUES ($1,$2,$3,'user',$4,$5,$6,$7,$8)
     ON CONFLICT (obligation_id,event_type) DO NOTHING`,
    [randomUUID(), obligation.id, input.eventType, input.actorIdentityId, dueAt, input.occurredAt,
      Math.max(0, input.occurredAt.getTime() - dueAt.getTime()), { caseEventSequence: input.caseEventSequence }],
  );
}

function assertText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) throw new SupportCaseError(`${label} must contain ${minimum} to ${maximum} characters.`, "invalid_input");
  return normalized;
}

function supportReference(now: Date): string {
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return `SUP-${day}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function nextActivityAt(current: Date): Date {
  return new Date(Math.max(Date.now(), current.getTime() + 1));
}

async function readCase(client: PoolClient, caseId: string, lock = false): Promise<CaseRow> {
  const result = await client.query<CaseRow>(`${caseSelect} WHERE support_case.id = $1${lock ? " FOR UPDATE OF support_case" : ""}`, [caseId]);
  if (!result.rows[0]) throw new SupportCaseError("Support case not found.", "not_found");
  return result.rows[0];
}

async function readEvents(client: PoolClient, caseId: string, includeInternal: boolean) {
  const result = await client.query<EventRow>(
    `SELECT event.*, actor.email AS actor_email, actor.legal_name AS actor_legal_name,
            assignee.legal_name AS assignee_legal_name
       FROM fractal.support_case_events event
       JOIN fractal.identities actor ON actor.id = event.actor_identity_id
       LEFT JOIN fractal.identities assignee ON assignee.id = event.assignee_identity_id
      WHERE event.case_id = $1 AND ($2::boolean OR event.visibility = 'requester')
      ORDER BY event.sequence`,
    [caseId, includeInternal],
  );
  return result.rows.map((event) => ({
    id: event.id, sequence: event.sequence, eventType: event.event_type, fromStatus: event.from_status, toStatus: event.to_status,
    fromAssigneeIdentityId: event.from_assignee_identity_id,
    assignee: event.assignee_identity_id && event.assignee_legal_name ? { id: event.assignee_identity_id, legalName: event.assignee_legal_name } : null,
    actor: { id: event.actor_identity_id, email: event.actor_email, legalName: event.actor_legal_name },
    visibility: event.visibility, message: event.message, occurredAt: event.occurred_at.toISOString(),
  }));
}

async function readServiceEvents(client: PoolClient, caseId: string) {
  const result = await client.query<{
    id: string; obligation_id: string; cycle_number: number; event_type: string; actor_type: "user" | "system";
    actor_identity_id: string | null; actor_legal_name: string | null; due_at: Date; occurred_at: Date; lateness_ms: string;
  }>(
    `SELECT event.id, event.obligation_id, obligation.cycle_number, event.event_type, event.actor_type,
            event.actor_identity_id, actor.legal_name AS actor_legal_name, event.due_at, event.occurred_at, event.lateness_ms
       FROM fractal.support_case_service_events event
       JOIN fractal.support_case_service_obligations obligation ON obligation.id = event.obligation_id
       LEFT JOIN fractal.identities actor ON actor.id = event.actor_identity_id
      WHERE obligation.case_id = $1
      ORDER BY obligation.cycle_number, event.occurred_at, event.id`,
    [caseId],
  );
  return result.rows.map((event) => ({
    id: event.id, obligationId: event.obligation_id, cycleNumber: event.cycle_number,
    eventType: event.event_type, actorType: event.actor_type,
    actor: event.actor_identity_id && event.actor_legal_name ? { id: event.actor_identity_id, legalName: event.actor_legal_name } : null,
    dueAt: event.due_at.toISOString(), occurredAt: event.occurred_at.toISOString(), latenessMs: Number(event.lateness_ms),
  }));
}

export async function listOwnSupportCases(input: { actorIdentityId: string; status?: SupportCaseStatus }) {
  return withPostgresTransaction(async (client) => {
    const result = await client.query<CaseRow>(`${caseSelect}
      WHERE support_case.requester_identity_id = $1 AND ($2::text IS NULL OR support_case.status = $2)
      ORDER BY support_case.last_activity_at DESC, support_case.id DESC LIMIT 100`, [input.actorIdentityId, input.status ?? null]);
    return { cases: result.rows.map(mapCase) };
  });
}

export async function getOwnSupportCase(input: { actorIdentityId: string; caseId: string }) {
  return withPostgresTransaction(async (client) => {
    const supportCase = await readCase(client, input.caseId);
    if (supportCase.requester_identity_id !== input.actorIdentityId) throw new SupportCaseError("Support case not found.", "not_found");
    return { case: mapCase(supportCase), events: await readEvents(client, input.caseId, false), serviceEvents: await readServiceEvents(client, input.caseId), notificationDeliveries: await readSupportNotificationDeliveries(client, input.caseId), attachments: await readSupportCaseAttachments(client, { caseId: input.caseId, actorIdentityId: input.actorIdentityId, staff: false }) };
  });
}

export async function createSupportCase(input: {
  actorIdentityId: string; actorRole: "investor" | "issuer" | "professional" | "operator" | "admin";
  category: SupportCaseCategory; reportedImpact: SupportCaseImpact; subject: string; description: string;
  relatedReference?: string; occurredAt: Date; commandKey: string;
}) {
  const subject = assertText(input.subject, "Subject", 10, 200);
  const description = assertText(input.description, "Description", 20, 5000);
  const relatedReference = input.relatedReference?.trim() || null;
  if (input.relatedReference !== undefined && (!relatedReference || relatedReference.length < 3 || relatedReference.length > 200)) throw new SupportCaseError("Related reference must contain 3 to 200 characters.", "invalid_input");
  if (Number.isNaN(input.occurredAt.getTime()) || input.occurredAt > new Date(Date.now() + 60_000)) throw new SupportCaseError("Occurred time is invalid or in the future.", "invalid_input");
  const result = await runPostgresIdempotentCommand<{ case: ReturnType<typeof mapCase> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `support-case:${input.actorIdentityId}`, route: "POST:/v1/support/cases", commandKey: input.commandKey,
    payload: { category: input.category, reportedImpact: input.reportedImpact, subject, description, relatedReference, occurredAt: input.occurredAt.toISOString() },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), execute: async (client) => {
      const id = randomUUID(); const now = new Date(); const reference = supportReference(now);
      await client.query(`INSERT INTO fractal.support_cases
        (id, reference, requester_identity_id, requester_role, category, reported_impact, subject, description, related_reference, occurred_at, created_at, last_activity_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)`,
      [id, reference, input.actorIdentityId, input.actorRole, input.category, input.reportedImpact, subject, description, relatedReference, input.occurredAt, now]);
      await client.query(`INSERT INTO fractal.support_case_events
        (id, case_id, sequence, event_type, from_status, to_status, actor_identity_id, visibility, message, occurred_at)
        VALUES ($1,$2,1,'opened',NULL,'new',$3,'requester',$4,$5)`, [randomUUID(), id, input.actorIdentityId, description, now]);
      const serviceObligationId = await bindServiceObligation(client, {
        caseId: id, category: input.category, reportedImpact: input.reportedImpact, sourceCaseEventSequence: 1, openedAt: now,
      });
      await enqueueSupportNotification(client, { caseId: id, caseEventSequence: 1, recipientIdentityId: input.actorIdentityId, notificationType: "opened" });
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${id}`, actorId: input.actorIdentityId, actorType: "user",
        action: "support.case.opened", entityType: "support_case", entityId: id, reason: "Authenticated support case opened.",
        payload: { reference, category: input.category, reportedImpact: input.reportedImpact, hasRelatedReference: Boolean(relatedReference), serviceObligationId } });
      await appendOutboxEvent(client, { aggregateType: "support_case", aggregateId: id, eventType: "support.case.opened",
        payload: { reference, category: input.category, reportedImpact: input.reportedImpact, auditEventId: audit.id } });
      return { status: 201, body: { case: mapCase(await readCase(client, id)) } };
    },
  });
  return { case: result.body.case, replayed: result.replayed };
}

export async function addRequesterSupportMessage(input: { actorIdentityId: string; caseId: string; message: string; expectedVersion: number; commandKey: string }) {
  const message = assertText(input.message, "Message", 2, 5000);
  const result = await runPostgresIdempotentCommand<{ case: ReturnType<typeof mapCase> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `support-case:${input.actorIdentityId}`, route: `POST:/v1/support/cases/${input.caseId}/messages`, commandKey: input.commandKey,
    payload: { message, expectedVersion: input.expectedVersion }, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), execute: async (client) => {
      const current = await readCase(client, input.caseId, true);
      if (current.requester_identity_id !== input.actorIdentityId) throw new SupportCaseError("Support case not found.", "not_found");
      if (current.version !== input.expectedVersion) throw new SupportCaseError("The case changed after it was opened. Refresh before replying.", "conflict");
      const reopened = current.status === "resolved" || current.status === "closed";
      if (reopened && !current.assigned_to_identity_id) throw new SupportCaseError("The closed case cannot be reopened until support ownership is restored.", "invalid_state");
      const nextStatus = reopened ? "in_progress" : current.status;
      const eventType = reopened ? "reopened" : "requester_message";
      const nextVersion = current.version + 1; const now = nextActivityAt(current.last_activity_at);
      await client.query(`INSERT INTO fractal.support_case_events
        (id, case_id, sequence, event_type, from_status, to_status, from_assignee_identity_id, assignee_identity_id, actor_identity_id, visibility, message, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,'requester',$9,$10)`,
      [randomUUID(), current.id, nextVersion, eventType, current.status, nextStatus, current.assigned_to_identity_id, input.actorIdentityId, message, now]);
      await client.query(`UPDATE fractal.support_cases SET status=$2, resolution_summary=NULL, version=$3, last_activity_at=$4 WHERE id=$1`, [current.id, nextStatus, nextVersion, now]);
      if (reopened) {
        await bindServiceObligation(client, {
          caseId: current.id, category: current.category, reportedImpact: current.reported_impact,
          sourceCaseEventSequence: nextVersion, openedAt: now,
        });
      }
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${current.id}`, actorId: input.actorIdentityId, actorType: "user",
        action: reopened ? "support.case.reopened_by_requester" : "support.case.requester_message_added", entityType: "support_case", entityId: current.id,
        reason: "Requester added case information.", payload: { version: nextVersion, status: nextStatus } });
      await appendOutboxEvent(client, { aggregateType: "support_case", aggregateId: current.id, eventType: reopened ? "support.case.reopened" : "support.case.requester_message_added", payload: { version: nextVersion, auditEventId: audit.id } });
      return { status: 200, body: { case: mapCase(await readCase(client, current.id)) } };
    },
  });
  return { case: result.body.case, replayed: result.replayed };
}

export async function listAdministratorSupportCases(input: { actorIdentityId: string; status?: SupportCaseStatus; category?: SupportCaseCategory }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "support_case_manage");
    const result = await client.query<CaseRow>(`${caseSelect}
      WHERE ($1::text IS NULL OR support_case.status=$1) AND ($2::text IS NULL OR support_case.category=$2)
      ORDER BY CASE support_case.reported_impact WHEN 'security_or_privacy_concern' THEN 1 WHEN 'financial_or_legal_risk' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
      support_case.created_at, support_case.id LIMIT 200`, [input.status ?? null, input.category ?? null]);
    return { cases: result.rows.map(mapCase) };
  });
}

export async function getAdministratorSupportCase(input: { actorIdentityId: string; caseId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "support_case_manage");
    return { case: mapCase(await readCase(client, input.caseId)), events: await readEvents(client, input.caseId, true), serviceEvents: await readServiceEvents(client, input.caseId), notificationDeliveries: await readSupportNotificationDeliveries(client, input.caseId), attachments: await readSupportCaseAttachments(client, { caseId: input.caseId, actorIdentityId: input.actorIdentityId, staff: true }) };
  });
}

export async function transitionAdministratorSupportCase(input: {
  actorIdentityId: string; caseId: string; action: SupportCaseStaffAction; expectedVersion: number;
  message: string; assigneeIdentityId?: string; commandKey: string;
}) {
  const message = assertText(input.message, "Case note", 2, 5000);
  const result = await runPostgresIdempotentCommand<{ case: ReturnType<typeof mapCase> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `administrator-support-case:${input.actorIdentityId}`, route: `POST:/v1/admin/support-cases/${input.caseId}/transitions`, commandKey: input.commandKey,
    payload: { action: input.action, expectedVersion: input.expectedVersion, message, assigneeIdentityId: input.assigneeIdentityId ?? null },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000), execute: async (client) => {
      await requireAdministratorCapability(client, input.actorIdentityId, "support_case_manage");
      const current = await readCase(client, input.caseId, true);
      if (current.version !== input.expectedVersion) throw new SupportCaseError("The case changed after it was opened. Refresh before acting.", "conflict");
      let status = current.status; let assignee = current.assigned_to_identity_id; let resolution = current.resolution_summary;
      let eventType: string; let visibility: "requester" | "internal" = "internal";
      if (input.action === "triage") {
        if (status !== "new") throw new SupportCaseError("Only a new case can be triaged.", "invalid_state");
        assignee = input.assigneeIdentityId ?? input.actorIdentityId;
        await requireAdministratorCapability(client, assignee, "support_case_manage");
        status = "triaged"; eventType = "triaged";
      } else if (input.action === "assign") {
        if (status === "closed" || !input.assigneeIdentityId || input.assigneeIdentityId === assignee) throw new SupportCaseError("Select a different capable owner for an active case.", "invalid_state");
        await requireAdministratorCapability(client, input.assigneeIdentityId, "support_case_manage");
        assignee = input.assigneeIdentityId; eventType = "assigned";
      } else if (input.action === "start") {
        if (!assignee || !["triaged", "waiting_requester"].includes(status)) throw new SupportCaseError("A triaged or waiting case with an owner is required.", "invalid_state");
        status = "in_progress"; eventType = "status_changed";
      } else if (input.action === "wait_requester") {
        if (!assignee || !["triaged", "in_progress"].includes(status)) throw new SupportCaseError("An owned triaged or in-progress case is required.", "invalid_state");
        status = "waiting_requester"; eventType = "status_changed"; visibility = "requester";
      } else if (input.action === "resolve") {
        if (!assignee || !["triaged", "in_progress", "waiting_requester"].includes(status) || message.length < 10) throw new SupportCaseError("An owned active case and a resolution of at least 10 characters are required.", "invalid_state");
        status = "resolved"; resolution = message; eventType = "resolved"; visibility = "requester";
      } else if (input.action === "close") {
        if (status !== "resolved" || !resolution) throw new SupportCaseError("Only a resolved case can be closed.", "invalid_state");
        status = "closed"; eventType = "closed"; visibility = "requester";
      } else if (input.action === "reopen") {
        if (!assignee || !["resolved", "closed"].includes(status)) throw new SupportCaseError("Only an owned resolved or closed case can be reopened.", "invalid_state");
        status = "in_progress"; resolution = null; eventType = "reopened"; visibility = "requester";
      } else if (input.action === "reply" || input.action === "note") {
        if (status === "closed") throw new SupportCaseError("Reopen the case before adding a message.", "invalid_state");
        eventType = input.action === "reply" ? "staff_message" : "staff_note";
        visibility = input.action === "reply" ? "requester" : "internal";
      } else { throw new SupportCaseError("Unsupported support-case action.", "invalid_input"); }
      const nextVersion = current.version + 1; const now = nextActivityAt(current.last_activity_at);
      const eventMessage = input.action === "close" ? resolution! : message;
      await client.query(`INSERT INTO fractal.support_case_events
        (id, case_id, sequence, event_type, from_status, to_status, from_assignee_identity_id, assignee_identity_id, actor_identity_id, visibility, message, occurred_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [randomUUID(), current.id, nextVersion, eventType, current.status, status, current.assigned_to_identity_id, assignee, input.actorIdentityId, visibility, eventMessage, now]);
      await client.query(`UPDATE fractal.support_cases SET status=$2, assigned_to_identity_id=$3, resolution_summary=$4, version=$5, last_activity_at=$6 WHERE id=$1`,
      [current.id, status, assignee, resolution, nextVersion, now]);
      if (input.action === "triage") {
        await appendMetServiceEvent(client, { caseId: current.id, eventType: "acknowledgement_met", actorIdentityId: input.actorIdentityId, occurredAt: now, caseEventSequence: nextVersion });
      }
      if (input.action === "resolve") {
        await appendMetServiceEvent(client, { caseId: current.id, eventType: "resolution_met", actorIdentityId: input.actorIdentityId, occurredAt: now, caseEventSequence: nextVersion });
      }
      if (input.action === "reopen") {
        await bindServiceObligation(client, {
          caseId: current.id, category: current.category, reportedImpact: current.reported_impact,
          sourceCaseEventSequence: nextVersion, openedAt: now,
        });
      }
      const notificationType = input.action === "reply" ? "staff_reply"
        : input.action === "wait_requester" ? "waiting_requester"
          : input.action === "resolve" ? "resolved"
            : input.action === "close" ? "closed"
              : input.action === "reopen" ? "reopened"
            : null;
      if (notificationType) {
        await enqueueSupportNotification(client, { caseId: current.id, caseEventSequence: nextVersion, recipientIdentityId: current.requester_identity_id, notificationType });
      }
      const audit = await appendPostgresAuditEvent(client, { scopeKey: `support-case:${current.id}`, actorId: input.actorIdentityId, actorType: "user",
        action: `administrator.support_case.${eventType}`, entityType: "support_case", entityId: current.id, reason: `Support case ${input.action} recorded.`,
        payload: { fromStatus: current.status, toStatus: status, assigneeIdentityId: assignee, version: nextVersion, visibility } });
      await appendOutboxEvent(client, { aggregateType: "support_case", aggregateId: current.id, eventType: `support.case.${eventType}`,
        payload: { status, version: nextVersion, auditEventId: audit.id } });
      return { status: 200, body: { case: mapCase(await readCase(client, current.id)) } };
    },
  });
  return { case: result.body.case, replayed: result.replayed };
}
