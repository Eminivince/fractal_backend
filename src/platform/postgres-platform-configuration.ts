import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { env } from "../config/env.js";
import { requirePostgres, withPostgresTransaction } from "../db/postgres.js";
import { hashPayload, stableJsonStringify } from "../utils/idempotency.js";
import { requireAdministratorCapability } from "./postgres-administrator-capabilities.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { runPostgresIdempotentCommand } from "./postgres-idempotency.js";
import { appendOutboxEvent } from "./postgres-outbox.js";
import { validateSupportCaseServicePolicy } from "../modules/support/domain/support-service-policy.js";
import { validateSupportCaseDataPolicy } from "../modules/support/domain/support-data-policy.js";
import { validatePrivacyRightsResponsePolicy } from "../modules/privacy/domain/privacy-rights-policy.js";
import { validatePrivacyPackagePolicy } from "../modules/privacy/domain/privacy-package-policy.js";
import { validatePrivacyContentProfile } from "../modules/privacy/domain/privacy-content-profile.js";
import {
  parsePrivacyExternalAdapterPolicy,
  validatePrivacyExternalAdapterPolicy,
} from "../modules/privacy/domain/privacy-external-adapter-policy.js";
import {
  evaluatePrivacyExternalAttestationSet,
  parseExternalPrivacyAttestationKeyRing,
  validatePrivacyExternalAttestationSet,
} from "../modules/privacy/domain/privacy-external-attestation-set.js";
import { validateOrganizationDocumentRetentionPolicy } from "../modules/offerings/domain/organization-document-retention-policy.js";
import { validateOfferingNoticePolicy } from "../modules/offerings/domain/offering-notice-policy.js";
import { validateDistributionPolicy } from "../modules/distributions/domain/distribution-policy.js";
import { validateDistributionLifecyclePolicy } from "../modules/distributions/domain/distribution-lifecycle-policy.js";
import { externalPrivacyAdapterRuntimeRegistry } from "./privacy-external-adapter-registry.js";

const EXTERNAL_ADAPTER_POLICY_KEY = "privacy.external_source.adapter_policy";
const EXTERNAL_ATTESTATION_SET_KEY = "privacy.external_source.attestation_set";

export type PlatformConfigurationValueType = "boolean" | "integer" | "decimal" | "string" | "json";
export type PlatformConfigurationStatus = "validation_failed" | "pending" | "rejected" | "scheduled" | "active" | "superseded" | "failed";

export class PlatformConfigurationError extends Error {
  constructor(
    message: string,
    readonly code: "not_found" | "forbidden" | "conflict" | "invalid_input" | "invalid_state" | "stale_version",
  ) {
    super(message);
    this.name = "PlatformConfigurationError";
  }
}

interface DefinitionRow {
  configuration_key: string;
  label: string;
  description: string;
  value_type: PlatformConfigurationValueType;
  validation_schema: Record<string, unknown>;
  consumer_binding: "next_request" | "new_session" | "new_case" | "new_agreement" | "new_calculation";
  status: "active" | "retired";
}

interface VersionRow {
  id: string;
  configuration_key: string;
  version_number: number;
  state_version: number;
  status: PlatformConfigurationStatus;
  proposed_value: unknown;
  value_sha256: string;
  validation_output: Record<string, unknown>;
  impact_preview: Record<string, unknown>;
  reason: string;
  proposed_by_identity_id: string;
  proposer_legal_name: string;
  proposer_email: string;
  reviewed_by_identity_id: string | null;
  reviewer_legal_name: string | null;
  reviewer_email: string | null;
  decision_reason: string | null;
  effective_at: Date;
  proposed_at: Date;
  reviewed_at: Date | null;
  activated_at: Date | null;
  superseded_at: Date | null;
  supersedes_version_id: string | null;
  rollback_of_version_id: string | null;
  failure_code: string | null;
  failure_detail: string | null;
}

interface EventRow {
  id: string;
  configuration_version_id: string;
  sequence: number;
  event_type: string;
  from_status: string | null;
  to_status: string;
  actor_type: "user" | "system";
  actor_identity_id: string | null;
  actor_legal_name: string | null;
  reason: string;
  evidence: Record<string, unknown>;
  occurred_at: Date;
}

const versionSelect = `
  SELECT version.*,
         proposer.legal_name AS proposer_legal_name, proposer.email AS proposer_email,
         reviewer.legal_name AS reviewer_legal_name, reviewer.email AS reviewer_email
    FROM fractal.platform_configuration_versions version
    JOIN fractal.identities proposer ON proposer.id = version.proposed_by_identity_id
    LEFT JOIN fractal.identities reviewer ON reviewer.id = version.reviewed_by_identity_id`;

function mapIdentity(id: string, legalName: string, email: string) {
  return { id, legalName, email };
}

