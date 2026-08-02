import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { stableJsonStringify } from "../utils/idempotency.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

export type ProviderIncidentSeverity = "sev1" | "sev2" | "sev3" | "sev4";
export type ProviderIncidentStatus = "open" | "acknowledged" | "contained" | "resolved";
export type ProviderIncidentAction = "acknowledge" | "assign" | "contain" | "escalate" | "resolve" | "reopen";

export class AdministratorProviderIncidentError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_state" | "invalid_input") {
    super(message);
    this.name = "AdministratorProviderIncidentError";
  }
}

type IncidentRow = {
  id: string; provider_key: string; source: string; external_reference: string | null;
  severity: ProviderIncidentSeverity; status: ProviderIncidentStatus; summary: string; user_impact: string;
  detection_evidence: Record<string, unknown>; detected_at: Date; acknowledgement_due_at: Date; resolution_due_at: Date;
  owner_identity_id: string | null; owner_legal_name: string | null; owner_email: string | null;
  created_by_identity_id: string; creator_legal_name: string; creator_email: string;
  acknowledged_at: Date | null; contained_at: Date | null; resolved_at: Date | null;
  version: number; created_at: Date; updated_at: Date;
};

type EventRow = {
  id: string; sequence: number; event_type: string; from_status: ProviderIncidentStatus | null;
  to_status: ProviderIncidentStatus; from_severity: ProviderIncidentSeverity | null; severity: ProviderIncidentSeverity;
  from_owner_identity_id: string | null; owner_identity_id: string | null;
  owner_legal_name: string | null; actor_identity_id: string; actor_legal_name: string; actor_email: string;
  acknowledgement_due_at: Date; resolution_due_at: Date; acknowledged_at: Date | null; contained_at: Date | null;
  resolved_at: Date | null; reason: string; evidence: Record<string, unknown>; occurred_at: Date;
};

const MAX_INCIDENT_EVIDENCE_BYTES = 64 * 1024;

const incidentSelect = `
  SELECT incident.*, owner.legal_name AS owner_legal_name, owner.email AS owner_email,
         creator.legal_name AS creator_legal_name, creator.email AS creator_email
    FROM fractal.administrator_provider_incidents incident
    JOIN fractal.identities creator ON creator.id = incident.created_by_identity_id
    LEFT JOIN fractal.identities owner ON owner.id = incident.owner_identity_id`;

function slaState(dueAt: Date, completedAt: Date | null): "met" | "open" | "breached" {
  if (completedAt) return completedAt <= dueAt ? "met" : "breached";
  return new Date() <= dueAt ? "open" : "breached";
}

function mapIncident(row: IncidentRow, includeEvidence = false) {
  return {
    id: row.id,
    providerKey: row.provider_key,
    source: row.source,
    externalReference: row.external_reference,
    severity: row.severity,
    status: row.status,
    summary: row.summary,
    userImpact: row.user_impact,
    ...(includeEvidence ? { detectionEvidence: row.detection_evidence } : {}),
    detectedAt: row.detected_at.toISOString(),
    acknowledgementDueAt: row.acknowledgement_due_at.toISOString(),
    resolutionDueAt: row.resolution_due_at.toISOString(),
    acknowledgementSlaState: slaState(row.acknowledgement_due_at, row.acknowledged_at),
    resolutionSlaState: slaState(row.resolution_due_at, row.resolved_at),
    owner: row.owner_identity_id && row.owner_legal_name && row.owner_email
      ? { id: row.owner_identity_id, legalName: row.owner_legal_name, email: row.owner_email }
      : null,
    createdBy: { id: row.created_by_identity_id, legalName: row.creator_legal_name, email: row.creator_email },
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    containedAt: row.contained_at?.toISOString() ?? null,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    version: row.version,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function deadlineWindow(severity: ProviderIncidentSeverity, from: Date) {
  const windows = {
    sev1: { acknowledgeMinutes: 15, resolveMinutes: 240 },
    sev2: { acknowledgeMinutes: 30, resolveMinutes: 480 },
    sev3: { acknowledgeMinutes: 240, resolveMinutes: 2_880 },
    sev4: { acknowledgeMinutes: 1_440, resolveMinutes: 7_200 },
  } as const;
  const policy = windows[severity];
  return {
    acknowledgementDueAt: new Date(from.getTime() + policy.acknowledgeMinutes * 60_000),
    resolutionDueAt: new Date(from.getTime() + policy.resolveMinutes * 60_000),
  };
}

function assertText(value: string, label: string, minimum: number, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    throw new AdministratorProviderIncidentError(`${label} must contain ${minimum} to ${maximum} characters.`, "invalid_input");
  }
  return normalized;
}

function assertEvidence(value: Record<string, unknown>, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AdministratorProviderIncidentError(`${label} must be a JSON object.`, "invalid_input");
  }
  let canonical: string;
  try {
    canonical = stableJsonStringify(value);
  } catch {
    throw new AdministratorProviderIncidentError(`${label} must be a serializable JSON object.`, "invalid_input");
  }
  if (Buffer.byteLength(canonical, "utf8") > MAX_INCIDENT_EVIDENCE_BYTES) {
    throw new AdministratorProviderIncidentError(`${label} cannot exceed 64 KiB.`, "invalid_input");
  }
  return value;
}

