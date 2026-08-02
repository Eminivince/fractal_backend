import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { AdministratorCapabilityError, requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { readActivePlatformConfigurationForBinding } from "./postgres-platform-configuration.js";
import { readActiveExternalPrivacyAdapterPolicyForBinding } from "./privacy-external-adapter-runtime.js";
import { readActiveExternalPrivacyAttestationReadiness } from "./privacy-external-attestation-runtime.js";
import { parsePrivacyRightsResponsePolicy } from "../modules/privacy/domain/privacy-rights-policy.js";
import { listDistributionPrivacyTreatments } from "./postgres-distribution-privacy-treatments.js";

const PRIVACY_RIGHTS_LOCK = 5_014_907_331;
const capability = "privacy_request_manage";

export type PrivacyRequestType = "access" | "portability" | "correction" | "erasure" | "restriction" | "objection";
export type PrivacyRequestStatus = "submitted" | "in_review" | "awaiting_requester" | "decision_pending" | "approved" | "partially_approved" | "refused" | "withdrawn";
export type PrivacyDecisionOutcome = "approve" | "partially_approve" | "refuse";
export type PrivacyScopeAction = "provide" | "correct" | "erase" | "restrict" | "retain" | "refuse" | "not_applicable";

export interface PrivacyScopeOutcome {
  category: string;
  action: PrivacyScopeAction;
  explanation: string;
}

export class PrivacyRightsError extends Error {
  constructor(message: string, readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input" | "policy_unavailable") {
    super(message);
    this.name = "PrivacyRightsError";
  }
}

type RequestRow = {
  id: string; reference: string; requester_identity_id: string; requester_email: string; requester_legal_name: string;
  requester_role: string; request_type: PrivacyRequestType; details: string; identity_assurance: string;
  email_verified_at_snapshot: Date; policy_version_id: string | null; due_at: Date | null; status: PrivacyRequestStatus;
  assigned_to_identity_id: string | null; assignee_legal_name: string | null; current_decision_request_id: string | null;
  version: number; created_at: Date; last_activity_at: Date;
  bound_policy_version_id: string | null; bound_policy_version_number: number | null; bound_policy_projection_version: number | null;
  bound_policy_value_sha256: string | null; bound_policy_reference: string | null; bound_policy_name: string | null;
  bound_policy_jurisdiction: string | null; bound_controller_name: string | null; bound_communication_channel: string | null;
  bound_deadline_basis: string | null; bound_response_calendar_days: number | null; bound_due_at: Date | null; policy_bound_at: Date | null;
};

type EventRow = {
  id: string; sequence: number; event_type: string; from_status: PrivacyRequestStatus | null; to_status: PrivacyRequestStatus;
  actor_identity_id: string; actor_legal_name: string; assignee_identity_id: string | null; assignee_legal_name: string | null;
  decision_request_id: string | null; visibility: "requester" | "internal"; message: string; occurred_at: Date;
};

type DecisionRow = {
  id: string; reference: string; privacy_request_id: string; outcome: PrivacyDecisionOutcome; decision_summary: string;
  lawful_basis: string; scope_outcomes: PrivacyScopeOutcome[]; fulfillment_coverage: FulfillmentCoverage;
  status: "pending" | "applied" | "rejected"; requested_by_identity_id: string; requester_legal_name: string;
  reviewed_by_identity_id: string | null; reviewer_legal_name: string | null; review_reason: string | null;
  requested_at: Date; reviewed_at: Date | null; applied_at: Date | null;
};

export interface FulfillmentCoverage {
  complete: boolean;
  schemaVersion: string;
  coveredAuthorities: string[];
  uncoveredAuthorities: string[];
  authorities: Array<{
    key: string; label: string; sourceCount: number; inventoryStatus: "catalogued" | "unresolved";
    rightStatus: "available" | "partial" | "unavailable" | "not_applicable"; blocker: string | null;
  }>;
  legalHold: { active: boolean; pendingImposition: boolean };
  executionAvailable: boolean;
}

const requestSelect = `
  SELECT request.*, requester.email AS requester_email, requester.legal_name AS requester_legal_name,
         assignee.legal_name AS assignee_legal_name,
         binding.policy_version_id AS bound_policy_version_id,binding.policy_version_number AS bound_policy_version_number,
         binding.policy_projection_version AS bound_policy_projection_version,binding.policy_value_sha256 AS bound_policy_value_sha256,
         binding.policy_reference AS bound_policy_reference,binding.policy_name AS bound_policy_name,
         binding.jurisdiction AS bound_policy_jurisdiction,binding.controller_name AS bound_controller_name,
         binding.communication_channel AS bound_communication_channel,binding.deadline_basis AS bound_deadline_basis,
         binding.response_calendar_days AS bound_response_calendar_days,binding.due_at AS bound_due_at,binding.bound_at AS policy_bound_at
  FROM fractal.privacy_rights_requests request
  JOIN fractal.identities requester ON requester.id=request.requester_identity_id
  LEFT JOIN fractal.identities assignee ON assignee.id=request.assigned_to_identity_id
  LEFT JOIN fractal.privacy_rights_policy_bindings binding ON binding.privacy_request_id=request.id`;

const eventSelect = `
  SELECT event.*, actor.legal_name AS actor_legal_name, assignee.legal_name AS assignee_legal_name
  FROM fractal.privacy_rights_request_events event
  JOIN fractal.identities actor ON actor.id=event.actor_identity_id
  LEFT JOIN fractal.identities assignee ON assignee.id=event.assignee_identity_id`;

const decisionSelect = `
  SELECT decision.*, requester.legal_name AS requester_legal_name, reviewer.legal_name AS reviewer_legal_name
  FROM fractal.privacy_rights_decision_requests decision
  JOIN fractal.identities requester ON requester.id=decision.requested_by_identity_id
  LEFT JOIN fractal.identities reviewer ON reviewer.id=decision.reviewed_by_identity_id`;

function normalized(value: string, label: string, minimum: number, maximum: number) {
  const result = value.trim();
  if (result.length < minimum || result.length > maximum) throw new PrivacyRightsError(`${label} must contain ${minimum} to ${maximum} characters.`, "invalid_input");
  return result;
}

function validatedScopeOutcomes(outcome: PrivacyDecisionOutcome, values: PrivacyScopeOutcome[]) {
  if (values.length < 1 || values.length > 100) throw new PrivacyRightsError("At least one bounded scope outcome is required.", "invalid_input");
  const seen = new Set<string>();
  const scopes = values.map((value) => {
    const category = normalized(value.category, "Scope category", 2, 120);
    const explanation = normalized(value.explanation, "Scope explanation", 20, 2_000);
    const key = category.toLocaleLowerCase("en");
    if (seen.has(key)) throw new PrivacyRightsError("Each privacy decision scope category must be unique.", "invalid_input");
    seen.add(key);
    return { category, action: value.action, explanation };
  });
  const grants = scopes.some((scope) => ["provide", "correct", "erase", "restrict"].includes(scope.action));
  const withholds = scopes.some((scope) => ["retain", "refuse"].includes(scope.action));
  if ((outcome === "approve" && withholds) || (outcome === "refuse" && grants)
    || (outcome === "partially_approve" && (!grants || !withholds))) {
    throw new PrivacyRightsError("The overall privacy outcome does not match its per-scope actions.", "invalid_input");
  }
  return scopes;
}

function reference(prefix: "PRV" | "PRD") {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${date}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`;
}

function mapRequest(row: RequestRow) {
  return {
    id: row.id, reference: row.reference,
    requester: { id: row.requester_identity_id, email: row.requester_email, legalName: row.requester_legal_name, role: row.requester_role },
    requestType: row.request_type, details: row.details, identityAssurance: row.identity_assurance,
    emailVerifiedAt: row.email_verified_at_snapshot.toISOString(),
    policy: row.bound_policy_version_id ? {
      versionId: row.bound_policy_version_id, versionNumber: row.bound_policy_version_number!, projectionVersion: row.bound_policy_projection_version!,
      valueSha256: row.bound_policy_value_sha256!, reference: row.bound_policy_reference!, name: row.bound_policy_name!,
      jurisdiction: row.bound_policy_jurisdiction!, controllerName: row.bound_controller_name!, communicationChannel: row.bound_communication_channel!,
      deadlineBasis: row.bound_deadline_basis!, responseCalendarDays: row.bound_response_calendar_days!, dueAt: row.bound_due_at!.toISOString(),
      boundAt: row.policy_bound_at!.toISOString(),
    } : null,
    status: row.status,
    assignee: row.assigned_to_identity_id && row.assignee_legal_name ? { id: row.assigned_to_identity_id, legalName: row.assignee_legal_name } : null,
    currentDecisionRequestId: row.current_decision_request_id, version: row.version,
    createdAt: row.created_at.toISOString(), lastActivityAt: row.last_activity_at.toISOString(),
  };
}

function mapEvent(row: EventRow) {
  return {
    id: row.id, sequence: row.sequence, eventType: row.event_type, fromStatus: row.from_status, toStatus: row.to_status,
    actor: { id: row.actor_identity_id, legalName: row.actor_legal_name },
    assignee: row.assignee_identity_id && row.assignee_legal_name ? { id: row.assignee_identity_id, legalName: row.assignee_legal_name } : null,
    decisionRequestId: row.decision_request_id, visibility: row.visibility, message: row.message, occurredAt: row.occurred_at.toISOString(),
  };
}

function mapDecision(row: DecisionRow) {
  return {
    id: row.id, reference: row.reference, privacyRequestId: row.privacy_request_id, outcome: row.outcome,
    decisionSummary: row.decision_summary, lawfulBasis: row.lawful_basis, scopeOutcomes: row.scope_outcomes,
    fulfillmentCoverage: row.fulfillment_coverage, status: row.status,
    requestedBy: { id: row.requested_by_identity_id, legalName: row.requester_legal_name },
    reviewedBy: row.reviewed_by_identity_id && row.reviewer_legal_name ? { id: row.reviewed_by_identity_id, legalName: row.reviewer_legal_name } : null,
    reviewReason: row.review_reason, requestedAt: row.requested_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null, appliedAt: row.applied_at?.toISOString() ?? null,
  };
}

async function lock(client: PoolClient) { await client.query("SELECT pg_advisory_xact_lock($1)", [PRIVACY_RIGHTS_LOCK]); }

async function requireCapability(client: PoolClient, identityId: string) {
  try { await requireAdministratorCapability(client, identityId, capability); }
  catch (error) {
    if (error instanceof AdministratorCapabilityError) throw new PrivacyRightsError("Privacy rights management capability is required.", "forbidden");
    throw error;
  }
}

async function verifiedRequester(client: PoolClient, identityId: string) {
  const result = await client.query<{ email_verified_at: Date | null; roles: string[] }>(
    `SELECT identity.email_verified_at,
            COALESCE(array_agg(role.role ORDER BY role.role) FILTER (WHERE role.role IS NOT NULL),'{}')::text[] AS roles
       FROM fractal.identities identity
       LEFT JOIN fractal.identity_role_assignments role ON role.identity_id=identity.id
        AND role.scope_type='global' AND role.revoked_at IS NULL
      WHERE identity.id=$1 AND identity.status='active'
      GROUP BY identity.id`, [identityId],
  );
  const row = result.rows[0];
  if (!row) throw new PrivacyRightsError("Active requester identity not found.", "not_found");
  if (!row.email_verified_at) throw new PrivacyRightsError("Verified email is required for privacy-rights intake.", "forbidden");
  const roles = row.roles.filter((role) => ["investor", "issuer", "professional", "operator", "admin"].includes(role));
  if (roles.length !== 1) throw new PrivacyRightsError("Exactly one active global actor role is required for privacy-rights intake.", "conflict");
  return { role: roles[0]!, emailVerifiedAt: row.email_verified_at };
}

async function readRequest(client: PoolClient, requestId: string, lockRow = false) {
  const result = await client.query<RequestRow>(`${requestSelect} WHERE request.id=$1${lockRow ? " FOR UPDATE OF request" : ""}`, [requestId]);
  if (!result.rows[0]) throw new PrivacyRightsError("Privacy-rights request not found.", "not_found");
  return result.rows[0];
}

export async function readPrivacyFulfillmentCoverage(
  client: PoolClient,
  requesterIdentityId: string,
  requestType: PrivacyRequestType,
  privacyRequestId?: string,
): Promise<FulfillmentCoverage> {
  const [hold, inventory] = await Promise.all([client.query<{ active: boolean; pending: boolean }>(
    `SELECT
       EXISTS (
         SELECT 1 FROM fractal.data_legal_holds hold_record
         WHERE hold_record.released_at IS NULL AND (
           (hold_record.target_type='identity' AND hold_record.target_id=$1)
           OR (hold_record.target_type='support_case' AND hold_record.target_id IN (SELECT id FROM fractal.support_cases WHERE requester_identity_id=$1))
           OR (hold_record.target_type='support_attachment' AND hold_record.target_id IN (
             SELECT attachment.id FROM fractal.support_case_attachments attachment
             JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id WHERE support_case.requester_identity_id=$1
           ))
           OR fractal.distribution_lifecycle_target_involves_identity(hold_record.target_type,hold_record.target_id,$1)
         )
       ) AS active,
       EXISTS (
         SELECT 1 FROM fractal.data_legal_hold_change_requests request
         WHERE request.change_type='impose' AND request.status='pending' AND (
           (request.target_type='identity' AND request.target_id=$1)
           OR (request.target_type='support_case' AND request.target_id IN (SELECT id FROM fractal.support_cases WHERE requester_identity_id=$1))
           OR (request.target_type='support_attachment' AND request.target_id IN (
             SELECT attachment.id FROM fractal.support_case_attachments attachment
             JOIN fractal.support_cases support_case ON support_case.id=attachment.case_id WHERE support_case.requester_identity_id=$1
           ))
           OR fractal.distribution_lifecycle_target_involves_identity(request.target_type,request.target_id,$1)
         )
       ) AS pending`,
    [requesterIdentityId],
  ), client.query<{
    authority_key: string; label: string; source_count: string; inventory_status: "catalogued" | "unresolved";
    right_status: "available" | "partial" | "unavailable" | "not_applicable"; blocker: string | null;
  }>(
    `WITH source_status AS (
       SELECT source.*,
              CASE
                WHEN source.source_kind<>'postgres_relation'
                 AND $2::uuid IS NOT NULL
                 AND EXISTS(
                   SELECT 1
                     FROM fractal.privacy_external_collection_snapshots snapshot
                     JOIN fractal.platform_configuration_active_versions adapter
                       ON adapter.configuration_key=snapshot.adapter_policy_configuration_key
                      AND adapter.active_version_id=snapshot.adapter_policy_version_id
                     JOIN fractal.platform_configuration_active_versions attestation
                       ON attestation.configuration_key=snapshot.attestation_configuration_key
                      AND attestation.active_version_id=snapshot.attestation_version_id
                    WHERE snapshot.privacy_request_id=$2
                      AND snapshot.requester_identity_id=$3
                      AND snapshot.request_type=$1
                      AND snapshot.source_key=source.source_key
                      AND snapshot.status='available'
                      AND snapshot.expires_at>now()
                 ) THEN 'available'
                ELSE CASE $1
                  WHEN 'access' THEN source.access_status
                  WHEN 'portability' THEN source.portability_status
                  WHEN 'correction' THEN source.correction_status
                  WHEN 'erasure' THEN source.erasure_status
                  WHEN 'restriction' THEN source.restriction_status
                  WHEN 'objection' THEN source.objection_status
                END
              END AS effective_right_status
         FROM fractal.privacy_data_sources source
     )
     SELECT authority.authority_key,authority.label,count(source.source_key)::text AS source_count,
            CASE WHEN bool_or(source.inventory_status='unresolved') THEN 'unresolved' ELSE 'catalogued' END AS inventory_status,
            CASE WHEN NOT authority.contains_personal_data THEN 'not_applicable'
                 WHEN bool_and(source.effective_right_status='available') THEN 'available'
                 WHEN bool_or(source.effective_right_status='available') THEN 'partial'
                 ELSE 'unavailable' END AS right_status,
            authority.blocker
       FROM fractal.privacy_data_authorities authority
       JOIN source_status source ON source.authority_key=authority.authority_key
      GROUP BY authority.authority_key,authority.label,authority.contains_personal_data,authority.blocker
      ORDER BY authority.authority_key`,
    [requestType, privacyRequestId ?? null, requesterIdentityId],
  )]);
  const authorities = inventory.rows.map((row) => ({
    key: row.authority_key, label: row.label, sourceCount: Number(row.source_count), inventoryStatus: row.inventory_status,
    rightStatus: row.right_status, blocker: row.blocker,
  }));
  const coveredAuthorities = authorities.filter((authority) => authority.rightStatus === "available").map((authority) => authority.key);
  const uncoveredAuthorities = authorities.filter((authority) => ["partial", "unavailable"].includes(authority.rightStatus)).map((authority) => authority.key);
  const complete = uncoveredAuthorities.length === 0 && authorities.every((authority) =>
    authority.inventoryStatus === "catalogued" && ["available", "not_applicable"].includes(authority.rightStatus));
  return {
    complete,
    schemaVersion: "privacy-fulfillment-inventory-v2",
    coveredAuthorities,
    uncoveredAuthorities,
    authorities,
    legalHold: { active: hold.rows[0]?.active === true, pendingImposition: hold.rows[0]?.pending === true },
    executionAvailable: complete,
  };
}

async function bindActiveResponsePolicy(client: PoolClient, request: RequestRow, boundAt: Date) {
  const binding = await readActivePlatformConfigurationForBinding(client, "privacy.rights.response_policy");
  if (!binding) return null;
  const policy = parsePrivacyRightsResponsePolicy(binding.value);
  const responseCalendarDays = policy.responseCalendarDays[request.request_type];
  const dueAt = new Date(request.created_at.getTime() + responseCalendarDays * 86_400_000);
  await client.query(
    `INSERT INTO fractal.privacy_rights_policy_bindings
      (privacy_request_id,policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,
       policy_reference,policy_name,jurisdiction,controller_name,identity_assurance,communication_channel,
       deadline_basis,response_calendar_days,request_created_at,due_at,bound_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'authenticated_verified_email_session',$10,$11,$12,$13,$14,$15)`,
    [request.id, binding.versionId, binding.versionNumber, binding.projectionVersion, binding.valueSha256,
      policy.policyReference, policy.policyName, policy.jurisdiction, policy.controllerName, policy.communicationChannel,
      policy.deadlineBasis, responseCalendarDays, request.created_at, dueAt, boundAt],
  );
  return { versionId: binding.versionId, dueAt, policyReference: policy.policyReference };
}

async function appendEvent(client: PoolClient, input: {
  request: RequestRow; actorIdentityId: string; eventType: string; toStatus: PrivacyRequestStatus; assigneeIdentityId: string | null;
  decisionRequestId?: string | null; visibility: "requester" | "internal"; message: string; occurredAt: Date;
}) {
  const sequence = input.request.version + 1;
  await client.query(
    `INSERT INTO fractal.privacy_rights_request_events
      (id,privacy_request_id,sequence,event_type,from_status,to_status,from_assignee_identity_id,assignee_identity_id,decision_request_id,actor_identity_id,visibility,message,occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [randomUUID(), input.request.id, sequence, input.eventType, input.request.status, input.toStatus, input.request.assigned_to_identity_id,
      input.assigneeIdentityId, input.decisionRequestId ?? null, input.actorIdentityId, input.visibility, input.message, input.occurredAt],
  );
  await client.query(
    `UPDATE fractal.privacy_rights_requests SET status=$2,assigned_to_identity_id=$3,current_decision_request_id=$4,
       version=$5,last_activity_at=$6 WHERE id=$1`,
    [input.request.id, input.toStatus, input.assigneeIdentityId, input.decisionRequestId ?? null, sequence, input.occurredAt],
  );
}

async function emit(client: PoolClient, input: { requestId: string; actorIdentityId: string; action: string; reason: string; payload: Record<string, unknown> }) {
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `privacy-request:${input.requestId}`, actorId: input.actorIdentityId, actorType: "user", action: input.action,
    entityType: "privacy_rights_request", entityId: input.requestId, reason: input.reason, payload: input.payload,
  });
  await appendOutboxEvent(client, { aggregateType: "privacy_rights_request", aggregateId: input.requestId, eventType: input.action, payload: { ...input.payload, auditEventId: audit.id } });
}