function mapVersion(row: VersionRow) {
  return {
    id: row.id,
    configurationKey: row.configuration_key,
    versionNumber: row.version_number,
    stateVersion: row.state_version,
    status: row.status,
    proposedValue: row.proposed_value,
    valueSha256: row.value_sha256,
    validationOutput: row.validation_output,
    impactPreview: row.impact_preview,
    reason: row.reason,
    proposedBy: mapIdentity(row.proposed_by_identity_id, row.proposer_legal_name, row.proposer_email),
    reviewedBy: row.reviewed_by_identity_id && row.reviewer_legal_name && row.reviewer_email
      ? mapIdentity(row.reviewed_by_identity_id, row.reviewer_legal_name, row.reviewer_email)
      : null,
    decisionReason: row.decision_reason,
    effectiveAt: row.effective_at.toISOString(),
    proposedAt: row.proposed_at.toISOString(),
    reviewedAt: row.reviewed_at?.toISOString() ?? null,
    activatedAt: row.activated_at?.toISOString() ?? null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
    supersedesVersionId: row.supersedes_version_id,
    rollbackOfVersionId: row.rollback_of_version_id,
    failureCode: row.failure_code,
    failureDetail: row.failure_detail,
  };
}

function mapEvent(row: EventRow) {
  return {
    id: row.id,
    configurationVersionId: row.configuration_version_id,
    sequence: row.sequence,
    eventType: row.event_type,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    actorType: row.actor_type,
    actor: row.actor_identity_id && row.actor_legal_name ? { id: row.actor_identity_id, legalName: row.actor_legal_name } : null,
    reason: row.reason,
    evidence: row.evidence,
    occurredAt: row.occurred_at.toISOString(),
  };
}

async function definitionForUpdate(client: PoolClient, configurationKey: string): Promise<DefinitionRow> {
  const result = await client.query<DefinitionRow>(
    `SELECT configuration_key, label, description, value_type, validation_schema, consumer_binding, status
       FROM fractal.platform_configuration_definitions
      WHERE configuration_key = $1
      FOR UPDATE`,
    [configurationKey],
  );
  const definition = result.rows[0];
  if (!definition) throw new PlatformConfigurationError("Platform configuration definition not found.", "not_found");
  if (definition.status !== "active") throw new PlatformConfigurationError("This platform configuration definition is retired.", "invalid_state");
  return definition;
}

function text(value: string, label: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 10 || trimmed.length > 2_000) {
    throw new PlatformConfigurationError(`${label} must contain 10 to 2000 characters.`, "invalid_input");
  }
  return trimmed;
}

async function requireConfigurationCapability(client: PoolClient, identityId: string, configurationKey: string): Promise<void> {
  await requireAdministratorCapability(client, identityId, "platform_configuration_manage");
  if (configurationKey === EXTERNAL_ADAPTER_POLICY_KEY || configurationKey === EXTERNAL_ATTESTATION_SET_KEY) {
    await requireAdministratorCapability(client, identityId, "privacy_source_manage");
  }
}

function validateValue(definition: DefinitionRow, value: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  if (definition.value_type === "boolean" && typeof value !== "boolean") errors.push("Value must be a boolean.");
  if (definition.value_type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value))) errors.push("Value must be a safe integer.");
  if (definition.value_type === "decimal" && (typeof value !== "number" || !Number.isFinite(value))) errors.push("Value must be a finite number.");
  if (definition.value_type === "string" && typeof value !== "string") errors.push("Value must be a string.");
  if (definition.value_type === "json" && (!value || typeof value !== "object")) errors.push("Value must be a JSON object or array.");

  const schema = definition.validation_schema;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`Value must be at least ${schema.minimum}.`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`Value must be no more than ${schema.maximum}.`);
  }
  if (typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) errors.push(`Value must contain at least ${schema.minLength} characters.`);
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) errors.push(`Value must contain no more than ${schema.maxLength} characters.`);
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`Value must be one of: ${schema.enum.join(", ")}.`);
  }
  if (definition.configuration_key === "support.case.service_policy") {
    errors.push(...validateSupportCaseServicePolicy(value));
  }
  if (definition.configuration_key === "support.case.data_policy") {
    errors.push(...validateSupportCaseDataPolicy(value));
  }
  if (definition.configuration_key === "privacy.rights.response_policy") {
    errors.push(...validatePrivacyRightsResponsePolicy(value));
  }
  if (definition.configuration_key === "privacy.rights.package_policy") {
    errors.push(...validatePrivacyPackagePolicy(value));
  }
  if (definition.configuration_key === "privacy.rights.content_profile") {
    errors.push(...validatePrivacyContentProfile(value));
  }
  if (definition.configuration_key === "privacy.external_source.adapter_policy") {
    errors.push(...validatePrivacyExternalAdapterPolicy(value));
  }
  if (definition.configuration_key === EXTERNAL_ATTESTATION_SET_KEY) {
    errors.push(...validatePrivacyExternalAttestationSet(value));
  }
  if (definition.configuration_key === "organization.document.retention_policy") {
    errors.push(...validateOrganizationDocumentRetentionPolicy(value));
  }
  if (definition.configuration_key === "offering.notice.policy") {
    errors.push(...validateOfferingNoticePolicy(value));
  }
  if (definition.configuration_key === "offering.distribution.policy") {
    errors.push(...validateDistributionPolicy(value));
  }
  if (definition.configuration_key === "privacy.distribution.lifecycle_policy") {
    errors.push(...validateDistributionLifecyclePolicy(value));
  }
  try { stableJsonStringify(value); } catch { errors.push("Value cannot be represented as canonical JSON."); }
  return { valid: errors.length === 0, errors };
}