async function readIncident(client: PoolClient, incidentId: string, lock = false): Promise<IncidentRow> {
  const result = await client.query<IncidentRow>(`${incidentSelect} WHERE incident.id = $1${lock ? " FOR UPDATE OF incident" : ""}`, [incidentId]);
  if (!result.rows[0]) throw new AdministratorProviderIncidentError("Provider incident not found.", "not_found");
  return result.rows[0];
}

export async function listAdministratorProviderIncidents(input: {
  actorIdentityId: string;
  status?: ProviderIncidentStatus;
  severity?: ProviderIncidentSeverity;
  providerKey?: string;
}) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "provider_incident_manage");
    const result = await client.query<IncidentRow>(
      `${incidentSelect}
        WHERE ($1::text IS NULL OR incident.status = $1)
          AND ($2::text IS NULL OR incident.severity = $2)
          AND ($3::text IS NULL OR incident.provider_key = $3)
        ORDER BY CASE incident.severity WHEN 'sev1' THEN 1 WHEN 'sev2' THEN 2 WHEN 'sev3' THEN 3 ELSE 4 END,
                 incident.detected_at DESC, incident.id DESC
        LIMIT 200`,
      [input.status ?? null, input.severity ?? null, input.providerKey ?? null],
    );
    return { incidents: result.rows.map((row) => mapIncident(row)) };
  });
}

export async function getAdministratorProviderIncident(input: { actorIdentityId: string; incidentId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "provider_incident_manage");
    const incident = await readIncident(client, input.incidentId);
    const events = await client.query<EventRow>(
      `SELECT event.*, actor.legal_name AS actor_legal_name, actor.email AS actor_email,
              owner.legal_name AS owner_legal_name
         FROM fractal.administrator_provider_incident_events event
         JOIN fractal.identities actor ON actor.id = event.actor_identity_id
         LEFT JOIN fractal.identities owner ON owner.id = event.owner_identity_id
        WHERE event.incident_id = $1 ORDER BY event.sequence`,
      [input.incidentId],
    );
    return {
      incident: mapIncident(incident, true),
      events: events.rows.map((event) => ({
        id: event.id, sequence: event.sequence, eventType: event.event_type,
        fromStatus: event.from_status, toStatus: event.to_status, fromSeverity: event.from_severity, severity: event.severity,
        fromOwnerIdentityId: event.from_owner_identity_id,
        owner: event.owner_identity_id && event.owner_legal_name ? { id: event.owner_identity_id, legalName: event.owner_legal_name } : null,
        actor: { id: event.actor_identity_id, legalName: event.actor_legal_name, email: event.actor_email },
        acknowledgementDueAt: event.acknowledgement_due_at.toISOString(), resolutionDueAt: event.resolution_due_at.toISOString(),
        acknowledgedAt: event.acknowledged_at?.toISOString() ?? null,
        containedAt: event.contained_at?.toISOString() ?? null,
        resolvedAt: event.resolved_at?.toISOString() ?? null,
        reason: event.reason, evidence: event.evidence, occurredAt: event.occurred_at.toISOString(),
      })),
    };
  });
}