export async function createPrivacyRightsRequest(input: { actorIdentityId: string; requestType: PrivacyRequestType; details: string; commandKey: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client);
    const requester = await verifiedRequester(client, input.actorIdentityId);
    const details = normalized(input.details, "Request details", 20, 5_000);
    const key = normalized(input.commandKey, "Command key", 1, 200);
    const replay = await client.query<RequestRow>(`${requestSelect} WHERE request.requester_identity_id=$1 AND request.command_key=$2`, [input.actorIdentityId, key]);
    if (replay.rows[0]) {
      if (replay.rows[0].request_type !== input.requestType || replay.rows[0].details !== details) throw new PrivacyRightsError("This command key was already used for a different privacy request.", "conflict");
      return { request: mapRequest(replay.rows[0]), replayed: true };
    }
    const active = await client.query("SELECT 1 FROM fractal.privacy_rights_requests WHERE requester_identity_id=$1 AND request_type=$2 AND status NOT IN ('refused','withdrawn')", [input.actorIdentityId, input.requestType]);
    if (active.rowCount) throw new PrivacyRightsError("An active request of this type already exists.", "conflict");
    const id = randomUUID(); const now = new Date();
    await client.query(
      `INSERT INTO fractal.privacy_rights_requests
        (id,reference,requester_identity_id,requester_role,request_type,details,identity_assurance,email_verified_at_snapshot,command_key,created_at,last_activity_at)
       VALUES ($1,$2,$3,$4,$5,$6,'authenticated_verified_email_session',$7,$8,$9,$9)`,
      [id, reference("PRV"), input.actorIdentityId, requester.role, input.requestType, details, requester.emailVerifiedAt, key, now],
    );
    const openingRequest = await readRequest(client, id);
    const policyBinding = await bindActiveResponsePolicy(client, openingRequest, now);
    await client.query(
      `INSERT INTO fractal.privacy_rights_request_events
        (id,privacy_request_id,sequence,event_type,to_status,actor_identity_id,visibility,message,occurred_at)
       VALUES ($1,$2,1,'opened','submitted',$3,'requester',$4,$5)`, [randomUUID(), id, input.actorIdentityId, details, now],
    );
    await emit(client, { requestId: id, actorIdentityId: input.actorIdentityId, action: "privacy.request.opened", reason: "An authenticated identity opened a privacy-rights request.", payload: { requestType: input.requestType, requesterRole: requester.role, policyBound: policyBinding !== null, policyVersionId: policyBinding?.versionId ?? null } });
    return { request: mapRequest(await readRequest(client, id)), replayed: false };
  });
}