async function validateConfigurationBindings(
  client: PoolClient,
  configurationKey: string,
  value: unknown,
  checkedAt: Date,
): Promise<string[]> {
  if (configurationKey !== EXTERNAL_ATTESTATION_SET_KEY) return [];
  const policyBinding = await readActivePlatformConfigurationForBinding(client, EXTERNAL_ADAPTER_POLICY_KEY);
  if (!policyBinding) return ["An active external adapter policy is required before an attestation set can be accepted."];
  let policy;
  try {
    policy = parsePrivacyExternalAdapterPolicy(policyBinding.value);
  } catch {
    return ["The active external adapter policy does not satisfy its governed schema."];
  }
  const parsedKeyRing = parseExternalPrivacyAttestationKeyRing(env.PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON);
  const evaluation = evaluatePrivacyExternalAttestationSet({
    value,
    policy,
    policyBinding: {
      configurationKey: EXTERNAL_ADAPTER_POLICY_KEY,
      versionId: policyBinding.versionId,
      versionNumber: policyBinding.versionNumber,
      projectionVersion: policyBinding.projectionVersion,
      valueSha256: policyBinding.valueSha256,
    },
    runtimeRegistry: externalPrivacyAdapterRuntimeRegistry,
    applicationReleaseSha256: env.APPLICATION_RELEASE_SHA256,
    keyRing: parsedKeyRing.keyRing,
    keyRingErrors: parsedKeyRing.errors,
    now: checkedAt,
  });
  const errors = [...evaluation.errors];
  const fatalFailures = new Set([
    "policy_mismatch",
    "policy_coverage_missing",
    "coverage_mismatch",
    "key_unknown",
    "key_revoked",
    "key_invalid",
    "signature_invalid",
    "not_yet_valid",
    "expired",
    "stale",
  ]);
  for (const source of evaluation.sources) {
    if (source.failures.some((failure) => fatalFailures.has(failure))) {
      errors.push(`${source.sourceKey}: ${source.failures.join(",")}: ${source.reason}`);
    }
  }
  if (evaluation.validSourceCount < 1) {
    errors.push("At least one external source requires a fully valid production attestation.");
  }
  return [...new Set(errors)];
}

export type ActivePlatformConfigurationBinding = {
  configurationKey: string;
  versionId: string;
  versionNumber: number;
  projectionVersion: number;
  value: unknown;
  valueSha256: string;
  boundAt: string;
};

/**
 * Lock and resolve the active projection in the consumer transaction. This
 * prevents an activation from racing an exact new-work binding.
 */
export async function readActivePlatformConfigurationForBinding(
  client: PoolClient,
  configurationKey: string,
): Promise<ActivePlatformConfigurationBinding | null> {
  const row = await activeProjection(client, configurationKey);
  if (!row) return null;
  const bound = await client.query<{ bound_at: Date }>(
    `SELECT bound_at FROM fractal.platform_configuration_active_versions WHERE configuration_key = $1`,
    [configurationKey],
  );
  return {
    configurationKey,
    versionId: row.active_version_id,
    versionNumber: row.version_number,
    projectionVersion: row.projection_version,
    value: row.proposed_value,
    valueSha256: row.value_sha256,
    boundAt: bound.rows[0]!.bound_at.toISOString(),
  };
}

async function activeProjection(client: PoolClient, configurationKey: string) {
  // Serialize activation, proposal, rollback, and consumer binding even when
  // the projection does not exist yet (a row lock cannot protect absence).
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration:' || $1, 0))",
    [configurationKey],
  );
  const result = await client.query<{ active_version_id: string; projection_version: number; version_number: number; proposed_value: unknown; value_sha256: string }>(
    `SELECT projection.active_version_id, projection.projection_version,
            version.version_number, version.proposed_value, version.value_sha256
       FROM fractal.platform_configuration_active_versions projection
       JOIN fractal.platform_configuration_versions version ON version.id = projection.active_version_id
      WHERE projection.configuration_key = $1
      FOR UPDATE OF projection`,
    [configurationKey],
  );
  return result.rows[0] ?? null;
}

function assertExpectedProjection(actual: { projection_version: number } | null, expected: number | null): void {
  const current = actual?.projection_version ?? null;
  if (current !== expected) {
    throw new PlatformConfigurationError(`Configuration projection changed; expected ${expected ?? "no active version"}, found ${current ?? "no active version"}.`, "stale_version");
  }
}