export async function createAdministratorProviderIncident(input: {
  actorIdentityId: string; providerKey: string; source: "manual" | "system_health" | "provider_webhook" | "queue_monitor" | "external_alert";
  externalReference?: string; severity: ProviderIncidentSeverity; summary: string; userImpact: string;
  detectionEvidence: Record<string, unknown>; detectedAt: Date; ownerIdentityId?: string; reason: string; commandKey: string;
}) {
  const providerKey = input.providerKey.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]{1,79}$/.test(providerKey)) throw new AdministratorProviderIncidentError("Provider key is invalid.", "invalid_input");
  const summary = assertText(input.summary, "Summary", 10, 300);
  const userImpact = assertText(input.userImpact, "User impact", 10, 2000);
  const reason = assertText(input.reason, "Creation reason", 10, 2000);
  const detectionEvidence = assertEvidence(input.detectionEvidence, "Detection evidence");
  const externalReference = input.externalReference?.trim() || null;
  if (input.externalReference !== undefined && (!externalReference || externalReference.length < 3 || externalReference.length > 200)) {
    throw new AdministratorProviderIncidentError("External reference must contain 3 to 200 characters.", "invalid_input");
  }
  if (Number.isNaN(input.detectedAt.getTime())) throw new AdministratorProviderIncidentError("Detection time is invalid.", "invalid_input");
  if (input.detectedAt > new Date(Date.now() + 60_000)) throw new AdministratorProviderIncidentError("Detection time cannot be in the future.", "invalid_input");
  const result = await runPostgresIdempotentCommand<{ incident: ReturnType<typeof mapIncident> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `administrator-provider-incident:${input.actorIdentityId}`,
    route: "POST:/v1/admin/provider-incidents",
    commandKey: input.commandKey,
    payload: {
      providerKey, source: input.source, externalReference, severity: input.severity,
      summary, userImpact, detectionEvidence, detectedAt: input.detectedAt.toISOString(),
      ownerIdentityId: input.ownerIdentityId ?? null, reason,
    },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await requireAdministratorCapability(client, input.actorIdentityId, "provider_incident_manage");
      const ownerIdentityId = input.ownerIdentityId ?? input.actorIdentityId;
      await requireAdministratorCapability(client, ownerIdentityId, "provider_incident_manage");
      const deadlines = deadlineWindow(input.severity, input.detectedAt);
      const incidentId = randomUUID();
      try {
        await client.query(
          `INSERT INTO fractal.administrator_provider_incidents
             (id, provider_key, source, external_reference, severity, summary, user_impact,
              detection_evidence, detected_at, acknowledgement_due_at, resolution_due_at,
              owner_identity_id, created_by_identity_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [incidentId, providerKey, input.source, externalReference, input.severity, summary, userImpact,
            detectionEvidence, input.detectedAt, deadlines.acknowledgementDueAt, deadlines.resolutionDueAt, ownerIdentityId, input.actorIdentityId],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") throw new AdministratorProviderIncidentError("This provider reference already has an incident.", "conflict");
        throw error;
      }
      await client.query(
          `INSERT INTO fractal.administrator_provider_incident_events
           (id, incident_id, sequence, event_type, from_status, to_status, from_severity, severity,
            from_owner_identity_id, owner_identity_id, actor_identity_id, acknowledgement_due_at,
            resolution_due_at, acknowledged_at, contained_at, resolved_at, reason, evidence, occurred_at)
         VALUES ($1, $2, 1, 'created', NULL, 'open', NULL, $3, NULL, $4, $5, $6, $7,
                 NULL, NULL, NULL, $8, $9, now())`,
        [randomUUID(), incidentId, input.severity, ownerIdentityId, input.actorIdentityId,
          deadlines.acknowledgementDueAt, deadlines.resolutionDueAt, reason, detectionEvidence],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `provider-incident:${incidentId}`, actorId: input.actorIdentityId, actorType: "user",
        action: "administrator.provider_incident.created", entityType: "administrator_provider_incident", entityId: incidentId,
        reason, payload: { providerKey, severity: input.severity, source: input.source, ownerIdentityId },
      });
      await appendOutboxEvent(client, { aggregateType: "administrator_provider_incident", aggregateId: incidentId,
        eventType: "administrator.provider_incident.created", payload: { providerKey, severity: input.severity, auditEventId: audit.id } });
      return { status: 201, body: { incident: mapIncident(await readIncident(client, incidentId)) } };
    },
  });
  return { incident: result.body.incident, replayed: result.replayed };
}

export async function transitionAdministratorProviderIncident(input: {
  actorIdentityId: string; incidentId: string; action: ProviderIncidentAction; expectedVersion: number;
  reason: string; evidence: Record<string, unknown>; ownerIdentityId?: string; severity?: ProviderIncidentSeverity; commandKey: string;
}) {
  const reason = assertText(input.reason, "Transition reason", 10, 2000);
  const evidence = assertEvidence(input.evidence, "Transition evidence");
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new AdministratorProviderIncidentError("Expected version must be a positive integer.", "invalid_input");
  }
  const result = await runPostgresIdempotentCommand<{ incident: ReturnType<typeof mapIncident> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `administrator-provider-incident:${input.actorIdentityId}`,
    route: `POST:/v1/admin/provider-incidents/${input.incidentId}/transitions`, commandKey: input.commandKey,
    payload: { action: input.action, expectedVersion: input.expectedVersion, reason, evidence,
      ownerIdentityId: input.ownerIdentityId ?? null, severity: input.severity ?? null },
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1_000),
    execute: async (client) => {
      await requireAdministratorCapability(client, input.actorIdentityId, "provider_incident_manage");
      const current = await readIncident(client, input.incidentId, true);
      if (current.version !== input.expectedVersion) throw new AdministratorProviderIncidentError("The incident changed after it was opened. Refresh before acting.", "conflict");
      let status = current.status;
      let severity = current.severity;
      let ownerIdentityId = current.owner_identity_id;
      let acknowledgedAt = current.acknowledged_at;
      let containedAt = current.contained_at;
      let resolvedAt = current.resolved_at;
      let acknowledgementDueAt = current.acknowledgement_due_at;
      let resolutionDueAt = current.resolution_due_at;
      const transitionedAt = new Date();
      if (input.action === "acknowledge") {
        if (status !== "open") throw new AdministratorProviderIncidentError("Only an open incident can be acknowledged.", "invalid_state");
        status = "acknowledged"; acknowledgedAt = transitionedAt;
      } else if (input.action === "assign") {
        if (status === "resolved" || !input.ownerIdentityId) throw new AdministratorProviderIncidentError("An active incident and owner are required for assignment.", "invalid_state");
        if (input.ownerIdentityId === ownerIdentityId) throw new AdministratorProviderIncidentError("Select a different incident owner.", "invalid_state");
        await requireAdministratorCapability(client, input.ownerIdentityId, "provider_incident_manage");
        ownerIdentityId = input.ownerIdentityId;
      } else if (input.action === "contain") {
        if (status !== "acknowledged") throw new AdministratorProviderIncidentError("Acknowledge the incident before recording containment.", "invalid_state");
        status = "contained"; containedAt = transitionedAt;
      } else if (input.action === "resolve") {
        if (status !== "acknowledged" && status !== "contained") throw new AdministratorProviderIncidentError("Acknowledge the incident before resolution.", "invalid_state");
        status = "resolved"; resolvedAt = transitionedAt;
      } else if (input.action === "reopen") {
        if (status !== "resolved") throw new AdministratorProviderIncidentError("Only a resolved incident can be reopened.", "invalid_state");
        status = "open"; acknowledgedAt = null; containedAt = null; resolvedAt = null;
        const deadlines = deadlineWindow(severity, transitionedAt);
        acknowledgementDueAt = deadlines.acknowledgementDueAt; resolutionDueAt = deadlines.resolutionDueAt;
      } else {
        if (status === "resolved" || !input.severity) throw new AdministratorProviderIncidentError("An active incident and higher severity are required for escalation.", "invalid_state");
        const rank = { sev1: 1, sev2: 2, sev3: 3, sev4: 4 } as const;
        if (rank[input.severity] >= rank[severity]) throw new AdministratorProviderIncidentError("Escalation must increase incident severity.", "invalid_state");
        severity = input.severity;
        const deadlines = deadlineWindow(severity, current.detected_at);
        acknowledgementDueAt = deadlines.acknowledgementDueAt; resolutionDueAt = deadlines.resolutionDueAt;
      }
      const nextVersion = current.version + 1;
      const eventType = input.action === "acknowledge" ? "acknowledged" : input.action === "contain" ? "contained" : input.action === "resolve" ? "resolved" : input.action === "reopen" ? "reopened" : input.action === "escalate" ? "escalated" : "assigned";
      await client.query(
        `INSERT INTO fractal.administrator_provider_incident_events
           (id, incident_id, sequence, event_type, from_status, to_status, from_severity, severity,
            from_owner_identity_id, owner_identity_id, actor_identity_id, acknowledgement_due_at,
            resolution_due_at, acknowledged_at, contained_at, resolved_at, reason, evidence, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)`,
        [randomUUID(), current.id, nextVersion, eventType, current.status, status, current.severity, severity,
          current.owner_identity_id, ownerIdentityId, input.actorIdentityId, acknowledgementDueAt, resolutionDueAt,
          acknowledgedAt, containedAt, resolvedAt, reason, evidence, transitionedAt],
      );
      await client.query(
        `UPDATE fractal.administrator_provider_incidents
            SET status = $2, severity = $3, owner_identity_id = $4, acknowledged_at = $5,
                contained_at = $6, resolved_at = $7, acknowledgement_due_at = $8,
                resolution_due_at = $9, version = $10, updated_at = $11
          WHERE id = $1`,
        [current.id, status, severity, ownerIdentityId, acknowledgedAt, containedAt, resolvedAt,
          acknowledgementDueAt, resolutionDueAt, nextVersion, transitionedAt],
      );
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `provider-incident:${current.id}`, actorId: input.actorIdentityId, actorType: "user",
        action: `administrator.provider_incident.${eventType}`, entityType: "administrator_provider_incident", entityId: current.id,
        reason, payload: { fromStatus: current.status, toStatus: status, severity, ownerIdentityId, version: nextVersion },
      });
      await appendOutboxEvent(client, { aggregateType: "administrator_provider_incident", aggregateId: current.id,
        eventType: `administrator.provider_incident.${eventType}`, payload: { version: nextVersion, auditEventId: audit.id } });
      return { status: 200, body: { incident: mapIncident(await readIncident(client, current.id)) } };
    },
  });
  return { incident: result.body.incident, replayed: result.replayed };
}