export async function bindPrivacyRightsResponsePolicy(input: { actorIdentityId: string; requestId: string; expectedVersion: number }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const request = await readRequest(client, input.requestId, true);
    if (request.version !== input.expectedVersion) throw new PrivacyRightsError("The request changed; reload before binding its response policy.", "conflict");
    if (["decision_pending", "approved", "partially_approved", "refused", "withdrawn"].includes(request.status)) {
      throw new PrivacyRightsError("A response policy cannot be attached after independent review or closure.", "conflict");
    }
    if (request.bound_policy_version_id) return { request: mapRequest(request), replayed: true };
    const boundAt = new Date();
    const binding = await bindActiveResponsePolicy(client, request, boundAt);
    if (!binding) throw new PrivacyRightsError("No approved privacy response policy is active.", "policy_unavailable");
    await emit(client, {
      requestId: request.id, actorIdentityId: input.actorIdentityId, action: "privacy.request.policy_bound",
      reason: "A capable privacy administrator bound the exact active response policy to an existing request.",
      payload: { policyVersionId: binding.versionId, policyReference: binding.policyReference, dueAt: binding.dueAt.toISOString() },
    });
    return { request: mapRequest(await readRequest(client, request.id)), replayed: false };
  });
}

export async function listOwnPrivacyRightsRequests(input: { actorIdentityId: string }) {
  const result = await requirePostgres().query<RequestRow>(`${requestSelect} WHERE request.requester_identity_id=$1 ORDER BY request.last_activity_at DESC,request.id DESC LIMIT 100`, [input.actorIdentityId]);
  return { requests: result.rows.map(mapRequest) };
}