async function appendConfigurationEvent(client: PoolClient, input: {
  versionId: string;
  eventType: "proposed" | "validation_failed" | "approved" | "rejected" | "activated" | "superseded" | "activation_failed";
  fromStatus: string | null;
  toStatus: string;
  actorType: "user" | "system";
  actorIdentityId?: string;
  reason: string;
  evidence: Record<string, unknown>;
}) {
  await client.query(
    `INSERT INTO fractal.platform_configuration_events
       (id, configuration_version_id, sequence, event_type, from_status, to_status,
        actor_type, actor_identity_id, reason, evidence)
     SELECT $1, $2, COALESCE(max(sequence), 0) + 1, $3, $4, $5, $6, $7, $8, $9
       FROM fractal.platform_configuration_events
      WHERE configuration_version_id = $2`,
    [randomUUID(), input.versionId, input.eventType, input.fromStatus, input.toStatus, input.actorType,
      input.actorIdentityId ?? null, input.reason, input.evidence],
  );
}

async function readVersion(client: PoolClient, versionId: string, lock = false): Promise<VersionRow> {
  const result = await client.query<VersionRow>(`${versionSelect} WHERE version.id = $1${lock ? " FOR UPDATE OF version" : ""}`, [versionId]);
  const version = result.rows[0];
  if (!version) throw new PlatformConfigurationError("Platform configuration version not found.", "not_found");
  return version;
}

export async function listPlatformConfigurations(input: { actorIdentityId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "platform_configuration_manage");
    const definitions = await client.query<DefinitionRow & { projection_version: number | null; active_version_id: string | null }>(
        `SELECT definition.configuration_key, definition.label, definition.description,
                definition.value_type, definition.validation_schema, definition.consumer_binding, definition.status,
                projection.projection_version, projection.active_version_id
           FROM fractal.platform_configuration_definitions definition
           LEFT JOIN fractal.platform_configuration_active_versions projection
             ON projection.configuration_key = definition.configuration_key
          ORDER BY CASE definition.status WHEN 'active' THEN 0 ELSE 1 END, definition.configuration_key`,
      );
    const versions = await client.query<VersionRow>(`${versionSelect} ORDER BY version.configuration_key, version.version_number DESC LIMIT 500`);
    const mappedVersions = versions.rows.map(mapVersion);
    return {
      definitions: definitions.rows.map((definition) => ({
        key: definition.configuration_key,
        label: definition.label,
        description: definition.description,
        valueType: definition.value_type,
        validationSchema: definition.validation_schema,
        consumerBinding: definition.consumer_binding,
        status: definition.status,
        projectionVersion: definition.projection_version,
        activeVersionId: definition.active_version_id,
        versions: mappedVersions.filter((version) => version.configurationKey === definition.configuration_key),
      })),
    };
  });
}

export async function getPlatformConfigurationVersion(input: { actorIdentityId: string; versionId: string }) {
  return withPostgresTransaction(async (client) => {
    await requireAdministratorCapability(client, input.actorIdentityId, "platform_configuration_manage");
    const version = await readVersion(client, input.versionId);
    const events = await client.query<EventRow>(
      `SELECT event.*, actor.legal_name AS actor_legal_name
         FROM fractal.platform_configuration_events event
         LEFT JOIN fractal.identities actor ON actor.id = event.actor_identity_id
        WHERE event.configuration_version_id = $1
        ORDER BY event.sequence`,
      [input.versionId],
    );
    const attempts = await client.query<{ id: string; outcome: string; due_at: Date; attempted_at: Date; lateness_ms: string; failure_code: string | null; failure_detail: string | null }>(
      `SELECT id, outcome, due_at, attempted_at, lateness_ms, failure_code, failure_detail
         FROM fractal.platform_configuration_activation_attempts
        WHERE configuration_version_id = $1 ORDER BY attempted_at, id`,
      [input.versionId],
    );
    return {
      version: mapVersion(version),
      events: events.rows.map(mapEvent),
      activationAttempts: attempts.rows.map((attempt) => ({
        id: attempt.id, outcome: attempt.outcome, dueAt: attempt.due_at.toISOString(),
        attemptedAt: attempt.attempted_at.toISOString(), latenessMs: Number(attempt.lateness_ms),
        failureCode: attempt.failure_code, failureDetail: attempt.failure_detail,
      })),
    };
  });
}