async function detail(client: PoolClient, request: RequestRow, staff: boolean) {
  const events = await client.query<EventRow>(`${eventSelect} WHERE event.privacy_request_id=$1 ${staff ? "" : "AND event.visibility='requester'"} ORDER BY event.sequence`, [request.id]);
  const decisions = await client.query<DecisionRow>(`${decisionSelect} WHERE decision.privacy_request_id=$1 ${staff ? "" : "AND decision.status='applied'"} ORDER BY decision.requested_at,decision.id`, [request.id]);
  return { request: mapRequest(request), events: events.rows.map(mapEvent), decisions: decisions.rows.map(mapDecision),
    distributionTreatments: await listDistributionPrivacyTreatments(client, request.id, staff),
    fulfillmentCoverage: await readPrivacyFulfillmentCoverage(client, request.requester_identity_id, request.request_type, request.id) };
}

export async function getOwnPrivacyRightsRequest(input: { actorIdentityId: string; requestId: string }) {
  return withPostgresTransaction(async (client) => {
    const request = await readRequest(client, input.requestId);
    if (request.requester_identity_id !== input.actorIdentityId) throw new PrivacyRightsError("Privacy-rights request not found.", "not_found");
    return detail(client, request, false);
  });
}

export async function replyToPrivacyRightsRequest(input: { actorIdentityId: string; requestId: string; message: string; expectedVersion: number }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); const request = await readRequest(client, input.requestId, true);
    if (request.requester_identity_id !== input.actorIdentityId) throw new PrivacyRightsError("Privacy-rights request not found.", "not_found");
    if (request.version !== input.expectedVersion) throw new PrivacyRightsError("The request changed; reload before replying.", "conflict");
    if (request.status !== "awaiting_requester") throw new PrivacyRightsError("This request is not waiting for requester information.", "conflict");
    const message = normalized(input.message, "Requester reply", 2, 5_000); const now = new Date();
    await appendEvent(client, { request, actorIdentityId: input.actorIdentityId, eventType: "requester_replied", toStatus: "in_review", assigneeIdentityId: request.assigned_to_identity_id, visibility: "requester", message, occurredAt: now });
    await emit(client, { requestId: request.id, actorIdentityId: input.actorIdentityId, action: "privacy.request.requester_replied", reason: "The requester supplied additional information.", payload: { sequence: request.version + 1 } });
    return { request: mapRequest(await readRequest(client, request.id)) };
  });
}

export async function withdrawPrivacyRightsRequest(input: { actorIdentityId: string; requestId: string; reason: string; expectedVersion: number }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); const request = await readRequest(client, input.requestId, true);
    if (request.requester_identity_id !== input.actorIdentityId) throw new PrivacyRightsError("Privacy-rights request not found.", "not_found");
    if (request.version !== input.expectedVersion) throw new PrivacyRightsError("The request changed; reload before withdrawing.", "conflict");
    if (!["submitted", "in_review", "awaiting_requester"].includes(request.status)) throw new PrivacyRightsError("This request can no longer be withdrawn through self-service.", "conflict");
    const reason = normalized(input.reason, "Withdrawal reason", 10, 2_000); const now = new Date();
    await appendEvent(client, { request, actorIdentityId: input.actorIdentityId, eventType: "withdrawn", toStatus: "withdrawn", assigneeIdentityId: null, visibility: "requester", message: reason, occurredAt: now });
    await emit(client, { requestId: request.id, actorIdentityId: input.actorIdentityId, action: "privacy.request.withdrawn", reason: "The authenticated requester withdrew the request.", payload: { priorStatus: request.status } });
    return { request: mapRequest(await readRequest(client, request.id)) };
  });
}

export async function listAdministratorPrivacyRightsRequests(input: { actorIdentityId: string; status?: PrivacyRequestStatus; requestType?: PrivacyRequestType }) {
  return withPostgresTransaction(async (client) => {
    await requireCapability(client, input.actorIdentityId);
    const result = await client.query<RequestRow>(`${requestSelect} WHERE ($1::text IS NULL OR request.status=$1) AND ($2::text IS NULL OR request.request_type=$2) ORDER BY request.created_at,request.id LIMIT 250`, [input.status ?? null, input.requestType ?? null]);
    return { requests: result.rows.map(mapRequest) };
  });
}