async function createVersion(client: PoolClient, input: {
  actorIdentityId: string;
  configurationKey: string;
  proposedValue: unknown;
  expectedProjectionVersion: number | null;
  effectiveAt: Date;
  reason: string;
  rollbackOfVersionId?: string;
}) {
  await requireConfigurationCapability(client, input.actorIdentityId, input.configurationKey);
  if (input.configurationKey === EXTERNAL_ATTESTATION_SET_KEY) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration:' || $1, 0))",
      [EXTERNAL_ADAPTER_POLICY_KEY],
    );
  }
  const definition = await definitionForUpdate(client, input.configurationKey);
  const projection = await activeProjection(client, input.configurationKey);
  assertExpectedProjection(projection, input.expectedProjectionVersion);
  if (Number.isNaN(input.effectiveAt.getTime())) throw new PlatformConfigurationError("Effective time is invalid.", "invalid_input");
  if (input.effectiveAt.getTime() < Date.now() - 5 * 60_000) throw new PlatformConfigurationError("Effective time cannot be more than five minutes in the past.", "invalid_input");
  if (input.effectiveAt.getTime() > Date.now() + 366 * 24 * 60 * 60_000) throw new PlatformConfigurationError("Effective time cannot be more than one year ahead.", "invalid_input");

  const validation = validateValue(definition, input.proposedValue);
  validation.errors.push(...await validateConfigurationBindings(
    client,
    input.configurationKey,
    input.proposedValue,
    input.effectiveAt,
  ));
  const valueSha256 = hashPayload(input.proposedValue);
  if (projection?.value_sha256 === valueSha256) validation.errors.push("Proposed value is identical to the active version.");
  validation.valid = validation.errors.length === 0;
  const versionNumberResult = await client.query<{ next_version: number }>(
    `SELECT COALESCE(max(version_number), 0) + 1 AS next_version
       FROM fractal.platform_configuration_versions WHERE configuration_key = $1`,
    [input.configurationKey],
  );
  const versionNumber = Number(versionNumberResult.rows[0]?.next_version);
  const versionId = randomUUID();
  const status: PlatformConfigurationStatus = validation.valid ? "pending" : "validation_failed";
  const validationOutput = { valid: validation.valid, errors: validation.errors, schema: definition.validation_schema, checkedAt: new Date().toISOString() };
  const impactPreview = {
    configurationKey: input.configurationKey,
    consumerBinding: definition.consumer_binding,
    currentProjectionVersion: projection?.projection_version ?? null,
    currentVersionNumber: projection?.version_number ?? null,
    proposedVersionNumber: versionNumber,
    effectiveAt: input.effectiveAt.toISOString(),
    inFlightBehaviour: "Existing sessions, cases, agreements, and calculations remain bound to the version captured when they began.",
    valueChanged: projection?.value_sha256 !== valueSha256,
  };
  await client.query(
    `INSERT INTO fractal.platform_configuration_versions
       (id, configuration_key, version_number, state_version, status, proposed_value, value_sha256,
        validation_output, impact_preview, reason, proposed_by_identity_id, effective_at,
        supersedes_version_id, rollback_of_version_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [versionId, input.configurationKey, versionNumber, validation.valid ? 1 : 2, status, JSON.stringify(input.proposedValue), valueSha256,
      validationOutput, impactPreview, input.reason, input.actorIdentityId, input.effectiveAt,
      projection?.active_version_id ?? null, input.rollbackOfVersionId ?? null],
  );
  await appendConfigurationEvent(client, {
    versionId, eventType: "proposed", fromStatus: null, toStatus: "pending",
    actorType: "user", actorIdentityId: input.actorIdentityId, reason: input.reason,
    evidence: { valueSha256, expectedProjectionVersion: input.expectedProjectionVersion, rollbackOfVersionId: input.rollbackOfVersionId ?? null },
  });
  if (!validation.valid) {
    await appendConfigurationEvent(client, {
      versionId, eventType: "validation_failed", fromStatus: "pending", toStatus: "validation_failed",
      actorType: "user", actorIdentityId: input.actorIdentityId, reason: "The immutable proposal did not satisfy its governed type and validation schema.",
      evidence: { errors: validation.errors },
    });
  }
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `platform-configuration:${input.configurationKey}`, actorId: input.actorIdentityId, actorType: "user",
    action: validation.valid ? "platform.configuration.proposed" : "platform.configuration.validation_failed",
    entityType: "platform_configuration_version", entityId: versionId, reason: input.reason,
    payload: { configurationKey: input.configurationKey, versionNumber, valueSha256, status, effectiveAt: input.effectiveAt.toISOString() },
  });
  await appendOutboxEvent(client, {
    aggregateType: "platform_configuration_version", aggregateId: versionId,
    eventType: validation.valid ? "platform.configuration.proposed" : "platform.configuration.validation_failed",
    payload: { configurationKey: input.configurationKey, versionNumber, valueSha256, auditEventId: audit.id },
  });
  return mapVersion(await readVersion(client, versionId));
}

export async function proposePlatformConfigurationVersion(input: {
  actorIdentityId: string;
  configurationKey: string;
  proposedValue: unknown;
  expectedProjectionVersion: number | null;
  effectiveAt: Date;
  reason: string;
  commandKey: string;
}) {
  const reason = text(input.reason, "Proposal reason");
  const result = await runPostgresIdempotentCommand<{ version: ReturnType<typeof mapVersion> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `platform-configuration:${input.actorIdentityId}`,
    route: `POST:/v1/admin/platform-configuration/${input.configurationKey}/versions`,
    commandKey: input.commandKey,
    payload: { configurationKey: input.configurationKey, proposedValue: input.proposedValue, expectedProjectionVersion: input.expectedProjectionVersion, effectiveAt: input.effectiveAt.toISOString(), reason },
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    execute: async (client) => ({ status: 201, body: { version: await createVersion(client, { ...input, reason }) } }),
  });
  return { version: result.body.version, replayed: result.replayed };
}

export async function decidePlatformConfigurationVersion(input: {
  actorIdentityId: string;
  versionId: string;
  action: "approve" | "reject";
  expectedStateVersion: number;
  decisionReason: string;
  commandKey: string;
}) {
  const decisionReason = text(input.decisionReason, "Decision reason");
  if (!Number.isInteger(input.expectedStateVersion) || input.expectedStateVersion < 1) throw new PlatformConfigurationError("Expected state version is invalid.", "invalid_input");
  const result = await runPostgresIdempotentCommand<{ version: ReturnType<typeof mapVersion> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `platform-configuration:${input.actorIdentityId}`,
    route: `POST:/v1/admin/platform-configuration/versions/${input.versionId}/decision`,
    commandKey: input.commandKey,
    payload: { versionId: input.versionId, action: input.action, expectedStateVersion: input.expectedStateVersion, decisionReason },
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    execute: async (client) => {
      await requireAdministratorCapability(client, input.actorIdentityId, "platform_configuration_manage");
      const version = await readVersion(client, input.versionId, true);
      await requireConfigurationCapability(client, input.actorIdentityId, version.configuration_key);
      if (version.status !== "pending") throw new PlatformConfigurationError("Only a pending configuration version can be reviewed.", "invalid_state");
      if (version.state_version !== input.expectedStateVersion) throw new PlatformConfigurationError("Configuration version changed before this decision.", "stale_version");
      if (version.proposed_by_identity_id === input.actorIdentityId) throw new PlatformConfigurationError("The proposer cannot review their own configuration version.", "forbidden");
      const projection = await activeProjection(client, version.configuration_key);
      if ((projection?.active_version_id ?? null) !== version.supersedes_version_id) throw new PlatformConfigurationError("The active configuration changed after this proposal; submit a new version.", "stale_version");
      const nextStatus = input.action === "approve" ? "scheduled" : "rejected";
      const updated = await client.query(
        `UPDATE fractal.platform_configuration_versions
            SET status = $1, state_version = state_version + 1, reviewed_by_identity_id = $2,
                decision_reason = $3, reviewed_at = now()
          WHERE id = $4 AND status = 'pending' AND state_version = $5`,
        [nextStatus, input.actorIdentityId, decisionReason, input.versionId, input.expectedStateVersion],
      );
      if (updated.rowCount !== 1) throw new PlatformConfigurationError("Configuration decision lost an optimistic concurrency race.", "stale_version");
      await appendConfigurationEvent(client, {
        versionId: input.versionId, eventType: input.action === "approve" ? "approved" : "rejected",
        fromStatus: "pending", toStatus: nextStatus, actorType: "user", actorIdentityId: input.actorIdentityId,
        reason: decisionReason, evidence: { expectedStateVersion: input.expectedStateVersion, effectiveAt: version.effective_at.toISOString() },
      });
      const audit = await appendPostgresAuditEvent(client, {
        scopeKey: `platform-configuration:${version.configuration_key}`, actorId: input.actorIdentityId, actorType: "user",
        action: `platform.configuration.${input.action === "approve" ? "approved" : "rejected"}`,
        entityType: "platform_configuration_version", entityId: version.id, reason: decisionReason,
        payload: { configurationKey: version.configuration_key, versionNumber: version.version_number, effectiveAt: version.effective_at.toISOString() },
      });
      await appendOutboxEvent(client, { aggregateType: "platform_configuration_version", aggregateId: version.id,
        eventType: `platform.configuration.${input.action === "approve" ? "approved" : "rejected"}`,
        payload: { configurationKey: version.configuration_key, versionNumber: version.version_number, auditEventId: audit.id } });
      return { status: 200, body: { version: mapVersion(await readVersion(client, version.id)) } };
    },
  });
  return { version: result.body.version, replayed: result.replayed };
}

export async function proposePlatformConfigurationRollback(input: {
  actorIdentityId: string;
  configurationKey: string;
  targetVersionId: string;
  expectedProjectionVersion: number;
  effectiveAt: Date;
  reason: string;
  commandKey: string;
}) {
  const reason = text(input.reason, "Rollback reason");
  const result = await runPostgresIdempotentCommand<{ version: ReturnType<typeof mapVersion> }>({
    actorIdentityId: input.actorIdentityId,
    scopeKey: `platform-configuration:${input.actorIdentityId}`,
    route: `POST:/v1/admin/platform-configuration/${input.configurationKey}/rollbacks`,
    commandKey: input.commandKey,
    payload: { configurationKey: input.configurationKey, targetVersionId: input.targetVersionId, expectedProjectionVersion: input.expectedProjectionVersion, effectiveAt: input.effectiveAt.toISOString(), reason },
    expiresAt: new Date(Date.now() + 24 * 60 * 60_000),
    execute: async (client) => {
      await requireConfigurationCapability(client, input.actorIdentityId, input.configurationKey);
      const target = await readVersion(client, input.targetVersionId);
      if (target.configuration_key !== input.configurationKey || !["active", "superseded"].includes(target.status)) {
        throw new PlatformConfigurationError("Rollback target must be an active or superseded version of this definition.", "invalid_state");
      }
      const version = await createVersion(client, {
        actorIdentityId: input.actorIdentityId, configurationKey: input.configurationKey,
        proposedValue: target.proposed_value, expectedProjectionVersion: input.expectedProjectionVersion,
        effectiveAt: input.effectiveAt, reason, rollbackOfVersionId: target.id,
      });
      return { status: 201, body: { version } };
    },
  });
  return { version: result.body.version, replayed: result.replayed };
}

async function activateVersion(client: PoolClient, versionId: string, now: Date): Promise<"activated" | "already_terminal" | "failed"> {
  const version = await readVersion(client, versionId, true);
  if (version.status !== "scheduled") {
    await client.query(
      `INSERT INTO fractal.platform_configuration_activation_attempts
         (id, configuration_version_id, outcome, due_at, lateness_ms)
       VALUES ($1, $2, 'already_terminal', $3, $4)`,
      [randomUUID(), version.id, version.effective_at, Math.max(0, now.getTime() - version.effective_at.getTime())],
    );
    return "already_terminal";
  }
  if (version.configuration_key === EXTERNAL_ATTESTATION_SET_KEY) {
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended('platform-configuration:' || $1, 0))",
      [EXTERNAL_ADAPTER_POLICY_KEY],
    );
  }
  const bindingErrors = await validateConfigurationBindings(
    client,
    version.configuration_key,
    version.proposed_value,
    now,
  );
  if (bindingErrors.length) {
    const detail = `Activation-time binding validation failed: ${bindingErrors.join(" | ")}`;
    await client.query(
      `UPDATE fractal.platform_configuration_versions
          SET status = 'failed', state_version = state_version + 1,
              failure_code = 'binding_validation_failed', failure_detail = $2
        WHERE id = $1`,
      [version.id, detail],
    );
    await appendConfigurationEvent(client, {
      versionId: version.id,
      eventType: "activation_failed",
      fromStatus: "scheduled",
      toStatus: "failed",
      actorType: "system",
      reason: "The exact external attestation bindings were not valid at activation time.",
      evidence: { errors: bindingErrors },
    });
    await client.query(
      `INSERT INTO fractal.platform_configuration_activation_attempts
         (id, configuration_version_id, outcome, due_at, lateness_ms, failure_code, failure_detail)
       VALUES ($1, $2, 'failed', $3, $4, 'binding_validation_failed', $5)`,
      [randomUUID(), version.id, version.effective_at, Math.max(0, now.getTime() - version.effective_at.getTime()), detail],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `platform-configuration:${version.configuration_key}`,
      actorType: "system",
      action: "platform.configuration.activation_failed",
      entityType: "platform_configuration_version",
      entityId: version.id,
      reason: "The exact external attestation bindings were not valid at activation time.",
      payload: {
        configurationKey: version.configuration_key,
        versionNumber: version.version_number,
        failureCode: "binding_validation_failed",
        errorCount: bindingErrors.length,
      },
    });
    await appendOutboxEvent(client, {
      aggregateType: "platform_configuration_version",
      aggregateId: version.id,
      eventType: "platform.configuration.activation_failed",
      payload: {
        configurationKey: version.configuration_key,
        versionNumber: version.version_number,
        failureCode: "binding_validation_failed",
        auditEventId: audit.id,
      },
    });
    return "failed";
  }
  const projection = await activeProjection(client, version.configuration_key);
  if ((projection?.active_version_id ?? null) !== version.supersedes_version_id) {
    const detail = "The active projection changed after approval; automatic activation was refused.";
    await client.query(
      `UPDATE fractal.platform_configuration_versions
          SET status = 'failed', state_version = state_version + 1,
              failure_code = 'stale_active_projection', failure_detail = $2
        WHERE id = $1`,
      [version.id, detail],
    );
    await appendConfigurationEvent(client, { versionId: version.id, eventType: "activation_failed", fromStatus: "scheduled", toStatus: "failed", actorType: "system", reason: detail, evidence: { expectedActiveVersionId: version.supersedes_version_id, actualActiveVersionId: projection?.active_version_id ?? null } });
    await client.query(
      `INSERT INTO fractal.platform_configuration_activation_attempts
         (id, configuration_version_id, outcome, due_at, lateness_ms, failure_code, failure_detail)
       VALUES ($1, $2, 'failed', $3, $4, 'stale_active_projection', $5)`,
      [randomUUID(), version.id, version.effective_at, Math.max(0, now.getTime() - version.effective_at.getTime()), detail],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `platform-configuration:${version.configuration_key}`, actorType: "system",
      action: "platform.configuration.activation_failed", entityType: "platform_configuration_version", entityId: version.id,
      reason: detail, payload: { configurationKey: version.configuration_key, versionNumber: version.version_number, failureCode: "stale_active_projection" },
    });
    await appendOutboxEvent(client, { aggregateType: "platform_configuration_version", aggregateId: version.id,
      eventType: "platform.configuration.activation_failed",
      payload: { configurationKey: version.configuration_key, versionNumber: version.version_number, failureCode: "stale_active_projection", auditEventId: audit.id } });
    return "failed";
  }

  if (projection) {
    await client.query(
      `UPDATE fractal.platform_configuration_versions
          SET status = 'superseded', state_version = state_version + 1, superseded_at = $2
        WHERE id = $1 AND status = 'active'`,
      [projection.active_version_id, now],
    );
    await appendConfigurationEvent(client, { versionId: projection.active_version_id, eventType: "superseded", fromStatus: "active", toStatus: "superseded", actorType: "system", reason: `Superseded by approved version ${version.version_number}.`, evidence: { successorVersionId: version.id } });
  }
  await client.query(
    `UPDATE fractal.platform_configuration_versions
        SET status = 'active', state_version = state_version + 1, activated_at = $2
      WHERE id = $1 AND status = 'scheduled'`,
    [version.id, now],
  );
  const projectionVersion = (projection?.projection_version ?? 0) + 1;
  await client.query(
    `INSERT INTO fractal.platform_configuration_active_versions
       (configuration_key, active_version_id, projection_version, bound_at)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (configuration_key) DO UPDATE
       SET active_version_id = EXCLUDED.active_version_id,
           projection_version = EXCLUDED.projection_version,
           bound_at = EXCLUDED.bound_at`,
    [version.configuration_key, version.id, projectionVersion, now],
  );
  const latenessMs = Math.max(0, now.getTime() - version.effective_at.getTime());
  await client.query(
    `INSERT INTO fractal.platform_configuration_activation_attempts
       (id, configuration_version_id, outcome, due_at, attempted_at, lateness_ms)
     VALUES ($1, $2, 'activated', $3, $4, $5)`,
    [randomUUID(), version.id, version.effective_at, now, latenessMs],
  );
  await appendConfigurationEvent(client, { versionId: version.id, eventType: "activated", fromStatus: "scheduled", toStatus: "active", actorType: "system", reason: "Approved configuration version reached its effective time.", evidence: { projectionVersion, latenessMs } });
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `platform-configuration:${version.configuration_key}`, actorType: "system",
    action: "platform.configuration.activated", entityType: "platform_configuration_version", entityId: version.id,
    reason: "Approved configuration version reached its effective time.",
    payload: { configurationKey: version.configuration_key, versionNumber: version.version_number, projectionVersion, valueSha256: version.value_sha256, latenessMs },
  });
  await appendOutboxEvent(client, { aggregateType: "platform_configuration_version", aggregateId: version.id,
    eventType: "platform.configuration.activated", payload: { configurationKey: version.configuration_key, versionNumber: version.version_number, projectionVersion, auditEventId: audit.id } });
  return "activated";
}

export async function activateDuePlatformConfigurationVersions(now = new Date(), limit = 25) {
  const due = await requirePostgres().query<{ id: string }>(
    `SELECT id FROM fractal.platform_configuration_versions
      WHERE status = 'scheduled' AND effective_at <= $1
      ORDER BY effective_at, configuration_key, version_number
      LIMIT $2`,
    [now, Math.max(1, Math.min(limit, 100))],
  );
  const outcomes = { activated: 0, failed: 0, alreadyTerminal: 0 };
  for (const candidate of due.rows) {
    const outcome = await withPostgresTransaction((client) => activateVersion(client, candidate.id, now));
    if (outcome === "activated") outcomes.activated += 1;
    else if (outcome === "failed") outcomes.failed += 1;
    else outcomes.alreadyTerminal += 1;
  }
  return outcomes;
}

/** Resolve one exact active version for a consumer to persist with new work. */
export async function readActivePlatformConfiguration(configurationKey: string) {
  const result = await requirePostgres().query<{ active_version_id: string; projection_version: number; version_number: number; proposed_value: unknown; value_sha256: string; bound_at: Date }>(
    `SELECT projection.active_version_id, projection.projection_version, projection.bound_at,
            version.version_number, version.proposed_value, version.value_sha256
       FROM fractal.platform_configuration_active_versions projection
       JOIN fractal.platform_configuration_versions version ON version.id = projection.active_version_id
      WHERE projection.configuration_key = $1 AND version.status = 'active'`,
    [configurationKey],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    configurationKey, versionId: row.active_version_id, versionNumber: row.version_number,
    projectionVersion: row.projection_version, value: row.proposed_value,
    valueSha256: row.value_sha256, boundAt: row.bound_at.toISOString(),
  };
}