export async function getAdministratorPrivacyDataInventory(input: { actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireCapability(client, input.actorIdentityId);
    const result = await client.query<{
      authority_key: string; authority_label: string; authority_description: string; authority_contains_personal_data: boolean;
      rights_applicability: PrivacyRequestType[]; authority_blocker: string | null; source_key: string; source_kind: string;
      source_locator: string; source_contains_personal_data: boolean; subject_linkage: string; data_categories: string[];
      inventory_status: "catalogued" | "unresolved"; access_status: string; portability_status: string; correction_status: string;
      erasure_status: string; restriction_status: string; objection_status: string; retention_policy_status: string;
      hold_coverage_status: string; source_blocker: string | null;
    }>(
      `SELECT authority.authority_key,authority.label AS authority_label,authority.description AS authority_description,
              authority.contains_personal_data AS authority_contains_personal_data,authority.rights_applicability,authority.blocker AS authority_blocker,
              source.source_key,source.source_kind,source.source_locator,source.contains_personal_data AS source_contains_personal_data,
              source.subject_linkage,source.data_categories,source.inventory_status,source.access_status,source.portability_status,
              source.correction_status,source.erasure_status,source.restriction_status,source.objection_status,
              source.retention_policy_status,source.hold_coverage_status,source.blocker AS source_blocker
         FROM fractal.privacy_data_authorities authority
         JOIN fractal.privacy_data_sources source ON source.authority_key=authority.authority_key
        ORDER BY authority.authority_key,source.source_kind,source.source_key`,
    );
    const authorities = new Map<string, {
      key: string; label: string; description: string; containsPersonalData: boolean; rightsApplicability: PrivacyRequestType[];
      blocker: string | null; sources: Array<Record<string, unknown>>;
    }>();
    for (const row of result.rows) {
      const authority = authorities.get(row.authority_key) ?? {
        key: row.authority_key, label: row.authority_label, description: row.authority_description,
        containsPersonalData: row.authority_contains_personal_data, rightsApplicability: row.rights_applicability,
        blocker: row.authority_blocker, sources: [],
      };
      authority.sources.push({
        key: row.source_key, kind: row.source_kind, locator: row.source_locator, containsPersonalData: row.source_contains_personal_data,
        subjectLinkage: row.subject_linkage, dataCategories: row.data_categories, inventoryStatus: row.inventory_status,
        rightsStatus: {
          access: row.access_status, portability: row.portability_status, correction: row.correction_status,
          erasure: row.erasure_status, restriction: row.restriction_status, objection: row.objection_status,
        },
        retentionPolicyStatus: row.retention_policy_status, holdCoverageStatus: row.hold_coverage_status, blocker: row.source_blocker,
      });
      authorities.set(row.authority_key, authority);
    }
    const values = [...authorities.values()];
    const externalAdapter = await readActiveExternalPrivacyAdapterPolicyForBinding(client);
    const externalAttestation = externalAdapter
      ? await readActiveExternalPrivacyAttestationReadiness(client, {
        policy: externalAdapter.policy,
        policyBinding: externalAdapter.binding,
      })
      : {
        status: "not_activated" as const,
        versionId: null,
        versionNumber: null,
        projectionVersion: null,
        valueSha256: null,
        setReference: null,
        validSourceCount: 0,
        invalidSourceKeys: [] as string[],
        earliestExpiryAt: null,
        configurationErrorCount: 0,
        sources: [] as Array<{ sourceKey: string; status: string; failures: string[]; reason: string; expiresAt?: string }>,
        blocksAvailability: true,
      };
    const externalAdapterPolicy = externalAdapter ? {
      status: externalAdapter.runtime.runtimeCompatibleSourceCount === externalAdapter.runtime.contractSourceCount
        ? externalAttestation.validSourceCount === externalAdapter.runtime.contractSourceCount
          ? "runtime_compatible_attested" as const
          : "runtime_compatible_unattested" as const
        : "active_contract_only" as const,
      versionId: externalAdapter.binding.versionId,
      versionNumber: externalAdapter.binding.versionNumber,
      projectionVersion: externalAdapter.binding.projectionVersion,
      valueSha256: externalAdapter.binding.valueSha256,
      policyReference: externalAdapter.policy.policyReference,
      jurisdictionCode: externalAdapter.policy.jurisdictionCode,
      contractSourceCount: externalAdapter.runtime.contractSourceCount,
      runtimeCompatibleSourceCount: externalAdapter.runtime.runtimeCompatibleSourceCount,
      liveAttestedSourceCount: externalAttestation.validSourceCount,
      missingRuntimeSourceKeys: externalAdapter.runtime.missingRuntimeSourceKeys,
      mismatchedRuntimeSourceKeys: externalAdapter.runtime.mismatchedRuntimeSourceKeys,
      coverageMissingSourceKeys: externalAdapter.runtime.coverageMissingSourceKeys,
      coverageMismatchedRuntimeSourceKeys:
        externalAdapter.runtime.coverageMismatchedRuntimeSourceKeys,
      duplicateRuntimeSourceKeys: externalAdapter.runtime.duplicateRuntimeSourceKeys,
      blocksAvailability: true,
    } : {
      status: "not_activated" as const,
      versionId: null,
      versionNumber: null,
      projectionVersion: null,
      valueSha256: null,
      policyReference: null,
      jurisdictionCode: null,
      contractSourceCount: 0,
      runtimeCompatibleSourceCount: 0,
      liveAttestedSourceCount: 0,
      missingRuntimeSourceKeys: [],
      mismatchedRuntimeSourceKeys: [],
      coverageMissingSourceKeys: [],
      coverageMismatchedRuntimeSourceKeys: [],
      duplicateRuntimeSourceKeys: [],
      blocksAvailability: true,
    };
    return {
      schemaVersion: "privacy-data-source-inventory-v1",
      summary: {
        authorityCount: values.length, sourceCount: result.rows.length,
        postgresRelationCount: result.rows.filter((row) => row.source_kind === "postgres_relation").length,
        externalSourceCount: result.rows.filter((row) => row.source_kind !== "postgres_relation").length,
        unresolvedSourceCount: result.rows.filter((row) => row.inventory_status === "unresolved").length,
        accessReadySourceCount: result.rows.filter((row) => row.access_status === "available").length,
        portabilityReadySourceCount: result.rows.filter((row) => row.portability_status === "available").length,
        executionReadySourceCount: result.rows.filter((row) => row.correction_status === "available" && row.erasure_status === "available"
          && row.restriction_status === "available" && row.objection_status === "available").length,
      },
      externalAdapterPolicy,
      externalAttestation,
      authorities: values,
    };
  });
}

export async function getAdministratorPrivacyRightsRequest(input: { actorIdentityId: string; requestId: string }) {
  return withPostgresTransaction(async (client) => { await requireCapability(client, input.actorIdentityId); return detail(client, await readRequest(client, input.requestId), true); });
}

export async function transitionAdministratorPrivacyRightsRequest(input: { actorIdentityId: string; requestId: string; action: "begin_review" | "request_information" | "note"; message: string; expectedVersion: number }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId); const request = await readRequest(client, input.requestId, true);
    if (request.version !== input.expectedVersion) throw new PrivacyRightsError("The request changed; reload before recording a transition.", "conflict");
    const message = normalized(input.message, "Transition evidence", input.action === "note" ? 2 : 10, 5_000); const now = new Date();
    if (input.action === "begin_review" && request.status !== "submitted") throw new PrivacyRightsError("Only a submitted request can enter review.", "conflict");
    if (input.action !== "begin_review" && request.status !== "in_review") throw new PrivacyRightsError("This action requires a request in review.", "conflict");
    if (request.assigned_to_identity_id && request.assigned_to_identity_id !== input.actorIdentityId) throw new PrivacyRightsError("Only the assigned privacy owner can change this request.", "forbidden");
    const eventType = input.action === "begin_review" ? "review_started" : input.action === "request_information" ? "information_requested" : "staff_note";
    const toStatus: PrivacyRequestStatus = input.action === "request_information" ? "awaiting_requester" : input.action === "begin_review" ? "in_review" : request.status;
    const visibility = input.action === "note" ? "internal" as const : "requester" as const;
    await appendEvent(client, { request, actorIdentityId: input.actorIdentityId, eventType, toStatus, assigneeIdentityId: request.assigned_to_identity_id ?? input.actorIdentityId, visibility, message, occurredAt: now });
    await emit(client, { requestId: request.id, actorIdentityId: input.actorIdentityId, action: `privacy.request.${eventType}`, reason: "A capable privacy administrator recorded a governed request transition.", payload: { fromStatus: request.status, toStatus, visibility } });
    return { request: mapRequest(await readRequest(client, request.id)) };
  });
}

export async function proposePrivacyRightsDecision(input: { actorIdentityId: string; requestId: string; outcome: PrivacyDecisionOutcome; decisionSummary: string; lawfulBasis: string; scopeOutcomes: PrivacyScopeOutcome[]; commandKey: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const summary = normalized(input.decisionSummary, "Decision summary", 20, 5_000);
    const lawfulBasis = normalized(input.lawfulBasis, "Lawful-basis explanation", 20, 2_000);
    const key = normalized(input.commandKey, "Command key", 1, 200);
    const scopeOutcomes = validatedScopeOutcomes(input.outcome, input.scopeOutcomes);
    const replay = await client.query<DecisionRow>(`${decisionSelect} WHERE decision.requested_by_identity_id=$1 AND decision.command_key=$2`, [input.actorIdentityId, key]);
    if (replay.rows[0]) {
      const prior = replay.rows[0];
      if (prior.privacy_request_id !== input.requestId || prior.outcome !== input.outcome || prior.decision_summary !== summary
        || prior.lawful_basis !== lawfulBasis || JSON.stringify(prior.scope_outcomes) !== JSON.stringify(scopeOutcomes)) {
        throw new PrivacyRightsError("This command key was already used for a different privacy decision.", "conflict");
      }
      return { decision: mapDecision(prior), replayed: true };
    }
    const request = await readRequest(client, input.requestId, true);
    if (request.status !== "in_review") throw new PrivacyRightsError("A decision can only be proposed while the request is in review.", "conflict");
    if (request.assigned_to_identity_id !== input.actorIdentityId) throw new PrivacyRightsError("Only the assigned privacy owner can propose the outcome.", "forbidden");
    const pending = await client.query("SELECT 1 FROM fractal.privacy_rights_decision_requests WHERE privacy_request_id=$1 AND status='pending'", [request.id]);
    if (pending.rowCount) throw new PrivacyRightsError("A decision is already pending independent review.", "conflict");
    const decisionId = randomUUID(); const now = new Date(); const fulfillmentCoverage = await readPrivacyFulfillmentCoverage(client, request.requester_identity_id, request.request_type, request.id);
    await client.query(
      `INSERT INTO fractal.privacy_rights_decision_requests
        (id,reference,privacy_request_id,outcome,decision_summary,lawful_basis,scope_outcomes,fulfillment_coverage,command_key,requested_by_identity_id,requested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [decisionId, reference("PRD"), request.id, input.outcome, summary, lawfulBasis, JSON.stringify(scopeOutcomes), JSON.stringify(fulfillmentCoverage), key, input.actorIdentityId, now],
    );
    await appendEvent(client, { request, actorIdentityId: input.actorIdentityId, eventType: "decision_proposed", toStatus: "decision_pending", assigneeIdentityId: request.assigned_to_identity_id, decisionRequestId: decisionId, visibility: "internal", message: summary, occurredAt: now });
    await emit(client, { requestId: request.id, actorIdentityId: input.actorIdentityId, action: "privacy.request.decision_proposed", reason: "A structured privacy outcome was submitted for independent review.", payload: { decisionRequestId: decisionId, outcome: input.outcome, coverageComplete: fulfillmentCoverage.complete, legalHold: fulfillmentCoverage.legalHold } });
    const decision = await client.query<DecisionRow>(`${decisionSelect} WHERE decision.id=$1`, [decisionId]);
    return { decision: mapDecision(decision.rows[0]!), replayed: false };
  });
}

export async function decidePrivacyRightsDecision(input: { actorIdentityId: string; decisionRequestId: string; decision: "approve" | "reject"; reviewReason: string }) {
  return withPostgresTransaction(async (client) => {
    await lock(client); await requireCapability(client, input.actorIdentityId);
    const reviewReason = normalized(input.reviewReason, "Review reason", 20, 2_000);
    const result = await client.query<DecisionRow>(`${decisionSelect} WHERE decision.id=$1 FOR UPDATE OF decision`, [input.decisionRequestId]);
    const decision = result.rows[0]; if (!decision) throw new PrivacyRightsError("Privacy decision request not found.", "not_found");
    const desired = input.decision === "approve" ? "applied" : "rejected";
    if (decision.status !== "pending") {
      if (decision.status === desired && decision.reviewed_by_identity_id === input.actorIdentityId && decision.review_reason === reviewReason) return { decision: mapDecision(decision), replayed: true };
      throw new PrivacyRightsError("This decision request already has a different terminal outcome.", "conflict");
    }
    if (decision.requested_by_identity_id === input.actorIdentityId) throw new PrivacyRightsError("The proposer cannot review the same privacy outcome.", "forbidden");
    const request = await readRequest(client, decision.privacy_request_id, true);
    if (request.status !== "decision_pending" || request.current_decision_request_id !== decision.id) throw new PrivacyRightsError("The privacy request is no longer waiting for this decision.", "conflict");
    if (input.decision === "approve") {
      const currentCoverage = await readPrivacyFulfillmentCoverage(client, request.requester_identity_id, request.request_type, request.id);
      const coverageMatch = await client.query<{ matches: boolean }>("SELECT $1::jsonb=$2::jsonb AS matches", [JSON.stringify(currentCoverage), JSON.stringify(decision.fulfillment_coverage)]);
      if (coverageMatch.rows[0]?.matches !== true) {
        throw new PrivacyRightsError("Privacy fulfillment coverage changed; reject and submit a fresh outcome for review.", "conflict");
      }
    }
    const now = new Date();
    await client.query(`UPDATE fractal.privacy_rights_decision_requests SET status=$2,reviewed_by_identity_id=$3,review_reason=$4,reviewed_at=$5,applied_at=$6 WHERE id=$1`,
      [decision.id, desired, input.actorIdentityId, reviewReason, now, input.decision === "approve" ? now : null]);
    const toStatus: PrivacyRequestStatus = input.decision === "reject" ? "in_review" : decision.outcome === "approve" ? "approved" : decision.outcome === "partially_approve" ? "partially_approved" : "refused";
    const eventType = input.decision === "approve" ? "decision_approved" : "decision_rejected";
    const message = input.decision === "approve" ? decision.decision_summary : reviewReason;
    await appendEvent(client, { request, actorIdentityId: input.actorIdentityId, eventType, toStatus, assigneeIdentityId: request.assigned_to_identity_id, decisionRequestId: decision.id, visibility: "requester", message, occurredAt: now });
    await emit(client, { requestId: request.id, actorIdentityId: input.actorIdentityId, action: `privacy.request.${eventType}`, reason: "An independent capable administrator reviewed the proposed privacy outcome.", payload: { decisionRequestId: decision.id, outcome: decision.outcome, reviewDecision: input.decision, toStatus, coverageComplete: decision.fulfillment_coverage.complete } });
    const updated = await client.query<DecisionRow>(`${decisionSelect} WHERE decision.id=$1`, [decision.id]);
    return { decision: mapDecision(updated.rows[0]!), replayed: false };
  });
}
