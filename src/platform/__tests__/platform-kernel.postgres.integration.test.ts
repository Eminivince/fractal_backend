import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import {
  applyPostgresMigrations,
  POSTGRES_MIGRATION_ADVISORY_LOCK,
  PostgresSchemaDriftError,
  verifyPostgresSchema,
} from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, requirePostgres, withPostgresTransaction } from "../../db/postgres.js";
import { appendPostgresAuditEvent } from "../postgres-audit.js";
import { PostgresIdempotencyConflictError, runPostgresIdempotentCommand } from "../postgres-idempotency.js";
import { appendOutboxEvent } from "../postgres-outbox.js";
import { receiveInboxEvent } from "../postgres-inbox.js";
import { PostgresAuditVerificationError, verifyPostgresAuditScope } from "../postgres-audit-verification.js";
import { decodeAdminAccessCursor, listAdminAccessIdentities, listAdminAuditEvents } from "../postgres-admin-read-models.js";
import {
  createIdentityAccessChangeRequest,
  decideIdentityAccessChangeRequest,
  IdentityAccessGovernanceError,
  listIdentityAccessChangeRequests,
} from "../postgres-identity-access-governance.js";
import {
  AdministratorOperationsError,
  administratorOperationsKeyFingerprint,
  approveAdministratorRecoveryRequest,
  bootstrapAdministratorCohort,
  createAdministratorRecoveryRequest,
  readAdministratorOperationsStatus,
} from "../postgres-administrator-operations.js";
import {
  createAdministratorCapabilityChangeRequest,
  decideAdministratorCapabilityChangeRequest,
  listAdministratorCapabilityRegister,
} from "../postgres-administrator-capabilities.js";
import {
  createAdministratorAuditExport,
  listAdministratorAuditExports,
  retrieveAdministratorAuditExport,
} from "../postgres-administrator-audit-exports.js";
import { listResendPrivacyDeliveryReferencesForIdentity } from "../postgres-resend-privacy-references.js";
import {
  createAdministratorProviderIncident,
  getAdministratorProviderIncident,
  listAdministratorProviderIncidents,
  transitionAdministratorProviderIncident,
} from "../postgres-administrator-provider-incidents.js";
import {
  addRequesterSupportMessage,
  createSupportCase,
  getAdministratorSupportCase,
  getOwnSupportCase,
  listAdministratorSupportCases,
  listOwnSupportCases,
  transitionAdministratorSupportCase,
} from "../postgres-support-cases.js";
import {
  activateDuePlatformConfigurationVersions,
  decidePlatformConfigurationVersion,
  getPlatformConfigurationVersion,
  listPlatformConfigurations,
  proposePlatformConfigurationRollback,
  proposePlatformConfigurationVersion,
  readActivePlatformConfiguration,
} from "../postgres-platform-configuration.js";
import {
  decidePlatformContentVersion,
  getLegalConsentStatus,
  listPlatformContent,
  listPublishedLegalDocumentHistory,
  listPublishedLegalDocuments,
  proposePlatformContentVersion,
  publishDuePlatformContent,
  readPublishedLegalDocument,
  readPublishedLegalDocumentBytes,
  recordLegalReacceptance,
} from "../postgres-platform-content.js";
import { createPostgresAuthIdentity, getPostgresAuthIdentityByEmail } from "../postgres-identities.js";
import { sweepSupportCaseServiceDeadlines } from "../postgres-support-service-levels.js";
import { dispatchPendingSupportNotifications } from "../postgres-support-notifications.js";
import {
  authorizeSupportCaseAttachmentUpload,
  getSupportCaseAttachmentForDownload,
  recordSupportCaseAttachment,
  recordSupportCaseAttachmentDownload,
  SupportAttachmentReplayError,
} from "../postgres-support-attachments.js";
import {
  decideLegalHoldChange,
  decideSupportAttachmentDisposition,
  proposeLegalHoldChange,
  proposeSupportAttachmentDisposition,
  readSupportAttachmentLifecycle,
  resolveSupportEvidenceHoldTarget,
} from "../postgres-support-evidence-lifecycle.js";
import {
  bindPrivacyRightsResponsePolicy,
  createPrivacyRightsRequest,
  decidePrivacyRightsDecision,
  getAdministratorPrivacyDataInventory,
  getAdministratorPrivacyRightsRequest,
  getOwnPrivacyRightsRequest,
  listAdministratorPrivacyRightsRequests,
  listOwnPrivacyRightsRequests,
  proposePrivacyRightsDecision,
  replyToPrivacyRightsRequest,
  transitionAdministratorPrivacyRightsRequest,
  withdrawPrivacyRightsRequest,
} from "../postgres-privacy-rights.js";
import { collectCanonicalPrivacySourceSections, listPrivacyRightsPackagePreparations, preparePrivacyRightsPackageEvidence } from "../postgres-privacy-package-preparations.js";
import {
  downloadOwnPrivacyPackage,
  expireAndQueuePrivacyPackageCleanup,
  listOwnPrivacyPackageDeliveries,
  materializeOnePrivacyPackage,
  requestPrivacyPackageDelivery,
} from "../postgres-privacy-package-deliveries.js";
import {
  parsePrivacyContentProfile,
  privacyContentProfileSourceKeys,
  privacyContentProfileSourceKeysForRight,
  privacySafeFieldCatalog,
  type PrivacyContentFieldCatalogVersion,
  type PrivacyContentProfile,
} from "../../modules/privacy/domain/privacy-content-profile.js";
import { parsePrivacyPackageArchiveV2 } from "../../modules/privacy/domain/privacy-package-archive.js";
import { dispatchPendingStorageCleanupTasks } from "../../services/postgres-storage-cleanup-worker.js";
import {
  authorizeProfessionalPayout,
  authorizeProfessionalReplacementPayout,
  decideProfessionalFinanceExceptionResolution,
  decideProfessionalInvoice,
  executeProfessionalFinanceCreditNote,
  openProfessionalFinanceException,
  prepareProfessionalFinanceExceptionResolution,
  recordProfessionalFinanceExceptionEvidence,
} from "../postgres-professional-invoices.js";

function fullPrivacyProfile() {
  const fieldCatalogVersion: PrivacyContentFieldCatalogVersion = "privacy-safe-fields-v45";
  const rules = (right: "access" | "portability") => privacyContentProfileSourceKeysForRight(fieldCatalogVersion, right).map((sourceKey) => ({
    sourceKey,
    includedFields: [...privacySafeFieldCatalog[sourceKey]],
    excludedFields: [],
  }));
  return parsePrivacyContentProfile({
    profileReference: "PRIV-INFRASTRUCTURE-TEST-1",
    profileName: "Infrastructure privacy collector test profile",
    schemaVersion: "privacy-content-profile-v1",
    fieldCatalogVersion,
    jurisdictionCode: "NG",
    legalBasisReference: "Authenticated data subject access test authority",
    effectiveScope: "authenticated_data_subject_access_and_portability",
    access: { sourceRules: rules("access") },
    portability: { sourceRules: rules("portability") },
  });
}

describe("PostgreSQL platform kernel", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.distribution_privacy_treatment_executions, fractal.distribution_privacy_treatment_requests, fractal.distribution_lifecycle_policy_bindings, fractal.investor_distribution_tax_statements, fractal.distribution_tax_remittance_reversal_requests, fractal.distribution_tax_remittance_requests, fractal.distribution_tax_remittance_policies, fractal.distribution_payout_exception_executions, fractal.distribution_payout_exception_hold_requests, fractal.distribution_payout_exception_evidence, fractal.distribution_payout_exception_cases, fractal.distribution_payout_exception_policies, fractal.distribution_payout_provider_events, fractal.distribution_payout_instructions, fractal.distribution_funding_requests, fractal.distribution_payout_recipient_recovery_cases, fractal.investor_distribution_payout_profiles, fractal.distribution_entitlements, fractal.distribution_declaration_requests, fractal.ownership_snapshot_holdings, fractal.ownership_snapshot_requests, fractal.privacy_rights_package_preparations, fractal.privacy_rights_policy_bindings, fractal.privacy_rights_request_events, fractal.privacy_rights_decision_requests, fractal.privacy_rights_requests, fractal.storage_cleanup_tasks, fractal.support_attachment_dispositions, fractal.support_attachment_disposition_requests, fractal.data_legal_holds, fractal.data_legal_hold_change_requests, fractal.legal_document_acceptances, fractal.platform_content_events, fractal.platform_content_publications, fractal.platform_content_versions, fractal.support_case_attachment_access_events, fractal.support_case_attachments, fractal.support_case_notification_deliveries, fractal.support_case_service_events, fractal.support_case_service_obligations, fractal.support_case_service_sweeps, fractal.platform_configuration_activation_attempts, fractal.platform_configuration_events, fractal.platform_configuration_active_versions, fractal.platform_configuration_versions, fractal.support_case_events, fractal.support_cases, fractal.administrator_provider_incident_events, fractal.administrator_provider_incidents, fractal.administrator_audit_exports, fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests, fractal.administrator_recovery_requests, fractal.administrator_bootstrap_state, fractal.auth_email_deliveries, fractal.identity_access_change_requests, fractal.payment_provider_instructions, fractal.security_notifications, fractal.auth_step_up_grants, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events, fractal.auth_sessions, fractal.idempotency_commands CASCADE");
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("persists an idempotent command and its outbox event atomically", async () => {
    const actorIdentityId = randomUUID();
    const otherActorIdentityId = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.identities (id, email, legal_name, status)
       VALUES ($1, $2, 'Idempotency actor', 'active'), ($3, $4, 'Other idempotency actor', 'active')`,
      [actorIdentityId, `idempotency-${actorIdentityId}@example.test`, otherActorIdentityId, `idempotency-${otherActorIdentityId}@example.test`],
    );
    let executions = 0;
    const options = {
      actorIdentityId,
      scopeKey: "investor:demo",
      route: "POST:/v1/platform/reference-command",
      commandKey: "command-1",
      payload: { action: "reference" },
      expiresAt: new Date(Date.now() + 60_000),
      execute: async (client: Parameters<typeof appendOutboxEvent>[0]) => {
        executions += 1;
        await appendOutboxEvent(client, {
          aggregateType: "platform_reference",
          aggregateId: "demo",
          eventType: "PlatformReferenceCommandCompleted",
          payload: { execution: executions },
          privacy: { kind: "subjects", subjectIdentityIds: [actorIdentityId] },
        });
        return { body: { execution: executions }, status: 201 };
      },
    };

    const first = await runPostgresIdempotentCommand(options);
    const replay = await runPostgresIdempotentCommand(options);

    expect(first).toMatchObject({ body: { execution: 1 }, status: 201, replayed: false });
    expect(replay).toMatchObject({ body: { execution: 1 }, status: 201, replayed: true });
    expect(executions).toBe(1);
    const outbox = await postgresQuery<{ count: string }>("SELECT count(*) FROM fractal.outbox_events");
    expect(Number(outbox.rows[0]?.count)).toBe(1);
    const outboxAttribution = await postgresQuery<{
      privacy_classification: string; privacy_subject_identity_ids: string[]; privacy_attribution_basis: string;
    }>(
      `SELECT privacy_classification,privacy_subject_identity_ids,privacy_attribution_basis
         FROM fractal.outbox_events WHERE aggregate_type='platform_reference' AND aggregate_id='demo'`,
    );
    expect(outboxAttribution.rows[0]).toEqual({
      privacy_classification: "subject_attributed",
      privacy_subject_identity_ids: [actorIdentityId],
      privacy_attribution_basis: "explicit_subjects",
    });
    await expect(postgresQuery(
      "UPDATE fractal.outbox_events SET privacy_subject_identity_ids='{}'::uuid[] WHERE aggregate_type='platform_reference' AND aggregate_id='demo'",
    )).rejects.toThrow("event privacy attribution is immutable");
    await expect(postgresQuery(
      `INSERT INTO fractal.outbox_events(id,aggregate_type,aggregate_id,event_type,payload)
       VALUES($1,'legacy_test','legacy','legacy.created','{}')`,
      [randomUUID()],
    )).rejects.toThrow("new event writes require an explicit privacy classification");
    const persisted = await postgresQuery<{ actor_identity_id: string; attribution_status: string }>(
      `SELECT actor_identity_id, attribution_status
         FROM fractal.idempotency_commands
        WHERE scope_key=$1 AND route=$2 AND command_key=$3`,
      [options.scopeKey, options.route, options.commandKey],
    );
    expect(persisted.rows[0]).toEqual({ actor_identity_id: actorIdentityId, attribution_status: "attributed" });

    await expect(
      runPostgresIdempotentCommand({ ...options, actorIdentityId: otherActorIdentityId }),
    ).rejects.toThrow("Command key cannot be reused; submit a new command key");
    expect(executions).toBe(1);

    await expect(
      runPostgresIdempotentCommand({ ...options, payload: { action: "different" } }),
    ).rejects.toBeInstanceOf(PostgresIdempotencyConflictError);

    await expect(
      postgresQuery("UPDATE fractal.idempotency_commands SET actor_identity_id=$1 WHERE actor_identity_id=$2", [otherActorIdentityId, actorIdentityId]),
    ).rejects.toThrow("idempotency command attribution is immutable");
    await expect(
      postgresQuery(
        `INSERT INTO fractal.idempotency_commands
           (id, scope_key, route, command_key, request_hash, expires_at, attribution_status)
         VALUES ($1, 'legacy:test', 'POST:/legacy', 'legacy-key', repeat('0',64), now()+interval '1 day', 'legacy_unattributed')`,
        [randomUUID()],
      ),
    ).rejects.toThrow("new idempotency commands require an attributed actor");
    const inventory = await postgresQuery<{ access_status: string; blocker: string }>(
      `SELECT access_status, blocker
         FROM fractal.privacy_data_sources
        WHERE source_key='postgres.fractal.idempotency_commands'`,
    );
    expect(inventory.rows[0]).toMatchObject({ access_status: "available" });
    expect(inventory.rows[0]?.blocker).toContain("Migration fails closed");
    const actorSections = await withPostgresTransaction((client) =>
      collectCanonicalPrivacySourceSections(client, actorIdentityId, "access", fullPrivacyProfile()));
    const otherActorSections = await withPostgresTransaction((client) =>
      collectCanonicalPrivacySourceSections(client, otherActorIdentityId, "access", fullPrivacyProfile()));
    const actorCommands = actorSections.get("postgres.fractal.idempotency_commands")?.canonicalContent ?? "";
    expect(actorCommands).toContain('"route":"POST:/v1/platform/reference-command"');
    expect(actorCommands).toContain('"responseStatus":201');
    expect(actorCommands).not.toContain(options.scopeKey);
    expect(actorCommands).not.toContain(options.commandKey);
    expect(actorCommands).not.toContain('"execution":1');
    expect(otherActorSections.get("postgres.fractal.idempotency_commands")?.canonicalContent).toContain('"records":[]');
  });

  it("chains audit records and rejects later mutation", async () => {
    const [first, second] = await withPostgresTransaction(async (client) => {
      const one = await appendPostgresAuditEvent(client, {
        scopeKey: "organization:demo",
        actorType: "system",
        action: "ReferenceCreated",
        entityType: "reference",
        entityId: "one",
        payload: { version: 1 },
      });
      const two = await appendPostgresAuditEvent(client, {
        scopeKey: "organization:demo",
        actorType: "system",
        action: "ReferenceUpdated",
        entityType: "reference",
        entityId: "one",
        payload: { version: 2 },
      });
      return [one, two];
    });

    expect(second.sequence).toBeGreaterThan(first.sequence);
    expect(second.parentHash).toBe(first.canonicalHash);
    await expect(verifyPostgresAuditScope("organization:demo")).resolves.toMatchObject({ events: 2, latestHash: second.canonicalHash });
    await expect(
      postgresQuery("UPDATE fractal.audit_events SET action = 'tampered' WHERE id = $1", [first.id]),
    ).rejects.toThrow("append-only");
    await postgresQuery("UPDATE fractal.audit_chain_heads SET latest_hash = $1 WHERE scope_key = 'organization:demo'", ["f".repeat(64)]);
    await expect(verifyPostgresAuditScope("organization:demo")).rejects.toBeInstanceOf(PostgresAuditVerificationError);
    await postgresQuery(
      "UPDATE fractal.audit_chain_heads SET latest_sequence = $1, latest_hash = $2 WHERE scope_key = 'organization:demo'",
      [second.sequence, second.canonicalHash],
    );
    await expect(verifyPostgresAuditScope("organization:demo")).resolves.toMatchObject({ events: 2, latestHash: second.canonicalHash });
  });

  it("serves bounded administrator access and redacted audit read models from PostgreSQL", async () => {
    const adminId = randomUUID();
    const investorId = randomUUID();
    const marker = `admin-read-${randomUUID()}`;
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1, $2, $3, 'active', now()), ($4, $5, $6, 'disabled', NULL)`,
        [
          adminId,
          `${marker}-admin@example.test`,
          `${marker} Administrator`,
          investorId,
          `${marker}-investor@example.test`,
          `${marker} Investor`,
        ],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'investor', 'global')`,
        [randomUUID(), adminId, randomUUID(), investorId],
      );
      await withPostgresTransaction((client) => appendPostgresAuditEvent(client, {
        scopeKey: `identity:${investorId}`,
        actorId: adminId,
        actorType: "user",
        action: "admin.reference.reviewed",
        entityType: "identity",
        entityId: investorId,
        reason: marker,
        payload: { secretThatMustNotReachListView: "sensitive" },
      }));

      const firstPage = await listAdminAccessIdentities({ query: marker, limit: 1 });
      expect(firstPage.identities).toHaveLength(1);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      const secondPage = await listAdminAccessIdentities({
        query: marker,
        cursor: decodeAdminAccessCursor(firstPage.nextCursor!),
        limit: 1,
      });
      expect(secondPage.identities).toHaveLength(1);
      expect(new Set([...firstPage.identities, ...secondPage.identities].map((identity) => identity.globalRole)))
        .toEqual(new Set(["admin", "investor"]));

      const audit = await listAdminAuditEvents({ query: marker, limit: 10 });
      expect(audit.events).toHaveLength(1);
      expect(audit.events[0]).toMatchObject({
        actorId: adminId,
        actorEmail: `${marker}-admin@example.test`,
        action: "admin.reference.reviewed",
        entityId: investorId,
      });
      expect(audit.events[0]).not.toHaveProperty("payload");
    } finally {
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [[adminId, investorId]]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [[adminId, investorId]]);
    }
  });

  it("governs administrator audit-export capability and freezes independently verifiable evidence", async () => {
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const reserveId = randomUUID();
    const targetId = randomUUID();
    const identities = [makerId, checkerId, reserveId, targetId];
    const marker = `audit-export-${randomUUID()}`;
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1, $2, 'Capability maker', 'active', now()),
                ($3, $4, 'Capability checker', 'active', now()),
                ($5, $6, 'Capability reserve', 'active', now()),
                ($7, $8, 'Capability target', 'active', now())`,
        [
          makerId, `${marker}-maker@example.test`,
          checkerId, `${marker}-checker@example.test`,
          reserveId, `${marker}-reserve@example.test`,
          targetId, `${marker}-target@example.test`,
        ],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'admin', 'global'),
                ($5, $6, 'admin', 'global'), ($7, $8, 'admin', 'global')`,
        [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), reserveId, randomUUID(), targetId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_assignments (id, identity_id, capability_key)
         VALUES ($1, $2, 'audit_export'), ($3, $4, 'audit_export'), ($5, $6, 'audit_export')`,
        [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), reserveId],
      );
      await withPostgresTransaction((client) => appendPostgresAuditEvent(client, {
        scopeKey: `identity:${targetId}`,
        actorId: makerId,
        actorType: "user",
        action: "administrator.export.reference",
        entityType: "identity",
        entityId: targetId,
        reason: marker,
        payload: { controlledEvidence: "included only in the capability-protected export" },
      }));

      await expect(createAdministratorAuditExport({
        requestedByIdentityId: targetId,
        filters: { query: marker },
        maxRecords: 10,
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "forbidden" });

      const proposed = await createAdministratorCapabilityChangeRequest({
        actorIdentityId: makerId,
        targetIdentityId: targetId,
        capabilityKey: "audit_export",
        changeType: "grant",
        reason: "Grant bounded audit-export responsibility for the independent evidence review.",
        commandKey: randomUUID(),
      });
      await expect(decideAdministratorCapabilityChangeRequest({
        actorIdentityId: makerId,
        requestId: proposed.request.id,
        decision: "approve",
        reason: "The maker must never approve their own capability request.",
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "forbidden" });
      await expect(decideAdministratorCapabilityChangeRequest({
        actorIdentityId: checkerId,
        requestId: proposed.request.id,
        decision: "approve",
        reason: "The evidence-export responsibility and separation of duties were independently reviewed.",
        commandKey: randomUUID(),
      })).resolves.toMatchObject({ request: { status: "applied", targetIdentity: { id: targetId } } });
      await expect(postgresQuery(
        "UPDATE fractal.administrator_capability_assignments SET granted_at = now() + interval '1 minute' WHERE identity_id = $1 AND revoked_at IS NULL",
        [targetId],
      )).rejects.toThrow("immutable");

      const commandKey = randomUUID();
      const created = await createAdministratorAuditExport({
        requestedByIdentityId: targetId,
        filters: { query: marker, action: "administrator.export.reference" },
        maxRecords: 10,
        commandKey,
      });
      const replayed = await createAdministratorAuditExport({
        requestedByIdentityId: targetId,
        filters: { query: marker, action: "administrator.export.reference" },
        maxRecords: 10,
        commandKey,
      });
      expect(created).toMatchObject({
        replayed: false,
        export: { recordCount: 1, contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
      });
      expect(replayed).toMatchObject({ replayed: true, export: { id: created.export.id } });
      expect((await listAdministratorAuditExports({ requestedByIdentityId: targetId })).exports)
        .toContainEqual(expect.objectContaining({ id: created.export.id }));
      const downloaded = await retrieveAdministratorAuditExport({ requestedByIdentityId: targetId, exportId: created.export.id });
      expect(createHash("sha256").update(downloaded.canonicalContent).digest("hex")).toBe(created.export.contentSha256);
      expect(JSON.parse(downloaded.canonicalContent)).toMatchObject({
        schemaVersion: "fractal.audit-export.v1",
        recordCount: 1,
        events: [{
          action: "administrator.export.reference",
          payload: { controlledEvidence: "included only in the capability-protected export" },
        }],
      });
      await expect(postgresQuery(
        "UPDATE fractal.administrator_audit_exports SET record_count = 0 WHERE id = $1",
        [created.export.id],
      )).rejects.toThrow("immutable");

      const revoke = await createAdministratorCapabilityChangeRequest({
        actorIdentityId: makerId,
        targetIdentityId: targetId,
        capabilityKey: "audit_export",
        changeType: "revoke",
        reason: "Remove the bounded evidence-export responsibility after the review assignment ended.",
        commandKey: randomUUID(),
      });
      await decideAdministratorCapabilityChangeRequest({
        actorIdentityId: checkerId,
        requestId: revoke.request.id,
        decision: "approve",
        reason: "The assignment end and remaining capable administrator quorum were independently confirmed.",
        commandKey: randomUUID(),
      });
      await expect(retrieveAdministratorAuditExport({ requestedByIdentityId: targetId, exportId: created.export.id }))
        .rejects.toMatchObject({ code: "forbidden" });
      const register = await listAdministratorCapabilityRegister({ query: `${marker}-target` });
      expect(register.assignments).toEqual([]);
      expect(register.requests.map((request) => request.status)).toEqual(["applied", "applied"]);
    } finally {
      await postgresQuery("TRUNCATE fractal.administrator_audit_exports, fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("governs provider incidents through a capability-protected immutable state machine", async () => {
    const actorId = randomUUID();
    const ownerId = randomUUID();
    const reserveId = randomUUID();
    const unassignedId = randomUUID();
    const identities = [actorId, ownerId, reserveId, unassignedId];
    const marker = `provider-incident-${randomUUID()}`;
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1, $2, 'Incident commander', 'active', now()),
                ($3, $4, 'Incident owner', 'active', now()),
                ($5, $6, 'Incident reserve', 'active', now()),
                ($7, $8, 'Unassigned administrator', 'active', now())`,
        [
          actorId, `${marker}-actor@example.test`,
          ownerId, `${marker}-owner@example.test`,
          reserveId, `${marker}-reserve@example.test`,
          unassignedId, `${marker}-unassigned@example.test`,
        ],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'admin', 'global'),
                ($5, $6, 'admin', 'global'), ($7, $8, 'admin', 'global')`,
        [randomUUID(), actorId, randomUUID(), ownerId, randomUUID(), reserveId, randomUUID(), unassignedId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_assignments (id, identity_id, capability_key)
         VALUES ($1, $2, 'provider_incident_manage'), ($3, $4, 'provider_incident_manage'),
                ($5, $6, 'provider_incident_manage')`,
        [randomUUID(), actorId, randomUUID(), ownerId, randomUUID(), reserveId],
      );

      const detectedAt = new Date(Date.now() - 60_000);
      const creation = {
        actorIdentityId: actorId,
        providerKey: "resend",
        source: "external_alert" as const,
        externalReference: marker,
        severity: "sev3" as const,
        summary: "Transactional email delivery latency is elevated",
        userImpact: "Verification and recovery codes may arrive later than the published service target.",
        detectionEvidence: { alert: marker, region: "global", deliveryLagSeconds: 420 },
        detectedAt,
        reason: "Open a controlled incident from the independently verified provider alert.",
        commandKey: randomUUID(),
      };
      await expect(createAdministratorProviderIncident({ ...creation, actorIdentityId: unassignedId, commandKey: randomUUID() }))
        .rejects.toMatchObject({ code: "forbidden" });
      await expect(createAdministratorProviderIncident({
        ...creation,
        detectionEvidence: { payload: "x".repeat(65 * 1024) },
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "invalid_input" });

      const created = await createAdministratorProviderIncident(creation);
      const replayed = await createAdministratorProviderIncident(creation);
      expect(created).toMatchObject({
        replayed: false,
        incident: {
          providerKey: "resend", externalReference: marker, severity: "sev3", status: "open",
          version: 1, owner: { id: actorId }, acknowledgementSlaState: "open", resolutionSlaState: "open",
        },
      });
      expect(replayed).toMatchObject({ replayed: true, incident: { id: created.incident.id } });
      await expect(createAdministratorProviderIncident({ ...creation, commandKey: randomUUID() }))
        .rejects.toMatchObject({ code: "conflict" });

      const listed = await listAdministratorProviderIncidents({
        actorIdentityId: actorId,
        status: "open",
        severity: "sev3",
        providerKey: "resend",
      });
      expect(listed.incidents).toEqual([expect.objectContaining({ id: created.incident.id, version: 1 })]);
      await expect(listAdministratorProviderIncidents({ actorIdentityId: unassignedId }))
        .rejects.toMatchObject({ code: "forbidden" });

      const directIncidentId = randomUUID();
      await expect(withPostgresTransaction(async (client) => {
        await client.query(
          `INSERT INTO fractal.administrator_provider_incidents
             (id, provider_key, source, severity, summary, user_impact, detection_evidence,
              detected_at, acknowledgement_due_at, resolution_due_at, owner_identity_id, created_by_identity_id)
           VALUES ($1, 'resend', 'manual', 'sev4', 'Direct insert without an event',
                   'This row must never commit without its immutable creation evidence.', '{}',
                   now(), now() + interval '24 hours', now() + interval '120 hours', $2, $2)`,
          [directIncidentId, actorId],
        );
      })).rejects.toThrow("requires its immutable initial event");

      const acknowledge = await transitionAdministratorProviderIncident({
        actorIdentityId: actorId, incidentId: created.incident.id, action: "acknowledge", expectedVersion: 1,
        reason: "Acknowledge the alert after confirming that the delivery queue is materially delayed.",
        evidence: { providerStatusCheckedAt: new Date().toISOString() }, commandKey: randomUUID(),
      });
      expect(acknowledge.incident).toMatchObject({ status: "acknowledged", version: 2, acknowledgedAt: expect.any(String) });
      await expect(transitionAdministratorProviderIncident({
        actorIdentityId: actorId, incidentId: created.incident.id, action: "contain", expectedVersion: 1,
        reason: "This stale transition must not overwrite the acknowledged incident projection.",
        evidence: {}, commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "conflict" });

      const assigned = await transitionAdministratorProviderIncident({
        actorIdentityId: actorId, incidentId: created.incident.id, action: "assign", expectedVersion: 2,
        ownerIdentityId: ownerId,
        reason: "Assign the provider response and customer-impact coordination to the duty incident owner.",
        evidence: { handoff: marker }, commandKey: randomUUID(),
      });
      expect(assigned.incident).toMatchObject({ status: "acknowledged", version: 3, owner: { id: ownerId } });
      await expect(transitionAdministratorProviderIncident({
        actorIdentityId: actorId, incidentId: created.incident.id, action: "assign", expectedVersion: 3,
        ownerIdentityId: ownerId,
        reason: "A no-op assignment must not manufacture an immutable incident transition.",
        evidence: {}, commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "invalid_state" });

      const escalated = await transitionAdministratorProviderIncident({
        actorIdentityId: ownerId, incidentId: created.incident.id, action: "escalate", expectedVersion: 3,
        severity: "sev2",
        reason: "Escalate because the delay now affects both registration and administrator recovery delivery.",
        evidence: { affectedQueues: ["verification", "recovery"] }, commandKey: randomUUID(),
      });
      expect(escalated.incident).toMatchObject({ status: "acknowledged", severity: "sev2", version: 4 });
      const contained = await transitionAdministratorProviderIncident({
        actorIdentityId: ownerId, incidentId: created.incident.id, action: "contain", expectedVersion: 4,
        reason: "Contain impact by pausing non-critical sends and preserving capacity for authentication delivery.",
        evidence: { queuePolicy: "authentication_priority" }, commandKey: randomUUID(),
      });
      expect(contained.incident).toMatchObject({ status: "contained", severity: "sev2", version: 5, containedAt: expect.any(String) });
      const resolved = await transitionAdministratorProviderIncident({
        actorIdentityId: ownerId, incidentId: created.incident.id, action: "resolve", expectedVersion: 5,
        reason: "Resolve after provider recovery and a sustained successful authentication-delivery sample.",
        evidence: { successfulSamples: 25, observationMinutes: 30 }, commandKey: randomUUID(),
      });
      expect(resolved.incident).toMatchObject({ status: "resolved", version: 6, resolvedAt: expect.any(String) });
      const reopened = await transitionAdministratorProviderIncident({
        actorIdentityId: reserveId, incidentId: created.incident.id, action: "reopen", expectedVersion: 6,
        reason: "Reopen after the same provider degradation recurred inside the monitoring window.",
        evidence: { recurrenceAlert: `${marker}-recurrence` }, commandKey: randomUUID(),
      });
      expect(reopened.incident).toMatchObject({
        status: "open", version: 7, acknowledgedAt: null, containedAt: null, resolvedAt: null,
      });

      const detail = await getAdministratorProviderIncident({ actorIdentityId: actorId, incidentId: created.incident.id });
      expect(detail.incident).toMatchObject({ id: created.incident.id, detectionEvidence: creation.detectionEvidence, version: 7 });
      expect(detail.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
      expect(detail.events).toContainEqual(expect.objectContaining({
        sequence: 4, eventType: "escalated", fromSeverity: "sev3", severity: "sev2",
        fromOwnerIdentityId: ownerId, owner: expect.objectContaining({ id: ownerId }),
      }));
      expect(detail.events.at(-1)).toMatchObject({
        eventType: "reopened", fromStatus: "resolved", toStatus: "open",
        acknowledgedAt: null, containedAt: null, resolvedAt: null,
      });
      await expect(postgresQuery(
        "UPDATE fractal.administrator_provider_incidents SET version = version + 1, updated_at = now() + interval '1 second' WHERE id = $1",
        [created.incident.id],
      )).rejects.toThrow("requires its immutable event");
      await expect(postgresQuery(
        "UPDATE fractal.administrator_provider_incident_events SET reason = 'tampered immutable incident evidence' WHERE incident_id = $1 AND sequence = 2",
        [created.incident.id],
      )).rejects.toThrow("events are immutable");

      const revoke = await createAdministratorCapabilityChangeRequest({
        actorIdentityId: ownerId,
        targetIdentityId: actorId,
        capabilityKey: "provider_incident_manage",
        changeType: "revoke",
        reason: "Remove incident-control responsibility after the duty rotation was independently reassigned.",
        commandKey: randomUUID(),
      });
      await decideAdministratorCapabilityChangeRequest({
        actorIdentityId: reserveId,
        requestId: revoke.request.id,
        decision: "approve",
        reason: "Confirm the rotation and the remaining two independently capable incident administrators.",
        commandKey: randomUUID(),
      });
      await expect(getAdministratorProviderIncident({ actorIdentityId: actorId, incidentId: created.incident.id }))
        .rejects.toMatchObject({ code: "forbidden" });
    } finally {
      await postgresQuery("TRUNCATE fractal.administrator_provider_incident_events, fractal.administrator_provider_incidents, fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("governs requester-owned support cases and capability-protected staff decisions", async () => {
    const requesterId = randomUUID();
    const otherRequesterId = randomUUID();
    const supportAdminId = randomUUID();
    const reserveAdminId = randomUUID();
    const identities = [requesterId, otherRequesterId, supportAdminId, reserveAdminId];
    const marker = `support-case-${randomUUID()}`;
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1,$2,'Support requester','active',now()), ($3,$4,'Other requester','active',now()),
                ($5,$6,'Support administrator','active',now()), ($7,$8,'Support reserve','active',now())`,
        [requesterId, `${marker}-requester@example.test`, otherRequesterId, `${marker}-other@example.test`,
          supportAdminId, `${marker}-admin@example.test`, reserveAdminId, `${marker}-reserve@example.test`],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id,identity_id,role,scope_type)
         VALUES ($1,$2,'investor','global'),($3,$4,'investor','global'),($5,$6,'admin','global'),($7,$8,'admin','global')`,
        [randomUUID(), requesterId, randomUUID(), otherRequesterId, randomUUID(), supportAdminId, randomUUID(), reserveAdminId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_assignments (id,identity_id,capability_key)
         VALUES ($1,$2,'support_case_manage'),($3,$4,'support_case_manage'),
                ($5,$2,'platform_configuration_manage'),($6,$4,'platform_configuration_manage'),
                ($7,$2,'data_lifecycle_manage'),($8,$4,'data_lifecycle_manage')`,
        [randomUUID(), supportAdminId, randomUUID(), reserveAdminId, randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      );
      const servicePolicy = {
        policyReference: "SUPPORT-OPS-TEST-1",
        policyName: "Approved test support operations policy",
        impactTargets: {
          question: { priority: "p4", acknowledgementMinutes: 120, resolutionMinutes: 1_440, escalationMinutesBeforeResolution: 120 },
          blocked: { priority: "p2", acknowledgementMinutes: 30, resolutionMinutes: 240, escalationMinutesBeforeResolution: 30 },
          financial_or_legal_risk: { priority: "p1", acknowledgementMinutes: 15, resolutionMinutes: 120, escalationMinutesBeforeResolution: 20 },
          security_or_privacy_concern: { priority: "p1", acknowledgementMinutes: 10, resolutionMinutes: 60, escalationMinutesBeforeResolution: 15 },
        },
        categoryOverrides: [],
      };
      const invalidPolicy = await proposePlatformConfigurationVersion({
        actorIdentityId: supportAdminId, configurationKey: "support.case.service_policy",
        proposedValue: { ...servicePolicy, impactTargets: { ...servicePolicy.impactTargets, blocked: { ...servicePolicy.impactTargets.blocked, escalationMinutesBeforeResolution: 240 } } },
        expectedProjectionVersion: null, effectiveAt: new Date(),
        reason: "Prove that an invalid escalation boundary cannot enter the approval queue.", commandKey: randomUUID(),
      });
      expect(invalidPolicy.version).toMatchObject({ status: "validation_failed", validationOutput: { valid: false } });
      const proposedPolicy = await proposePlatformConfigurationVersion({
        actorIdentityId: supportAdminId, configurationKey: "support.case.service_policy", proposedValue: servicePolicy,
        expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000),
        reason: "Bind test support cases to exact approved priority and service targets.", commandKey: randomUUID(),
      });
      expect(proposedPolicy.version).toMatchObject({ status: "pending", validationOutput: { valid: true } });
      await decidePlatformConfigurationVersion({
        actorIdentityId: reserveAdminId, versionId: proposedPolicy.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "Independently approve the complete test priority, acknowledgement, escalation, and resolution matrix.", commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });
      const dataPolicy = {
        policyReference: "SUPPORT-DATA-TEST-1",
        policyName: "Approved test support evidence policy",
        maximumBytes: 1_048_576,
        allowedMimeTypes: ["application/pdf", "image/png"],
        classifications: {
          general: { retentionDays: 30 },
          personal_data: { retentionDays: 60 },
          financial_record: { retentionDays: 365 },
          identity_document: { retentionDays: 90 },
          security_sensitive: { retentionDays: 120 },
        },
      };
      const proposedDataPolicy = await proposePlatformConfigurationVersion({
        actorIdentityId: supportAdminId, configurationKey: "support.case.data_policy", proposedValue: dataPolicy,
        expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000),
        reason: "Bind support evidence to exact approved file, classification, and retention controls.", commandKey: randomUUID(),
      });
      await decidePlatformConfigurationVersion({
        actorIdentityId: reserveAdminId, versionId: proposedDataPolicy.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "Independently approve the support evidence types, limits, classifications, and retention periods.", commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });
      const commandKey = randomUUID();
      const creation = { actorIdentityId: requesterId, actorRole: "investor" as const, category: "payment_status" as const,
        reportedImpact: "blocked" as const, subject: "Payment status has remained unclear", description: "The payment record remains pending after the provider page returned to Fractal.",
        relatedReference: marker, occurredAt: new Date(Date.now() - 60_000), commandKey };
      const created = await createSupportCase(creation);
      expect(created).toMatchObject({ replayed: false, case: { requester: { id: requesterId }, status: "new", version: 1, reference: expect.stringMatching(/^SUP-/),
        serviceLevel: { priority: "p2", cycleNumber: 1, policy: { versionId: proposedPolicy.version.id, reference: "SUPPORT-OPS-TEST-1" } } } });
      const delivered: Array<{ subject: string; text: string; html: string }> = [];
      expect(await dispatchPendingSupportNotifications({ workerId: "support-notification-test", logger: { info: () => undefined, error: () => undefined }, send: async (payload) => { delivered.push(payload); return { status: "sent", provider: "resend", providerMessageId: `resend-${payload.idempotencyKey}` }; } })).toBe(1);
      expect(delivered[0]).toMatchObject({ subject: expect.stringContaining(created.case.reference), text: expect.stringContaining("intentionally contains no case description") });
      expect(delivered[0]!.text).not.toContain(created.case.description);
      const supportDelivery = (await getOwnSupportCase({
        actorIdentityId: requesterId,
        caseId: created.case.id,
      })).notificationDeliveries[0]!;
      expect(supportDelivery).toMatchObject({
        notificationType: "opened",
        status: "sent",
        provider: "resend",
        attempts: 1,
      });
      await expect(listResendPrivacyDeliveryReferencesForIdentity(requesterId))
        .resolves.toContainEqual({
          providerMessageId: `resend-fractal-support-${supportDelivery.id}`,
          recipientEmail: `${marker}-requester@example.test`,
        });
      await expect(listResendPrivacyDeliveryReferencesForIdentity(otherRequesterId))
        .resolves.not.toContainEqual(expect.objectContaining({
          providerMessageId: `resend-fractal-support-${supportDelivery.id}`,
        }));
      await expect(postgresQuery(
        `INSERT INTO fractal.auth_email_deliveries
           (id,identity_id,delivery_type,status,sent_at,provider,provider_message_id)
         VALUES ($1,$2,'password_reset','sent',now(),'resend',$3)`,
        [
          randomUUID(),
          requesterId,
          `resend-fractal-support-${supportDelivery.id}`,
        ],
      )).rejects.toThrow("already bound to another delivery command");
      const missingCorrelationId = randomUUID();
      await postgresQuery(
        `INSERT INTO fractal.auth_email_deliveries
           (id,identity_id,delivery_type,status)
         VALUES ($1,$2,'administrator_activation','requested')`,
        [missingCorrelationId, requesterId],
      );
      await expect(postgresQuery(
        `UPDATE fractal.auth_email_deliveries
            SET status='sent',sent_at=now()
          WHERE id=$1`,
        [missingCorrelationId],
      )).rejects.toThrow("requires exact provider correlation");
      await expect(postgresQuery(
        `INSERT INTO fractal.support_case_service_obligations
           (id,case_id,cycle_number,source_case_event_sequence,policy_version_id,policy_version_number,policy_projection_version,
            policy_value_sha256,policy_reference,policy_name,priority,acknowledgement_due_at,escalation_due_at,resolution_due_at,opened_at)
         SELECT $1,case_id,99,99,policy_version_id,policy_version_number,policy_projection_version,repeat('0',64),
                policy_reference,policy_name,priority,acknowledgement_due_at,escalation_due_at,resolution_due_at,opened_at
           FROM fractal.support_case_service_obligations WHERE id=$2`,
        [randomUUID(), created.case.serviceLevel!.obligationId],
      )).rejects.toThrow("exact active service-policy version");
      await expect(postgresQuery(
        `INSERT INTO fractal.support_case_service_obligations
           (id,case_id,cycle_number,source_case_event_sequence,policy_version_id,policy_version_number,policy_projection_version,
            policy_value_sha256,policy_reference,policy_name,priority,acknowledgement_due_at,escalation_due_at,resolution_due_at,opened_at)
         SELECT $1,case_id,99,99,policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,
                policy_reference,policy_name,'p4',acknowledgement_due_at,escalation_due_at,resolution_due_at,opened_at
           FROM fractal.support_case_service_obligations WHERE id=$2`,
        [randomUUID(), created.case.serviceLevel!.obligationId],
      )).rejects.toThrow("facts do not match the exact approved service policy");
      await expect(postgresQuery(
        `INSERT INTO fractal.support_case_service_events
           (id,obligation_id,event_type,actor_type,actor_identity_id,due_at,occurred_at,lateness_ms,evidence)
         VALUES ($1,$2,'escalated','user',$3,$4,$4,0,'{}'::jsonb)`,
        [randomUUID(), created.case.serviceLevel!.obligationId, supportAdminId, created.case.serviceLevel!.escalationDueAt],
      )).rejects.toThrow("actor does not match its event type");
      await expect(createSupportCase(creation)).resolves.toMatchObject({ replayed: true, case: { id: created.case.id } });
      await expect(getOwnSupportCase({ actorIdentityId: otherRequesterId, caseId: created.case.id })).rejects.toMatchObject({ code: "not_found" });
      await expect(listOwnSupportCases({ actorIdentityId: requesterId })).resolves.toMatchObject({ cases: [expect.objectContaining({ id: created.case.id })] });

      const requesterBytes = Buffer.from("requester support evidence");
      const requesterDigest = createHash("sha256").update(requesterBytes).digest("hex");
      const requesterAttachmentCommand = randomUUID();
      const requesterAttachmentInput = {
        caseId: created.case.id, actorIdentityId: requesterId, staff: false, visibility: "requester" as const,
        commandKey: requesterAttachmentCommand, classification: "financial_record" as const, filename: "receipt.pdf",
        mimeType: "application/pdf", bytes: requesterBytes.length, contentSha256: requesterDigest,
        storageKey: `support/${created.case.id}/${randomUUID()}-receipt.pdf`, scanner: "clamav_instream" as const,
        scannedAt: new Date(Date.now() - 1_000),
      };
      await expect(authorizeSupportCaseAttachmentUpload({
        caseId: created.case.id, actorIdentityId: otherRequesterId, staff: false, visibility: "requester", mimeType: "application/pdf",
      })).rejects.toMatchObject({ code: "not_found" });
      await expect(authorizeSupportCaseAttachmentUpload({
        caseId: created.case.id, actorIdentityId: requesterId, staff: false, visibility: "requester", mimeType: "application/zip",
      })).rejects.toMatchObject({ code: "invalid_input" });
      const requesterAttachment = await recordSupportCaseAttachment(requesterAttachmentInput);
      expect(requesterAttachment.attachment).toMatchObject({
        visibility: "requester", classification: "financial_record", retentionDays: 365,
        policy: { versionId: proposedDataPolicy.version.id, reference: "SUPPORT-DATA-TEST-1" },
        scan: { status: "clean", scanner: "clamav_instream" },
      });
      await expect(recordSupportCaseAttachment(requesterAttachmentInput)).rejects.toBeInstanceOf(SupportAttachmentReplayError);
      await expect(recordSupportCaseAttachment({ ...requesterAttachmentInput, actorIdentityId: otherRequesterId, commandKey: randomUUID(), storageKey: `support/${created.case.id}/${randomUUID()}-other.pdf` }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(recordSupportCaseAttachment({ ...requesterAttachmentInput, visibility: "internal", commandKey: randomUUID(), storageKey: `support/${created.case.id}/${randomUUID()}-internal.pdf` }))
        .rejects.toMatchObject({ code: "forbidden" });

      const internalBytes = Buffer.from("restricted operations evidence");
      const internalDigest = createHash("sha256").update(internalBytes).digest("hex");
      const internalAttachment = await recordSupportCaseAttachment({
        caseId: created.case.id, actorIdentityId: supportAdminId, staff: true, visibility: "internal", commandKey: randomUUID(),
        classification: "security_sensitive", filename: "provider-investigation.png", mimeType: "image/png",
        bytes: internalBytes.length, contentSha256: internalDigest, storageKey: `support/${created.case.id}/${randomUUID()}-investigation.png`,
        scanner: "clamav_instream", scannedAt: new Date(Date.now() - 1_000),
      });
      const requesterAttachmentDetail = await getOwnSupportCase({ actorIdentityId: requesterId, caseId: created.case.id });
      expect(requesterAttachmentDetail.attachments.map((attachment) => attachment.id)).toEqual([requesterAttachment.attachment.id]);
      expect(requesterAttachmentDetail.attachments[0]).not.toHaveProperty("storageKey");
      const administratorAttachmentDetail = await getAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id });
      expect(administratorAttachmentDetail.attachments.map((attachment) => attachment.id)).toEqual([
        requesterAttachment.attachment.id, internalAttachment.attachment.id,
      ]);
      await expect(getSupportCaseAttachmentForDownload({ attachmentId: internalAttachment.attachment.id, actorIdentityId: requesterId, staff: false }))
        .rejects.toMatchObject({ code: "not_found" });
      await expect(recordSupportCaseAttachmentDownload({ attachmentId: requesterAttachment.attachment.id, actorIdentityId: requesterId, staff: false, verifiedSha256: "0".repeat(64) }))
        .rejects.toMatchObject({ code: "invalid_input" });
      await recordSupportCaseAttachmentDownload({ attachmentId: requesterAttachment.attachment.id, actorIdentityId: requesterId, staff: false, verifiedSha256: requesterDigest });
      expect((await postgresQuery<{ integrity_verified: boolean }>("SELECT integrity_verified FROM fractal.support_case_attachment_access_events WHERE attachment_id=$1", [requesterAttachment.attachment.id])).rows)
        .toEqual([{ integrity_verified: true }]);
      await expect(postgresQuery("UPDATE fractal.support_case_attachments SET filename='tampered.pdf' WHERE id=$1", [requesterAttachment.attachment.id]))
        .rejects.toThrow("support attachment evidence is immutable");

      const expiredAttachmentId = randomUUID();
      const expiredDigest = createHash("sha256").update("expired support evidence").digest("hex");
      await postgresQuery(
        `INSERT INTO fractal.support_case_attachments
          (id,case_id,uploaded_by_identity_id,command_key,visibility,classification,filename,mime_type,bytes,content_sha256,storage_key,
           scan_status,scanner,scanned_at,policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,
           policy_reference,policy_name,retention_days,uploaded_at,retention_due_at)
         SELECT $1,case_id,$2,$3,'requester','general','expired-evidence.pdf','application/pdf',24,$4,$5,
                'clean','clamav_instream',$6,policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,
                policy_reference,policy_name,30,$7::timestamptz,$7::timestamptz+interval '30 days'
           FROM fractal.support_case_attachments WHERE id=$8`,
        [expiredAttachmentId, requesterId, randomUUID(), expiredDigest, `local://support/${created.case.id}/${expiredAttachmentId}.pdf`,
          new Date(Date.now() - 32 * 86_400_000), new Date(Date.now() - 31 * 86_400_000), requesterAttachment.attachment.id],
      );
      await expect(resolveSupportEvidenceHoldTarget({ actorIdentityId: supportAdminId, attachmentId: expiredAttachmentId, scope: "case" }))
        .resolves.toEqual({ targetType: "support_case", targetId: created.case.id });
      await expect(resolveSupportEvidenceHoldTarget({ actorIdentityId: supportAdminId, attachmentId: expiredAttachmentId, scope: "requester_identity" }))
        .resolves.toEqual({ targetType: "identity", targetId: requesterId });
      const holdCommand = { actorIdentityId: supportAdminId, targetType: "support_attachment" as const, targetId: expiredAttachmentId,
        changeType: "impose" as const, reasonCategory: "complaint" as const,
        reason: "Preserve the evidence while the formal complaint and its review remain active.", commandKey: randomUUID() };
      const holdProposal = await proposeLegalHoldChange(holdCommand);
      expect(await proposeLegalHoldChange(holdCommand)).toMatchObject({ replayed: true, request: { id: holdProposal.request.id } });
      await expect(proposeSupportAttachmentDisposition({ actorIdentityId: reserveAdminId, attachmentId: expiredAttachmentId,
        reason: "A pending protective hold must reserve the evidence before either independent decision completes.", commandKey: randomUUID() }))
        .rejects.toMatchObject({ code: "conflict" });
      await expect(decideLegalHoldChange({ actorIdentityId: supportAdminId, requestId: holdProposal.request.id, decision: "approve",
        decisionReason: "A maker cannot approve the legal hold they proposed for this evidence." })).rejects.toMatchObject({ code: "forbidden" });
      await decideLegalHoldChange({ actorIdentityId: reserveAdminId, requestId: holdProposal.request.id, decision: "approve",
        decisionReason: "Independently confirm the complaint scope and preserve this evidence from disposition." });
      await expect(proposeSupportAttachmentDisposition({ actorIdentityId: supportAdminId, attachmentId: expiredAttachmentId,
        reason: "Delete evidence whose approved retention period has elapsed after all holds are cleared.", commandKey: randomUUID() }))
        .rejects.toMatchObject({ code: "conflict" });
      const releaseProposal = await proposeLegalHoldChange({ ...holdCommand, changeType: "release", commandKey: randomUUID(),
        reason: "Release the evidence after the complaint owner confirmed the preservation need has ended." });
      await decideLegalHoldChange({ actorIdentityId: reserveAdminId, requestId: releaseProposal.request.id, decision: "approve",
        decisionReason: "Independently verify complaint closure and approve release of this evidence hold." });
      const dispositionProposal = await proposeSupportAttachmentDisposition({ actorIdentityId: supportAdminId, attachmentId: expiredAttachmentId,
        reason: "Delete the object after its approved retention period and legal hold release were verified.", commandKey: randomUUID() });
      await decideSupportAttachmentDisposition({ actorIdentityId: reserveAdminId, requestId: dispositionProposal.request.id, decision: "approve",
        decisionReason: "Independently verify the retention deadline, released hold, digest, and deletion scope." });
      await expect(getSupportCaseAttachmentForDownload({ attachmentId: expiredAttachmentId, actorIdentityId: requesterId, staff: false }))
        .rejects.toMatchObject({ code: "conflict" });
      expect(await readSupportAttachmentLifecycle({ actorIdentityId: supportAdminId, attachmentId: expiredAttachmentId }))
        .toMatchObject({ activeHolds: [], pendingHoldChanges: [], pendingDispositionRequest: null, disposition: { status: "cleanup_requested" } });
      const removed: string[] = [];
      expect(await dispatchPendingStorageCleanupTasks({ workerId: "support-disposition-test", logger: { info: () => undefined, error: () => undefined },
        remove: async (storageKey) => { removed.push(storageKey); } })).toBe(1);
      expect(removed).toEqual([`local://support/${created.case.id}/${expiredAttachmentId}.pdf`]);
      expect(await readSupportAttachmentLifecycle({ actorIdentityId: reserveAdminId, attachmentId: expiredAttachmentId }))
        .toMatchObject({ disposition: { status: "completed", completedAt: expect.any(String) } });
      await expect(proposeLegalHoldChange({ ...holdCommand, commandKey: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
      await expect(postgresQuery("UPDATE fractal.support_attachment_disposition_requests SET reason='tampered lifecycle evidence' WHERE id=$1", [dispositionProposal.request.id]))
        .rejects.toThrow("terminal support disposition evidence is immutable");

      const requesterMessage = await addRequesterSupportMessage({ actorIdentityId: requesterId, caseId: created.case.id, expectedVersion: 1,
        message: "The provider reference is visible, but no confirmed receipt has appeared.", commandKey: randomUUID() });
      expect(requesterMessage.case).toMatchObject({ version: 2, status: "new" });
      const afterDeadlines = new Date(new Date(created.case.serviceLevel!.resolutionDueAt).getTime() + 1_000);
      expect(await sweepSupportCaseServiceDeadlines({ workerId: "support-test-worker", now: afterDeadlines })).toEqual({ acknowledgementBreaches: 1, escalations: 1, resolutionBreaches: 1 });
      expect(await sweepSupportCaseServiceDeadlines({ workerId: "support-test-worker-replay", now: afterDeadlines })).toEqual({ acknowledgementBreaches: 0, escalations: 0, resolutionBreaches: 0 });
      await expect(postgresQuery("UPDATE fractal.support_case_service_events SET evidence='{}'::jsonb WHERE obligation_id=$1", [created.case.serviceLevel!.obligationId]))
        .rejects.toThrow("service evidence is immutable");
      const sweeps = await postgresQuery<{ outcome: string; total: string }>(
        `SELECT outcome, count(*)::text AS total FROM fractal.support_case_service_sweeps GROUP BY outcome`,
      );
      expect(sweeps.rows).toEqual([{ outcome: "completed", total: "2" }]);
      await expect(listAdministratorSupportCases({ actorIdentityId: otherRequesterId })).rejects.toMatchObject({ code: "forbidden" });
      await expect(listAdministratorSupportCases({ actorIdentityId: supportAdminId, status: "new" })).resolves.toMatchObject({ cases: [expect.objectContaining({ id: created.case.id })] });

      const triaged = await transitionAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id, action: "triage", expectedVersion: 2,
        message: "Triage confirms the payment authority must be checked before any retry.", commandKey: randomUUID() });
      expect(triaged.case).toMatchObject({ version: 3, status: "triaged", assignee: { id: supportAdminId } });
      expect((await getAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id })).serviceEvents.map((event) => event.eventType))
        .toEqual(expect.arrayContaining(["acknowledgement_breached", "escalated", "resolution_breached", "acknowledgement_met"]));
      const started = await transitionAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id, action: "start", expectedVersion: 3,
        message: "Begin reconciliation against the stored provider instruction and webhook inbox.", commandKey: randomUUID() });
      expect(started.case).toMatchObject({ version: 4, status: "in_progress" });
      await transitionAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id, action: "reply", expectedVersion: 4,
        message: "We are reconciling the stored payment record. Do not submit a second payment.", commandKey: randomUUID() });
      await postgresQuery("UPDATE fractal.support_case_notification_deliveries SET attempts=11 WHERE case_id=$1 AND case_event_sequence=5", [created.case.id]);
      expect(await dispatchPendingSupportNotifications({ workerId: "support-notification-terminal-test", logger: { info: () => undefined, error: () => undefined }, send: async () => ({ status: "failed", error: "test transport refusal" }) })).toBe(1);
      expect(await dispatchPendingSupportNotifications({ workerId: "support-notification-terminal-replay", logger: { info: () => undefined, error: () => undefined }, send: async () => ({ status: "sent", provider: "resend", providerMessageId: "resend-terminal-replay" }) })).toBe(0);
      expect((await getOwnSupportCase({ actorIdentityId: requesterId, caseId: created.case.id })).notificationDeliveries)
        .toEqual(expect.arrayContaining([expect.objectContaining({ caseEventSequence: 5, notificationType: "staff_reply", status: "terminal", attempts: 12 })]));
      await transitionAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id, action: "note", expectedVersion: 5,
        message: "Internal provider-inbox comparison is in progress.", commandKey: randomUUID() });
      const requesterDetail = await getOwnSupportCase({ actorIdentityId: requesterId, caseId: created.case.id });
      expect(requesterDetail.events.map((event) => event.sequence)).toEqual([1, 2, 5]);
      expect(requesterDetail.events.some((event) => event.visibility === "internal")).toBe(false);
      const staffDetail = await getAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id });
      expect(staffDetail.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);

      const resolved = await transitionAdministratorSupportCase({ actorIdentityId: supportAdminId, caseId: created.case.id, action: "resolve", expectedVersion: 6,
        message: "The provider instruction failed before settlement; no payment or allocation was recorded.", commandKey: randomUUID() });
      expect(resolved.case).toMatchObject({ version: 7, status: "resolved", resolutionSummary: expect.stringContaining("no payment") });
      const reopened = await addRequesterSupportMessage({ actorIdentityId: requesterId, caseId: created.case.id, expectedVersion: 7,
        message: "Please confirm whether the existing checkout reservation has also been released.", commandKey: randomUUID() });
      expect(reopened.case).toMatchObject({ version: 8, status: "in_progress", resolutionSummary: null });
      const resolvedAgain = await transitionAdministratorSupportCase({ actorIdentityId: reserveAdminId, caseId: created.case.id, action: "resolve", expectedVersion: 8,
        message: "The expired reservation was released and no allocation or settlement record exists.", commandKey: randomUUID() });
      const closed = await transitionAdministratorSupportCase({ actorIdentityId: reserveAdminId, caseId: created.case.id, action: "close", expectedVersion: 9,
        message: "Close after the requester-visible resolution and reservation confirmation.", commandKey: randomUUID() });
      expect(closed.case).toMatchObject({ version: 10, status: "closed", resolutionSummary: resolvedAgain.case.resolutionSummary });
      await expect(postgresQuery("UPDATE fractal.support_case_events SET message='tampered' WHERE case_id=$1 AND sequence=2", [created.case.id])).rejects.toThrow("events are immutable");
      await expect(postgresQuery("UPDATE fractal.support_cases SET version=version+1, last_activity_at=last_activity_at+interval '1 second' WHERE id=$1", [created.case.id])).rejects.toThrow("requires its immutable event");
    } finally {
      await postgresQuery("TRUNCATE fractal.distribution_privacy_treatment_executions, fractal.distribution_privacy_treatment_requests, fractal.distribution_lifecycle_policy_bindings, fractal.investor_distribution_tax_statements, fractal.distribution_tax_remittance_reversal_requests, fractal.distribution_tax_remittance_requests, fractal.distribution_tax_remittance_policies, fractal.distribution_payout_exception_executions, fractal.distribution_payout_exception_hold_requests, fractal.distribution_payout_exception_evidence, fractal.distribution_payout_exception_cases, fractal.distribution_payout_exception_policies, fractal.distribution_payout_provider_events, fractal.distribution_payout_instructions, fractal.distribution_funding_requests, fractal.distribution_payout_recipient_recovery_cases, fractal.investor_distribution_payout_profiles, fractal.distribution_entitlements, fractal.distribution_declaration_requests, fractal.privacy_rights_package_preparations, fractal.privacy_rights_policy_bindings, fractal.privacy_rights_request_events, fractal.privacy_rights_decision_requests, fractal.privacy_rights_requests, fractal.storage_cleanup_tasks, fractal.support_attachment_dispositions, fractal.support_attachment_disposition_requests, fractal.data_legal_holds, fractal.data_legal_hold_change_requests, fractal.support_case_attachment_access_events, fractal.support_case_attachments, fractal.support_case_notification_deliveries, fractal.support_case_service_events, fractal.support_case_service_obligations, fractal.support_case_service_sweeps, fractal.platform_configuration_activation_attempts, fractal.platform_configuration_events, fractal.platform_configuration_active_versions, fractal.platform_configuration_versions, fractal.support_case_events, fractal.support_cases, fractal.auth_email_deliveries, fractal.administrator_capability_assignments CASCADE");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("governs typed platform configuration through validation, independent approval, scheduled activation, supersession, and rollback", async () => {
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const unassignedId = randomUUID();
    const identities = [makerId, checkerId, unassignedId];
    const marker = `configuration-${randomUUID()}`;
    const key = "public.catalogue.default_page_size";
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1, $2, 'Configuration maker', 'active', now()),
                ($3, $4, 'Configuration checker', 'active', now()),
                ($5, $6, 'Unassigned administrator', 'active', now())`,
        [makerId, `${marker}-maker@example.test`, checkerId, `${marker}-checker@example.test`, unassignedId, `${marker}-unassigned@example.test`],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'admin', 'global'), ($5, $6, 'admin', 'global')`,
        [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), unassignedId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_assignments (id, identity_id, capability_key)
         VALUES ($1, $2, 'platform_configuration_manage'), ($3, $4, 'platform_configuration_manage')`,
        [randomUUID(), makerId, randomUUID(), checkerId],
      );

      await expect(listPlatformConfigurations({ actorIdentityId: unassignedId })).rejects.toMatchObject({ code: "forbidden" });
      const invalid = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: key, proposedValue: 5, expectedProjectionVersion: null,
        effectiveAt: new Date(), reason: "Retain immutable evidence of a value that fails the governed minimum.", commandKey: randomUUID(),
      });
      expect(invalid.version).toMatchObject({ status: "validation_failed", stateVersion: 2, versionNumber: 1, validationOutput: { valid: false } });
      expect((invalid.version.validationOutput.errors as string[]).join(" ")).toContain("at least 6");

      const firstEffectiveAt = new Date(Date.now() - 1_000);
      const firstCommand = {
        actorIdentityId: makerId, configurationKey: key, proposedValue: 24, expectedProjectionVersion: null,
        effectiveAt: firstEffectiveAt, reason: "Set a bounded initial catalogue page size for new public requests.", commandKey: randomUUID(),
      };
      const first = await proposePlatformConfigurationVersion(firstCommand);
      const replay = await proposePlatformConfigurationVersion(firstCommand);
      expect(first).toMatchObject({ replayed: false, version: { status: "pending", versionNumber: 2, supersedesVersionId: null } });
      expect(replay).toMatchObject({ replayed: true, version: { id: first.version.id } });
      await expect(decidePlatformConfigurationVersion({
        actorIdentityId: makerId, versionId: first.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "A maker cannot independently approve the version they proposed.", commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "forbidden" });
      const approvedFirst = await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: first.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "The type, bounds, public-request impact, and effective time were independently reviewed.", commandKey: randomUUID(),
      });
      expect(approvedFirst.version).toMatchObject({ status: "scheduled", stateVersion: 2, reviewedBy: { id: checkerId } });
      await expect(decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: first.version.id, action: "reject", expectedStateVersion: 1,
        decisionReason: "A stale duplicate decision must never alter an approved schedule.", commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "invalid_state" });

      const duplicateActivation = await Promise.all([
        activateDuePlatformConfigurationVersions(new Date()),
        activateDuePlatformConfigurationVersions(new Date()),
      ]);
      expect(duplicateActivation.reduce((sum, item) => sum + item.activated, 0)).toBe(1);
      expect(duplicateActivation.reduce((sum, item) => sum + item.failed, 0)).toBe(0);
      expect(duplicateActivation.reduce((sum, item) => sum + item.alreadyTerminal, 0)).toBeLessThanOrEqual(1);
      await expect(readActivePlatformConfiguration(key)).resolves.toMatchObject({ versionId: first.version.id, versionNumber: 2, projectionVersion: 1, value: 24 });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toEqual({ activated: 0, failed: 0, alreadyTerminal: 0 });

      await expect(proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: key, proposedValue: 30, expectedProjectionVersion: null,
        effectiveAt: new Date(), reason: "A stale no-projection command must not overwrite the live configuration.", commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "stale_version" });

      const futureEffectiveAt = new Date(Date.now() + 60_000);
      const second = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: key, proposedValue: 30, expectedProjectionVersion: 1,
        effectiveAt: futureEffectiveAt, reason: "Increase the default only for public requests beginning after the scheduled boundary.", commandKey: randomUUID(),
      });
      expect(second.version).toMatchObject({ status: "pending", supersedesVersionId: first.version.id, impactPreview: { currentProjectionVersion: 1, valueChanged: true } });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: second.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "The future-only request binding and catalogue response impact were independently accepted.", commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date(futureEffectiveAt.getTime() - 1))).toEqual({ activated: 0, failed: 0, alreadyTerminal: 0 });
      expect(await readActivePlatformConfiguration(key)).toMatchObject({ versionId: first.version.id, value: 24, projectionVersion: 1 });
      expect(await activateDuePlatformConfigurationVersions(new Date(futureEffectiveAt.getTime() + 1_000))).toEqual({ activated: 1, failed: 0, alreadyTerminal: 0 });
      expect(await readActivePlatformConfiguration(key)).toMatchObject({ versionId: second.version.id, value: 30, projectionVersion: 2 });

      const rollbackEffectiveAt = new Date(futureEffectiveAt.getTime() + 2_000);
      const rollback = await proposePlatformConfigurationRollback({
        actorIdentityId: makerId, configurationKey: key, targetVersionId: first.version.id, expectedProjectionVersion: 2,
        effectiveAt: rollbackEffectiveAt, reason: "Restore the previously approved value after observed response-size pressure.", commandKey: randomUUID(),
      });
      expect(rollback.version).toMatchObject({ status: "pending", proposedValue: 24, rollbackOfVersionId: first.version.id, supersedesVersionId: second.version.id });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: rollback.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "The rollback target hash, prior approval, and forward-only effective boundary were independently checked.", commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date(rollbackEffectiveAt.getTime() + 1_000))).toEqual({ activated: 1, failed: 0, alreadyTerminal: 0 });
      expect(await readActivePlatformConfiguration(key)).toMatchObject({ versionId: rollback.version.id, value: 24, projectionVersion: 3 });

      const detail = await getPlatformConfigurationVersion({ actorIdentityId: checkerId, versionId: rollback.version.id });
      expect(detail.events.map((event) => event.eventType)).toEqual(["proposed", "approved", "activated"]);
      expect(detail.activationAttempts).toEqual([expect.objectContaining({ outcome: "activated", latenessMs: 1000 })]);
      const register = await listPlatformConfigurations({ actorIdentityId: makerId });
      const definition = register.definitions.find((item) => item.key === key);
      expect(definition).toMatchObject({ projectionVersion: 3, activeVersionId: rollback.version.id, valueType: "integer", consumerBinding: "next_request" });
      expect(definition?.versions.map((version) => version.status)).toEqual(["active", "superseded", "superseded", "validation_failed"]);
      await expect(postgresQuery("UPDATE fractal.platform_configuration_versions SET proposed_value = '42'::jsonb WHERE id = $1", [rollback.version.id]))
        .rejects.toThrow("proposed platform configuration facts are immutable");
      const audit = await postgresQuery<{ action: string }>("SELECT action FROM fractal.audit_events WHERE scope_key = $1 ORDER BY sequence", [`platform-configuration:${key}`]);
      expect(audit.rows.map((row) => row.action)).toEqual([
        "platform.configuration.validation_failed", "platform.configuration.proposed", "platform.configuration.approved", "platform.configuration.activated",
        "platform.configuration.proposed", "platform.configuration.approved", "platform.configuration.activated",
        "platform.configuration.proposed", "platform.configuration.approved", "platform.configuration.activated",
      ]);

      const failureEffectiveAt = new Date(rollbackEffectiveAt.getTime() + 4_000);
      const failureCandidate = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: key, proposedValue: 28, expectedProjectionVersion: 3,
        effectiveAt: failureEffectiveAt, reason: "Exercise fail-closed activation evidence against an intentionally corrupted projection.", commandKey: randomUUID(),
      });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: failureCandidate.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "Approve the bounded candidate before the database fault-injection step.", commandKey: randomUUID(),
      });
      await expect(postgresQuery(
        `UPDATE fractal.platform_configuration_versions
            SET status = 'failed', state_version = state_version + 1,
                failure_code = 'manual_fault', failure_detail = 'No immutable transition event accompanies this direct projection write.'
          WHERE id = $1`,
        [failureCandidate.version.id],
      )).rejects.toThrow("projection requires its matching immutable event");
      await expect(postgresQuery(
        "UPDATE fractal.platform_configuration_active_versions SET active_version_id = $1, projection_version = 4, bound_at = bound_at + interval '1 second' WHERE configuration_key = $2",
        [second.version.id, key],
      )).rejects.toThrow("projection requires its exact activation event");
      // Fault injection: a separately privileged database actor violates the
      // database invariant by disabling only its deferred evidence trigger.
      // The worker must not overwrite this surprise state or retry forever.
      await postgresQuery("ALTER TABLE fractal.platform_configuration_active_versions DISABLE TRIGGER platform_configuration_active_projection_event");
      try {
        await postgresQuery(
          "UPDATE fractal.platform_configuration_active_versions SET active_version_id = $1, projection_version = 4, bound_at = bound_at + interval '1 second' WHERE configuration_key = $2",
          [second.version.id, key],
        );
      } finally {
        await postgresQuery("ALTER TABLE fractal.platform_configuration_active_versions ENABLE TRIGGER platform_configuration_active_projection_event");
      }
      expect(await activateDuePlatformConfigurationVersions(new Date(failureEffectiveAt.getTime() + 1_000))).toEqual({ activated: 0, failed: 1, alreadyTerminal: 0 });
      const failedDetail = await getPlatformConfigurationVersion({ actorIdentityId: checkerId, versionId: failureCandidate.version.id });
      expect(failedDetail.version).toMatchObject({ status: "failed", failureCode: "stale_active_projection" });
      expect(failedDetail.activationAttempts).toEqual([expect.objectContaining({ outcome: "failed", failureCode: "stale_active_projection" })]);
      const failureEvidence = await postgresQuery<{ action: string; event_type: string }>(
        `SELECT audit.action, outbox.event_type
           FROM fractal.audit_events audit
           JOIN fractal.outbox_events outbox ON outbox.aggregate_id = audit.entity_id
          WHERE audit.entity_id = $1
            AND audit.action = 'platform.configuration.activation_failed'
            AND outbox.event_type = 'platform.configuration.activation_failed'`,
        [failureCandidate.version.id],
      );
      expect(failureEvidence.rows).toEqual([{ action: "platform.configuration.activation_failed", event_type: "platform.configuration.activation_failed" }]);
    } finally {
      await postgresQuery("TRUNCATE fractal.distribution_privacy_treatment_executions, fractal.distribution_privacy_treatment_requests, fractal.distribution_lifecycle_policy_bindings, fractal.investor_distribution_tax_statements, fractal.distribution_tax_remittance_reversal_requests, fractal.distribution_tax_remittance_requests, fractal.distribution_tax_remittance_policies, fractal.distribution_payout_exception_executions, fractal.distribution_payout_exception_hold_requests, fractal.distribution_payout_exception_evidence, fractal.distribution_payout_exception_cases, fractal.distribution_payout_exception_policies, fractal.distribution_payout_provider_events, fractal.distribution_payout_instructions, fractal.distribution_funding_requests, fractal.distribution_payout_recipient_recovery_cases, fractal.investor_distribution_payout_profiles, fractal.distribution_entitlements, fractal.distribution_declaration_requests, fractal.privacy_rights_package_preparations, fractal.privacy_rights_policy_bindings, fractal.privacy_rights_request_events, fractal.privacy_rights_decision_requests, fractal.privacy_rights_requests, fractal.storage_cleanup_tasks, fractal.support_attachment_dispositions, fractal.support_attachment_disposition_requests, fractal.data_legal_holds, fractal.data_legal_hold_change_requests, fractal.support_case_attachment_access_events, fractal.support_case_attachments, fractal.support_case_notification_deliveries, fractal.support_case_service_events, fractal.support_case_service_obligations, fractal.platform_configuration_activation_attempts, fractal.platform_configuration_events, fractal.platform_configuration_active_versions, fractal.platform_configuration_versions, fractal.administrator_capability_assignments CASCADE");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("publishes immutable legal bytes with maker-checker control and records exact registration and re-acceptance evidence", async () => {
    const makerId = randomUUID(); const checkerId = randomUUID(); const unassignedId = randomUUID();
    const identities = [makerId, checkerId, unassignedId];
    const marker = randomUUID();
    const content = (title: string, revision: string) => ({
      title, eyebrow: "Approved legal notice", lead: `This ${title} ${revision} text is complete enough to exercise immutable publication evidence.`,
      readingTime: "8 min read", keyPoints: ["The exact canonical content hash controls acceptance evidence."],
      sections: [{ id: "scope", title: "1. Scope", paragraphs: [`This ${revision} approved test paragraph proves that draft, published, superseded, and accepted legal bytes remain distinct.`] }],
    });
    try {
      await postgresQuery(`INSERT INTO fractal.identities (id,email,legal_name,status,email_verified_at) VALUES
        ($1,$2,'Content maker','active',now()),($3,$4,'Content checker','active',now()),($5,$6,'Unassigned admin','active',now())`,
      [makerId, `content-maker-${marker}@example.test`, checkerId, `content-checker-${marker}@example.test`, unassignedId, `content-unassigned-${marker}@example.test`]);
      await postgresQuery(`INSERT INTO fractal.identity_role_assignments (id,identity_id,role,scope_type) VALUES
        ($1,$2,'admin','global'),($3,$4,'admin','global'),($5,$6,'admin','global')`, [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), unassignedId]);
      await postgresQuery(`INSERT INTO fractal.administrator_capability_assignments (id,identity_id,capability_key) VALUES
        ($1,$2,'platform_content_manage'),($3,$4,'platform_content_manage')`, [randomUUID(), makerId, randomUUID(), checkerId]);
      await expect(listPlatformContent({ actorIdentityId: unassignedId })).rejects.toMatchObject({ code: "forbidden" });

      const invalid = await proposePlatformContentVersion({ actorIdentityId: makerId, documentKey: "risk_global_public", semanticVersion: "0.0.1", content: { title: "Too thin" }, reacceptanceRequired: false, expectedProjectionVersion: null, effectiveAt: new Date(), changeSummary: "Retain structural validation evidence for incomplete legal content.", commandKey: randomUUID() });
      expect(invalid.version).toMatchObject({ status: "validation_failed", stateVersion: 2, validationOutput: { valid: false } });
      await expect(readPublishedLegalDocument("risk-disclosures")).rejects.toMatchObject({ code: "unavailable" });

      const references: Array<{ documentKey: string; versionId: string; contentSha256: string }> = [];
      for (const [documentKey, slug, title] of [["terms_global_public", "terms", "Terms of use"], ["privacy_global_public", "privacy", "Privacy notice"]] as const) {
        const proposal = await proposePlatformContentVersion({ actorIdentityId: makerId, documentKey, semanticVersion: "1.0.0", content: content(title, "version one"), reacceptanceRequired: true, expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000), changeSummary: `Adopt the complete initial ${title} test version with exact acceptance evidence.`, commandKey: randomUUID() });
        await expect(decidePlatformContentVersion({ actorIdentityId: makerId, versionId: proposal.version.id, action: "approve", expectedStateVersion: 1, decisionReason: "The maker must never approve their own legal content proposal.", commandKey: randomUUID() })).rejects.toMatchObject({ code: "forbidden" });
        const approved = await decidePlatformContentVersion({ actorIdentityId: checkerId, versionId: proposal.version.id, action: "approve", expectedStateVersion: 1, decisionReason: `Independently approve the complete ${title} structure, hash, and effective boundary.`, commandKey: randomUUID() });
        expect(approved.version).toMatchObject({ status: "scheduled", reviewedBy: { id: checkerId } });
        expect(await publishDuePlatformContent()).toMatchObject({ published: 1, failed: 0 });
        const published = await readPublishedLegalDocument(slug);
        expect(published).toMatchObject({ documentKey, semanticVersion: "1.0.0", content: { title } });
        const bytes = await readPublishedLegalDocumentBytes(slug, published.versionId);
        expect(createHash("sha256").update(bytes.bytes).digest("hex")).toBe(published.contentSha256);
        references.push({ documentKey, versionId: published.versionId, contentSha256: published.contentSha256 });
      }
      expect(await listPublishedLegalDocuments()).toMatchObject({ registrationDocumentsAvailable: true, documents: expect.arrayContaining([expect.objectContaining({ slug: "terms" }), expect.objectContaining({ slug: "privacy" })]) });

      const staleEmail = `stale-consent-${marker}@example.test`;
      await expect(createPostgresAuthIdentity({ email: staleEmail, legalName: "Stale Consent", role: "investor", passwordHash: "test-password-hash", legalAcceptances: references.map((reference, index) => index ? reference : { ...reference, contentSha256: "0".repeat(64) }) })).rejects.toMatchObject({ code: "stale_version" });
      expect(await getPostgresAuthIdentityByEmail(staleEmail)).toBeNull();

      const account = await createPostgresAuthIdentity({ email: `accepted-consent-${marker}@example.test`, legalName: "Accepted Consent", role: "investor", passwordHash: "test-password-hash", legalAcceptances: references, acceptanceMetadata: { ip: "127.0.0.20", userAgent: "Fractal integration" } });
      const acceptedRows = await postgresQuery<{ document_key: string; semantic_version: string; content_sha256: string; ip_hash: string; user_agent_hash: string }>("SELECT document_key,semantic_version,content_sha256,ip_hash,user_agent_hash FROM fractal.legal_document_acceptances WHERE identity_id=$1 ORDER BY document_key", [account.id]);
      expect(acceptedRows.rows).toHaveLength(2); expect(acceptedRows.rows.every((row) => row.semantic_version === "1.0.0" && row.ip_hash.length === 64 && row.user_agent_hash.length === 64)).toBe(true);

      const termsOne = await readPublishedLegalDocument("terms");
      await expect(postgresQuery(`INSERT INTO fractal.legal_document_acceptances
        (id,identity_id,content_version_id,document_key,semantic_version,content_sha256,acceptance_context,affirmative_action,evidence)
        VALUES ($1,$2,$3,$4,'9.9.9',$5,'registration','checkbox',$6)`,
      [randomUUID(), makerId, termsOne.versionId, termsOne.documentKey, termsOne.contentSha256, { projectionVersion: termsOne.projectionVersion, slug: termsOne.slug, acceptedContentSha256: termsOne.contentSha256 }])).rejects.toThrow("copied evidence does not match");
      const termsTwoProposal = await proposePlatformContentVersion({ actorIdentityId: makerId, documentKey: "terms_global_public", semanticVersion: "2.0.0", content: content("Terms of use", "version two material change"), reacceptanceRequired: true, expectedProjectionVersion: 1, effectiveAt: new Date(Date.now() - 1_000), changeSummary: "Adopt a material second Terms version and require exact-version re-acceptance.", commandKey: randomUUID() });
      await decidePlatformContentVersion({ actorIdentityId: checkerId, versionId: termsTwoProposal.version.id, action: "approve", expectedStateVersion: 1, decisionReason: "Independently approve the material Terms change and re-acceptance requirement.", commandKey: randomUUID() });
      expect(await publishDuePlatformContent()).toMatchObject({ published: 1, failed: 0 });
      const termsTwo = await readPublishedLegalDocument("terms");
      expect(termsTwo.versionId).not.toBe(termsOne.versionId);
      expect(await listPublishedLegalDocumentHistory("terms")).toMatchObject({ documents: [
        expect.objectContaining({ versionId: termsTwo.versionId, semanticVersion: "2.0.0" }),
        expect.objectContaining({ versionId: termsOne.versionId, semanticVersion: "1.0.0" }),
      ] });
      const supersededBytes = await readPublishedLegalDocumentBytes("terms", termsOne.versionId);
      expect(createHash("sha256").update(supersededBytes.bytes).digest("hex")).toBe(termsOne.contentSha256);
      expect(await getLegalConsentStatus(account.id)).toMatchObject({ available: true, required: [{ documentKey: "terms_global_public", versionId: termsTwo.versionId }] });
      await recordLegalReacceptance({ identityId: account.id, references: [{ documentKey: termsTwo.documentKey, versionId: termsTwo.versionId, contentSha256: termsTwo.contentSha256 }] });
      expect(await getLegalConsentStatus(account.id)).toMatchObject({ available: true, required: [] });
      await expect(postgresQuery("UPDATE fractal.legal_document_acceptances SET content_sha256=$2 WHERE id=(SELECT id FROM fractal.legal_document_acceptances WHERE identity_id=$1 LIMIT 1)", [account.id, "f".repeat(64)])).rejects.toThrow("evidence is immutable");
      await expect(postgresQuery("UPDATE fractal.platform_content_versions SET content='{}'::jsonb WHERE id=$1", [termsTwo.versionId])).rejects.toThrow("facts are immutable");

      const pendingPrivacy = await proposePlatformContentVersion({ actorIdentityId: makerId, documentKey: "privacy_global_public", semanticVersion: "1.1.0", content: content("Privacy notice", "unapproved draft"), reacceptanceRequired: false, expectedProjectionVersion: 1, effectiveAt: new Date(Date.now() + 60_000), changeSummary: "Propose a later privacy revision without exposing its draft bytes publicly.", commandKey: randomUUID() });
      expect((await readPublishedLegalDocument("privacy")).semanticVersion).toBe("1.0.0");
      await expect(postgresQuery(`UPDATE fractal.platform_content_versions SET status='scheduled',state_version=state_version+1,reviewed_by_identity_id=$2,decision_reason='Direct eventless review must fail database integrity.',reviewed_at=now() WHERE id=$1`, [pendingPrivacy.version.id, checkerId])).rejects.toThrow("requires its matching immutable event");
    } finally {
      await postgresQuery("TRUNCATE fractal.legal_document_acceptances, fractal.platform_content_events, fractal.platform_content_publications, fractal.platform_content_versions, fractal.auth_email_deliveries, fractal.administrator_capability_assignments");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id IN (SELECT id FROM fractal.identities WHERE email LIKE $1)", [`%${marker}@example.test`]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id IN (SELECT id FROM fractal.identities WHERE email LIKE $1)", [`%${marker}@example.test`]);
      await postgresQuery("DELETE FROM fractal.identities WHERE email LIKE $1", [`%${marker}@example.test`]);
    }
  });

  it("preserves capability quorum when a governed access change removes an administrator", async () => {
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const reserveId = randomUUID();
    const targetId = randomUUID();
    const identities = [makerId, checkerId, reserveId, targetId];
    const marker = `capability-quorum-${randomUUID()}`;
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1, $2, 'Quorum maker', 'active', now()),
                ($3, $4, 'Quorum checker', 'active', now()),
                ($5, $6, 'Quorum reserve', 'active', now()),
                ($7, $8, 'Quorum target', 'active', now())`,
        [
          makerId, `${marker}-maker@example.test`,
          checkerId, `${marker}-checker@example.test`,
          reserveId, `${marker}-reserve@example.test`,
          targetId, `${marker}-target@example.test`,
        ],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'admin', 'global'),
                ($5, $6, 'admin', 'global'), ($7, $8, 'admin', 'global')`,
        [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), reserveId, randomUUID(), targetId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_assignments (id, identity_id, capability_key)
         VALUES ($1, $2, 'audit_export'), ($3, $4, 'audit_export')`,
        [randomUUID(), reserveId, randomUUID(), targetId],
      );
      const request = await createIdentityAccessChangeRequest({
        actorIdentityId: makerId,
        targetIdentityId: targetId,
        changeType: "change_role",
        proposedRole: "operator",
        reason: "Move this administrator to an operational role after authority review.",
        commandKey: randomUUID(),
      });
      await expect(decideIdentityAccessChangeRequest({
        actorIdentityId: checkerId,
        requestId: request.request.id,
        decision: "approve",
        reason: "The role change is reviewed, but capability quorum must remain independently operable.",
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "last_administrator" } satisfies Partial<IdentityAccessGovernanceError>);
      const state = await postgresQuery<{ role: string; capability_key: string }>(
        `SELECT role.role, capability.capability_key
           FROM fractal.identity_role_assignments role
           JOIN fractal.administrator_capability_assignments capability
             ON capability.identity_id = role.identity_id AND capability.revoked_at IS NULL
          WHERE role.identity_id = $1 AND role.revoked_at IS NULL`,
        [targetId],
      );
      expect(state.rows).toEqual([{ role: "admin", capability_key: "audit_export" }]);
    } finally {
      await postgresQuery("TRUNCATE fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests, fractal.identity_access_change_requests");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("governs role changes through independent idempotent approval and revokes stale sessions", async () => {
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const reserveAdminId = randomUUID();
    const targetId = randomUUID();
    const sessionId = randomUUID();
    const identities = [makerId, checkerId, reserveAdminId, targetId];
    const marker = `access-governance-${randomUUID()}`;
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, email_verified_at)
         VALUES ($1, $2, 'Maker administrator', 'active', now()),
                ($3, $4, 'Checker administrator', 'active', now()),
                ($5, $6, 'Reserve administrator', 'active', now()),
                ($7, $8, 'Target investor', 'active', now())`,
        [
          makerId, `${marker}-maker@example.test`,
          checkerId, `${marker}-checker@example.test`,
          reserveAdminId, `${marker}-reserve@example.test`,
          targetId, `${marker}-target@example.test`,
        ],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'admin', 'global'),
                ($5, $6, 'admin', 'global'), ($7, $8, 'investor', 'global')`,
        [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), reserveAdminId, randomUUID(), targetId],
      );
      await postgresQuery(
        `INSERT INTO fractal.auth_sessions
           (id, token_family_id, subject_id, identity_id, role, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3::uuid::text, $3::uuid, 'investor', $4, now() + interval '1 hour')`,
        [sessionId, randomUUID(), targetId, "a".repeat(64)],
      );

      const command = {
        actorIdentityId: makerId,
        targetIdentityId: targetId,
        changeType: "change_role" as const,
        proposedRole: "operator" as const,
        reason: "Move this verified operational account into the operator workspace.",
        commandKey: randomUUID(),
      };
      const created = await createIdentityAccessChangeRequest(command);
      const replay = await createIdentityAccessChangeRequest(command);
      expect(created).toMatchObject({ replayed: false, request: { status: "pending", priorRole: "investor", proposedRole: "operator" } });
      expect(replay).toMatchObject({ replayed: true, request: { id: created.request.id } });

      await expect(decideIdentityAccessChangeRequest({
        actorIdentityId: makerId,
        requestId: created.request.id,
        decision: "approve",
        reason: "Maker must not approve the access change they requested.",
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<IdentityAccessGovernanceError>);

      const approved = await decideIdentityAccessChangeRequest({
        actorIdentityId: checkerId,
        requestId: created.request.id,
        decision: "approve",
        reason: "Identity evidence and operational responsibility were independently reviewed.",
        commandKey: randomUUID(),
      });
      expect(approved).toMatchObject({ replayed: false, request: { status: "applied", reviewedBy: { id: checkerId } } });

      const activeRole = await postgresQuery<{ role: string }>(
        "SELECT role FROM fractal.identity_role_assignments WHERE identity_id = $1 AND scope_type = 'global' AND revoked_at IS NULL",
        [targetId],
      );
      expect(activeRole.rows).toEqual([{ role: "operator" }]);
      const session = await postgresQuery<{ revoked_reason: string | null }>(
        "SELECT revoked_reason FROM fractal.auth_sessions WHERE id = $1",
        [sessionId],
      );
      expect(session.rows[0]?.revoked_reason).toBe("administrator_role_change");

      const queue = await listIdentityAccessChangeRequests({ status: "applied", query: `${marker}-target`, limit: 20 });
      expect(queue.requests).toHaveLength(1);
      const audit = await postgresQuery<{ action: string }>(
        "SELECT action FROM fractal.audit_events WHERE entity_id = $1 ORDER BY sequence",
        [created.request.id],
      );
      expect(audit.rows.map((row) => row.action)).toEqual([
        "identity.access_change.requested",
        "identity.access_change.applied",
      ]);
      const outbox = await postgresQuery<{ event_type: string }>(
        "SELECT event_type FROM fractal.outbox_events WHERE aggregate_id = $1 ORDER BY occurred_at",
        [created.request.id],
      );
      expect(outbox.rows.map((row) => row.event_type)).toEqual([
        "identity.access_change.requested",
        "identity.access_change.applied",
      ]);

      const staleMakerRequest = await createIdentityAccessChangeRequest({
        actorIdentityId: makerId,
        targetIdentityId: targetId,
        changeType: "suspend",
        reason: "Suspend this account while a documented security investigation is completed.",
        commandKey: randomUUID(),
      });
      await postgresQuery("UPDATE fractal.identities SET status = 'disabled' WHERE id = $1", [makerId]);
      await expect(decideIdentityAccessChangeRequest({
        actorIdentityId: checkerId,
        requestId: staleMakerRequest.request.id,
        decision: "approve",
        reason: "Attempted decision after the maker lost administrator authority.",
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "conflict" } satisfies Partial<IdentityAccessGovernanceError>);
    } finally {
      await postgresQuery("DELETE FROM fractal.identity_access_change_requests WHERE target_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.auth_sessions WHERE subject_id = ANY($1::text[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("seals one passwordless administrator cohort and refuses every later bootstrap path", async () => {
    type Assignment = { id: string; identity_id: string; scope_type: string; scope_id: string | null; granted_at: Date; revoked_at: Date | null };
    const priorAdministrators = await postgresQuery<Assignment>(
      `DELETE FROM fractal.identity_role_assignments
        WHERE role = 'admin'
        RETURNING id, identity_id, scope_type, scope_id, granted_at, revoked_at`,
    );
    let identityIds: string[] = [];
    const marker = randomUUID();
    try {
      const result = await bootstrapAdministratorCohort({
        initiatedBy: "release-security-operator",
        members: [
          { email: `bootstrap-a-${marker}@example.test`, legalName: "Bootstrap Administrator A" },
          { email: `bootstrap-b-${marker}@example.test`, legalName: "Bootstrap Administrator B" },
          { email: `bootstrap-c-${marker}@example.test`, legalName: "Bootstrap Administrator C" },
        ],
      });
      identityIds = result.identityIds;
      expect(result).toMatchObject({ cohortSize: 3, sealedAt: expect.any(String) });
      expect(new Set(identityIds).size).toBe(3);

      const identities = await postgresQuery<{
        status: string; password_hash: string | null; email_verified_at: Date | null; role: string;
      }>(
        `SELECT identity.status, identity.password_hash, identity.email_verified_at, assignment.role
           FROM fractal.identities identity
           JOIN fractal.identity_role_assignments assignment ON assignment.identity_id = identity.id
          WHERE identity.id = ANY($1::uuid[]) AND assignment.revoked_at IS NULL
          ORDER BY identity.email`,
        [identityIds],
      );
      expect(identities.rows).toHaveLength(3);
      expect(identities.rows.every((identity) => identity.status === "active"
        && identity.password_hash === null
        && identity.email_verified_at === null
        && identity.role === "admin")).toBe(true);
      const deliveries = await postgresQuery<{ delivery_type: string; status: string }>(
        "SELECT delivery_type, status FROM fractal.auth_email_deliveries WHERE identity_id = ANY($1::uuid[])",
        [identityIds],
      );
      expect(deliveries.rows).toHaveLength(3);
      expect(deliveries.rows.every((delivery) => delivery.delivery_type === "administrator_activation" && delivery.status === "requested")).toBe(true);
      await expect(readAdministratorOperationsStatus()).resolves.toMatchObject({
        bootstrap: { cohortId: result.cohortId, cohortSize: 3 },
        recovery: { pendingCount: 0 },
      });

      await expect(bootstrapAdministratorCohort({
        initiatedBy: "second-release-operator",
        members: [
          { email: `later-a-${marker}@example.test`, legalName: "Later Administrator A" },
          { email: `later-b-${marker}@example.test`, legalName: "Later Administrator B" },
          { email: `later-c-${marker}@example.test`, legalName: "Later Administrator C" },
        ],
      })).rejects.toMatchObject({ code: "sealed" } satisfies Partial<AdministratorOperationsError>);
      await expect(postgresQuery(
        "UPDATE fractal.administrator_bootstrap_state SET initiated_by = 'tampered-operator'",
      )).rejects.toThrow("administrator_bootstrap_state is sealed");
      const evidence = await postgresQuery<{ action: string }>(
        "SELECT action FROM fractal.audit_events WHERE action LIKE 'identity.administrator_bootstrap.%' ORDER BY sequence",
      );
      expect(evidence.rows.map((row) => row.action)).toEqual([
        "identity.administrator_bootstrap.provisioned",
        "identity.administrator_bootstrap.provisioned",
        "identity.administrator_bootstrap.provisioned",
        "identity.administrator_bootstrap.sealed",
      ]);
    } finally {
      await postgresQuery("TRUNCATE fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests, fractal.administrator_recovery_requests, fractal.administrator_bootstrap_state, fractal.auth_email_deliveries, fractal.identity_access_change_requests, fractal.payment_provider_instructions, fractal.security_notifications, fractal.auth_step_up_grants, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events, fractal.auth_sessions, fractal.idempotency_commands");
      if (identityIds.length) {
        await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identityIds]);
        await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identityIds]);
      }
      for (const assignment of priorAdministrators.rows) {
        await postgresQuery(
          `INSERT INTO fractal.identity_role_assignments
             (id, identity_id, role, scope_type, scope_id, granted_at, revoked_at)
           VALUES ($1, $2, 'admin', $3, $4, $5, $6)`,
          [assignment.id, assignment.identity_id, assignment.scope_type, assignment.scope_id, assignment.granted_at, assignment.revoked_at],
        );
      }
    }
  });

  it("requires independent break-glass approval and destroys every prior administrator credential", async () => {
    const targetId = randomUUID();
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const nativeSessionId = randomUUID();
    const mappedLegacySessionId = randomUUID();
    const accessRequestId = randomUUID();
    const identities = [targetId, makerId, checkerId];
    const marker = randomUUID();
    const requestFingerprint = administratorOperationsKeyFingerprint("request-key-material-that-is-independent-0001");
    const approvalFingerprint = administratorOperationsKeyFingerprint("approval-key-material-that-is-independent-0002");
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id, email, legal_name, status, password_hash, email_verified_at)
         VALUES ($1, $2, 'Recovery target', 'active', 'old-password-hash', now()),
                ($3, $4, 'Recovery maker', 'active', 'maker-password-hash', now()),
                ($5, $6, 'Recovery checker', 'active', 'checker-password-hash', now())`,
        [
          targetId, `recovery-target-${marker}@example.test`,
          makerId, `recovery-maker-${marker}@example.test`,
          checkerId, `recovery-checker-${marker}@example.test`,
        ],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global'), ($3, $4, 'admin', 'global'), ($5, $6, 'admin', 'global')`,
        [randomUUID(), targetId, randomUUID(), makerId, randomUUID(), checkerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.auth_sessions
           (id, token_family_id, subject_id, identity_id, role, refresh_token_hash, expires_at)
         VALUES ($1, $2, $3::uuid::text, $3, 'admin', $4, now() + interval '1 hour'),
                ($5, $6, $7, $3, 'admin', $8, now() + interval '1 hour')`,
        [nativeSessionId, randomUUID(), targetId, "a".repeat(64), mappedLegacySessionId, randomUUID(), `legacy-${marker}`, "b".repeat(64)],
      );
      await postgresQuery(
        `INSERT INTO fractal.auth_step_up_grants (session_id, identity_id, method, expires_at)
         VALUES ($1, $2, 'totp', now() + interval '10 minutes')`,
        [nativeSessionId, targetId],
      );
      await postgresQuery(
        `INSERT INTO fractal.totp_factors
           (id, identity_id, secret_ciphertext, confirmed_at, last_used_counter)
         VALUES ($1, $2, 'encrypted-old-secret', now(), 42)`,
        [randomUUID(), targetId],
      );
      await postgresQuery(
        `INSERT INTO fractal.totp_recovery_codes (id, identity_id, code_digest)
         VALUES ($1, $2, $3)`,
        [randomUUID(), targetId, "c".repeat(64)],
      );
      await postgresQuery(
        `INSERT INTO fractal.auth_email_deliveries (id, identity_id, delivery_type, status)
         VALUES ($1, $2, 'password_reset', 'requested')`,
        [randomUUID(), targetId],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_access_change_requests
           (id, target_identity_id, change_type, prior_role, proposed_role, prior_status, reason, requested_by_identity_id)
         VALUES ($1, $2, 'suspend', 'admin', NULL, 'active', 'Investigate this administrator before any ordinary access decision.', $3)`,
        [accessRequestId, targetId, makerId],
      );

      const requested = await createAdministratorRecoveryRequest({
        targetEmail: `recovery-target-${marker}@example.test`,
        incidentReference: `INC-${marker}`,
        reason: "Restore administrator control after the approved security incident response verified mailbox ownership.",
        requestedBy: "break-glass-request-operator",
        requesterKeyFingerprint: requestFingerprint,
      });
      expect(requested).toMatchObject({ status: "pending", targetIdentityId: targetId });
      expect(Date.parse(requested.expiresAt) - Date.parse(requested.requestedAt)).toBe(30 * 60 * 1_000);

      await expect(approveAdministratorRecoveryRequest({
        requestId: requested.id,
        approvedBy: "break-glass-request-operator",
        approverKeyFingerprint: approvalFingerprint,
      })).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<AdministratorOperationsError>);
      await expect(approveAdministratorRecoveryRequest({
        requestId: requested.id,
        approvedBy: "break-glass-approval-operator",
        approverKeyFingerprint: requestFingerprint,
      })).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<AdministratorOperationsError>);

      const approved = await approveAdministratorRecoveryRequest({
        requestId: requested.id,
        approvedBy: "break-glass-approval-operator",
        approverKeyFingerprint: approvalFingerprint,
      });
      expect(approved).toMatchObject({ request: { status: "applied" }, revokedSessionCount: 2, activationDeliveryId: expect.any(String) });
      const identity = await postgresQuery<{
        status: string; password_hash: string | null; email_verified_at: Date | null; credential_invalidated_at: Date | null;
      }>("SELECT status, password_hash, email_verified_at, credential_invalidated_at FROM fractal.identities WHERE id = $1", [targetId]);
      expect(identity.rows[0]).toMatchObject({
        status: "active",
        password_hash: null,
        email_verified_at: null,
        credential_invalidated_at: expect.any(Date),
      });
      const roles = await postgresQuery<{ role: string }>(
        "SELECT role FROM fractal.identity_role_assignments WHERE identity_id = $1 AND scope_type = 'global' AND revoked_at IS NULL",
        [targetId],
      );
      expect(roles.rows).toEqual([{ role: "admin" }]);
      const sessions = await postgresQuery<{ revoked_reason: string | null }>(
        "SELECT revoked_reason FROM fractal.auth_sessions WHERE identity_id = $1 ORDER BY id",
        [targetId],
      );
      expect(sessions.rows).toHaveLength(2);
      expect(sessions.rows.every((session) => session.revoked_reason === "administrator_break_glass_recovery")).toBe(true);
      const factor = await postgresQuery<{
        secret_ciphertext: string; confirmed_at: Date | null; last_used_counter: string | null; disabled_at: Date | null;
      }>("SELECT secret_ciphertext, confirmed_at, last_used_counter, disabled_at FROM fractal.totp_factors WHERE identity_id = $1", [targetId]);
      expect(factor.rows[0]).toMatchObject({
        secret_ciphertext: expect.stringMatching(/^disabled:administrator-recovery:/),
        confirmed_at: null,
        last_used_counter: null,
        disabled_at: expect.any(Date),
      });
      const activeRecoveryCodes = await postgresQuery<{ count: string }>(
        "SELECT count(*) FROM fractal.totp_recovery_codes WHERE identity_id = $1 AND used_at IS NULL AND replaced_at IS NULL",
        [targetId],
      );
      expect(Number(activeRecoveryCodes.rows[0]?.count)).toBe(0);
      const stepUps = await postgresQuery<{ count: string }>("SELECT count(*) FROM fractal.auth_step_up_grants WHERE identity_id = $1", [targetId]);
      expect(Number(stepUps.rows[0]?.count)).toBe(0);
      const accessRequest = await postgresQuery<{ status: string }>("SELECT status FROM fractal.identity_access_change_requests WHERE id = $1", [accessRequestId]);
      expect(accessRequest.rows[0]?.status).toBe("cancelled");
      const deliveries = await postgresQuery<{ delivery_type: string; status: string }>(
        "SELECT delivery_type, status FROM fractal.auth_email_deliveries WHERE identity_id = $1 ORDER BY requested_at, id",
        [targetId],
      );
      expect(deliveries.rows).toEqual(expect.arrayContaining([
        { delivery_type: "password_reset", status: "terminal" },
        { delivery_type: "administrator_activation", status: "requested" },
      ]));

      const expiredRequestId = randomUUID();
      await postgresQuery(
        `INSERT INTO fractal.administrator_recovery_requests
           (id, target_identity_id, incident_reference, reason, requested_by, requester_key_fingerprint,
            requested_at, expires_at)
         VALUES ($1, $2, $3, $4, 'expired-request-operator', $5,
                 now() - interval '31 minutes', now() - interval '1 minute')`,
        [expiredRequestId, targetId, `INC-EXPIRED-${marker}`, "This intentionally expired recovery request proves that late approval cannot alter credentials.", requestFingerprint],
      );
      await expect(approveAdministratorRecoveryRequest({
        requestId: expiredRequestId,
        approvedBy: "expired-approval-operator",
        approverKeyFingerprint: approvalFingerprint,
      })).rejects.toMatchObject({ code: "expired" } satisfies Partial<AdministratorOperationsError>);
      const expired = await postgresQuery<{ status: string }>("SELECT status FROM fractal.administrator_recovery_requests WHERE id = $1", [expiredRequestId]);
      expect(expired.rows[0]?.status).toBe("expired");
      await expect(postgresQuery(
        "UPDATE fractal.administrator_recovery_requests SET incident_reference = 'tampered' WHERE id = $1",
        [expiredRequestId],
      )).rejects.toThrow("terminal administrator recovery requests are immutable");
    } finally {
      await postgresQuery("TRUNCATE fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests, fractal.administrator_recovery_requests, fractal.administrator_bootstrap_state, fractal.auth_email_deliveries, fractal.identity_access_change_requests, fractal.payment_provider_instructions, fractal.security_notifications, fractal.auth_step_up_grants, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events, fractal.auth_sessions, fractal.idempotency_commands");
      await postgresQuery("DELETE FROM fractal.totp_recovery_codes WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.totp_factors WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [identities]);
    }
  });

  it("governs actor-neutral privacy-rights intake and independently reviewed outcomes without claiming fulfillment", async () => {
    const requesterId = randomUUID();
    const otherRequesterId = randomUUID();
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const identities = [requesterId, otherRequesterId, makerId, checkerId];
    const marker = `privacy-rights-${randomUUID()}`;
    const legalOrganizationId = randomUUID();
    const legalOfferingId = randomUUID();
    const legalOfferingVersionId = randomUUID();
    try {
      await postgresQuery(
        `INSERT INTO fractal.identities (id,email,legal_name,status,email_verified_at)
         VALUES ($1,$2,'Privacy requester','active',now()),($3,$4,'Other privacy requester','active',now()),
                ($5,$6,'Privacy maker','active',now()),($7,$8,'Privacy checker','active',now())`,
        [requesterId, `${marker}-requester@example.test`, otherRequesterId, `${marker}-other@example.test`,
          makerId, `${marker}-maker@example.test`, checkerId, `${marker}-checker@example.test`],
      );
      await postgresQuery(
        `INSERT INTO fractal.identity_role_assignments (id,identity_id,role,scope_type)
         VALUES ($1,$2,'issuer','global'),($3,$4,'professional','global'),($5,$6,'admin','global'),($7,$8,'admin','global')`,
        [randomUUID(), requesterId, randomUUID(), otherRequesterId, randomUUID(), makerId, randomUUID(), checkerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_assignments (id,identity_id,capability_key)
         VALUES ($1,$2,'privacy_request_manage'),($3,$4,'privacy_request_manage'),
                ($5,$2,'data_lifecycle_manage'),($6,$4,'data_lifecycle_manage'),
                ($7,$2,'platform_configuration_manage'),($8,$4,'platform_configuration_manage'),
                ($9,$2,'platform_content_manage'),($10,$4,'platform_content_manage'),
                ($11,$2,'provider_incident_manage'),($12,$4,'provider_incident_manage'),
                ($13,$2,'support_case_manage'),($14,$4,'support_case_manage')`,
        [randomUUID(), makerId, randomUUID(), checkerId, randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
      );

      const commandKey = randomUUID();
      const input = {
        actorIdentityId: requesterId, requestType: "erasure" as const,
        details: "Please assess erasure of the personal information no longer required for my issuer account.", commandKey,
      };
      const opened = await createPrivacyRightsRequest(input);
      expect(opened).toMatchObject({ replayed: false, request: { requester: { id: requesterId, role: "issuer" }, status: "submitted", version: 1, policy: null, reference: expect.stringMatching(/^PRV-/) } });
      await expect(createPrivacyRightsRequest(input)).resolves.toMatchObject({ replayed: true, request: { id: opened.request.id } });
      await expect(createPrivacyRightsRequest({ ...input, commandKey: randomUUID() })).rejects.toMatchObject({ code: "conflict" });
      await expect(getOwnPrivacyRightsRequest({ actorIdentityId: otherRequesterId, requestId: opened.request.id })).rejects.toMatchObject({ code: "not_found" });
      await expect(listOwnPrivacyRightsRequests({ actorIdentityId: requesterId })).resolves.toMatchObject({ requests: [expect.objectContaining({ id: opened.request.id })] });
      await expect(listAdministratorPrivacyRightsRequests({ actorIdentityId: otherRequesterId })).rejects.toMatchObject({ code: "forbidden" });
      await expect(listAdministratorPrivacyRightsRequests({ actorIdentityId: makerId })).resolves.toMatchObject({ requests: [expect.objectContaining({ id: opened.request.id })] });
      await expect(getAdministratorPrivacyDataInventory({ actorIdentityId: otherRequesterId })).rejects.toMatchObject({ code: "forbidden" });
      const inventory = await getAdministratorPrivacyDataInventory({ actorIdentityId: makerId });
      expect(inventory).toMatchObject({
        schemaVersion: "privacy-data-source-inventory-v1",
        summary: { authorityCount: 13, sourceCount: 161, postgresRelationCount: 150, externalSourceCount: 11, unresolvedSourceCount: 10, accessReadySourceCount: 142, portabilityReadySourceCount: 24, executionReadySourceCount: 4 },
        authorities: expect.arrayContaining([expect.objectContaining({ key: "external_objects_backups_logs", sources: expect.any(Array) })]),
      });
      expect(inventory.summary.postgresRelationCount).toBeGreaterThan(100);

      const review = await transitionAdministratorPrivacyRightsRequest({
        actorIdentityId: makerId, requestId: opened.request.id, action: "begin_review",
        message: "Review opened against the authenticated request and the current controlled data inventory.", expectedVersion: 1,
      });
      expect(review.request).toMatchObject({ status: "in_review", version: 2, assignee: { id: makerId } });
      const information = await transitionAdministratorPrivacyRightsRequest({
        actorIdentityId: makerId, requestId: opened.request.id, action: "request_information",
        message: "Please identify the account records you believe are inaccurate or no longer required.", expectedVersion: 2,
      });
      expect(information.request).toMatchObject({ status: "awaiting_requester", version: 3 });
      const replied = await replyToPrivacyRightsRequest({
        actorIdentityId: requesterId, requestId: opened.request.id,
        message: "The request concerns contact details and historical application drafts, not completed financial records.", expectedVersion: 3,
      });
      expect(replied.request).toMatchObject({ status: "in_review", version: 4 });

      const holdProposal = await proposeLegalHoldChange({
        actorIdentityId: makerId, targetType: "identity", targetId: requesterId, changeType: "impose", reasonCategory: "regulatory_request",
        reason: "Preserve identity-linked evidence while the regulator-requested record review remains active.", commandKey: randomUUID(),
      });
      await decideLegalHoldChange({ actorIdentityId: checkerId, requestId: holdProposal.request.id, decision: "approve", decisionReason: "The regulatory request is verified and requires preservation during the privacy review." });

      await expect(proposePrivacyRightsDecision({
        actorIdentityId: makerId, requestId: opened.request.id, outcome: "partially_approve",
        decisionSummary: "Duplicate decision scopes must be rejected before they can become governed evidence.",
        lawfulBasis: "Every data category needs one unambiguous outcome for independent privacy review.",
        scopeOutcomes: [
          { category: "identity_record", action: "correct", explanation: "The governed identity source can receive an independently verified correction." },
          { category: "IDENTITY_RECORD", action: "retain", explanation: "A conflicting duplicate category must never be accepted as a second outcome." },
        ], commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "invalid_input" });
      await expect(proposePrivacyRightsDecision({
        actorIdentityId: makerId, requestId: opened.request.id, outcome: "approve",
        decisionSummary: "An approval cannot conceal a per-scope refusal or retention decision.",
        lawfulBasis: "The overall decision label must agree with every material per-scope action recorded.",
        scopeOutcomes: [{ category: "regulated_evidence", action: "retain", explanation: "This retained scope conflicts with an overall approval and must be rejected." }],
        commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "invalid_input" });

      const proposed = await proposePrivacyRightsDecision({
        actorIdentityId: makerId, requestId: opened.request.id, outcome: "partially_approve",
        decisionSummary: "Contact details may be corrected, while regulated evidence remains preserved pending complete execution coverage.",
        lawfulBasis: "The active regulatory hold and financial-record retention duties require preservation of controlled evidence.",
        scopeOutcomes: [
          { category: "account_contact_details", action: "correct", explanation: "Verified contact details may be corrected through the governed identity authority." },
          { category: "regulated_transaction_evidence", action: "retain", explanation: "Regulated evidence remains preserved under the active identity-level legal hold." },
        ],
        commandKey: randomUUID(),
      });
      expect(proposed.decision).toMatchObject({
        status: "pending", outcome: "partially_approve",
        fulfillmentCoverage: { complete: false, schemaVersion: "privacy-fulfillment-inventory-v2", executionAvailable: false, legalHold: { active: true }, uncoveredAuthorities: expect.arrayContaining(["external_objects_backups_logs"]), authorities: expect.arrayContaining([expect.objectContaining({ key: "external_objects_backups_logs", rightStatus: "unavailable" })]) },
      });
      await expect(decidePrivacyRightsDecision({ actorIdentityId: makerId, decisionRequestId: proposed.decision.id, decision: "approve", reviewReason: "The structured outcome is ready for independent approval after scope review." })).rejects.toMatchObject({ code: "forbidden" });
      const approved = await decidePrivacyRightsDecision({
        actorIdentityId: checkerId, decisionRequestId: proposed.decision.id, decision: "approve",
        reviewReason: "The partial outcome accurately separates correctable data from evidence protected by the active hold.",
      });
      expect(approved.decision).toMatchObject({ status: "applied", reviewedBy: { id: checkerId } });
      await expect(decidePrivacyRightsDecision({
        actorIdentityId: checkerId, decisionRequestId: proposed.decision.id, decision: "approve",
        reviewReason: "The partial outcome accurately separates correctable data from evidence protected by the active hold.",
      })).resolves.toMatchObject({ replayed: true });
      await expect(decidePrivacyRightsDecision({
        actorIdentityId: checkerId, decisionRequestId: proposed.decision.id, decision: "approve",
        reviewReason: "A different review statement cannot be accepted as an idempotent replay of terminal evidence.",
      })).rejects.toMatchObject({ code: "conflict" });
      const ownDetail = await getOwnPrivacyRightsRequest({ actorIdentityId: requesterId, requestId: opened.request.id });
      expect(ownDetail).toMatchObject({
        request: { status: "partially_approved", version: 6 },
        fulfillmentCoverage: { complete: false, executionAvailable: false },
        decisions: [expect.objectContaining({ id: proposed.decision.id, status: "applied" })],
      });
      expect(ownDetail.events.map((event) => event.eventType)).toEqual(["opened", "review_started", "information_requested", "requester_replied", "decision_approved"]);
      const staffDetail = await getAdministratorPrivacyRightsRequest({ actorIdentityId: checkerId, requestId: opened.request.id });
      expect(staffDetail.events.map((event) => event.eventType)).toContain("decision_proposed");

      const access = await createPrivacyRightsRequest({
        actorIdentityId: requesterId, requestType: "access", details: "Please open a subject-access request for the personal information connected to this account.", commandKey: randomUUID(),
      });
      const privacyPolicy = {
        policyReference: "PRIV-NG-001", policyName: "Nigeria authenticated privacy rights response policy",
        jurisdiction: "Nigeria", controllerName: "Fractal governed test controller",
        identityAssurance: "authenticated_verified_email_session", communicationChannel: "authenticated_register",
        deadlineBasis: "calendar_days_from_authenticated_intake",
        responseCalendarDays: { access: 30, portability: 30, correction: 30, erasure: 30, restriction: 21, objection: 21 },
      } as const;
      const policyVersion = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: "privacy.rights.response_policy", proposedValue: privacyPolicy,
        expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000),
        reason: "Bind an independently reviewed response clock to authenticated privacy requests without inventing fulfillment.", commandKey: randomUUID(),
      });
      expect(policyVersion.version).toMatchObject({ status: "pending", validationOutput: { valid: true } });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: policyVersion.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "The jurisdiction, controller, assurance boundary, channel, and per-right calendar clocks were independently reviewed.", commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });
      const boundAccess = await bindPrivacyRightsResponsePolicy({ actorIdentityId: makerId, requestId: access.request.id, expectedVersion: 1 });
      expect(boundAccess).toMatchObject({ replayed: false, request: { policy: { versionId: policyVersion.version.id, reference: "PRIV-NG-001", responseCalendarDays: 30 } } });
      expect(new Date(boundAccess.request.policy!.dueAt).getTime() - new Date(access.request.createdAt).getTime()).toBe(30 * 86_400_000);
      await expect(bindPrivacyRightsResponsePolicy({ actorIdentityId: checkerId, requestId: access.request.id, expectedVersion: 1 })).resolves.toMatchObject({ replayed: true });
      await expect(withdrawPrivacyRightsRequest({
        actorIdentityId: requesterId, requestId: access.request.id, reason: "I opened this request in error and no longer want it processed.", expectedVersion: 1,
      })).resolves.toMatchObject({ request: { status: "withdrawn", version: 2 } });

      const packagePolicy = {
        policyReference: "PRIV-PACK-NG-001", policyName: "Nigeria privacy package preparation policy",
        schemaVersion: "privacy-package-policy-v2",
        canonicalFormat: "application/vnd.fractal.privacy-package+tar;version=2",
        identityAssurance: "authenticated_verified_email_session", deliveryChannel: "authenticated_register",
        allowInternalIncompletePreparation: true, maximumRecords: 10_000, maximumBytes: 5_000_000,
        maximumArtifacts: 100,
        packageRetentionHours: 72, requesterRetrievalHours: 24,
      } as const;
      const packagePolicyVersion = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: "privacy.rights.package_policy", proposedValue: packagePolicy,
        expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000),
        reason: "Govern bounded content-free preparation evidence without releasing an incomplete privacy package.", commandKey: randomUUID(),
      });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: packagePolicyVersion.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: "The canonical format, collection bounds, assurance, protected channel, and retention windows were independently reviewed.", commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });

      const accessExclusions: Partial<Record<typeof privacyContentProfileSourceKeys[number], readonly string[]>> = {
        "postgres.fractal.identities": ["credentialInvalidatedAt"],
      };
      const portabilityExclusions: Partial<Record<typeof privacyContentProfileSourceKeys[number], readonly string[]>> = {
        "postgres.fractal.identities": ["status", "emailVerifiedAt", "credentialInvalidatedAt", "updatedAt"],
        "postgres.fractal.identity_role_assignments": ["scopeId", "revokedAt"],
        "postgres.fractal.auth_sessions": ["businessId", "expiresAt", "revokedAt", "revokedReason"],
        "postgres.fractal.legal_document_acceptances": ["contentSha256"],
        "postgres.fractal.privacy_rights_requests": ["identityAssurance", "emailVerifiedAtSnapshot", "dueAt", "status", "lastActivityAt"],
        "postgres.fractal.privacy_rights_policy_bindings": [
          "policyReference", "policyName", "jurisdiction", "controllerName", "identityAssurance", "communicationChannel",
          "deadlineBasis", "responseCalendarDays", "requestCreatedAt",
        ],
        "postgres.fractal.privacy_rights_request_events": ["sequence", "fromStatus", "toStatus", "visibility"],
        "postgres.fractal.privacy_rights_decision_requests": ["lawfulBasis", "status", "requestedAt", "reviewedAt"],
        "postgres.fractal.agreement_acceptances": [
          "offeringVersion", "agreementDocumentHash", "executionHash", "acceptedAt", "createdAt",
        ],
        "postgres.fractal.support_cases": [
          "reference", "requesterRole", "status", "resolutionSummary", "version", "lastActivityAt",
        ],
        "postgres.fractal.investment_reservations": [
          "offeringVersion", "status", "expiresAt", "updatedAt",
        ],
        "postgres.fractal.organization_verification_requests": [
          "organizationLegalName", "version", "status", "submittedAt", "decidedAt", "verificationExpiresAt", "createdAt",
        ],
        "postgres.fractal.asset_application_requests": [
          "organizationLegalName", "status", "submittedAt", "decidedAt", "createdAt",
        ],
        "postgres.fractal.offering_publication_requests": [
          "organizationLegalName", "status", "submittedAt", "decidedAt", "createdAt",
        ],
        "postgres.fractal.offering_chain_deployment_requests": [
          "organizationLegalName", "status", "submittedAt", "decidedAt",
        ],
        "postgres.fractal.offering_issuance_term_requests": [
          "organizationLegalName", "status", "submittedAt", "decidedAt",
        ],
        "postgres.fractal.professional_invoices": [
          "currency", "grossMinor", "taxMinor", "withholdingTaxMinor", "netPayableMinor", "status", "reviewedAt",
        ],
      };
      const configurationValueSecret = `configuration-value-${randomUUID()}`;
      const configurationReasonSecret = `configuration-reason-${randomUUID()}`;
      const configurationDecisionSecret = `configuration-decision-${randomUUID()}`;
      const profileRules = (
        right: "access" | "portability",
        fieldCatalogVersion: PrivacyContentFieldCatalogVersion = "privacy-safe-fields-v45",
      ) => privacyContentProfileSourceKeysForRight(fieldCatalogVersion, right).map((sourceKey) => {
        const excludedNames = right === "access" ? accessExclusions[sourceKey] ?? [] : portabilityExclusions[sourceKey] ?? [];
        return {
          sourceKey,
          includedFields: privacySafeFieldCatalog[sourceKey].filter((field) => !excludedNames.includes(field)),
          excludedFields: privacySafeFieldCatalog[sourceKey].filter((field) => excludedNames.includes(field)).map((field) => ({
            field,
            reasonCode: right === "access" ? "security_sensitive" as const : "not_applicable_to_portability" as const,
            explanation: right === "access"
              ? "This security-state field is excluded from the approved access projection for the test profile."
              : "This platform-derived field is outside the approved portable-data projection for the test profile.",
          })),
        };
      });
      const accessProfile = { sourceRules: profileRules("access") };
      const portabilityProfile = { sourceRules: profileRules("portability") };
      const contentProfile: PrivacyContentProfile = {
        profileReference: "PRIV-CONTENT-NG-001",
        profileName: "Nigeria authenticated privacy content profile",
        schemaVersion: "privacy-content-profile-v1",
        fieldCatalogVersion: "privacy-safe-fields-v45",
        jurisdictionCode: "NG",
        legalBasisReference: configurationValueSecret,
        effectiveScope: "authenticated_data_subject_access_and_portability",
        access: accessProfile,
        portability: portabilityProfile,
      };
      const legacyContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v1",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v1") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v1") },
      });
      expect(legacyContentProfile.fieldCatalogVersion).toBe("privacy-safe-fields-v1");
      expect(legacyContentProfile.access.sourceRules).toHaveLength(8);
      expect(legacyContentProfile.portability.sourceRules).toHaveLength(8);
      const v2ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v2",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v2") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v2") },
      });
      expect(v2ContentProfile.access.sourceRules).toHaveLength(13);
      expect(v2ContentProfile.portability.sourceRules).toHaveLength(8);
      const v3ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v3",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v3") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v3") },
      });
      expect(v3ContentProfile.access.sourceRules).toHaveLength(18);
      expect(v3ContentProfile.portability.sourceRules).toHaveLength(8);
      const v4ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v4",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v4") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v4") },
      });
      expect(v4ContentProfile.access.sourceRules).toHaveLength(20);
      expect(v4ContentProfile.portability.sourceRules).toHaveLength(8);
      const v5ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v5",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v5") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v5") },
      });
      expect(v5ContentProfile.access.sourceRules).toHaveLength(24);
      expect(v5ContentProfile.portability.sourceRules).toHaveLength(9);
      const v6ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v6",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v6") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v6") },
      });
      expect(v6ContentProfile.access.sourceRules).toHaveLength(25);
      expect(v6ContentProfile.portability.sourceRules).toHaveLength(9);
      const v7ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v7",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v7") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v7") },
      });
      expect(v7ContentProfile.access.sourceRules).toHaveLength(29);
      expect(v7ContentProfile.portability.sourceRules).toHaveLength(9);
      const v8ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v8",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v8") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v8") },
      });
      expect(v8ContentProfile.access.sourceRules).toHaveLength(31);
      expect(v8ContentProfile.portability.sourceRules).toHaveLength(9);
      const v9ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v9",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v9") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v9") },
      });
      expect(v9ContentProfile.access.sourceRules).toHaveLength(33);
      expect(v9ContentProfile.portability.sourceRules).toHaveLength(10);
      const v10ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v10",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v10") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v10") },
      });
      expect(v10ContentProfile.access.sourceRules).toHaveLength(35);
      expect(v10ContentProfile.portability.sourceRules).toHaveLength(10);
      const v11ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v11",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v11") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v11") },
      });
      expect(v11ContentProfile.access.sourceRules).toHaveLength(37);
      expect(v11ContentProfile.portability.sourceRules).toHaveLength(11);
      const v12ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v12",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v12") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v12") },
      });
      expect(v12ContentProfile.access.sourceRules).toHaveLength(40);
      expect(v12ContentProfile.portability.sourceRules).toHaveLength(11);
      const v13ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v13",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v13") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v13") },
      });
      expect(v13ContentProfile.access.sourceRules).toHaveLength(43);
      expect(v13ContentProfile.portability.sourceRules).toHaveLength(12);
      const v14ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v14",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v14") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v14") },
      });
      expect(v14ContentProfile.access.sourceRules).toHaveLength(46);
      expect(v14ContentProfile.portability.sourceRules).toHaveLength(12);
      const v15ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v15",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v15") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v15") },
      });
      expect(v15ContentProfile.access.sourceRules).toHaveLength(50);
      expect(v15ContentProfile.portability.sourceRules).toHaveLength(12);
      const v16ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v16",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v16") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v16") },
      });
      expect(v16ContentProfile.access.sourceRules).toHaveLength(52);
      expect(v16ContentProfile.portability.sourceRules).toHaveLength(12);
      const v17ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v17",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v17") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v17") },
      });
      expect(v17ContentProfile.access.sourceRules).toHaveLength(57);
      expect(v17ContentProfile.portability.sourceRules).toHaveLength(12);
      const v18ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v18",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v18") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v18") },
      });
      expect(v18ContentProfile.access.sourceRules).toHaveLength(61);
      expect(v18ContentProfile.portability.sourceRules).toHaveLength(12);
      const v19ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v19",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v19") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v19") },
      });
      expect(v19ContentProfile.access.sourceRules).toHaveLength(64);
      expect(v19ContentProfile.portability.sourceRules).toHaveLength(13);
      const v20ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v20",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v20") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v20") },
      });
      expect(v20ContentProfile.access.sourceRules).toHaveLength(69);
      expect(v20ContentProfile.portability.sourceRules).toHaveLength(14);
      const v21ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v21",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v21") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v21") },
      });
      expect(v21ContentProfile.access.sourceRules).toHaveLength(73);
      expect(v21ContentProfile.portability.sourceRules).toHaveLength(15);
      const v22ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v22",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v22") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v22") },
      });
      expect(v22ContentProfile.access.sourceRules).toHaveLength(77);
      expect(v22ContentProfile.portability.sourceRules).toHaveLength(17);
      const v23ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v23",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v23") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v23") },
      });
      expect(v23ContentProfile.access.sourceRules).toHaveLength(79);
      expect(v23ContentProfile.portability.sourceRules).toHaveLength(17);
      const v24ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v24",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v24") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v24") },
      });
      expect(v24ContentProfile.access.sourceRules).toHaveLength(83);
      expect(v24ContentProfile.portability.sourceRules).toHaveLength(17);
      const v25ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v25",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v25") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v25") },
      });
      expect(v25ContentProfile.access.sourceRules).toHaveLength(86);
      expect(v25ContentProfile.portability.sourceRules).toHaveLength(19);
      const v26ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v26",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v26") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v26") },
      });
      expect(v26ContentProfile.access.sourceRules).toHaveLength(87);
      expect(v26ContentProfile.portability.sourceRules).toHaveLength(20);
      const v27ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v27",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v27") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v27") },
      });
      expect(v27ContentProfile.access.sourceRules).toHaveLength(88);
      expect(v27ContentProfile.portability.sourceRules).toHaveLength(20);
      const v28ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v28",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v28") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v28") },
      });
      expect(v28ContentProfile.access.sourceRules).toHaveLength(89);
      expect(v28ContentProfile.portability.sourceRules).toHaveLength(20);
      const v29ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v29",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v29") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v29") },
      });
      expect(v29ContentProfile.access.sourceRules).toHaveLength(90);
      expect(v29ContentProfile.portability.sourceRules).toHaveLength(20);
      const v30ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v30",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v30") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v30") },
      });
      expect(v30ContentProfile.access.sourceRules).toHaveLength(93);
      expect(v30ContentProfile.portability.sourceRules).toHaveLength(22);
      const v31ContentProfile = parsePrivacyContentProfile({
        ...contentProfile,
        fieldCatalogVersion: "privacy-safe-fields-v31",
        access: { sourceRules: profileRules("access", "privacy-safe-fields-v31") },
        portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v31") },
      });
      expect(v31ContentProfile.access.sourceRules).toHaveLength(95);
      expect(v31ContentProfile.portability.sourceRules).toHaveLength(23);
      const v32ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v32", access: { sourceRules: profileRules("access", "privacy-safe-fields-v32") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v32") } });
      expect(v32ContentProfile.access.sourceRules).toHaveLength(98);
      expect(v32ContentProfile.portability.sourceRules).toHaveLength(23);
      const v33ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v33", access: { sourceRules: profileRules("access", "privacy-safe-fields-v33") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v33") } });
      expect(v33ContentProfile.access.sourceRules).toHaveLength(100);
      expect(v33ContentProfile.portability.sourceRules).toHaveLength(23);
      const v34ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v34", access: { sourceRules: profileRules("access", "privacy-safe-fields-v34") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v34") } });
      expect(v34ContentProfile.access.sourceRules).toHaveLength(101);
      expect(v34ContentProfile.portability.sourceRules).toHaveLength(23);
      const v35ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v35", access: { sourceRules: profileRules("access", "privacy-safe-fields-v35") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v35") } });
      expect(v35ContentProfile.access.sourceRules).toHaveLength(102);
      expect(v35ContentProfile.portability.sourceRules).toHaveLength(23);
      const v36ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v36", access: { sourceRules: profileRules("access", "privacy-safe-fields-v36") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v36") } });
      expect(v36ContentProfile.access.sourceRules).toHaveLength(103);
      expect(v36ContentProfile.portability.sourceRules).toHaveLength(24);
      const v39ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v39", access: { sourceRules: profileRules("access", "privacy-safe-fields-v39") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v39") } });
      expect(v39ContentProfile.access.sourceRules).toHaveLength(123);
      expect(v39ContentProfile.portability.sourceRules).toHaveLength(24);
      const v40ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v40", access: { sourceRules: profileRules("access", "privacy-safe-fields-v40") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v40") } });
      expect(v40ContentProfile.access.sourceRules).toHaveLength(125);
      expect(v40ContentProfile.portability.sourceRules).toHaveLength(24);
      const v41ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v41", access: { sourceRules: profileRules("access", "privacy-safe-fields-v41") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v41") } });
      expect(v41ContentProfile.access.sourceRules).toHaveLength(127);
      expect(v41ContentProfile.portability.sourceRules).toHaveLength(24);
      const v42ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v42", access: { sourceRules: profileRules("access", "privacy-safe-fields-v42") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v42") } });
      expect(v42ContentProfile.access.sourceRules).toHaveLength(138);
      expect(v42ContentProfile.portability.sourceRules).toHaveLength(24);
      const v44ContentProfile = parsePrivacyContentProfile({ ...contentProfile, fieldCatalogVersion: "privacy-safe-fields-v44", access: { sourceRules: profileRules("access", "privacy-safe-fields-v44") }, portability: { sourceRules: profileRules("portability", "privacy-safe-fields-v44") } });
      expect(v44ContentProfile.access.sourceRules).toHaveLength(141);
      expect(v44ContentProfile.portability.sourceRules).toHaveLength(24);
      expect(contentProfile.access.sourceRules).toHaveLength(142);
      expect(contentProfile.portability.sourceRules).toHaveLength(24);
      const sourceClassifications = await postgresQuery<{
        source_key: string; contains_personal_data: boolean; subject_linkage: string;
        access_status: string; portability_status: string;
      }>(`SELECT source_key,contains_personal_data,subject_linkage,access_status,portability_status
            FROM fractal.privacy_data_sources
           WHERE source_key IN ('postgres.fractal.administrator_bootstrap_state','postgres.fractal.audit_chain_heads','postgres.fractal.inbox_events','postgres.fractal.ledger_accounts','postgres.fractal.organization_beneficial_owner_declarations','postgres.fractal.outbox_events','postgres.fractal.storage_cleanup_tasks','postgres.fractal.support_case_service_sweeps')
           ORDER BY source_key`);
      expect(sourceClassifications.rows).toEqual([
        {
          source_key: "postgres.fractal.administrator_bootstrap_state", contains_personal_data: true,
          subject_linkage: "relational_identity", access_status: "available", portability_status: "unavailable",
        },
        {
          source_key: "postgres.fractal.audit_chain_heads", contains_personal_data: true,
          subject_linkage: "direct_identity", access_status: "available", portability_status: "unavailable",
        },
        {
          source_key: "postgres.fractal.inbox_events", contains_personal_data: true,
          subject_linkage: "provider_correlation", access_status: "available", portability_status: "unavailable",
        },
        {
          source_key: "postgres.fractal.ledger_accounts", contains_personal_data: false,
          subject_linkage: "technical_no_subject", access_status: "not_applicable", portability_status: "not_applicable",
        },
        {
          source_key: "postgres.fractal.organization_beneficial_owner_declarations", contains_personal_data: true,
          subject_linkage: "direct_identity", access_status: "available", portability_status: "available",
        },
        {
          source_key: "postgres.fractal.outbox_events", contains_personal_data: true,
          subject_linkage: "direct_identity", access_status: "available", portability_status: "unavailable",
        },
        {
          source_key: "postgres.fractal.storage_cleanup_tasks", contains_personal_data: true,
          subject_linkage: "relational_identity", access_status: "available", portability_status: "unavailable",
        },
        {
          source_key: "postgres.fractal.support_case_service_sweeps", contains_personal_data: false,
          subject_linkage: "technical_no_subject", access_status: "not_applicable", portability_status: "not_applicable",
        },
      ]);
      const invalidContentProfile = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId,
        configurationKey: "privacy.rights.content_profile",
        proposedValue: { ...contentProfile, portability: { sourceRules: contentProfile.portability.sourceRules.slice(1) } },
        expectedProjectionVersion: null,
        effectiveAt: new Date(Date.now() - 1_000),
        reason: "Prove that a content profile omitting a canonical source cannot enter independent review.",
        commandKey: randomUUID(),
      });
      expect(invalidContentProfile.version).toMatchObject({ status: "validation_failed", validationOutput: { valid: false } });
      const nonCanonicalContentProfile = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId,
        configurationKey: "privacy.rights.content_profile",
        proposedValue: { ...contentProfile, profileName: ` ${contentProfile.profileName}` },
        expectedProjectionVersion: null,
        effectiveAt: new Date(Date.now() - 1_000),
        reason: "Prove approved profile bytes cannot differ from the canonical text consumed by package preparation.",
        commandKey: randomUUID(),
      });
      expect(nonCanonicalContentProfile.version).toMatchObject({ status: "validation_failed", validationOutput: { valid: false } });
      const contentProfileVersion = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId, configurationKey: "privacy.rights.content_profile", proposedValue: contentProfile,
        expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000),
        reason: configurationReasonSecret, commandKey: randomUUID(),
      });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId, versionId: contentProfileVersion.version.id, action: "approve", expectedStateVersion: 1,
        decisionReason: configurationDecisionSecret, commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });

      const bootstrapCohortId = randomUUID();
      const bootstrapFingerprintSecret = createHash("sha256").update(`bootstrap-fingerprint-${randomUUID()}`).digest("hex");
      const bootstrapInitiatorSecret = `bootstrap-operator-${randomUUID()}`;
      await postgresQuery(
        `INSERT INTO fractal.administrator_bootstrap_state
          (singleton,cohort_id,cohort_size,cohort_fingerprint,initiated_by,sealed_at)
         VALUES (TRUE,$1,3,$2,$3,now()-interval '3 hours')`,
        [bootstrapCohortId, bootstrapFingerprintSecret, bootstrapInitiatorSecret],
      );
      await withPostgresTransaction((client) => appendPostgresAuditEvent(client, {
        scopeKey: `identity:${requesterId}`, actorType: "operator",
        action: "identity.administrator_bootstrap.provisioned", entityType: "identity", entityId: requesterId,
        payload: { cohortId: bootstrapCohortId },
      }));
      await withPostgresTransaction((client) => appendPostgresAuditEvent(client, {
        scopeKey: `identity:${otherRequesterId}`, actorType: "operator",
        action: "identity.administrator_bootstrap.provisioned", entityType: "identity", entityId: otherRequesterId,
        payload: { cohortId: randomUUID() },
      }));

      const passwordSecret = `password-secret-${randomUUID()}`;
      const refreshSecret = "c".repeat(64);
      const deliveryWorkerSecret = `delivery-worker-${randomUUID()}`;
      const deliveryErrorSecret = `provider-error-${randomUUID()}`;
      const totpSecret = `totp-secret-${randomUUID()}`;
      const recoveryDigest = "d".repeat(64);
      await postgresQuery("UPDATE fractal.identities SET password_hash=$2 WHERE id=$1", [requesterId, passwordSecret]);
      const collectorSessionId = randomUUID();
      await postgresQuery(
        `INSERT INTO fractal.auth_sessions
          (id,token_family_id,subject_id,identity_id,role,refresh_token_hash,expires_at)
         VALUES ($1,$2,$3::text,$3::uuid,'issuer',$4,now()+interval '1 day')`,
        [collectorSessionId, randomUUID(), requesterId, refreshSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.auth_email_deliveries
          (id,identity_id,delivery_type,status,claimed_at,claimed_by,attempts,next_attempt_at,last_error)
         VALUES ($1,$2,'password_reset','failed',now(),$3,2,now()+interval '1 minute',$4)`,
        [randomUUID(), requesterId, deliveryWorkerSecret, deliveryErrorSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.auth_step_up_grants (session_id,identity_id,method,expires_at)
         VALUES ($1,$2,'totp',now()+interval '5 minutes')`,
        [collectorSessionId, requesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.totp_factors (id,identity_id,secret_ciphertext,confirmed_at,last_used_counter)
         VALUES ($1,$2,$3,now(),42)`,
        [randomUUID(), requesterId, totpSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.totp_recovery_codes (id,identity_id,code_digest)
         VALUES ($1,$2,$3)`,
        [randomUUID(), requesterId, recoveryDigest],
      );
      const requesterAuditReasonSecret = `requester-audit-reason-${randomUUID()}`;
      const requesterAuditPayloadSecret = `requester-audit-payload-${randomUUID()}`;
      const otherAuditActionSecret = `other-actor-audit-${randomUUID()}`;
      const notificationEvidence = await withPostgresTransaction(async (client) => {
        const audit = await appendPostgresAuditEvent(client, {
          scopeKey: `identity:${requesterId}`, actorId: requesterId, actorType: "user",
          action: "auth.session.security_test_notification", entityType: "auth_session", entityId: collectorSessionId,
          reason: requesterAuditReasonSecret, payload: { secret: requesterAuditPayloadSecret },
        });
        const outbox = await appendOutboxEvent(client, {
          aggregateType: "auth_session", aggregateId: collectorSessionId,
          eventType: "auth.session.security_test_notification", payload: { requesterId, auditEventId: audit.id },
        });
        return { auditId: audit.id, outboxId: outbox };
      });
      await withPostgresTransaction((client) => appendPostgresAuditEvent(client, {
        scopeKey: `identity:${makerId}`, actorId: makerId, actorType: "user",
        action: otherAuditActionSecret, entityType: "private_other_actor_event", entityId: randomUUID(),
        reason: "Other actor private audit reason", payload: { secret: "other-actor-private-audit-payload" },
      }));
      await postgresQuery(
        `INSERT INTO fractal.security_notifications
          (id,outbox_event_id,audit_event_id,subject_id,session_id,event_type)
         VALUES ($1,$2,$3,$4,$5,'auth.session.security_test_notification')`,
        [randomUUID(), notificationEvidence.outboxId, notificationEvidence.auditId, requesterId, collectorSessionId],
      );
      const accessChangeReason = `internal-access-reason-${randomUUID()}`;
      const capabilityChangeReason = `internal-capability-reason-${randomUUID()}`;
      const recoveryReason = `internal-recovery-reason-${randomUUID()}`;
      const recoveryOperator = `recovery-operator-${randomUUID()}`;
      const recoveryFingerprint = "a".repeat(64);
      const auditFilterSecret = `audit-filter-${randomUUID()}`;
      const auditContentSecret = `audit-content-${randomUUID()}`;
      const verificationWorkerSecret = `verification-worker-${randomUUID()}`;
      const verificationErrorSecret = `verification-error-${randomUUID()}`;
      const verificationApplicantSecret = `verification-applicant-${randomUUID()}`;
      const verificationEventSecret = `verification-event-${randomUUID()}`;
      const verificationRejectSecret = `verification-reject-${randomUUID()}`;
      const verificationPayloadHash = "b".repeat(64);
      const legalContentSecret = `legal-draft-content-${randomUUID()}`;
      const legalChangeSummarySecret = `legal-change-summary-${randomUUID()}`;
      const legalDecisionReasonSecret = `legal-decision-reason-${randomUUID()}`;
      const providerIncidentKey = `privacy_${randomUUID().replaceAll("-", "")}`;
      const providerIncidentSummarySecret = `Private provider incident summary ${randomUUID()}`;
      const providerIncidentImpactSecret = `Private provider incident impact ${randomUUID()}`;
      const providerIncidentDetectionSecret = `private-provider-detection-${randomUUID()}`;
      const providerIncidentReasonSecret = `Private provider incident reason ${randomUUID()}`;
      const supportSubject = `Privacy-safe support subject ${randomUUID()}`;
      const supportDescription = `Requester-provided support description ${randomUUID()}`;
      const supportRelatedReference = `REQUESTER-REFERENCE-${randomUUID()}`;
      const supportRequesterMessage = `Requester follow-up message ${randomUUID()}`;
      const supportVisibleReply = `Requester-visible service response ${randomUUID()}`;
      const supportInternalNoteSecret = `Internal support investigation ${randomUUID()}`;
      const requesterAttachmentFilename = `requester-evidence-${randomUUID()}.pdf`;
      const serviceAttachmentFilename = `service-evidence-${randomUUID()}.pdf`;
      const internalAttachmentFilename = `internal-investigation-${randomUUID()}.png`;
      const requesterAttachmentStorageSecret = `support/private/${randomUUID()}/requester.pdf`;
      const serviceAttachmentStorageSecret = `support/private/${randomUUID()}/service.pdf`;
      const internalAttachmentStorageSecret = `support/private/${randomUUID()}/internal.png`;
      const requesterAttachmentCommandSecret = `attachment-command-${randomUUID()}`;
      const serviceAttachmentCommandSecret = `attachment-command-${randomUUID()}`;
      const internalAttachmentCommandSecret = `attachment-command-${randomUUID()}`;
      const requesterWalletAddress = `0x${"1".repeat(40)}`;
      const otherRequesterWalletAddress = `0x${"2".repeat(40)}`;
      const requesterWalletChallengeId = randomUUID();
      const requesterWalletId = randomUUID();
      const otherRequesterWalletChallengeId = randomUUID();
      const otherRequesterWalletId = randomUUID();
      const requesterWalletMessageHashSecret = createHash("sha256").update(`wallet-message-${randomUUID()}`).digest("hex");
      const requesterWalletSignatureHashSecret = createHash("sha256").update(`wallet-signature-${randomUUID()}`).digest("hex");
      const otherRequesterWalletMessageHashSecret = createHash("sha256").update(`wallet-message-${randomUUID()}`).digest("hex");
      const otherRequesterWalletSignatureHashSecret = createHash("sha256").update(`wallet-signature-${randomUUID()}`).digest("hex");
      const requesterComplianceRequestId = randomUUID();
      const requesterComplianceReviewId = randomUUID();
      const otherRequesterComplianceRequestId = randomUUID();
      const otherRequesterComplianceReviewId = randomUUID();
      const requesterComplianceEvidenceSecret = `compliance-provider-evidence-${randomUUID()}`;
      const requesterComplianceDecisionSecret = `compliance-decision-reason-${randomUUID()}`;
      const requesterComplianceSnapshotSecret = `compliance-snapshot-${randomUUID()}`;
      const otherRequesterComplianceEvidenceSecret = `other-compliance-provider-evidence-${randomUUID()}`;
      const otherRequesterComplianceDecisionSecret = `other-compliance-decision-reason-${randomUUID()}`;
      const otherRequesterComplianceSnapshotSecret = `other-compliance-snapshot-${randomUUID()}`;
      const requesterEligibilitySnapshotId = randomUUID();
      const otherRequesterEligibilitySnapshotId = randomUUID();
      const requesterCommitmentId = randomUUID();
      const otherRequesterCommitmentId = randomUUID();
      const requesterReservationId = randomUUID();
      const otherRequesterReservationId = randomUUID();
      const requesterEligibilityPolicySecret = `eligibility-policy-${randomUUID()}`;
      const requesterEligibilityEvidenceSecret = `eligibility-evidence-${randomUUID()}`;
      const otherRequesterEligibilityPolicySecret = `other-eligibility-policy-${randomUUID()}`;
      const otherRequesterEligibilityEvidenceSecret = `other-eligibility-evidence-${randomUUID()}`;
      const requesterReservationCommandSecret = `reservation-command-${randomUUID()}`;
      const otherRequesterReservationCommandSecret = `other-reservation-command-${randomUUID()}`;
      const otherRequesterCommitmentReferenceSecret = `OTHER-PRIVATE-OFFERING-${randomUUID()}`;
      const requesterPaymentIntentId = randomUUID();
      const otherRequesterPaymentIntentId = randomUUID();
      const requesterPaymentReceiptId = randomUUID();
      const otherRequesterPaymentReceiptId = randomUUID();
      const requesterReconciliationId = randomUUID();
      const otherRequesterReconciliationId = randomUUID();
      const requesterProviderReferenceSecret = `provider-reference-${randomUUID()}`;
      const otherRequesterProviderReferenceSecret = `other-provider-reference-${randomUUID()}`;
      const requesterCheckoutSecret = `https://checkout.example.test/${randomUUID()}`;
      const requesterAccessCodeSecret = `access-${randomUUID()}`;
      const requesterPaymentMetadataSecret = `payment-metadata-${randomUUID()}`;
      const requesterReceiptMetadataSecret = `receipt-metadata-${randomUUID()}`;
      const requesterReconciliationDetailSecret = `reconciliation-detail-${randomUUID()}`;
      const requesterAccountingIntentId = randomUUID();
      const otherRequesterAccountingIntentId = randomUUID();
      const requesterJournalId = randomUUID();
      const otherRequesterJournalId = randomUUID();
      const requesterAccountingReceiptId = randomUUID();
      const otherRequesterAccountingReceiptId = randomUUID();
      const clearingAccountId = randomUUID();
      const escrowAccountId = randomUUID();
      const accountCodeSecret = `ASSET.PRIVACY_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      const escrowAccountCodeSecret = `LIABILITY.PRIVACY_${randomUUID().replaceAll("-", "").slice(0, 12).toUpperCase()}`;
      const accountNameSecret = `Internal clearing ${randomUUID()}`;
      const journalNarrativeSecret = `journal-narrative-${randomUUID()}`;
      const journalExternalReferenceSecret = `journal-external-${randomUUID()}`;
      const journalMetadataSecret = `journal-metadata-${randomUUID()}`;
      const issuanceTermsRequestId = randomUUID();
      const allocationPolicyEvidenceId = randomUUID();
      const requesterAllocationId = randomUUID();
      const otherRequesterAllocationId = randomUUID();
      const requesterAllocationOperationId = randomUUID();
      const otherRequesterAllocationOperationId = randomUUID();
      const requesterAllocationClaimId = randomUUID();
      const otherRequesterAllocationClaimId = randomUUID();
      const allocationPolicyHashSecret = createHash("sha256").update(`allocation-policy-${randomUUID()}`).digest("hex");
      const allocationPolicyStorageSecret = `governance/private/${randomUUID()}/allocation-policy.pdf`;
      const requesterAllocationComplianceSecret = `allocation-compliance-${randomUUID()}`;
      const otherRequesterAllocationComplianceSecret = `other-allocation-compliance-${randomUUID()}`;
      const requesterAllocationDecisionSecret = `allocation-decision-${randomUUID()}`;
      const requesterAllocationWorkerSecret = `allocation-worker-${randomUUID()}`;
      const otherRequesterAllocationWorkerSecret = `other-allocation-worker-${randomUUID()}`;
      const requesterAllocationTransactionHash = `0x${"6".repeat(64)}`;
      const otherRequesterAllocationTransactionHash = `0x${"7".repeat(64)}`;
      const agreementSignature = "Privacy Requester Contract Signature";
      const agreementDocumentHash = createHash("sha256").update(`agreement-document-${randomUUID()}`).digest("hex");
      const agreementExecutionHash = createHash("sha256").update(`agreement-execution-${randomUUID()}`).digest("hex");
      const agreementIpHash = createHash("sha256").update(`agreement-ip-${randomUUID()}`).digest("hex");
      const agreementUserAgentHash = createHash("sha256").update(`agreement-agent-${randomUUID()}`).digest("hex");
      await postgresQuery(
        `INSERT INTO fractal.identity_access_change_requests
          (id,target_identity_id,change_type,prior_role,proposed_role,prior_status,reason,requested_by_identity_id)
         VALUES ($1,$2,'change_role','admin','operator','active',$3,$4)`,
        [randomUUID(), makerId, accessChangeReason, checkerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_capability_change_requests
          (id,target_identity_id,capability_key,change_type,prior_enabled,reason,requested_by_identity_id)
         VALUES ($1,$2,'audit_export','revoke',true,$3,$4)`,
        [randomUUID(), makerId, capabilityChangeReason, checkerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.administrator_recovery_requests
          (id,target_identity_id,incident_reference,reason,requested_by,requester_key_fingerprint,expires_at)
         VALUES ($1,$2,'INC-PRIVACY-COLLECTOR',$3,$4,$5,now()+interval '20 minutes')`,
        [randomUUID(), makerId, recoveryReason, recoveryOperator, recoveryFingerprint],
      );
      const auditExportContent = JSON.stringify({ records: [{ confidential: auditContentSecret }] });
      await postgresQuery(
        `INSERT INTO fractal.administrator_audit_exports
          (id,requested_by_identity_id,filters,sequence_high_watermark,record_count,content_sha256,content)
         VALUES ($1,$2,$3,0,0,$4,$5)`,
        [randomUUID(), makerId, JSON.stringify({ targetIdentityId: checkerId, confidential: auditFilterSecret }),
          createHash("sha256").update(auditExportContent).digest("hex"), auditExportContent],
      );
      await postgresQuery(
        `INSERT INTO fractal.provider_identity_verification_applications
          (id,identity_id,provider,external_user_id,status,claimed_at,claimed_by,attempts,next_attempt_at,last_error)
         VALUES ($1,$2,'sumsub',$3,'failed',now(),$4,4,now()+interval '10 minutes',$5)`,
        [randomUUID(), makerId, makerId, verificationWorkerSecret, verificationErrorSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.provider_identity_verification_events
          (id,provider,external_event_id,identity_id,external_user_id,applicant_id,event_type,review_status,
           review_answer,reject_labels,provider_created_at,payload_hash,received_at)
         VALUES ($1,'sumsub',$2,$3,$4,$5,'applicantReviewed','completed','GREEN',$6,now()-interval '1 minute',$7,now())`,
        [randomUUID(), verificationEventSecret, makerId, makerId, verificationApplicantSecret,
          JSON.stringify([verificationRejectSecret]), verificationPayloadHash],
      );
      await createAdministratorProviderIncident({
        actorIdentityId: makerId,
        ownerIdentityId: checkerId,
        providerKey: providerIncidentKey,
        source: "manual",
        severity: "sev2",
        summary: providerIncidentSummarySecret,
        userImpact: providerIncidentImpactSecret,
        detectionEvidence: { privateSignal: providerIncidentDetectionSecret },
        detectedAt: new Date(Date.now() - 60_000),
        reason: providerIncidentReasonSecret,
        commandKey: randomUUID(),
      });
      const supportServicePolicy = {
        policyReference: "SUPPORT-OPS-PRIVACY-1",
        policyName: "Approved privacy collector support operations policy",
        impactTargets: {
          question: { priority: "p4", acknowledgementMinutes: 120, resolutionMinutes: 1_440, escalationMinutesBeforeResolution: 120 },
          blocked: { priority: "p2", acknowledgementMinutes: 30, resolutionMinutes: 240, escalationMinutesBeforeResolution: 30 },
          financial_or_legal_risk: { priority: "p1", acknowledgementMinutes: 15, resolutionMinutes: 120, escalationMinutesBeforeResolution: 20 },
          security_or_privacy_concern: { priority: "p1", acknowledgementMinutes: 10, resolutionMinutes: 60, escalationMinutesBeforeResolution: 15 },
        },
        categoryOverrides: [],
      };
      const supportServicePolicyVersion = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId,
        configurationKey: "support.case.service_policy",
        proposedValue: supportServicePolicy,
        expectedProjectionVersion: null,
        effectiveAt: new Date(Date.now() - 1_000),
        reason: "Bind privacy collector support lifecycle fixtures to independently reviewed service controls.",
        commandKey: randomUUID(),
      });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId,
        versionId: supportServicePolicyVersion.version.id,
        action: "approve",
        expectedStateVersion: 1,
        decisionReason: "Independently approve the support priorities and service deadlines used by privacy collector evidence.",
        commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });
      const supportCase = await createSupportCase({
        actorIdentityId: requesterId,
        actorRole: "issuer",
        category: "privacy_request",
        reportedImpact: "question",
        subject: supportSubject,
        description: supportDescription,
        relatedReference: supportRelatedReference,
        occurredAt: new Date(Date.now() - 60_000),
        commandKey: randomUUID(),
      });
      await addRequesterSupportMessage({
        actorIdentityId: requesterId,
        caseId: supportCase.case.id,
        expectedVersion: 1,
        message: supportRequesterMessage,
        commandKey: randomUUID(),
      });
      await transitionAdministratorSupportCase({
        actorIdentityId: makerId,
        caseId: supportCase.case.id,
        action: "triage",
        expectedVersion: 2,
        message: "Triage confirms the privacy request requires controlled evidence review.",
        commandKey: randomUUID(),
      });
      await transitionAdministratorSupportCase({
        actorIdentityId: makerId,
        caseId: supportCase.case.id,
        action: "reply",
        expectedVersion: 3,
        message: supportVisibleReply,
        commandKey: randomUUID(),
      });
      await transitionAdministratorSupportCase({
        actorIdentityId: makerId,
        caseId: supportCase.case.id,
        action: "note",
        expectedVersion: 4,
        message: supportInternalNoteSecret,
        commandKey: randomUUID(),
      });
      const supportDataPolicy = {
        policyReference: "SUPPORT-DATA-PRIVACY-1",
        policyName: "Approved privacy collector support data policy",
        maximumBytes: 1_048_576,
        allowedMimeTypes: ["application/pdf", "image/png"],
        classifications: {
          general: { retentionDays: 30 },
          personal_data: { retentionDays: 60 },
          financial_record: { retentionDays: 365 },
          identity_document: { retentionDays: 90 },
          security_sensitive: { retentionDays: 120 },
        },
      };
      const supportDataPolicyVersion = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId,
        configurationKey: "support.case.data_policy",
        proposedValue: supportDataPolicy,
        expectedProjectionVersion: null,
        effectiveAt: new Date(Date.now() - 1_000),
        reason: "Bind privacy collector attachment fixtures to independently reviewed evidence controls.",
        commandKey: randomUUID(),
      });
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId,
        versionId: supportDataPolicyVersion.version.id,
        action: "approve",
        expectedStateVersion: 1,
        decisionReason: "Independently approve the attachment types, limits, classifications, and retention periods.",
        commandKey: randomUUID(),
      });
      expect(await activateDuePlatformConfigurationVersions(new Date())).toMatchObject({ activated: 1, failed: 0 });
      const requesterAttachmentDigest = createHash("sha256").update(requesterAttachmentFilename).digest("hex");
      const serviceAttachmentDigest = createHash("sha256").update(serviceAttachmentFilename).digest("hex");
      const internalAttachmentDigest = createHash("sha256").update(internalAttachmentFilename).digest("hex");
      const scannedAt = new Date(Date.now() - 1_000);
      const requesterAttachment = await recordSupportCaseAttachment({
        caseId: supportCase.case.id,
        actorIdentityId: requesterId,
        staff: false,
        visibility: "requester",
        commandKey: requesterAttachmentCommandSecret,
        classification: "personal_data",
        filename: requesterAttachmentFilename,
        mimeType: "application/pdf",
        bytes: 128,
        contentSha256: requesterAttachmentDigest,
        storageKey: requesterAttachmentStorageSecret,
        scanner: "clamav_instream",
        scannedAt,
      });
      const serviceAttachment = await recordSupportCaseAttachment({
        caseId: supportCase.case.id,
        actorIdentityId: makerId,
        staff: true,
        visibility: "requester",
        commandKey: serviceAttachmentCommandSecret,
        classification: "general",
        filename: serviceAttachmentFilename,
        mimeType: "application/pdf",
        bytes: 256,
        contentSha256: serviceAttachmentDigest,
        storageKey: serviceAttachmentStorageSecret,
        scanner: "clamav_instream",
        scannedAt,
      });
      const internalAttachment = await recordSupportCaseAttachment({
        caseId: supportCase.case.id,
        actorIdentityId: makerId,
        staff: true,
        visibility: "internal",
        commandKey: internalAttachmentCommandSecret,
        classification: "security_sensitive",
        filename: internalAttachmentFilename,
        mimeType: "image/png",
        bytes: 512,
        contentSha256: internalAttachmentDigest,
        storageKey: internalAttachmentStorageSecret,
        scanner: "clamav_instream",
        scannedAt,
      });
      const expiredRequesterAttachmentId = randomUUID();
      const expiredInternalAttachmentId = randomUUID();
      const expiredRequesterFilename = `expired-requester-${randomUUID()}.pdf`;
      const expiredInternalFilenameSecret = `expired-internal-${randomUUID()}.png`;
      const expiredRequesterDigest = createHash("sha256").update(expiredRequesterFilename).digest("hex");
      const expiredInternalDigestSecret = createHash("sha256").update(expiredInternalFilenameSecret).digest("hex");
      const expiredRequesterStorageSecret = `support/private/${randomUUID()}/expired-requester.pdf`;
      const expiredInternalStorageSecret = `support/private/${randomUUID()}/expired-internal.png`;
      const orphanCleanupStorageSecret = `orphan/private/${randomUUID()}/unlinked-object.bin`;
      const orphanCleanupErrorSecret = `Private orphan cleanup error ${randomUUID()} that has no canonical data subject.`;
      const dispositionReasonSecret = `Private disposition rationale ${randomUUID()} that must remain internal.`;
      const dispositionDecisionSecret = `Private disposition approval ${randomUUID()} that must remain internal.`;
      const internalDispositionDecisionSecret = `Private internal rejection ${randomUUID()} that must remain internal.`;
      const cloneExpiredAttachment = async (input: {
        sourceId: string; id: string; filename: string; digest: string; storageKey: string; commandKey: string;
      }) => postgresQuery(
        `INSERT INTO fractal.support_case_attachments
           (id,case_id,uploaded_by_identity_id,command_key,visibility,classification,filename,mime_type,bytes,
            content_sha256,storage_key,scan_status,scanner,scanned_at,configuration_key,policy_version_id,
            policy_version_number,policy_projection_version,policy_value_sha256,policy_reference,policy_name,
            retention_days,uploaded_at,retention_due_at)
         SELECT $2,case_id,uploaded_by_identity_id,$6,visibility,classification,$3,mime_type,bytes,$4,$5,
                scan_status,scanner,date_trunc('milliseconds',now())-make_interval(days=>retention_days+1)-interval '1 minute',configuration_key,
                policy_version_id,policy_version_number,policy_projection_version,policy_value_sha256,policy_reference,
                policy_name,retention_days,date_trunc('milliseconds',now())-make_interval(days=>retention_days+1),
                date_trunc('milliseconds',now())-interval '1 day'
           FROM fractal.support_case_attachments WHERE id=$1`,
        [input.sourceId, input.id, input.filename, input.digest, input.storageKey, input.commandKey],
      );
      await cloneExpiredAttachment({
        sourceId: requesterAttachment.attachment.id, id: expiredRequesterAttachmentId, filename: expiredRequesterFilename,
        digest: expiredRequesterDigest, storageKey: expiredRequesterStorageSecret, commandKey: randomUUID(),
      });
      await cloneExpiredAttachment({
        sourceId: internalAttachment.attachment.id, id: expiredInternalAttachmentId, filename: expiredInternalFilenameSecret,
        digest: expiredInternalDigestSecret, storageKey: expiredInternalStorageSecret, commandKey: randomUUID(),
      });
      const holdReleaseReasonSecret = `Private legal-hold release rationale ${randomUUID()} that must remain internal.`;
      const holdReleaseDecisionSecret = `Private legal-hold release approval ${randomUUID()} that must remain internal.`;
      const holdRelease = await proposeLegalHoldChange({
        actorIdentityId: makerId, targetType: "identity", targetId: requesterId, changeType: "release",
        reasonCategory: "regulatory_request", reason: holdReleaseReasonSecret, commandKey: randomUUID(),
      });
      await decideLegalHoldChange({
        actorIdentityId: checkerId, requestId: holdRelease.request.id, decision: "approve",
        decisionReason: holdReleaseDecisionSecret,
      });
      const requesterDisposition = await proposeSupportAttachmentDisposition({
        actorIdentityId: makerId, attachmentId: expiredRequesterAttachmentId,
        reason: dispositionReasonSecret, commandKey: randomUUID(),
      });
      await decideSupportAttachmentDisposition({
        actorIdentityId: checkerId, requestId: requesterDisposition.request.id,
        decision: "approve", decisionReason: dispositionDecisionSecret,
      });
      const requesterCleanupTask = await postgresQuery<{ id: string }>(
        `SELECT task.id FROM fractal.storage_cleanup_tasks task
         JOIN fractal.support_attachment_dispositions disposition ON disposition.id=task.governed_disposition_id
         WHERE disposition.disposition_request_id=$1`,
        [requesterDisposition.request.id],
      );
      await expect(postgresQuery(
        "UPDATE fractal.storage_cleanup_tasks SET storage_key=$2 WHERE id=$1",
        [requesterCleanupTask.rows[0]!.id, `forged/private/${randomUUID()}`],
      )).rejects.toThrow(/origin and subject linkage are immutable/);
      const internalDisposition = await proposeSupportAttachmentDisposition({
        actorIdentityId: makerId, attachmentId: expiredInternalAttachmentId,
        reason: `Internal-only disposition rationale ${randomUUID()} that must never enter requester evidence.`, commandKey: randomUUID(),
      });
      await decideSupportAttachmentDisposition({
        actorIdentityId: checkerId, requestId: internalDisposition.request.id,
        decision: "reject", decisionReason: internalDispositionDecisionSecret,
      });
      await postgresQuery(
        `INSERT INTO fractal.storage_cleanup_tasks (id,storage_key,source,metadata_error,purpose)
         VALUES ($1,$2,'privacy-regression-orphan',$3,'orphan_cleanup')`,
        [randomUUID(), orphanCleanupStorageSecret, orphanCleanupErrorSecret],
      );
      await recordSupportCaseAttachmentDownload({
        attachmentId: requesterAttachment.attachment.id,
        actorIdentityId: requesterId,
        staff: false,
        verifiedSha256: requesterAttachmentDigest,
      });
      await recordSupportCaseAttachmentDownload({
        attachmentId: serviceAttachment.attachment.id,
        actorIdentityId: makerId,
        staff: true,
        verifiedSha256: serviceAttachmentDigest,
      });
      await recordSupportCaseAttachmentDownload({
        attachmentId: internalAttachment.attachment.id,
        actorIdentityId: makerId,
        staff: true,
        verifiedSha256: internalAttachmentDigest,
      });
      await postgresQuery(
        `INSERT INTO fractal.investor_wallet_link_challenges
           (id,investor_identity_id,chain_id,wallet_address,message_hash,expires_at,status,consumed_at,created_at)
         VALUES
           ($1,$2,11155111,$3,$4,now()+interval '10 minutes','consumed',now(),now()-interval '2 minutes'),
           ($5,$6,80002,$7,$8,now()+interval '10 minutes','consumed',now(),now()-interval '1 minute')`,
        [requesterWalletChallengeId, requesterId, requesterWalletAddress, requesterWalletMessageHashSecret,
          otherRequesterWalletChallengeId, otherRequesterId, otherRequesterWalletAddress, otherRequesterWalletMessageHashSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investor_wallets
           (id,investor_identity_id,chain_id,wallet_address,link_challenge_id,signature_hash,status,verified_at,created_at)
         VALUES
           ($1,$2,11155111,$3,$4,$5,'active',now(),now()),
           ($6,$7,80002,$8,$9,$10,'active',now(),now())`,
        [requesterWalletId, requesterId, requesterWalletAddress, requesterWalletChallengeId, requesterWalletSignatureHashSecret,
          otherRequesterWalletId, otherRequesterId, otherRequesterWalletAddress, otherRequesterWalletChallengeId, otherRequesterWalletSignatureHashSecret],
      );
      const legalVersion = await proposePlatformContentVersion({
        actorIdentityId: makerId,
        documentKey: "risk_global_public",
        semanticVersion: "1.0.0",
        content: {
          title: "Risk disclosure",
          eyebrow: "Governed legal evidence",
          lead: "This test-only legal publication establishes exact privacy-safe actor lifecycle collection.",
          keyPoints: ["Only actor-linked lifecycle metadata belongs in the privacy access projection."],
          sections: [{
            id: "privacy-boundary",
            title: "Privacy boundary",
            paragraphs: [`The legal body contains ${legalContentSecret} and must never enter a subject package merely because its lifecycle is actor-linked.`],
          }],
        },
        reacceptanceRequired: false,
        expectedProjectionVersion: null,
        effectiveAt: new Date(Date.now() - 1_000),
        changeSummary: legalChangeSummarySecret,
        commandKey: randomUUID(),
      });
      await decidePlatformContentVersion({
        actorIdentityId: checkerId,
        versionId: legalVersion.version.id,
        action: "approve",
        expectedStateVersion: 1,
        decisionReason: legalDecisionReasonSecret,
        commandKey: randomUUID(),
      });
      expect(await publishDuePlatformContent()).toMatchObject({ published: 1, failed: 0 });
      const requesterOrganizationMembershipId = randomUUID();
      const otherOrganizationMembershipId = randomUUID();
      const organizationRegistrationSecret = `privacy-registration-${randomUUID()}`;
      const organizationAddressSecret = `privacy-address-${randomUUID()}`;
      const invitationWorkerSecret = `privacy-invitation-worker-${randomUUID()}`;
      const invitationErrorSecret = `privacy-invitation-error-${randomUUID()}`;
      const ownershipTransferReasonSecret = `privacy-transfer-reason-${randomUUID()}`;
      const verificationRequestId = randomUUID();
      const verificationRegistrationNumber = `PRIV-KYB-${randomUUID().slice(0, 8).toUpperCase()}`;
      const verificationAddressLine = `Verification address ${randomUUID()}`;
      const representativeAuthorityBasis = `The requester is authorized to submit the governed verification record ${randomUUID()}.`;
      const verificationStorageSecret = `organization-verification/${randomUUID()}`;
      const otherVerificationFilename = `other-verification-${randomUUID()}.pdf`;
      const requesterBeneficialOwnerName = `Requester beneficial owner ${randomUUID()}`;
      const unlinkedBeneficialOwnerSecret = `Unlinked third-party owner ${randomUUID()}`;
      await postgresQuery(
        `INSERT INTO fractal.organizations
           (id,legal_name,registration_number,status,created_by_identity_id,jurisdiction_code,entity_type,
            primary_activity,registered_address)
         VALUES ($1,'Privacy agreement issuer',$2,'active',$3,'NG','private_company',
                 'Governed privacy collector test activity',jsonb_build_object('line1',$4::text))`,
        [legalOrganizationId, organizationRegistrationSecret, makerId, organizationAddressSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.organization_memberships
           (id,organization_id,identity_id,role,status,invited_by_identity_id,granted_at)
         VALUES ($1,$2,$3,'owner','active',$5,now()-interval '2 days'),
                ($4,$2,$5,'administrator','active',$5,now()-interval '1 day')`,
        [requesterOrganizationMembershipId, legalOrganizationId, requesterId, otherOrganizationMembershipId, otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.organization_invitations
           (id,organization_id,email,role,invited_by_identity_id,expires_at,delivery_status,delivery_attempts,
            delivery_claimed_at,delivery_claimed_by,delivery_next_attempt_at,delivery_last_error)
         VALUES ($1,$2,$3,'viewer',$4,now()+interval '7 days','failed',3,now()-interval '1 minute',$5,now()+interval '5 minutes',$6)`,
        [randomUUID(), legalOrganizationId, `${marker}-requester@example.test`, makerId, invitationWorkerSecret, invitationErrorSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.organization_ownership_transfer_requests
           (id,organization_id,source_membership_id,target_membership_id,requested_by_identity_id,reason,status,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',now()+interval '7 days')`,
        [randomUUID(), legalOrganizationId, requesterOrganizationMembershipId, otherOrganizationMembershipId,
          requesterId, ownershipTransferReasonSecret],
      );
      const requesterVerificationDocuments = [
        { id: randomUUID(), type: "registration_evidence", filename: "requester-registration.pdf", digest: createHash("sha256").update(`${marker}-registration`).digest("hex") },
        { id: randomUUID(), type: "ownership_structure", filename: "requester-ownership.pdf", digest: createHash("sha256").update(`${marker}-ownership`).digest("hex") },
        { id: randomUUID(), type: "representative_authority", filename: "requester-authority.pdf", digest: createHash("sha256").update(`${marker}-authority`).digest("hex") },
      ] as const;
      const otherVerificationDocumentId = randomUUID();
      await postgresQuery(
        `INSERT INTO fractal.organization_verification_evidence_documents
           (id,organization_id,evidence_type,filename,mime_type,storage_key,content_sha256,bytes,uploaded_by_identity_id)
         VALUES ($1,$2,$3,$4,'application/pdf',$5,$6,128,$7),
                ($8,$2,$9,$10,'application/pdf',$11,$12,256,$7),
                ($13,$2,$14,$15,'application/pdf',$16,$17,512,$7),
                ($18,$2,'other',$19,'application/pdf',$20,$21,1024,$22)`,
        [requesterVerificationDocuments[0].id, legalOrganizationId, requesterVerificationDocuments[0].type,
          requesterVerificationDocuments[0].filename, `${verificationStorageSecret}/registration`, requesterVerificationDocuments[0].digest, requesterId,
          requesterVerificationDocuments[1].id, requesterVerificationDocuments[1].type,
          requesterVerificationDocuments[1].filename, `${verificationStorageSecret}/ownership`, requesterVerificationDocuments[1].digest,
          requesterVerificationDocuments[2].id, requesterVerificationDocuments[2].type,
          requesterVerificationDocuments[2].filename, `${verificationStorageSecret}/authority`, requesterVerificationDocuments[2].digest,
          otherVerificationDocumentId, otherVerificationFilename, `${verificationStorageSecret}/other`,
          createHash("sha256").update(`${marker}-other-verification`).digest("hex"), otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.organization_verification_requests
           (id,organization_id,version,legal_name,registration_number,jurisdiction_code,entity_type,primary_activity,
            registered_address,representative_authority_basis,status,submitted_by_identity_id)
         VALUES ($1,$2,1,'Privacy agreement issuer',$3,'NG','private_company',
                 'Governed organization verification',jsonb_build_object('line1',$4::text,'city','Lagos','countryCode','NG'),$5,'draft',$6)`,
        [verificationRequestId, legalOrganizationId, verificationRegistrationNumber, verificationAddressLine,
          representativeAuthorityBasis, requesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.organization_beneficial_owner_declarations
           (id,verification_request_id,owner_type,legal_name,ownership_bps,is_control_person,
            nationality_or_jurisdiction_code,country_of_residence_code,subject_identity_id,
            subject_link_basis,subject_linked_at)
         VALUES ($1,$2,'natural_person',$3,6000,true,'NG','NG',$4,
                 'submitting_identity_self_declaration',now()-interval '1 hour'),
                ($5,$2,'natural_person',$6,4000,false,'NG','NG',NULL,NULL,NULL)`,
        [randomUUID(), verificationRequestId, requesterBeneficialOwnerName, requesterId,
          randomUUID(), unlinkedBeneficialOwnerSecret],
      );
      for (const document of requesterVerificationDocuments) {
        await postgresQuery(
          `INSERT INTO fractal.organization_verification_request_evidence
             (verification_request_id,organization_id,evidence_document_id,evidence_type)
           VALUES ($1,$2,$3,$4)`,
          [verificationRequestId, legalOrganizationId, document.id, document.type],
        );
      }
      await postgresQuery(
        `INSERT INTO fractal.organization_verification_request_evidence
           (verification_request_id,organization_id,evidence_document_id,evidence_type)
         VALUES ($1,$2,$3,'other')`,
        [verificationRequestId, legalOrganizationId, otherVerificationDocumentId],
      );
      const assetApplicationReference = `PRIV-ASSET-${randomUUID().slice(0, 8).toUpperCase()}`;
      const assetName = `Requester governed asset ${randomUUID()}`;
      const amendedAssetName = `Requester governed asset amendment ${randomUUID()}`;
      const assetSummary = `Requester-authored asset application summary with governed privacy correlation ${randomUUID()}.`;
      const assetMaterialChange = `Requester-authored material change replaces the approved capacity and asset description ${randomUUID()}.`;
      const assetStorageSecret = `asset-applications/${randomUUID()}`;
      const assetDecisionReasonSecret = `Private asset decision rationale ${randomUUID()}`;
      const otherAssetReferenceSecret = `OTHER-ASSET-${randomUUID().slice(0, 8).toUpperCase()}`;
      const otherAssetNameSecret = `Other requester private asset ${randomUUID()}`;
      const otherAssetSummarySecret = `Other requester private asset application summary ${randomUUID()} with sufficient governed detail.`;
      const otherAssetDecisionSecret = `Other requester private asset decision ${randomUUID()}`;
      const otherActorResponseSecret = `Another actor's diligence response ${randomUUID()}`;
      const requesterDiligenceResponse = `Requester-authored diligence response ${randomUUID()}`;
      const assetReviewNotesSecret = `Private reviewer deliberation ${randomUUID()}`;
      const professionalFirmOrganizationId = randomUUID();
      const professionalFirmMembershipId = randomUUID();
      const professionalAssetRequestId = randomUUID();
      const professionalWorkOrderId = randomUUID();
      const professionalFirmLegalName = `Privacy professional firm ${randomUUID()}`;
      const professionalWorkOrderReference = `PRIV-WORK-${randomUUID().slice(0, 8).toUpperCase()}`;
      const professionalWorkOrderTitle = `Independent asset mandate ${randomUUID()}`;
      const professionalScopeSecret = `Confidential mandate scope ${randomUUID()} that must not enter subject-access evidence.`;
      const professionalExclusionsSecret = `Confidential mandate exclusions ${randomUUID()} that must not enter subject-access evidence.`;
      const professionalWorkEventReasonSecret = `Confidential work-order event rationale ${randomUUID()}`;
      const professionalWorkEventPayloadSecret = `confidential-work-event-payload-${randomUUID()}`;
      const otherProfessionalEventTypeSecret = `other-professional-event-${randomUUID()}`;
      const professionalDeliverableId = randomUUID();
      const professionalEvidenceId = randomUUID();
      const otherProfessionalEvidenceId = randomUUID();
      const professionalDeliverableTitle = `Authored diligence package ${randomUUID()}`;
      const professionalDeliverableSummary = `Requester-authored professional deliverable summary ${randomUUID()}.`;
      const professionalEvidenceFilename = `professional-evidence-${randomUUID()}.pdf`;
      const otherProfessionalEvidenceFilenameSecret = `other-professional-evidence-${randomUUID()}.pdf`;
      const professionalEvidenceDigest = createHash("sha256").update(professionalEvidenceFilename).digest("hex");
      const otherProfessionalEvidenceDigestSecret = createHash("sha256").update(otherProfessionalEvidenceFilenameSecret).digest("hex");
      const professionalEvidenceStorageSecret = `professional-deliverables/${randomUUID()}/author.pdf`;
      const otherProfessionalEvidenceStorageSecret = `professional-deliverables/${randomUUID()}/other.pdf`;
      const professionalPayoutProfileId = randomUUID();
      const professionalTaxTreatmentId = randomUUID();
      const professionalInvoiceId = randomUUID();
      const professionalInvoiceReference = `PRO-INV-${randomUUID().slice(0, 8).toUpperCase()}`;
      const professionalPayoutRecipientSecret = `paystack-recipient-${randomUUID()}`;
      const professionalTaxLegalSourceSecret = `confidential-tax-source-${randomUUID()}`;
      const professionalDeliverableReviewSecret = `confidential-deliverable-review-${randomUUID()}`;
      const professionalPayoutWorkerSecret = `professional-payout-worker-${randomUUID()}`;
      const professionalPayoutFailureSecret = `professional-payout-failure-${randomUUID()}`;
      const professionalFinancePolicyId = randomUUID();
      const professionalFinancePolicySecret = `confidential-finance-policy-${randomUUID()}`;
      const professionalFinanceEvidenceFilenameSecret = `finance-evidence-${randomUUID()}.pdf`;
      const professionalFinanceEvidenceStorageSecret = `professional-finance/${randomUUID()}/evidence.pdf`;
      const professionalFinanceEvidenceDigestSecret = createHash("sha256").update(professionalFinanceEvidenceFilenameSecret).digest("hex");
      const professionalCreditNoteReference = `PRO-CN-${randomUUID().slice(0, 8).toUpperCase()}`;
      const professionalCreditNoteReasonSecret = `Confidential credit-note rationale ${randomUUID()}`;
      const professionalReplacementReasonSecret = `Confidential replacement-payout rationale ${randomUUID()}`;
      const professionalReplacementEvidenceFilenameSecret = `replacement-evidence-${randomUUID()}.pdf`;
      const professionalReplacementEvidenceStorageSecret = `professional-finance/${randomUUID()}/replacement.pdf`;
      const professionalReplacementEvidenceDigestSecret = createHash("sha256").update(professionalReplacementEvidenceFilenameSecret).digest("hex");
      const professionalRecoveryRecipientSecret = `recovery-recipient-${randomUUID()}`;
      const professionalRecoveryFailureSecret = `recovery-failure-${randomUUID()}`;
      const professionalRecoveryResolutionSecret = `recovery-resolution-${randomUUID()}`;
      const requesterAssetEvidenceV1 = { id: randomUUID(), digest: createHash("sha256").update(`${marker}-asset-v1`).digest("hex") };
      const requesterAssetEvidenceV2 = { id: randomUUID(), digest: createHash("sha256").update(`${marker}-asset-v2`).digest("hex") };
      const otherAssetEvidence = { id: randomUUID(), digest: createHash("sha256").update(`${marker}-other-asset`).digest("hex") };
      await postgresQuery(
        `INSERT INTO fractal.asset_application_evidence_documents
           (id,organization_id,filename,mime_type,storage_key,content_sha256,bytes,uploaded_by_identity_id)
         VALUES ($1,$2,'requester-asset-v1.pdf','application/pdf',$3,$4,2048,$5),
                ($6,$2,'requester-asset-v2.pdf','application/pdf',$7,$8,4096,$5),
                ($9,$2,'other-requester-asset.pdf','application/pdf',$10,$11,8192,$12)`,
        [requesterAssetEvidenceV1.id, legalOrganizationId, `${assetStorageSecret}/v1`, requesterAssetEvidenceV1.digest, requesterId,
          requesterAssetEvidenceV2.id, `${assetStorageSecret}/v2`, requesterAssetEvidenceV2.digest,
          otherAssetEvidence.id, `${assetStorageSecret}/other`, otherAssetEvidence.digest, otherRequesterId],
      );
      const requesterAssetRequestV1Id = randomUUID();
      const requesterAssetRequestV2Id = randomUUID();
      const otherAssetRequestId = randomUUID();
      const requesterApprovedAssetV1Id = randomUUID();
      const requesterApprovedAssetV2Id = randomUUID();
      const otherApprovedAssetId = randomUUID();
      await postgresQuery(
        `INSERT INTO fractal.asset_application_requests
           (id,organization_id,application_reference,application_version,asset_name,asset_type,country_code,state,city,
            summary,requested_capacity_minor,currency,dossier_evidence_document_id,dossier_hash,status,submitted_by_identity_id,submitted_at)
         VALUES ($1,$2,$3,1,$4,'commercial_property','NG','Lagos','Ikeja',$5,900000,'NGN',$6,$7,'submitted',$8,now()-interval '4 hours')`,
        [requesterAssetRequestV1Id, legalOrganizationId, assetApplicationReference, assetName, assetSummary,
          requesterAssetEvidenceV1.id, requesterAssetEvidenceV1.digest, requesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.asset_application_requests
           (id,organization_id,application_reference,application_version,asset_name,asset_type,country_code,state,city,
            summary,material_change_summary,requested_capacity_minor,currency,dossier_evidence_document_id,dossier_hash,status,submitted_by_identity_id,submitted_at)
         VALUES ($1,$2,$3,2,$4,'commercial_property','NG','Lagos','Ikeja',$5,$6,950000,'NGN',$7,$8,'submitted',$9,now()-interval '3 hours')`,
        [requesterAssetRequestV2Id, legalOrganizationId, assetApplicationReference, amendedAssetName, assetSummary,
          assetMaterialChange, requesterAssetEvidenceV2.id, requesterAssetEvidenceV2.digest, requesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.asset_application_requests
           (id,organization_id,application_reference,application_version,asset_name,asset_type,country_code,state,city,
            summary,requested_capacity_minor,currency,dossier_evidence_document_id,dossier_hash,status,submitted_by_identity_id,submitted_at)
         VALUES ($1,$2,$3,1,$4,'industrial_property','NG','Lagos','Apapa',$5,870000,'NGN',$6,$7,'submitted',$8,now()-interval '2 hours')`,
        [otherAssetRequestId, legalOrganizationId, otherAssetReferenceSecret, otherAssetNameSecret, otherAssetSummarySecret,
          otherAssetEvidence.id, otherAssetEvidence.digest, otherRequesterId],
      );
      const approveAssetRequest = async (input: {
        requestId: string; approvedVersionId: string; reference: string; version: number; name: string; type: string;
        city: string; summary: string; capacity: number; evidenceId: string; digest: string; reason: string;
      }) => {
        await postgresQuery(
          `INSERT INTO fractal.approved_asset_application_versions
             (id,application_request_id,organization_id,application_reference,application_version,asset_name,asset_type,
              country_code,state,city,summary,requested_capacity_minor,currency,dossier_evidence_document_id,dossier_hash,
              approved_by_identity_id,approved_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'NG','Lagos',$8,$9,$10,'NGN',$11,$12,$13,now())`,
          [input.approvedVersionId, input.requestId, legalOrganizationId, input.reference, input.version, input.name,
            input.type, input.city, input.summary, input.capacity, input.evidenceId, input.digest, makerId],
        );
        await postgresQuery(
          `UPDATE fractal.asset_application_requests
              SET status='approved',decided_by_identity_id=$2,decided_at=now(),decision_reason=$3,approved_application_version_id=$4
            WHERE id=$1`,
          [input.requestId, makerId, input.reason, input.approvedVersionId],
        );
      };
      await approveAssetRequest({ requestId: requesterAssetRequestV1Id, approvedVersionId: requesterApprovedAssetV1Id,
        reference: assetApplicationReference, version: 1, name: assetName, type: "commercial_property", city: "Ikeja",
        summary: assetSummary, capacity: 900000, evidenceId: requesterAssetEvidenceV1.id,
        digest: requesterAssetEvidenceV1.digest, reason: assetDecisionReasonSecret });
      await approveAssetRequest({ requestId: requesterAssetRequestV2Id, approvedVersionId: requesterApprovedAssetV2Id,
        reference: assetApplicationReference, version: 2, name: amendedAssetName, type: "commercial_property", city: "Ikeja",
        summary: assetSummary, capacity: 950000, evidenceId: requesterAssetEvidenceV2.id,
        digest: requesterAssetEvidenceV2.digest, reason: assetDecisionReasonSecret });
      await approveAssetRequest({ requestId: otherAssetRequestId, approvedVersionId: otherApprovedAssetId,
        reference: otherAssetReferenceSecret, version: 1, name: otherAssetNameSecret, type: "industrial_property", city: "Apapa",
        summary: otherAssetSummarySecret, capacity: 870000, evidenceId: otherAssetEvidence.id,
        digest: otherAssetEvidence.digest, reason: otherAssetDecisionSecret });
      await postgresQuery(
        `INSERT INTO fractal.organizations (id,legal_name,status,created_by_identity_id)
         VALUES ($1,$2,'active',$3)`,
        [professionalFirmOrganizationId, professionalFirmLegalName, otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_firm_profiles (organization_id,status,credential_status)
         VALUES ($1,'active','verified')`,
        [professionalFirmOrganizationId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_firm_memberships
           (id,firm_organization_id,identity_id,role,status,granted_by_identity_id,granted_at)
         VALUES ($1,$2,$3,'engagement_lead','active',$4,now()-interval '1 day')`,
        [professionalFirmMembershipId, professionalFirmOrganizationId, otherRequesterId, makerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.asset_application_requests
           (id,organization_id,application_reference,application_version,asset_name,asset_type,country_code,state,city,
            summary,requested_capacity_minor,currency,dossier_evidence_document_id,dossier_hash,status,submitted_by_identity_id,submitted_at)
         VALUES ($1,$2,$3,1,'Professional mandate source asset','commercial_property','NG','Lagos','Ikeja',
                 'Submitted asset application retained solely to prove professional mandate subject linkage.',500000,'NGN',$4,$5,'submitted',$6,now()-interval '1 hour')`,
        [professionalAssetRequestId, legalOrganizationId, `PRIV-MANDATE-${randomUUID().slice(0, 8).toUpperCase()}`,
          requesterAssetEvidenceV1.id, requesterAssetEvidenceV1.digest, requesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_work_orders
           (id,reference,issuer_organization_id,professional_firm_organization_id,asset_application_request_id,title,
            scope,exclusions,confidentiality,response_due_at,delivery_due_at,fee_minor,currency,status,invited_by_identity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'confidential',now()+interval '2 days',now()+interval '10 days',550000,'NGN','invited',$9)`,
        [professionalWorkOrderId, professionalWorkOrderReference, legalOrganizationId, professionalFirmOrganizationId,
          professionalAssetRequestId, professionalWorkOrderTitle, professionalScopeSecret, professionalExclusionsSecret, makerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_work_order_assignments
           (id,work_order_id,firm_membership_id,assigned_by_identity_id,assigned_at)
         VALUES ($1,$2,$3,$4,now()-interval '30 minutes')`,
        [randomUUID(), professionalWorkOrderId, professionalFirmMembershipId, makerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_work_order_conflicts
           (id,work_order_id,declared_by_identity_id,declaration)
         VALUES ($1,$2,$3,'no_conflict')`,
        [randomUUID(), professionalWorkOrderId, otherRequesterId],
      );
      await postgresQuery(
        `UPDATE fractal.professional_work_orders
            SET status='accepted',decided_by_identity_id=$2,decided_at=now()
          WHERE id=$1`,
        [professionalWorkOrderId, otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_work_order_events
           (id,work_order_id,actor_identity_id,event_type,reason,payload,created_at)
         VALUES ($1,$2,$3,'accepted',$4,jsonb_build_object('secret',$5::text),now()-interval '20 minutes'),
                ($6,$2,$7,$8,NULL,jsonb_build_object('secret','other-actor-private-payload'),now()-interval '25 minutes')`,
        [randomUUID(), professionalWorkOrderId, otherRequesterId, professionalWorkEventReasonSecret,
          professionalWorkEventPayloadSecret, randomUUID(), makerId, otherProfessionalEventTypeSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_deliverable_evidence_documents
           (id,work_order_id,filename,mime_type,storage_key,content_sha256,bytes,uploaded_by_identity_id)
         VALUES ($1,$2,$3,'application/pdf',$4,$5,4096,$6),
                ($7,$2,$8,'application/pdf',$9,$10,8192,$11)`,
        [professionalEvidenceId, professionalWorkOrderId, professionalEvidenceFilename,
          professionalEvidenceStorageSecret, professionalEvidenceDigest, otherRequesterId,
          otherProfessionalEvidenceId, otherProfessionalEvidenceFilenameSecret,
          otherProfessionalEvidenceStorageSecret, otherProfessionalEvidenceDigestSecret, makerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_deliverable_versions
           (id,work_order_id,version,title,submission_summary,status,submitted_by_identity_id)
         VALUES ($1,$2,1,$3,$4,'submitted',$5)`,
        [professionalDeliverableId, professionalWorkOrderId, professionalDeliverableTitle,
          professionalDeliverableSummary, otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_deliverable_version_documents
           (deliverable_version_id,evidence_document_id)
         VALUES ($1,$2),($1,$3)`,
        [professionalDeliverableId, professionalEvidenceId, otherProfessionalEvidenceId],
      );
      await postgresQuery(
        `UPDATE fractal.professional_deliverable_versions
            SET status='accepted',reviewed_by_identity_id=$2,reviewed_at=now(),review_notes=$3
          WHERE id=$1`,
        [professionalDeliverableId, makerId, professionalDeliverableReviewSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_payout_profile_versions
           (id,firm_organization_id,version,rail,currency,account_holder_name,account_last4,
            provider_recipient_reference,status,verified_by_identity_id)
         VALUES ($1,$2,1,'bank_transfer','NGN','Confidential professional settlement account','4821',$3,'verified',$4)`,
        [professionalPayoutProfileId, professionalFirmOrganizationId, professionalPayoutRecipientSecret, makerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_invoice_tax_treatments
           (id,issuer_organization_id,version,jurisdiction_code,service_class,currency,indirect_tax_rate_bps,
            withholding_tax_rate_bps,effective_from,legal_source_reference,status,prepared_by_identity_id,
            approved_by_identity_id,approved_at)
         VALUES ($1,$2,1,'NG','professional_services','NGN',1000,500,now()-interval '1 day',$3,'active',$4,$5,now())`,
        [professionalTaxTreatmentId, legalOrganizationId, professionalTaxLegalSourceSecret, makerId, checkerId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_invoices
           (id,reference,work_order_id,deliverable_version_id,professional_firm_organization_id,
            payout_profile_version_id,tax_treatment_id,currency,gross_minor,tax_minor,withholding_tax_minor,
            net_payable_minor,due_at,status,submitted_by_identity_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'NGN',550000,55000,27500,577500,now()+interval '14 days','submitted',$8)`,
        [professionalInvoiceId, professionalInvoiceReference, professionalWorkOrderId, professionalDeliverableId,
          professionalFirmOrganizationId, professionalPayoutProfileId, professionalTaxTreatmentId, otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_finance_approval_policies
           (id,issuer_organization_id,version,resolution_type,currency,maximum_amount_minor,
            effective_from,policy_reference,status,prepared_by_identity_id,approved_by_identity_id,approved_at)
         VALUES ($1,$2,1,'credit_note','NGN',1000000,now()-interval '1 day',$3,'active',$4,$5,now())`,
        [professionalFinancePolicyId, legalOrganizationId, professionalFinancePolicySecret, makerId, checkerId],
      );
      await decideProfessionalInvoice({
        invoiceId: professionalInvoiceId, decidedByIdentityId: makerId, approve: true,
      });
      const professionalPayout = await authorizeProfessionalPayout({
        invoiceId: professionalInvoiceId, authorizedByIdentityId: checkerId,
      });
      await postgresQuery(
        `UPDATE fractal.professional_payout_instructions
            SET status='failed',dispatch_started_at=now(),dispatch_worker_id=$2,
                failed_at=now(),failure_reason=$3
          WHERE id=$1`,
        [professionalPayout.payoutInstructionId, professionalPayoutWorkerSecret, professionalPayoutFailureSecret],
      );
      const professionalFinanceException = await openProfessionalFinanceException({
        payoutInstructionId: professionalPayout.payoutInstructionId, openedByIdentityId: makerId,
      });
      await recordProfessionalFinanceExceptionEvidence({
        financeExceptionCaseId: professionalFinanceException.financeExceptionCaseId,
        uploadedByIdentityId: checkerId,
        evidenceType: "provider_verification",
        storageKey: professionalFinanceEvidenceStorageSecret,
        filename: professionalFinanceEvidenceFilenameSecret,
        mimeType: "application/pdf",
        contentSha256: professionalFinanceEvidenceDigestSecret,
      });
      await prepareProfessionalFinanceExceptionResolution({
        financeExceptionCaseId: professionalFinanceException.financeExceptionCaseId,
        preparedByIdentityId: makerId,
        resolutionType: "credit_note",
        resolutionReason: professionalCreditNoteReasonSecret,
        resolutionPayload: {
          creditNote: {
            reference: professionalCreditNoteReference,
            grossMinor: 550000,
            taxMinor: 55000,
            withholdingTaxMinor: 27500,
            netCreditMinor: 577500,
          },
        },
      });
      await decideProfessionalFinanceExceptionResolution({
        financeExceptionCaseId: professionalFinanceException.financeExceptionCaseId,
        reviewedByIdentityId: checkerId,
        approve: true,
      });
      const professionalCreditNote = await executeProfessionalFinanceCreditNote({
        financeExceptionCaseId: professionalFinanceException.financeExceptionCaseId,
        executedByIdentityId: requesterId,
      });
      await postgresQuery(
        "UPDATE fractal.professional_finance_exception_cases SET status='closed',closed_at=now() WHERE id=$1",
        [professionalFinanceException.financeExceptionCaseId],
      );
      await postgresQuery(
        `INSERT INTO fractal.professional_finance_approval_policies
           (id,issuer_organization_id,version,resolution_type,currency,maximum_amount_minor,effective_from,
            policy_reference,status,prepared_by_identity_id,approved_by_identity_id,approved_at)
         VALUES ($1,$2,2,'replacement_payout','NGN',1000000,now()-interval '1 day',$3,'active',$4,$5,now())`,
        [randomUUID(), legalOrganizationId, `replacement-policy-${randomUUID()}`, makerId, checkerId],
      );
      const replacementException = await openProfessionalFinanceException({
        payoutInstructionId: professionalPayout.payoutInstructionId, openedByIdentityId: makerId,
      });
      await recordProfessionalFinanceExceptionEvidence({
        financeExceptionCaseId: replacementException.financeExceptionCaseId,
        uploadedByIdentityId: checkerId,
        evidenceType: "provider_verification",
        storageKey: professionalReplacementEvidenceStorageSecret,
        filename: professionalReplacementEvidenceFilenameSecret,
        mimeType: "application/pdf",
        contentSha256: professionalReplacementEvidenceDigestSecret,
      });
      await prepareProfessionalFinanceExceptionResolution({
        financeExceptionCaseId: replacementException.financeExceptionCaseId,
        preparedByIdentityId: makerId,
        resolutionType: "replacement_payout",
        resolutionReason: professionalReplacementReasonSecret,
        resolutionPayload: { replacementPayout: { payoutProfileVersionId: professionalPayoutProfileId, amountMinor: 500000 } },
      });
      await decideProfessionalFinanceExceptionResolution({
        financeExceptionCaseId: replacementException.financeExceptionCaseId,
        reviewedByIdentityId: checkerId,
        approve: true,
      });
      await authorizeProfessionalReplacementPayout({
        financeExceptionCaseId: replacementException.financeExceptionCaseId,
        authorizedByIdentityId: requesterId,
      });
      await postgresQuery(
        `INSERT INTO fractal.professional_payout_recipient_recovery_cases
           (id,firm_organization_id,provider,provider_recipient_reference,failure_reason,status,created_at,
            resolved_at,resolved_by_identity_id,resolution_notes)
         VALUES ($1,$2,'paystack',$3,$4,'deactivated',now()-interval '2 hours',now()-interval '1 hour',$5,$6)`,
        [randomUUID(), professionalFirmOrganizationId, professionalRecoveryRecipientSecret,
          professionalRecoveryFailureSecret, requesterId, professionalRecoveryResolutionSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.asset_application_review_items
           (id,organization_id,application_request_id,category,title,request_message,required,status,response_message,
            response_evidence_document_id,responded_by_identity_id,responded_at,reviewed_by_identity_id,reviewed_at,
            review_notes,opened_by_identity_id,opened_at)
         VALUES ($1,$2,$3,'title','Confirm title evidence','Provide the current title evidence.',true,'verified',$4,$5,$6,now(),$7,now(),$8,$7,now()-interval '90 minutes'),
                ($9,$2,$3,'capacity','Confirm requested capacity','Explain the requested capacity change.',true,'responded',$10,$11,$12,now(),NULL,NULL,NULL,$7,now()-interval '60 minutes')`,
        [randomUUID(), legalOrganizationId, requesterAssetRequestV2Id, otherActorResponseSecret, otherAssetEvidence.id,
          otherRequesterId, makerId, assetReviewNotesSecret, randomUUID(), requesterDiligenceResponse,
          requesterAssetEvidenceV2.id, requesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.investor_compliance_profiles
           (identity_id,kyc_status,investor_class,accreditation_status,jurisdiction_code,reviewed_at,expires_at,evidence,updated_at)
         VALUES
           ($1,'approved','sophisticated','verified','NG',now()-interval '1 day',now()+interval '1 year',jsonb_build_object('providerSecret',$2::text),now()),
           ($3,'approved','retail','not_required','GH',now()-interval '2 days',now()+interval '1 year',jsonb_build_object('providerSecret',$4::text),now())`,
        [requesterId, requesterComplianceEvidenceSecret, otherRequesterId, otherRequesterComplianceEvidenceSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investor_compliance_review_requests
           (id,organization_id,investor_identity_id,kyc_status,investor_class,accreditation_status,jurisdiction_code,
            reviewed_at,expires_at,evidence,status,submitted_by_identity_id,submitted_at,decided_by_identity_id,decided_at,decision_reason,created_at)
         VALUES
           ($1,$2,$3,'approved','sophisticated','verified','NG',now()-interval '1 day',now()+interval '1 year',jsonb_build_object('providerSecret',$4::text),'approved',$5,now()-interval '1 hour',$6,now(),$7,now()-interval '1 hour'),
           ($8,$2,$9,'approved','retail','not_required','GH',now()-interval '2 days',now()+interval '1 year',jsonb_build_object('providerSecret',$10::text),'approved',$5,now()-interval '2 hours',$6,now()-interval '1 hour',$11,now()-interval '2 hours')`,
        [requesterComplianceRequestId, legalOrganizationId, requesterId, requesterComplianceEvidenceSecret, makerId, checkerId,
          requesterComplianceDecisionSecret, otherRequesterComplianceRequestId, otherRequesterId, otherRequesterComplianceEvidenceSecret,
          otherRequesterComplianceDecisionSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investor_compliance_profile_reviews
           (id,review_request_id,organization_id,investor_identity_id,approved_by_identity_id,approved_at,profile_snapshot,created_at)
         VALUES
           ($1,$2,$3,$4,$5,now(),jsonb_build_object('snapshotSecret',$6::text),now()),
           ($7,$8,$3,$9,$5,now()-interval '1 hour',jsonb_build_object('snapshotSecret',$10::text),now()-interval '1 hour')`,
        [requesterComplianceReviewId, requesterComplianceRequestId, legalOrganizationId, requesterId, checkerId,
          requesterComplianceSnapshotSecret, otherRequesterComplianceReviewId, otherRequesterComplianceRequestId,
          otherRequesterId, otherRequesterComplianceSnapshotSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.offering_products
          (id,organization_id,public_reference,status,currency,capacity_minor,opens_at,closes_at)
         VALUES ($1,$2,$3,'published','NGN',1000000,now()-interval '1 day',now()+interval '1 day')`,
        [legalOfferingId, legalOrganizationId, `PRIVACY-AGREEMENT-${marker}`],
      );
      await postgresQuery(
        `INSERT INTO fractal.offering_publication_versions
          (id,offering_id,version,terms,eligibility_policy,agreement_document_hash,disclosure_bundle_hash,published_by_identity_id,published_at)
         VALUES ($1,$2,1,'{}'::jsonb,'{}'::jsonb,$3,$4,$5,now())`,
        [legalOfferingVersionId, legalOfferingId, agreementDocumentHash, "1".repeat(64), makerId],
      );
      const publicationStorageSecret = `offering-publication/${randomUUID()}`;
      const publicationDecisionReasonSecret = `Private publication approval reason ${randomUUID()}`;
      const publicationEligibilitySecret = `private-eligibility-${randomUUID()}`;
      const otherPublicationReferenceSecret = `OTHER-PUBLICATION-${randomUUID().slice(0, 8).toUpperCase()}`;
      const otherPublicationNameSecret = `Other requester private offering ${randomUUID()}`;
      const requesterAgreementEvidenceId = randomUUID();
      const requesterDisclosureEvidenceId = randomUUID();
      const otherAgreementEvidenceId = randomUUID();
      const otherDisclosureEvidenceId = randomUUID();
      const otherAgreementDigest = createHash("sha256").update(`${marker}-other-publication-agreement`).digest("hex");
      const otherDisclosureDigest = createHash("sha256").update(`${marker}-other-publication-disclosure`).digest("hex");
      await postgresQuery(
        `INSERT INTO fractal.offering_publication_evidence_documents
           (id,organization_id,evidence_kind,filename,mime_type,storage_key,content_sha256,bytes,uploaded_by_identity_id)
         VALUES ($1,$2,'agreement','requester-offering-agreement.pdf','application/pdf',$3,$4,4096,$5),
                ($6,$2,'disclosure_bundle','requester-offering-disclosure.pdf','application/pdf',$7,$8,8192,$5),
                ($9,$2,'agreement','other-offering-agreement.pdf','application/pdf',$10,$11,4096,$12),
                ($13,$2,'disclosure_bundle','other-offering-disclosure.pdf','application/pdf',$14,$15,8192,$12)`,
        [requesterAgreementEvidenceId, legalOrganizationId, `${publicationStorageSecret}/requester-agreement`, agreementDocumentHash,
          requesterId, requesterDisclosureEvidenceId, `${publicationStorageSecret}/requester-disclosure`, "1".repeat(64),
          otherAgreementEvidenceId, `${publicationStorageSecret}/other-agreement`, otherAgreementDigest, otherRequesterId,
          otherDisclosureEvidenceId, `${publicationStorageSecret}/other-disclosure`, otherDisclosureDigest],
      );
      const publicationTerms = {
        publicSlug: `privacy-offering-${randomUUID().slice(0, 8)}`, name: `Requester governed offering ${randomUUID()}`,
        assetClass: "logistics_industrial", summary: `Requester-authored public summary ${randomUUID()} with governed detail.`,
        thesis: `Requester-authored investment thesis ${randomUUID()} with sufficient governed publication detail.`,
        riskSummary: `Requester-authored risk summary ${randomUUID()} with sufficient governed publication detail.`,
        incomeSource: `Requester-authored rental income source ${randomUUID()}.`, structure: `Requester-authored protected SPV structure ${randomUUID()}.`,
        security: `Requester-authored security package ${randomUUID()}.`, feeSummary: `Requester-authored fee summary ${randomUUID()}.`,
        nextMilestone: `Requester-authored next operating milestone ${randomUUID()}.`, minimumTicketMinor: 10000,
        targetReturnBps: 1600, termMonths: 36,
      };
      const otherPublicationTerms = {
        ...publicationTerms, publicSlug: `other-offering-${randomUUID().slice(0, 8)}`, name: otherPublicationNameSecret,
        summary: `Other requester private public summary ${randomUUID()} with governed detail.`,
      };
      await postgresQuery(
        `INSERT INTO fractal.offering_publication_requests
           (id,organization_id,public_reference,currency,capacity_minor,opens_at,closes_at,terms,eligibility_policy,
            agreement_document_hash,disclosure_bundle_hash,status,submitted_by_identity_id,submitted_at,
            decided_by_identity_id,decided_at,decision_reason,published_offering_id,agreement_evidence_document_id,
            disclosure_evidence_document_id,approved_asset_application_version_id)
         VALUES ($1,$2,$3,'NGN',900000,now()-interval '1 day',now()+interval '1 day',$4::jsonb,
                 jsonb_build_object('secret',$5::text),$6,$7,'approved',$8,now()-interval '2 hours',$9,now()-interval '1 hour',$10,$11,$12,$13,$14),
                ($15,$2,$16,'NGN',800000,now()-interval '1 day',now()+interval '1 day',$17::jsonb,
                 jsonb_build_object('secret','other-private-eligibility'),$18,$19,'submitted',$20,now()-interval '30 minutes',NULL,NULL,NULL,NULL,$21,$22,$23)`,
        [randomUUID(), legalOrganizationId, `PRIVACY-AGREEMENT-${marker}`, JSON.stringify(publicationTerms),
          publicationEligibilitySecret, agreementDocumentHash, "1".repeat(64), requesterId, makerId,
          publicationDecisionReasonSecret, legalOfferingId, requesterAgreementEvidenceId, requesterDisclosureEvidenceId,
          requesterApprovedAssetV2Id, randomUUID(), otherPublicationReferenceSecret, JSON.stringify(otherPublicationTerms),
          otherAgreementDigest, otherDisclosureDigest, otherRequesterId, otherAgreementEvidenceId,
          otherDisclosureEvidenceId, otherApprovedAssetId],
      );
      const requesterChainDeploymentId = randomUUID();
      const otherChainDeploymentId = randomUUID();
      const requesterChainOperationId = randomUUID();
      const requesterChainClaimId = randomUUID();
      const otherIssuanceTermsId = randomUUID();
      const otherIssuancePolicyEvidenceId = randomUUID();
      const tokenFactoryAddress = `0x${"4".repeat(40)}`;
      const tokenContractAddress = `0x${"5".repeat(40)}`;
      const chainTransactionHash = `0x${"6".repeat(64)}`;
      const otherChainTokenNameSecret = `Other private token ${randomUUID()}`;
      const otherChainDecisionReasonSecret = `Other private chain decision ${randomUUID()}`;
      const chainWorkerSecret = `private-chain-worker-${randomUUID()}`;
      const otherIssuancePolicyHashSecret = createHash("sha256").update(`${marker}-other-issuance-policy`).digest("hex");
      const otherIssuanceDecisionSecret = `Other private issuance decision ${randomUUID()}`;
      await postgresQuery(
        `INSERT INTO fractal.offering_chain_deployment_requests
           (id,organization_id,offering_id,offering_version_id,chain_id,token_factory_address,offering_name,token_name,
            token_symbol,max_balance_per_holder,retail_cap,max_total_supply,status,submitted_by_identity_id,submitted_at,
            decided_by_identity_id,decided_at,decision_reason)
         VALUES ($1,$2,$3,$4,11155111,$5,$6,$7,'PRIV',500000,100000,900000,'approved',$8,now()-interval '50 minutes',$9,now()-interval '40 minutes',NULL),
                ($10,$2,$3,$4,11155111,$5,$11,$12,'OTHR',400000,80000,800000,'rejected',$13,now()-interval '35 minutes',$9,now()-interval '30 minutes',$14)`,
        [requesterChainDeploymentId, legalOrganizationId, legalOfferingId, legalOfferingVersionId, tokenFactoryAddress,
          publicationTerms.name, `Privacy Token ${marker}`, requesterId, makerId, otherChainDeploymentId,
          otherPublicationNameSecret, otherChainTokenNameSecret, otherRequesterId, otherChainDecisionReasonSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.offering_chain_operations
           (id,request_id,organization_id,offering_id,chain_id,token_factory_address,operation_type,status,
            transaction_hash,token_contract_address,block_number,submitted_at,confirmed_at,created_at,updated_at)
         VALUES ($1,$2,$3,$4,11155111,$5,'deploy_token','confirmed',$6,$7,123456,now()-interval '25 minutes',
                 now()-interval '20 minutes',now()-interval '40 minutes',now()-interval '20 minutes')`,
        [requesterChainOperationId, requesterChainDeploymentId, legalOrganizationId, legalOfferingId,
          tokenFactoryAddress, chainTransactionHash, tokenContractAddress],
      );
      await postgresQuery(
        `INSERT INTO fractal.offering_chain_operation_dispatch_claims
           (id,operation_id,worker_id,status,transaction_hash,failure_reason,claimed_at,completed_at)
         VALUES ($1,$2,$3,'confirmed',$4,NULL,now()-interval '25 minutes',now()-interval '20 minutes')`,
        [requesterChainClaimId, requesterChainOperationId, chainWorkerSecret, chainTransactionHash],
      );
      await postgresQuery(
        `INSERT INTO fractal.agreement_acceptances
          (id,offering_version_id,investor_identity_id,agreement_document_hash,signature_name,execution_hash,accepted_at,ip_hash,user_agent_hash)
         VALUES ($1,$2,$3,$4,$5,$6,now(),$7,$8)`,
        [randomUUID(), legalOfferingVersionId, requesterId, agreementDocumentHash, agreementSignature,
          agreementExecutionHash, agreementIpHash, agreementUserAgentHash],
      );
      await postgresQuery(
        `INSERT INTO fractal.investment_eligibility_snapshots
          (id,offering_version_id,investor_identity_id,status,reason_codes,policy_snapshot,evidence_snapshot,evaluated_at,expires_at)
         VALUES
          ($1,$2,$3,'eligible','["requester_eligible"]'::jsonb,jsonb_build_object('secret',$4::text),jsonb_build_object('secret',$5::text),now()-interval '2 minutes',now()+interval '1 hour'),
          ($6,$2,$7,'ineligible','["other_requester_private_reason"]'::jsonb,jsonb_build_object('secret',$8::text),jsonb_build_object('secret',$9::text),now()-interval '1 minute',now()+interval '1 hour')`,
        [requesterEligibilitySnapshotId, legalOfferingVersionId, requesterId, requesterEligibilityPolicySecret,
          requesterEligibilityEvidenceSecret, otherRequesterEligibilitySnapshotId, otherRequesterId,
          otherRequesterEligibilityPolicySecret, otherRequesterEligibilityEvidenceSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investment_commitments
          (id,organization_id,investor_identity_id,offering_reference,currency,committed_minor,status)
         VALUES
          ($1,$2,$3,$4,'NGN',123457,'payment_pending'),
          ($5,$2,$6,$7,'NGN',765431,'payment_pending')`,
        [requesterCommitmentId, legalOrganizationId, requesterId, `PRIVACY-AGREEMENT-${marker}`,
          otherRequesterCommitmentId, otherRequesterId, otherRequesterCommitmentReferenceSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investment_reservations
          (id,offering_id,offering_version_id,investor_identity_id,amount_minor,currency,status,expires_at,
           commitment_id,command_key,eligibility_snapshot_id,agreement_acceptance_id)
         VALUES
          ($1,$2,$3,$4,123457,'NGN','pending_payment',now()+interval '1 hour',$5,$6,$7,NULL),
          ($8,$2,$3,$9,765431,'NGN','pending_payment',now()+interval '1 hour',$10,$11,$12,NULL)`,
        [requesterReservationId, legalOfferingId, legalOfferingVersionId, requesterId, requesterCommitmentId,
          requesterReservationCommandSecret, requesterEligibilitySnapshotId, otherRequesterReservationId,
          otherRequesterId, otherRequesterCommitmentId, otherRequesterReservationCommandSecret,
          otherRequesterEligibilitySnapshotId],
      );
      const requesterPaymentOutboxId = await withPostgresTransaction((client) => appendOutboxEvent(client, {
        aggregateType: "payment_intent", aggregateId: requesterPaymentIntentId,
        eventType: "payment.intent.created", payload: { test: "privacy-requester" },
        privacy: { kind: "subjects", subjectIdentityIds: [requesterId] },
      }));
      const otherPaymentOutboxId = await withPostgresTransaction((client) => appendOutboxEvent(client, {
        aggregateType: "payment_intent", aggregateId: otherRequesterPaymentIntentId,
        eventType: "payment.intent.created", payload: { test: "other-requester" },
        privacy: { kind: "subjects", subjectIdentityIds: [otherRequesterId] },
      }));
      await postgresQuery(
        `INSERT INTO fractal.payment_intents
          (id,commitment_id,provider,provider_reference,expected_minor,currency,status,expires_at,metadata)
         VALUES
          ($1,$2,'paystack',$3,123457,'NGN','amount_mismatch',now()+interval '1 hour',jsonb_build_object('secret',$4::text)),
          ($5,$6,'stripe',$7,765431,'NGN','amount_mismatch',now()+interval '1 hour',jsonb_build_object('secret','other-private-metadata'))`,
        [requesterPaymentIntentId, requesterCommitmentId, requesterProviderReferenceSecret,
          requesterPaymentMetadataSecret, otherRequesterPaymentIntentId, otherRequesterCommitmentId,
          otherRequesterProviderReferenceSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.payment_provider_instructions
          (id,payment_intent_id,outbox_event_id,provider,status,checkout_url,provider_access_code,initialized_at)
         VALUES
          ($1,$2,$3,'paystack','initialized',$4,$5,now()),
          ($6,$7,$8,'stripe','initialized','https://other.private/checkout','other-private-access',now())`,
        [randomUUID(), requesterPaymentIntentId, requesterPaymentOutboxId, requesterCheckoutSecret,
          requesterAccessCodeSecret, randomUUID(), otherRequesterPaymentIntentId, otherPaymentOutboxId],
      );
      await postgresQuery(
        `INSERT INTO fractal.payment_receipts
          (id,payment_intent_id,provider,provider_event_id,payload_hash,amount_minor,currency,status,received_at,metadata)
         VALUES
          ($1,$2,'paystack',$3,$4,123456,'NGN','amount_mismatch',now(),jsonb_build_object('secret',$5::text)),
          ($6,$7,'stripe',$8,$9,765430,'NGN','amount_mismatch',now(),jsonb_build_object('secret','other-private-receipt'))`,
        [requesterPaymentReceiptId, requesterPaymentIntentId, `event-${randomUUID()}`, "a".repeat(64),
          requesterReceiptMetadataSecret, otherRequesterPaymentReceiptId, otherRequesterPaymentIntentId,
          `event-${randomUUID()}`, "b".repeat(64)],
      );
      await postgresQuery(
        `INSERT INTO fractal.payment_reconciliation_cases
          (id,receipt_id,organization_id,case_type,status,expected_minor,actual_minor,currency,details)
         VALUES
          ($1,$2,$3,'amount_mismatch','open',123457,123456,'NGN',jsonb_build_object('secret',$4::text)),
          ($5,$6,$3,'amount_mismatch','open',765431,765430,'NGN',jsonb_build_object('secret','other-private-case'))`,
        [requesterReconciliationId, requesterPaymentReceiptId, legalOrganizationId,
          requesterReconciliationDetailSecret, otherRequesterReconciliationId, otherRequesterPaymentReceiptId],
      );
      await postgresQuery(
        `INSERT INTO fractal.payment_intents
          (id,commitment_id,provider,provider_reference,expected_minor,currency,status,expires_at)
         VALUES
          ($1,$2,'paystack',$3,345678,'NGN','receipt_matched',now()+interval '1 hour'),
          ($4,$5,'stripe',$6,876543,'NGN','receipt_matched',now()+interval '1 hour')`,
        [requesterAccountingIntentId, requesterCommitmentId, `accounting-provider-${randomUUID()}`,
          otherRequesterAccountingIntentId, otherRequesterCommitmentId, `other-accounting-provider-${randomUUID()}`],
      );
      await withPostgresTransaction(async (client) => {
        await client.query(
          `INSERT INTO fractal.ledger_accounts
            (id,organization_id,code,name,account_type,normal_balance)
           VALUES
            ($1,$2,$3,$4,'asset','debit'),
            ($5,$2,$6,'Internal investor escrow','liability','credit')`,
          [clearingAccountId, legalOrganizationId, accountCodeSecret, accountNameSecret,
            escrowAccountId, escrowAccountCodeSecret],
        );
        await client.query(
          `INSERT INTO fractal.journal_entries
            (id,scope_key,organization_id,idempotency_key,request_hash,status,currency,effective_at,narrative,external_ref,metadata)
           VALUES
            ($1,$2,$3,$4,$5,'posted','NGN',now()-interval '10 minutes',$6,$7,jsonb_build_object('secret',$8::text)),
            ($9,$2,$3,$10,$11,'posted','NGN',now()-interval '5 minutes','other private narrative','other private external',jsonb_build_object('secret','other private journal metadata'))`,
          [requesterJournalId, `organization:${legalOrganizationId}`, legalOrganizationId, randomUUID(),
            "e".repeat(64), journalNarrativeSecret, journalExternalReferenceSecret, journalMetadataSecret,
            otherRequesterJournalId, randomUUID(), "f".repeat(64)],
        );
        await client.query(
          `INSERT INTO fractal.journal_postings
            (journal_id,line_number,account_id,direction,amount_minor,currency,metadata)
           VALUES
            ($1,1,$2,'debit',345678,'NGN',jsonb_build_object('secret','requester debit metadata')),
            ($1,2,$3,'credit',345678,'NGN',jsonb_build_object('secret','requester credit metadata')),
            ($4,1,$2,'debit',876543,'NGN',jsonb_build_object('secret','other debit metadata')),
            ($4,2,$3,'credit',876543,'NGN',jsonb_build_object('secret','other credit metadata'))`,
          [requesterJournalId, clearingAccountId, escrowAccountId, otherRequesterJournalId],
        );
        await client.query(
          `INSERT INTO fractal.payment_receipts
            (id,payment_intent_id,provider,provider_event_id,payload_hash,amount_minor,currency,status,journal_id,received_at)
           VALUES
            ($1,$2,'paystack',$3,$4,345678,'NGN','matched',$5,now()-interval '10 minutes'),
            ($6,$7,'stripe',$8,$9,876543,'NGN','matched',$10,now()-interval '5 minutes')`,
          [requesterAccountingReceiptId, requesterAccountingIntentId, `accounting-event-${randomUUID()}`,
            "c".repeat(64), requesterJournalId, otherRequesterAccountingReceiptId,
            otherRequesterAccountingIntentId, `other-accounting-event-${randomUUID()}`, "d".repeat(64),
            otherRequesterJournalId],
        );
      });
      await postgresQuery(
        `INSERT INTO fractal.governance_evidence_documents
          (id,organization_id,offering_id,evidence_kind,filename,mime_type,storage_key,content_sha256,bytes,uploaded_by_identity_id)
         VALUES ($1,$2,$3,'allocation_policy','allocation-policy.pdf','application/pdf',$4,$5,128,$6),
                ($7,$2,$3,'allocation_policy','other-allocation-policy.pdf','application/pdf',$8,$9,256,$10)`,
        [allocationPolicyEvidenceId, legalOrganizationId, legalOfferingId, allocationPolicyStorageSecret,
          allocationPolicyHashSecret, makerId, otherIssuancePolicyEvidenceId,
          `governance/private/${randomUUID()}/other-allocation-policy.pdf`, otherIssuancePolicyHashSecret, otherRequesterId],
      );
      await postgresQuery(
        `INSERT INTO fractal.offering_issuance_term_requests
          (id,organization_id,offering_id,offering_version_id,currency,token_unit_price_minor,max_total_supply,
           allocation_policy_hash,allocation_policy_evidence_document_id,status,submitted_by_identity_id,submitted_at,
           decided_by_identity_id,decided_at,decision_reason)
         VALUES ($1,$2,$3,$4,'NGN',100,1000000,$5,$6,'approved',$7,now()-interval '2 hours',$8,now()-interval '1 hour',NULL),
                ($9,$2,$3,$4,'NGN',999,800000,$10,$11,'rejected',$12,now()-interval '30 minutes',$8,now()-interval '25 minutes',$13)`,
        [issuanceTermsRequestId, legalOrganizationId, legalOfferingId, legalOfferingVersionId,
          allocationPolicyHashSecret, allocationPolicyEvidenceId, requesterId, makerId,
          otherIssuanceTermsId, otherIssuancePolicyHashSecret, otherIssuancePolicyEvidenceId,
          otherRequesterId, otherIssuanceDecisionSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investment_allocation_requests
          (id,organization_id,offering_id,issuance_terms_request_id,reservation_id,investor_identity_id,wallet_id,
           chain_id,wallet_address,invested_minor,currency,token_unit_price_minor,token_amount,allocation_policy_hash,
           compliance_snapshot,status,submitted_by_identity_id,submitted_at,decided_by_identity_id,decided_at,decision_reason)
         VALUES
          ($1,$2,$3,$4,$5,$6,$7,11155111,$8,123457,'NGN',100,1234,$9,jsonb_build_object('secret',$10::text),'approved',$11,now()-interval '30 minutes',$12,now()-interval '20 minutes',$13),
          ($14,$2,$3,$4,$15,$16,$17,80002,$18,765431,'NGN',100,7654,$9,jsonb_build_object('secret',$19::text),'approved',$11,now()-interval '25 minutes',$12,now()-interval '15 minutes','other private decision')`,
        [requesterAllocationId, legalOrganizationId, legalOfferingId, issuanceTermsRequestId, requesterReservationId,
          requesterId, requesterWalletId, requesterWalletAddress, allocationPolicyHashSecret,
          requesterAllocationComplianceSecret, makerId, checkerId, requesterAllocationDecisionSecret,
          otherRequesterAllocationId, otherRequesterReservationId, otherRequesterId, otherRequesterWalletId,
          otherRequesterWalletAddress, otherRequesterAllocationComplianceSecret],
      );
      await postgresQuery(
        `INSERT INTO fractal.investment_allocation_chain_operations
          (id,allocation_request_id,organization_id,offering_id,chain_id,token_contract_address,wallet_address,
           token_amount,operation_type,status,transaction_hash,submitted_at,confirmed_at)
         VALUES
          ($1,$2,$3,$4,11155111,$5,$6,1234,'mint','confirmed',$7,now()-interval '10 minutes',now()-interval '5 minutes'),
          ($8,$9,$3,$4,80002,$10,$11,7654,'mint','confirmed',$12,now()-interval '9 minutes',now()-interval '4 minutes')`,
        [requesterAllocationOperationId, requesterAllocationId, legalOrganizationId, legalOfferingId,
          `0x${"8".repeat(40)}`, requesterWalletAddress, requesterAllocationTransactionHash,
          otherRequesterAllocationOperationId, otherRequesterAllocationId, `0x${"9".repeat(40)}`,
          otherRequesterWalletAddress, otherRequesterAllocationTransactionHash],
      );
      await postgresQuery(
        `INSERT INTO fractal.investment_allocation_chain_dispatch_claims
          (id,operation_id,worker_id,status,transaction_hash,claimed_at,completed_at)
         VALUES
          ($1,$2,$3,'confirmed',$4,now()-interval '11 minutes',now()-interval '5 minutes'),
          ($5,$6,$7,'confirmed',$8,now()-interval '10 minutes',now()-interval '4 minutes')`,
        [requesterAllocationClaimId, requesterAllocationOperationId, requesterAllocationWorkerSecret,
          requesterAllocationTransactionHash, otherRequesterAllocationClaimId, otherRequesterAllocationOperationId,
          otherRequesterAllocationWorkerSecret, otherRequesterAllocationTransactionHash],
      );
      const requesterInboxRawSecret = `signed-paystack-body-${randomUUID()}`;
      const requesterInboxSignatureSecret = `paystack-signature-${randomUUID()}`;
      const otherRequesterInboxRawSecret = `other-signed-paystack-body-${randomUUID()}`;
      await receiveInboxEvent({
        provider: "paystack", externalEventId: `privacy-charge-${randomUUID()}`,
        payload: {
          eventType: "charge.success", data: { reference: requesterProviderReferenceSecret },
          rawBody: requesterInboxRawSecret, signature: requesterInboxSignatureSecret,
        },
      });
      await receiveInboxEvent({
        provider: "paystack", externalEventId: `other-privacy-charge-${randomUUID()}`,
        payload: {
          eventType: "charge.success", data: { reference: otherRequesterProviderReferenceSecret },
          rawBody: otherRequesterInboxRawSecret, signature: `other-paystack-signature-${randomUUID()}`,
        },
      });
      const sections = await withPostgresTransaction((client) => collectCanonicalPrivacySourceSections(client, requesterId, "access", contentProfile));
      const canonicalCollection = [...sections.values()].map((section) => section.canonicalContent).join("\n");
      const requesterBootstrapCollection = sections.get("postgres.fractal.administrator_bootstrap_state")?.canonicalContent ?? "";
      const requesterAuditCollection = sections.get("postgres.fractal.audit_events")?.canonicalContent ?? "";
      const requesterAuditHeadCollection = sections.get("postgres.fractal.audit_chain_heads")?.canonicalContent ?? "";
      const requesterRecoveryResolutionCollection = sections.get("postgres.fractal.professional_payout_recipient_recovery_cases")?.canonicalContent ?? "";
      const requesterReplacementAuthorizationCollection = sections.get("postgres.fractal.professional_replacement_payout_requests")?.canonicalContent ?? "";
      const requesterBeneficialOwnerCollection = sections.get("postgres.fractal.organization_beneficial_owner_declarations")?.canonicalContent ?? "";
      const requesterCleanupCollection = sections.get("postgres.fractal.storage_cleanup_tasks")?.canonicalContent ?? "";
      const requesterInboxCollection = sections.get("postgres.fractal.inbox_events")?.canonicalContent ?? "";
      const requesterOutboxCollection = sections.get("postgres.fractal.outbox_events")?.canonicalContent ?? "";
      const requesterAuditHead = await postgresQuery<{ latest_hash: string }>(
        "SELECT latest_hash FROM fractal.audit_chain_heads WHERE scope_key=$1",
        [`identity:${requesterId}`],
      );
      expect(sections.size).toBe(142);
      expect(requesterInboxCollection).toContain('"provider":"paystack"');
      expect(requesterInboxCollection).toContain('"processingStatus":"pending"');
      expect(requesterInboxCollection).not.toContain(requesterProviderReferenceSecret);
      expect(requesterInboxCollection).not.toContain(requesterInboxRawSecret);
      expect(requesterInboxCollection).not.toContain(requesterInboxSignatureSecret);
      expect(requesterInboxCollection).not.toContain(otherRequesterInboxRawSecret);
      expect(requesterOutboxCollection).toContain('"deliveryStatus":"pending"');
      expect(requesterOutboxCollection).not.toContain("auth.session.security_test_notification");
      expect(requesterOutboxCollection).not.toContain("decision_proposed");
      expect(requesterOutboxCollection).not.toContain(notificationEvidence.outboxId);
      expect(requesterOutboxCollection).not.toContain(notificationEvidence.auditId);
      expect(requesterOutboxCollection).not.toContain(requesterId);
      expect(requesterCleanupCollection).toContain('"cleanupPurpose":"governed_support_attachment_disposition"');
      expect(requesterCleanupCollection).toContain('"status":"cleanup_requested"');
      expect(requesterCleanupCollection).toContain('"requestedAt"');
      expect(requesterCleanupCollection).not.toContain(expiredRequesterStorageSecret);
      expect(requesterCleanupCollection).not.toContain(expiredInternalStorageSecret);
      expect(requesterCleanupCollection).not.toContain(orphanCleanupStorageSecret);
      expect(requesterCleanupCollection).not.toContain(orphanCleanupErrorSecret);
      expect(requesterCleanupCollection).not.toContain(expiredRequesterFilename);
      expect(requesterCleanupCollection).not.toContain(expiredRequesterDigest);
      expect(requesterBeneficialOwnerCollection).toContain(requesterBeneficialOwnerName);
      expect(requesterBeneficialOwnerCollection).toContain('"ownershipBps":6000');
      expect(requesterBeneficialOwnerCollection).not.toContain(unlinkedBeneficialOwnerSecret);
      expect(requesterBeneficialOwnerCollection).not.toContain(verificationRequestId);
      expect(requesterBootstrapCollection).toContain('"cohortSize":3');
      expect(requesterBootstrapCollection).toContain('"sealedAt"');
      expect(requesterBootstrapCollection).not.toContain(bootstrapCohortId);
      expect(requesterBootstrapCollection).not.toContain(bootstrapFingerprintSecret);
      expect(requesterBootstrapCollection).not.toContain(bootstrapInitiatorSecret);
      expect(requesterAuditHeadCollection).toContain('"latestSequence"');
      expect(requesterAuditHeadCollection).toContain('"updatedAt"');
      expect(requesterAuditHeadCollection).not.toContain("identity:");
      expect(requesterAuditHeadCollection).not.toContain(requesterAuditHead.rows[0]!.latest_hash);
      expect(canonicalCollection).toContain(agreementSignature);
      expect(canonicalCollection).toContain(agreementDocumentHash);
      expect(canonicalCollection).toContain(agreementExecutionHash);
      expect(canonicalCollection).not.toContain(agreementIpHash);
      expect(canonicalCollection).not.toContain(agreementUserAgentHash);
      expect(canonicalCollection).not.toContain(passwordSecret);
      expect(canonicalCollection).not.toContain(refreshSecret);
      expect(canonicalCollection).not.toContain(deliveryWorkerSecret);
      expect(canonicalCollection).not.toContain(deliveryErrorSecret);
      expect(canonicalCollection).not.toContain(totpSecret);
      expect(canonicalCollection).not.toContain(recoveryDigest);
      expect(canonicalCollection).not.toContain(notificationEvidence.auditId);
      expect(canonicalCollection).not.toContain(notificationEvidence.outboxId);
      expect(canonicalCollection).not.toContain("commandKey");
      expect(canonicalCollection).not.toContain("credentialInvalidatedAt");
      expect(canonicalCollection).not.toContain("reviewReason");
      expect(canonicalCollection).not.toContain("decision_proposed");
      expect(requesterAuditCollection).toContain("auth.session.security_test_notification");
      expect(requesterAuditCollection).toContain('"actorType":"user"');
      expect(requesterAuditCollection).toContain('"entityType":"auth_session"');
      expect(requesterAuditCollection).not.toContain(requesterAuditReasonSecret);
      expect(requesterAuditCollection).not.toContain(requesterAuditPayloadSecret);
      expect(requesterAuditCollection).not.toContain(otherAuditActionSecret);
      expect(requesterRecoveryResolutionCollection).toContain('"participationRole":"resolver"');
      expect(requesterRecoveryResolutionCollection).toContain('"status":"deactivated"');
      expect(requesterRecoveryResolutionCollection).not.toContain(professionalRecoveryRecipientSecret);
      expect(requesterRecoveryResolutionCollection).not.toContain(professionalRecoveryFailureSecret);
      expect(requesterRecoveryResolutionCollection).not.toContain(professionalRecoveryResolutionSecret);
      expect(requesterReplacementAuthorizationCollection).toContain('"participationRole":"authorizer"');
      expect(requesterReplacementAuthorizationCollection).toContain('"status":"authorized"');
      expect(requesterReplacementAuthorizationCollection).not.toContain(professionalReplacementReasonSecret);
      expect(requesterReplacementAuthorizationCollection).not.toContain(professionalPayoutRecipientSecret);
      expect(requesterReplacementAuthorizationCollection).not.toContain("amountMinor");
      expect(sections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportCase.case.reference);
      expect(sections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportSubject);
      expect(sections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportDescription);
      expect(sections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportRelatedReference);
      expect(sections.get("postgres.fractal.support_case_events")?.canonicalContent).toContain(supportRequesterMessage);
      expect(sections.get("postgres.fractal.support_case_events")?.canonicalContent).toContain(supportVisibleReply);
      expect(sections.get("postgres.fractal.support_case_events")?.canonicalContent).toContain("requester_action");
      expect(sections.get("postgres.fractal.support_case_events")?.canonicalContent).toContain("service_response");
      const attachmentCollection = sections.get("postgres.fractal.support_case_attachments")?.canonicalContent ?? "";
      const attachmentAccessCollection = sections.get("postgres.fractal.support_case_attachment_access_events")?.canonicalContent ?? "";
      expect(attachmentCollection).toContain(requesterAttachmentFilename);
      expect(attachmentCollection).toContain(serviceAttachmentFilename);
      expect(attachmentCollection).toContain(requesterAttachmentDigest);
      expect(attachmentCollection).toContain(serviceAttachmentDigest);
      expect(attachmentCollection).toContain("requester_upload");
      expect(attachmentCollection).toContain("service_attachment");
      expect(attachmentAccessCollection).toContain(requesterAttachmentFilename);
      expect(attachmentAccessCollection).toContain(serviceAttachmentFilename);
      expect(attachmentAccessCollection).toContain("requester_download");
      expect(attachmentAccessCollection).toContain("service_access");
      expect(attachmentCollection).not.toContain(internalAttachmentFilename);
      expect(attachmentCollection).not.toContain(internalAttachmentDigest);
      expect(attachmentAccessCollection).not.toContain(internalAttachmentFilename);
      expect(attachmentAccessCollection).not.toContain(internalAttachmentDigest);
      const dispositionRequestCollection = sections.get("postgres.fractal.support_attachment_disposition_requests")?.canonicalContent ?? "";
      const dispositionCollection = sections.get("postgres.fractal.support_attachment_dispositions")?.canonicalContent ?? "";
      expect(dispositionRequestCollection).toContain(supportCase.case.reference);
      expect(dispositionRequestCollection).toContain(expiredRequesterFilename);
      expect(dispositionRequestCollection).toContain(requesterDisposition.request.reference);
      expect(dispositionRequestCollection).toContain('"action":"delete_object"');
      expect(dispositionRequestCollection).toContain('"status":"applied"');
      expect(dispositionCollection).toContain(supportCase.case.reference);
      expect(dispositionCollection).toContain(expiredRequesterFilename);
      expect(dispositionCollection).toContain(expiredRequesterDigest);
      expect(dispositionCollection).toContain('"status":"cleanup_requested"');
      expect(dispositionRequestCollection).not.toContain(expiredInternalFilenameSecret);
      expect(dispositionCollection).not.toContain(expiredInternalFilenameSecret);
      expect(dispositionRequestCollection).not.toContain(expiredInternalDigestSecret);
      expect(dispositionCollection).not.toContain(expiredInternalDigestSecret);
      const professionalSections = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, otherRequesterId, "access", contentProfile));
      const professionalFirmCollection = professionalSections.get("postgres.fractal.professional_firm_profiles")?.canonicalContent ?? "";
      const professionalMembershipCollection = professionalSections.get("postgres.fractal.professional_firm_memberships")?.canonicalContent ?? "";
      const professionalWorkOrderCollection = professionalSections.get("postgres.fractal.professional_work_orders")?.canonicalContent ?? "";
      const professionalAssignmentCollection = professionalSections.get("postgres.fractal.professional_work_order_assignments")?.canonicalContent ?? "";
      const professionalDeliverableCollection = professionalSections.get("postgres.fractal.professional_deliverable_versions")?.canonicalContent ?? "";
      const professionalEvidenceCollection = professionalSections.get("postgres.fractal.professional_deliverable_evidence_documents")?.canonicalContent ?? "";
      const professionalDeliverableLinkCollection = professionalSections.get("postgres.fractal.professional_deliverable_version_documents")?.canonicalContent ?? "";
      const professionalInvoiceCollection = professionalSections.get("postgres.fractal.professional_invoices")?.canonicalContent ?? "";
      const professionalPayoutCollection = professionalSections.get("postgres.fractal.professional_payout_instructions")?.canonicalContent ?? "";
      const professionalCreditNoteCollection = professionalSections.get("postgres.fractal.professional_invoice_credit_notes")?.canonicalContent ?? "";
      const professionalFinanceExceptionCollection = professionalSections.get("postgres.fractal.professional_finance_exception_cases")?.canonicalContent ?? "";
      const professionalConflictCollection = professionalSections.get("postgres.fractal.professional_work_order_conflicts")?.canonicalContent ?? "";
      const professionalWorkEventCollection = professionalSections.get("postgres.fractal.professional_work_order_events")?.canonicalContent ?? "";
      const professionalFinanceEvidenceMetadataCollection = professionalSections.get("postgres.fractal.professional_finance_exception_evidence")?.canonicalContent ?? "";
      const professionalGovernanceEvidenceCollection = professionalSections.get("postgres.fractal.governance_evidence_documents")?.canonicalContent ?? "";
      const unrelatedBootstrapCollection = professionalSections.get("postgres.fractal.administrator_bootstrap_state")?.canonicalContent ?? "";
      expect(professionalSections.size).toBe(142);
      expect(professionalSections.get("postgres.fractal.storage_cleanup_tasks")?.canonicalContent).toContain('"records":[]');
      expect(professionalSections.get("postgres.fractal.storage_cleanup_tasks")?.canonicalContent).not.toContain(orphanCleanupStorageSecret);
      expect(professionalSections.get("postgres.fractal.organization_beneficial_owner_declarations")?.canonicalContent).toContain('"records":[]');
      expect(professionalSections.get("postgres.fractal.organization_beneficial_owner_declarations")?.canonicalContent).not.toContain(requesterBeneficialOwnerName);
      expect(unrelatedBootstrapCollection).toContain('"records":[]');
      expect(unrelatedBootstrapCollection).not.toContain('"cohortSize"');
      expect(professionalFirmCollection).toContain(professionalFirmLegalName);
      expect(professionalFirmCollection).toContain('"credentialStatus":"verified"');
      expect(professionalMembershipCollection).toContain(professionalFirmLegalName);
      expect(professionalMembershipCollection).toContain('"role":"engagement_lead"');
      expect(professionalWorkOrderCollection).toContain(professionalWorkOrderReference);
      expect(professionalWorkOrderCollection).toContain(professionalWorkOrderTitle);
      expect(professionalWorkOrderCollection).toContain('"feeMinor":"550000"');
      expect(professionalAssignmentCollection).toContain(professionalWorkOrderReference);
      expect(professionalAssignmentCollection).toContain('"assignmentStatus":"active"');
      expect(professionalDeliverableCollection).toContain(professionalWorkOrderReference);
      expect(professionalDeliverableCollection).toContain(professionalDeliverableTitle);
      expect(professionalDeliverableCollection).toContain(professionalDeliverableSummary);
      expect(professionalEvidenceCollection).toContain(professionalWorkOrderReference);
      expect(professionalEvidenceCollection).toContain(professionalEvidenceFilename);
      expect(professionalEvidenceCollection).toContain(professionalEvidenceDigest);
      expect(professionalDeliverableLinkCollection).toContain(professionalDeliverableTitle);
      expect(professionalDeliverableLinkCollection).toContain(professionalEvidenceFilename);
      expect(professionalDeliverableLinkCollection).toContain(professionalEvidenceDigest);
      expect(professionalInvoiceCollection).toContain(professionalInvoiceReference);
      expect(professionalInvoiceCollection).toContain(professionalWorkOrderReference);
      expect(professionalInvoiceCollection).toContain(professionalDeliverableTitle);
      expect(professionalInvoiceCollection).toContain('"grossMinor":"550000"');
      expect(professionalInvoiceCollection).toContain('"netPayableMinor":"577500"');
      expect(professionalPayoutCollection).toContain(professionalInvoiceReference);
      expect(professionalPayoutCollection).toContain(professionalWorkOrderReference);
      expect(professionalPayoutCollection).toContain('"currency":"NGN"');
      expect(professionalPayoutCollection).toContain('"amountMinor":"577500"');
      expect(professionalPayoutCollection).toContain('"status":"failed"');
      expect(professionalCreditNoteCollection).toContain(professionalCreditNoteReference);
      expect(professionalCreditNoteCollection).toContain(professionalInvoiceReference);
      expect(professionalCreditNoteCollection).toContain(professionalWorkOrderReference);
      expect(professionalCreditNoteCollection).toContain('"grossMinor":"550000"');
      expect(professionalCreditNoteCollection).toContain('"taxMinor":"55000"');
      expect(professionalCreditNoteCollection).toContain('"withholdingTaxMinor":"27500"');
      expect(professionalCreditNoteCollection).toContain('"netCreditMinor":"577500"');
      expect(professionalFinanceExceptionCollection).toContain(professionalInvoiceReference);
      expect(professionalFinanceExceptionCollection).toContain(professionalWorkOrderReference);
      expect(professionalFinanceExceptionCollection).toContain('"status":"executed"');
      expect(professionalFinanceExceptionCollection).toContain('"resolutionType":"credit_note"');
      expect(professionalConflictCollection).toContain(professionalWorkOrderReference);
      expect(professionalConflictCollection).toContain('"declaration":"no_conflict"');
      expect(professionalWorkEventCollection).toContain(professionalWorkOrderReference);
      expect(professionalWorkEventCollection).toContain('"eventType":"accepted"');
      expect(professionalWorkEventCollection).not.toContain(professionalWorkEventReasonSecret);
      expect(professionalWorkEventCollection).not.toContain(professionalWorkEventPayloadSecret);
      expect(professionalWorkEventCollection).not.toContain(otherProfessionalEventTypeSecret);
      expect(professionalFinanceEvidenceMetadataCollection).not.toContain(professionalFinanceEvidenceFilenameSecret);
      expect(professionalGovernanceEvidenceCollection).toContain("other-allocation-policy.pdf");
      expect(professionalGovernanceEvidenceCollection).toContain('"evidenceKind":"allocation_policy"');
      expect(professionalGovernanceEvidenceCollection).not.toContain('"filename":"allocation-policy.pdf"');
      expect(professionalGovernanceEvidenceCollection).not.toContain(otherIssuancePolicyHashSecret);
      expect(professionalWorkOrderCollection).not.toContain(professionalScopeSecret);
      expect(professionalWorkOrderCollection).not.toContain(professionalExclusionsSecret);
      expect(professionalDeliverableCollection).not.toContain(professionalScopeSecret);
      expect(professionalDeliverableCollection).not.toContain(professionalExclusionsSecret);
      expect(professionalEvidenceCollection).not.toContain(professionalEvidenceStorageSecret);
      expect(professionalEvidenceCollection).not.toContain(otherProfessionalEvidenceStorageSecret);
      expect(professionalEvidenceCollection).not.toContain(otherProfessionalEvidenceFilenameSecret);
      expect(professionalEvidenceCollection).not.toContain(otherProfessionalEvidenceDigestSecret);
      expect(professionalDeliverableLinkCollection).not.toContain(professionalEvidenceStorageSecret);
      expect(professionalDeliverableLinkCollection).not.toContain(otherProfessionalEvidenceStorageSecret);
      expect(professionalDeliverableLinkCollection).not.toContain(otherProfessionalEvidenceFilenameSecret);
      expect(professionalDeliverableLinkCollection).not.toContain(otherProfessionalEvidenceDigestSecret);
      expect(professionalInvoiceCollection).not.toContain(professionalPayoutRecipientSecret);
      expect(professionalInvoiceCollection).not.toContain(professionalTaxLegalSourceSecret);
      expect(professionalInvoiceCollection).not.toContain(professionalDeliverableReviewSecret);
      expect(professionalPayoutCollection).not.toContain(professionalPayout.reference);
      expect(professionalPayoutCollection).not.toContain(professionalPayoutRecipientSecret);
      expect(professionalPayoutCollection).not.toContain(professionalPayoutWorkerSecret);
      expect(professionalPayoutCollection).not.toContain(professionalPayoutFailureSecret);
      expect(professionalPayoutCollection).not.toContain(makerId);
      expect(professionalPayoutCollection).not.toContain(checkerId);
      expect(professionalCreditNoteCollection).not.toContain(professionalCreditNoteReasonSecret);
      expect(professionalCreditNoteCollection).not.toContain(professionalFinancePolicySecret);
      expect(professionalCreditNoteCollection).not.toContain(professionalFinanceEvidenceFilenameSecret);
      expect(professionalCreditNoteCollection).not.toContain(professionalFinanceEvidenceStorageSecret);
      expect(professionalCreditNoteCollection).not.toContain(professionalFinanceEvidenceDigestSecret);
      expect(professionalCreditNoteCollection).not.toContain(professionalCreditNote.journalId);
      expect(professionalCreditNoteCollection).not.toContain(makerId);
      expect(professionalCreditNoteCollection).not.toContain(checkerId);
      expect(professionalCreditNoteCollection).not.toContain(requesterId);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalCreditNoteReasonSecret);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalCreditNoteReference);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalFinancePolicySecret);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalFinanceEvidenceFilenameSecret);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalFinanceEvidenceStorageSecret);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalFinanceEvidenceDigestSecret);
      expect(professionalFinanceExceptionCollection).not.toContain(professionalPayout.reference);
      expect(professionalFinanceExceptionCollection).not.toContain(makerId);
      expect(professionalFinanceExceptionCollection).not.toContain(checkerId);
      expect(professionalFinanceExceptionCollection).not.toContain(requesterId);
      const checkerProfessionalSections = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, checkerId, "access", contentProfile));
      const checkerFinanceEvidenceCollection = checkerProfessionalSections.get("postgres.fractal.professional_finance_exception_evidence")?.canonicalContent ?? "";
      expect(checkerFinanceEvidenceCollection).toContain(professionalFinanceEvidenceFilenameSecret);
      expect(checkerFinanceEvidenceCollection).toContain('"evidenceType":"provider_verification"');
      expect(checkerFinanceEvidenceCollection).toContain('"mimeType":"application/pdf"');
      expect(checkerFinanceEvidenceCollection).not.toContain(professionalFinanceEvidenceStorageSecret);
      expect(checkerFinanceEvidenceCollection).not.toContain(professionalFinanceEvidenceDigestSecret);
      expect(checkerFinanceEvidenceCollection).not.toContain(professionalFinanceException.financeExceptionCaseId);
      expect(canonicalCollection).not.toContain(professionalFirmLegalName);
      expect(canonicalCollection).not.toContain(professionalWorkOrderReference);
      expect(canonicalCollection).not.toContain(professionalWorkOrderTitle);
      expect(canonicalCollection).not.toContain(professionalDeliverableTitle);
      expect(canonicalCollection).not.toContain(professionalEvidenceFilename);
      expect(canonicalCollection).not.toContain(professionalInvoiceReference);
      expect(canonicalCollection).not.toContain(professionalPayout.reference);
      expect(canonicalCollection).not.toContain(professionalCreditNoteReference);
      const serviceObligationCollection = sections.get("postgres.fractal.support_case_service_obligations")?.canonicalContent ?? "";
      const serviceEventCollection = sections.get("postgres.fractal.support_case_service_events")?.canonicalContent ?? "";
      const supportNotificationCollection = sections.get("postgres.fractal.support_case_notification_deliveries")?.canonicalContent ?? "";
      const legalHoldChangeCollection = sections.get("postgres.fractal.data_legal_hold_change_requests")?.canonicalContent ?? "";
      const legalHoldCollection = sections.get("postgres.fractal.data_legal_holds")?.canonicalContent ?? "";
      expect(serviceObligationCollection).toContain(supportCase.case.reference);
      expect(serviceEventCollection).toContain(supportCase.case.reference);
      expect(supportNotificationCollection).toContain(supportCase.case.reference);
      expect(legalHoldChangeCollection).toContain('"changeType":"impose"');
      expect(legalHoldChangeCollection).toContain('"targetType":"identity"');
      expect(legalHoldCollection).toContain('"targetType":"identity"');
      const organizationCollection = sections.get("postgres.fractal.organizations")?.canonicalContent ?? "";
      const organizationMembershipCollection = sections.get("postgres.fractal.organization_memberships")?.canonicalContent ?? "";
      const organizationInvitationCollection = sections.get("postgres.fractal.organization_invitations")?.canonicalContent ?? "";
      const ownershipTransferCollection = sections.get("postgres.fractal.organization_ownership_transfer_requests")?.canonicalContent ?? "";
      expect(organizationCollection).toContain("Privacy agreement issuer");
      expect(organizationMembershipCollection).toContain('"role":"owner"');
      expect(organizationInvitationCollection).toContain(`${marker}-requester@example.test`);
      expect(ownershipTransferCollection).toContain('"participantSide":"source"');
      const organizationVerificationCollection = sections.get("postgres.fractal.organization_verification_requests")?.canonicalContent ?? "";
      const organizationVerificationEvidenceCollection = sections.get("postgres.fractal.organization_verification_evidence_documents")?.canonicalContent ?? "";
      const organizationVerificationLinkCollection = sections.get("postgres.fractal.organization_verification_request_evidence")?.canonicalContent ?? "";
      expect(organizationVerificationCollection).toContain(verificationRegistrationNumber);
      expect(organizationVerificationCollection).toContain(verificationAddressLine);
      expect(organizationVerificationCollection).toContain(representativeAuthorityBasis);
      expect(organizationVerificationEvidenceCollection).toContain(requesterVerificationDocuments[0].filename);
      expect(organizationVerificationLinkCollection).toContain(requesterVerificationDocuments[1].filename);
      expect(organizationVerificationEvidenceCollection).not.toContain(otherVerificationFilename);
      expect(organizationVerificationLinkCollection).not.toContain(otherVerificationFilename);
      const assetApplicationCollection = sections.get("postgres.fractal.asset_application_requests")?.canonicalContent ?? "";
      const assetEvidenceCollection = sections.get("postgres.fractal.asset_application_evidence_documents")?.canonicalContent ?? "";
      const assetReviewCollection = sections.get("postgres.fractal.asset_application_review_items")?.canonicalContent ?? "";
      const approvedAssetCollection = sections.get("postgres.fractal.approved_asset_application_versions")?.canonicalContent ?? "";
      const assetSupersessionCollection = sections.get("postgres.fractal.asset_application_version_supersessions")?.canonicalContent ?? "";
      expect(assetApplicationCollection).toContain(assetApplicationReference);
      expect(assetApplicationCollection).toContain(assetName);
      expect(assetApplicationCollection).toContain(amendedAssetName);
      expect(assetApplicationCollection).toContain(assetMaterialChange);
      expect(assetEvidenceCollection).toContain("requester-asset-v1.pdf");
      expect(assetEvidenceCollection).toContain("requester-asset-v2.pdf");
      expect(assetReviewCollection).toContain(requesterDiligenceResponse);
      expect(assetReviewCollection).toContain('"responseProvidedByRequester":true');
      expect(assetReviewCollection).toContain('"responseProvidedByRequester":false');
      expect(assetReviewCollection).not.toContain(otherActorResponseSecret);
      expect(approvedAssetCollection).toContain(assetApplicationReference);
      expect(approvedAssetCollection).toContain('"current":false');
      expect(approvedAssetCollection).toContain('"current":true');
      expect(assetSupersessionCollection).toContain('"participantSide":"both"');
      expect(assetSupersessionCollection).toContain('"supersededApplicationVersion":1');
      expect(assetSupersessionCollection).toContain('"replacementApplicationVersion":2');
      const publicationRequestCollection = sections.get("postgres.fractal.offering_publication_requests")?.canonicalContent ?? "";
      const publicationEvidenceCollection = sections.get("postgres.fractal.offering_publication_evidence_documents")?.canonicalContent ?? "";
      const offeringProductCollection = sections.get("postgres.fractal.offering_products")?.canonicalContent ?? "";
      const offeringVersionCollection = sections.get("postgres.fractal.offering_publication_versions")?.canonicalContent ?? "";
      expect(publicationRequestCollection).toContain(`PRIVACY-AGREEMENT-${marker}`);
      expect(publicationRequestCollection).toContain(publicationTerms.name);
      expect(publicationRequestCollection).toContain(publicationTerms.riskSummary);
      expect(publicationEvidenceCollection).toContain("requester-offering-agreement.pdf");
      expect(publicationEvidenceCollection).toContain("requester-offering-disclosure.pdf");
      expect(offeringProductCollection).toContain(`PRIVACY-AGREEMENT-${marker}`);
      expect(offeringVersionCollection).toContain(`PRIVACY-AGREEMENT-${marker}`);
      expect(publicationRequestCollection).not.toContain(otherPublicationReferenceSecret);
      expect(publicationEvidenceCollection).not.toContain("other-offering-agreement.pdf");
      const chainDeploymentCollection = sections.get("postgres.fractal.offering_chain_deployment_requests")?.canonicalContent ?? "";
      const issuanceTermsCollection = sections.get("postgres.fractal.offering_issuance_term_requests")?.canonicalContent ?? "";
      const offeringChainOperationCollection = sections.get("postgres.fractal.offering_chain_operations")?.canonicalContent ?? "";
      const offeringChainClaimCollection = sections.get("postgres.fractal.offering_chain_operation_dispatch_claims")?.canonicalContent ?? "";
      expect(chainDeploymentCollection).toContain(`Privacy Token ${marker}`);
      expect(chainDeploymentCollection).toContain(tokenFactoryAddress);
      expect(chainDeploymentCollection).not.toContain(otherChainTokenNameSecret);
      expect(chainDeploymentCollection).not.toContain(otherChainDecisionReasonSecret);
      expect(issuanceTermsCollection).toContain('"tokenUnitPriceMinor":"100"');
      expect(issuanceTermsCollection).not.toContain('"tokenUnitPriceMinor":"999"');
      expect(issuanceTermsCollection).not.toContain(allocationPolicyHashSecret);
      expect(issuanceTermsCollection).not.toContain(otherIssuancePolicyHashSecret);
      expect(issuanceTermsCollection).not.toContain(otherIssuanceDecisionSecret);
      expect(offeringChainOperationCollection).toContain(chainTransactionHash);
      expect(offeringChainOperationCollection).toContain(tokenContractAddress);
      expect(offeringChainClaimCollection).toContain(chainTransactionHash);
      expect(offeringChainClaimCollection).not.toContain(chainWorkerSecret);
      const walletChallengeCollection = sections.get("postgres.fractal.investor_wallet_link_challenges")?.canonicalContent ?? "";
      const walletCollection = sections.get("postgres.fractal.investor_wallets")?.canonicalContent ?? "";
      expect(walletChallengeCollection).toContain(requesterWalletAddress);
      expect(walletChallengeCollection).toContain("consumed");
      expect(walletCollection).toContain(requesterWalletAddress);
      expect(walletCollection).toContain("active");
      expect(walletChallengeCollection).not.toContain(otherRequesterWalletAddress);
      expect(walletCollection).not.toContain(otherRequesterWalletAddress);
      expect(canonicalCollection).not.toContain(requesterWalletMessageHashSecret);
      expect(canonicalCollection).not.toContain(requesterWalletSignatureHashSecret);
      expect(canonicalCollection).not.toContain(otherRequesterWalletMessageHashSecret);
      expect(canonicalCollection).not.toContain(otherRequesterWalletSignatureHashSecret);
      expect(canonicalCollection).not.toContain(requesterWalletChallengeId);
      expect(canonicalCollection).not.toContain(requesterWalletId);
      expect(canonicalCollection).not.toContain(otherRequesterWalletChallengeId);
      expect(canonicalCollection).not.toContain(otherRequesterWalletId);
      const complianceProfileCollection = sections.get("postgres.fractal.investor_compliance_profiles")?.canonicalContent ?? "";
      const complianceRequestCollection = sections.get("postgres.fractal.investor_compliance_review_requests")?.canonicalContent ?? "";
      const complianceReviewCollection = sections.get("postgres.fractal.investor_compliance_profile_reviews")?.canonicalContent ?? "";
      expect(complianceProfileCollection).toContain("sophisticated");
      expect(complianceProfileCollection).toContain("verified");
      expect(complianceProfileCollection).toContain("NG");
      expect(complianceRequestCollection).toContain("approved");
      expect(complianceReviewCollection).toContain("sophisticated");
      expect(complianceProfileCollection).not.toContain("GH");
      expect(complianceRequestCollection).not.toContain("GH");
      expect(complianceReviewCollection).not.toContain("GH");
      expect(canonicalCollection).not.toContain(requesterComplianceEvidenceSecret);
      expect(canonicalCollection).not.toContain(requesterComplianceDecisionSecret);
      expect(canonicalCollection).not.toContain(requesterComplianceSnapshotSecret);
      expect(canonicalCollection).not.toContain(otherRequesterComplianceEvidenceSecret);
      expect(canonicalCollection).not.toContain(otherRequesterComplianceDecisionSecret);
      expect(canonicalCollection).not.toContain(otherRequesterComplianceSnapshotSecret);
      expect(canonicalCollection).not.toContain(requesterComplianceRequestId);
      expect(canonicalCollection).not.toContain(requesterComplianceReviewId);
      expect(canonicalCollection).not.toContain(otherRequesterComplianceRequestId);
      expect(canonicalCollection).not.toContain(otherRequesterComplianceReviewId);
      const eligibilityCollection = sections.get("postgres.fractal.investment_eligibility_snapshots")?.canonicalContent ?? "";
      const commitmentCollection = sections.get("postgres.fractal.investment_commitments")?.canonicalContent ?? "";
      const reservationCollection = sections.get("postgres.fractal.investment_reservations")?.canonicalContent ?? "";
      expect(eligibilityCollection).toContain("requester_eligible");
      expect(commitmentCollection).toContain("123457");
      expect(reservationCollection).toContain("123457");
      expect(eligibilityCollection).not.toContain("other_requester_private_reason");
      expect(commitmentCollection).not.toContain("765431");
      expect(reservationCollection).not.toContain("765431");
      expect(canonicalCollection).not.toContain(requesterEligibilityPolicySecret);
      expect(canonicalCollection).not.toContain(requesterEligibilityEvidenceSecret);
      expect(canonicalCollection).not.toContain(otherRequesterEligibilityPolicySecret);
      expect(canonicalCollection).not.toContain(otherRequesterEligibilityEvidenceSecret);
      expect(canonicalCollection).not.toContain(requesterReservationCommandSecret);
      expect(canonicalCollection).not.toContain(otherRequesterReservationCommandSecret);
      expect(canonicalCollection).not.toContain(otherRequesterCommitmentReferenceSecret);
      expect(canonicalCollection).not.toContain(requesterEligibilitySnapshotId);
      expect(canonicalCollection).not.toContain(requesterCommitmentId);
      expect(canonicalCollection).not.toContain(requesterReservationId);
      const allocationCollection = sections.get("postgres.fractal.investment_allocation_requests")?.canonicalContent ?? "";
      const allocationOperationCollection = sections.get("postgres.fractal.investment_allocation_chain_operations")?.canonicalContent ?? "";
      const allocationClaimCollection = sections.get("postgres.fractal.investment_allocation_chain_dispatch_claims")?.canonicalContent ?? "";
      expect(allocationCollection).toContain("123457");
      expect(allocationOperationCollection).toContain(requesterAllocationTransactionHash);
      expect(allocationClaimCollection).toContain(requesterAllocationTransactionHash);
      expect(allocationCollection).not.toContain("765431");
      expect(allocationOperationCollection).not.toContain(otherRequesterAllocationTransactionHash);
      expect(allocationClaimCollection).not.toContain(otherRequesterAllocationTransactionHash);
      expect(canonicalCollection).not.toContain(allocationPolicyHashSecret);
      expect(canonicalCollection).not.toContain(allocationPolicyStorageSecret);
      expect(canonicalCollection).not.toContain(requesterAllocationComplianceSecret);
      expect(canonicalCollection).not.toContain(otherRequesterAllocationComplianceSecret);
      expect(canonicalCollection).not.toContain(requesterAllocationDecisionSecret);
      expect(canonicalCollection).not.toContain(requesterAllocationWorkerSecret);
      expect(canonicalCollection).not.toContain(otherRequesterAllocationWorkerSecret);
      expect(canonicalCollection).not.toContain(requesterAllocationId);
      expect(canonicalCollection).not.toContain(requesterAllocationOperationId);
      expect(canonicalCollection).not.toContain(requesterAllocationClaimId);
      const paymentIntentCollection = sections.get("postgres.fractal.payment_intents")?.canonicalContent ?? "";
      const paymentInstructionCollection = sections.get("postgres.fractal.payment_provider_instructions")?.canonicalContent ?? "";
      const paymentReceiptCollection = sections.get("postgres.fractal.payment_receipts")?.canonicalContent ?? "";
      const reconciliationCollection = sections.get("postgres.fractal.payment_reconciliation_cases")?.canonicalContent ?? "";
      expect(paymentIntentCollection).toContain("123457");
      expect(paymentInstructionCollection).toContain("paystack");
      expect(paymentReceiptCollection).toContain("123456");
      expect(reconciliationCollection).toContain("123456");
      expect(paymentIntentCollection).not.toContain("765431");
      expect(paymentReceiptCollection).not.toContain("765430");
      expect(canonicalCollection).not.toContain(requesterProviderReferenceSecret);
      expect(canonicalCollection).not.toContain(otherRequesterProviderReferenceSecret);
      expect(canonicalCollection).not.toContain(requesterCheckoutSecret);
      expect(canonicalCollection).not.toContain(requesterAccessCodeSecret);
      expect(canonicalCollection).not.toContain(requesterPaymentMetadataSecret);
      expect(canonicalCollection).not.toContain(requesterReceiptMetadataSecret);
      expect(canonicalCollection).not.toContain(requesterReconciliationDetailSecret);
      expect(canonicalCollection).not.toContain(requesterPaymentIntentId);
      expect(canonicalCollection).not.toContain(requesterPaymentReceiptId);
      expect(canonicalCollection).not.toContain(requesterReconciliationId);
      const journalCollection = sections.get("postgres.fractal.journal_entries")?.canonicalContent ?? "";
      const postingCollection = sections.get("postgres.fractal.journal_postings")?.canonicalContent ?? "";
      expect(journalCollection).toContain("PRIVACY-AGREEMENT");
      expect(postingCollection).toContain("345678");
      expect(postingCollection).toContain("debit");
      expect(postingCollection).toContain("credit");
      expect(postingCollection).not.toContain("876543");
      expect(canonicalCollection).not.toContain(accountCodeSecret);
      expect(canonicalCollection).not.toContain(escrowAccountCodeSecret);
      expect(canonicalCollection).not.toContain(accountNameSecret);
      expect(canonicalCollection).not.toContain(journalNarrativeSecret);
      expect(canonicalCollection).not.toContain(journalExternalReferenceSecret);
      expect(canonicalCollection).not.toContain(journalMetadataSecret);
      expect(canonicalCollection).not.toContain(requesterJournalId);
      expect(canonicalCollection).not.toContain(requesterAccountingReceiptId);
      expect(canonicalCollection).not.toContain(requesterAttachmentStorageSecret);
      expect(canonicalCollection).not.toContain(serviceAttachmentStorageSecret);
      expect(canonicalCollection).not.toContain(internalAttachmentStorageSecret);
      expect(canonicalCollection).not.toContain(requesterAttachmentCommandSecret);
      expect(canonicalCollection).not.toContain(serviceAttachmentCommandSecret);
      expect(canonicalCollection).not.toContain(internalAttachmentCommandSecret);
      expect(canonicalCollection).not.toContain(dispositionReasonSecret);
      expect(canonicalCollection).not.toContain(dispositionDecisionSecret);
      expect(canonicalCollection).not.toContain(internalDispositionDecisionSecret);
      expect(canonicalCollection).not.toContain(holdReleaseReasonSecret);
      expect(canonicalCollection).not.toContain(holdReleaseDecisionSecret);
      expect(canonicalCollection).not.toContain(requesterDisposition.request.id);
      expect(canonicalCollection).not.toContain(internalDisposition.request.id);
      expect(canonicalCollection).not.toContain(supportInternalNoteSecret);
      expect(canonicalCollection).not.toContain("Preserve identity-linked evidence while the regulator-requested record review remains active.");
      expect(canonicalCollection).not.toContain("The regulatory request is verified and requires preservation during the privacy review.");
      expect(canonicalCollection).not.toContain("regulatory_request");
      expect(canonicalCollection).not.toContain(organizationRegistrationSecret);
      expect(canonicalCollection).not.toContain(organizationAddressSecret);
      expect(canonicalCollection).not.toContain(invitationWorkerSecret);
      expect(canonicalCollection).not.toContain(invitationErrorSecret);
      expect(canonicalCollection).not.toContain(ownershipTransferReasonSecret);
      expect(canonicalCollection).not.toContain(otherOrganizationMembershipId);
      expect(canonicalCollection).not.toContain(verificationStorageSecret);
      expect(canonicalCollection).not.toContain(assetStorageSecret);
      expect(canonicalCollection).not.toContain(assetDecisionReasonSecret);
      expect(canonicalCollection).not.toContain(otherAssetReferenceSecret);
      expect(canonicalCollection).not.toContain(otherAssetNameSecret);
      expect(canonicalCollection).not.toContain(otherAssetSummarySecret);
      expect(canonicalCollection).not.toContain(otherAssetDecisionSecret);
      expect(canonicalCollection).not.toContain(otherActorResponseSecret);
      expect(canonicalCollection).not.toContain(assetReviewNotesSecret);
      expect(canonicalCollection).not.toContain("other-requester-asset.pdf");
      expect(canonicalCollection).not.toContain(publicationStorageSecret);
      expect(canonicalCollection).not.toContain(publicationDecisionReasonSecret);
      expect(canonicalCollection).not.toContain(publicationEligibilitySecret);
      expect(canonicalCollection).not.toContain(otherPublicationReferenceSecret);
      expect(canonicalCollection).not.toContain(otherPublicationNameSecret);
      expect(canonicalCollection).not.toContain(makerId);
      expect(canonicalCollection).not.toContain(checkerId);
      const governanceSections = await withPostgresTransaction((client) => collectCanonicalPrivacySourceSections(client, makerId, "access", contentProfile));
      const governanceCollection = [...governanceSections.values()].map((section) => section.canonicalContent).join("\n");
      const governanceEvidenceCollection = governanceSections.get("postgres.fractal.governance_evidence_documents")?.canonicalContent ?? "";
      const governanceAuditCollection = governanceSections.get("postgres.fractal.audit_events")?.canonicalContent ?? "";
      const governancePayoutProfileCollection = governanceSections.get("postgres.fractal.professional_payout_profile_versions")?.canonicalContent ?? "";
      const governanceTaxTreatmentCollection = governanceSections.get("postgres.fractal.professional_invoice_tax_treatments")?.canonicalContent ?? "";
      const governanceFinancePolicyCollection = governanceSections.get("postgres.fractal.professional_finance_approval_policies")?.canonicalContent ?? "";
      expect(governanceSections.size).toBe(142);
      expect(governanceCollection).toContain("INC-PRIVACY-COLLECTOR");
      expect(governanceCollection).toContain("audit_export");
      expect(governanceCollection).toContain("applicantReviewed");
      expect(governanceCollection).toContain("GREEN");
      expect(governanceCollection).toContain("sumsub");
      expect(governanceCollection).toContain("risk_global_public");
      expect(governanceCollection).toContain("proposer");
      expect(governanceCollection).toContain("privacy.rights.content_profile");
      expect(governanceCollection).toContain(providerIncidentKey);
      expect(governanceSections.get("postgres.fractal.administrator_provider_incidents")?.canonicalContent).toContain("creator");
      expect(governanceSections.get("postgres.fractal.administrator_provider_incident_events")?.canonicalContent).toContain("actor");
      expect(governanceEvidenceCollection).toContain("allocation-policy.pdf");
      expect(governanceEvidenceCollection).toContain('"mimeType":"application/pdf"');
      expect(governanceEvidenceCollection).not.toContain(allocationPolicyStorageSecret);
      expect(governanceEvidenceCollection).not.toContain(allocationPolicyHashSecret);
      expect(governanceEvidenceCollection).not.toContain('"filename":"other-allocation-policy.pdf"');
      expect(governanceAuditCollection).toContain(otherAuditActionSecret);
      expect(governanceAuditCollection).not.toContain("Other actor private audit reason");
      expect(governanceAuditCollection).not.toContain("other-actor-private-audit-payload");
      expect(governancePayoutProfileCollection).toContain('"participationRole":"verifier"');
      expect(governancePayoutProfileCollection).toContain('"rail":"bank_transfer"');
      expect(governancePayoutProfileCollection).toContain('"currency":"NGN"');
      expect(governancePayoutProfileCollection).not.toContain("Confidential professional settlement account");
      expect(governancePayoutProfileCollection).not.toContain("4821");
      expect(governancePayoutProfileCollection).not.toContain(professionalPayoutRecipientSecret);
      expect(governanceTaxTreatmentCollection).toContain('"participationRole":"preparer"');
      expect(governanceTaxTreatmentCollection).toContain('"status":"active"');
      expect(governanceTaxTreatmentCollection).not.toContain(professionalTaxLegalSourceSecret);
      expect(governanceTaxTreatmentCollection).not.toContain("professional_services");
      expect(governanceTaxTreatmentCollection).not.toContain("indirectTaxRateBps");
      expect(governanceTaxTreatmentCollection).not.toContain("withholdingTaxRateBps");
      expect(governanceFinancePolicyCollection).toContain('"participationRole":"preparer"');
      expect(governanceFinancePolicyCollection).toContain('"status":"active"');
      expect(governanceFinancePolicyCollection).not.toContain(professionalFinancePolicySecret);
      expect(governanceFinancePolicyCollection).not.toContain("maximumAmountMinor");
      expect(governanceFinancePolicyCollection).not.toContain("credit_note");
      expect(governanceCollection).not.toContain(configurationValueSecret);
      expect(governanceCollection).not.toContain(configurationReasonSecret);
      expect(governanceCollection).not.toContain(configurationDecisionSecret);
      expect(governanceCollection).not.toContain(accessChangeReason);
      expect(governanceCollection).not.toContain(capabilityChangeReason);
      expect(governanceCollection).not.toContain(recoveryReason);
      expect(governanceCollection).not.toContain(recoveryOperator);
      expect(governanceCollection).not.toContain(recoveryFingerprint);
      expect(governanceCollection).not.toContain(auditFilterSecret);
      expect(governanceCollection).not.toContain(auditContentSecret);
      expect(governanceCollection).not.toContain(checkerId);
      expect(governanceCollection).not.toContain(makerId);
      expect(governanceCollection).not.toContain(verificationWorkerSecret);
      expect(governanceCollection).not.toContain(verificationErrorSecret);
      expect(governanceCollection).not.toContain(verificationApplicantSecret);
      expect(governanceCollection).not.toContain(verificationEventSecret);
      expect(governanceCollection).not.toContain(verificationRejectSecret);
      expect(governanceCollection).not.toContain(verificationPayloadHash);
      expect(governanceCollection).not.toContain(legalContentSecret);
      expect(governanceCollection).not.toContain(legalChangeSummarySecret);
      expect(governanceCollection).not.toContain(legalDecisionReasonSecret);
      expect(governanceCollection).not.toContain(providerIncidentSummarySecret);
      expect(governanceCollection).not.toContain(providerIncidentImpactSecret);
      expect(governanceCollection).not.toContain(providerIncidentDetectionSecret);
      expect(governanceCollection).not.toContain(providerIncidentReasonSecret);
      expect(governanceCollection).not.toContain(supportSubject);
      expect(governanceCollection).not.toContain(supportDescription);
      expect(governanceCollection).not.toContain(supportRequesterMessage);
      expect(governanceCollection).not.toContain(supportVisibleReply);
      expect(governanceCollection).not.toContain(supportInternalNoteSecret);
      expect(governanceCollection).not.toContain(supportCase.case.reference);
      expect(governanceCollection).not.toContain(holdProposal.request.reference);
      expect(governanceCollection).not.toContain(requesterAttachmentFilename);
      expect(governanceCollection).not.toContain(serviceAttachmentFilename);
      expect(governanceCollection).not.toContain(internalAttachmentFilename);
      expect(governanceCollection).not.toContain(requesterWalletAddress);
      expect(governanceCollection).not.toContain(otherRequesterWalletAddress);
      expect(governanceCollection).not.toContain(requesterComplianceEvidenceSecret);
      expect(governanceCollection).not.toContain(otherRequesterComplianceEvidenceSecret);
      expect(governanceCollection).not.toContain("requester_eligible");
      expect(governanceCollection).not.toContain("123457");
      const checkerProviderSections = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, checkerId, "access", contentProfile));
      const checkerProviderCollection = [
        checkerProviderSections.get("postgres.fractal.administrator_provider_incidents")?.canonicalContent ?? "",
        checkerProviderSections.get("postgres.fractal.administrator_provider_incident_events")?.canonicalContent ?? "",
      ].join("\n");
      const checkerTaxTreatmentCollection = checkerProviderSections.get("postgres.fractal.professional_invoice_tax_treatments")?.canonicalContent ?? "";
      const checkerFinancePolicyCollection = checkerProviderSections.get("postgres.fractal.professional_finance_approval_policies")?.canonicalContent ?? "";
      const checkerPayoutProfileCollection = checkerProviderSections.get("postgres.fractal.professional_payout_profile_versions")?.canonicalContent ?? "";
      expect(checkerProviderCollection).toContain(providerIncidentKey);
      expect(checkerProviderSections.get("postgres.fractal.administrator_provider_incidents")?.canonicalContent).toContain("current_owner");
      expect(checkerProviderSections.get("postgres.fractal.administrator_provider_incident_events")?.canonicalContent).toContain("owner");
      expect(checkerProviderCollection).not.toContain(providerIncidentSummarySecret);
      expect(checkerProviderCollection).not.toContain(providerIncidentImpactSecret);
      expect(checkerProviderCollection).not.toContain(providerIncidentDetectionSecret);
      expect(checkerProviderCollection).not.toContain(providerIncidentReasonSecret);
      expect(checkerProviderCollection).not.toContain(makerId);
      expect(checkerProviderCollection).not.toContain(checkerId);
      expect(checkerTaxTreatmentCollection).toContain('"participationRole":"approver"');
      expect(checkerTaxTreatmentCollection).not.toContain(professionalTaxLegalSourceSecret);
      expect(checkerFinancePolicyCollection).toContain('"participationRole":"approver"');
      expect(checkerFinancePolicyCollection).not.toContain(professionalFinancePolicySecret);
      expect(checkerPayoutProfileCollection).toContain('"records":[]');
      expect(checkerPayoutProfileCollection).not.toContain("Confidential professional settlement account");
      const portableSections = await withPostgresTransaction((client) => collectCanonicalPrivacySourceSections(client, requesterId, "portability", contentProfile));
      expect(portableSections.size).toBe(24);
      expect(portableSections.get("postgres.fractal.organization_beneficial_owner_declarations")?.canonicalContent).toContain(requesterBeneficialOwnerName);
      expect(portableSections.get("postgres.fractal.organization_beneficial_owner_declarations")?.canonicalContent).not.toContain(unlinkedBeneficialOwnerSecret);
      expect(portableSections.get("postgres.fractal.agreement_acceptances")?.canonicalContent).toContain(agreementSignature);
      expect(portableSections.get("postgres.fractal.agreement_acceptances")?.canonicalContent).not.toContain(agreementExecutionHash);
      expect(portableSections.has("postgres.fractal.platform_content_events")).toBe(false);
      expect(portableSections.has("postgres.fractal.platform_content_publications")).toBe(false);
      expect(portableSections.has("postgres.fractal.platform_content_versions")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_case_events")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_case_attachment_access_events")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_case_attachments")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_attachment_disposition_requests")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_attachment_dispositions")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_firm_profiles")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_firm_memberships")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_work_orders")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_work_order_assignments")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_deliverable_versions")).toBe(true);
      expect(portableSections.has("postgres.fractal.professional_deliverable_evidence_documents")).toBe(true);
      expect(portableSections.has("postgres.fractal.professional_deliverable_version_documents")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_invoices")).toBe(true);
      expect(portableSections.has("postgres.fractal.investor_wallet_link_challenges")).toBe(false);
      expect(portableSections.has("postgres.fractal.investor_compliance_profile_reviews")).toBe(false);
      expect(portableSections.has("postgres.fractal.investor_compliance_profiles")).toBe(false);
      expect(portableSections.has("postgres.fractal.investor_compliance_review_requests")).toBe(false);
      expect(portableSections.has("postgres.fractal.investment_eligibility_snapshots")).toBe(false);
      expect(portableSections.has("postgres.fractal.investment_commitments")).toBe(false);
      expect(portableSections.has("postgres.fractal.investment_allocation_requests")).toBe(false);
      expect(portableSections.has("postgres.fractal.investment_allocation_chain_operations")).toBe(false);
      expect(portableSections.has("postgres.fractal.investment_allocation_chain_dispatch_claims")).toBe(false);
      expect(portableSections.has("postgres.fractal.payment_intents")).toBe(false);
      expect(portableSections.has("postgres.fractal.payment_provider_instructions")).toBe(false);
      expect(portableSections.has("postgres.fractal.payment_receipts")).toBe(false);
      expect(portableSections.has("postgres.fractal.payment_reconciliation_cases")).toBe(false);
      expect(portableSections.has("postgres.fractal.journal_entries")).toBe(false);
      expect(portableSections.has("postgres.fractal.journal_postings")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_case_service_obligations")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_case_service_events")).toBe(false);
      expect(portableSections.has("postgres.fractal.support_case_notification_deliveries")).toBe(false);
      expect(portableSections.has("postgres.fractal.data_legal_hold_change_requests")).toBe(false);
      expect(portableSections.has("postgres.fractal.data_legal_holds")).toBe(false);
      expect(portableSections.has("postgres.fractal.organizations")).toBe(false);
      expect(portableSections.has("postgres.fractal.organization_memberships")).toBe(false);
      expect(portableSections.has("postgres.fractal.organization_invitations")).toBe(false);
      expect(portableSections.has("postgres.fractal.organization_ownership_transfer_requests")).toBe(false);
      expect(portableSections.has("postgres.fractal.organization_verification_evidence_documents")).toBe(false);
      expect(portableSections.has("postgres.fractal.organization_verification_request_evidence")).toBe(false);
      expect(portableSections.get("postgres.fractal.organization_verification_requests")?.canonicalContent).toContain(verificationRegistrationNumber);
      expect(portableSections.get("postgres.fractal.organization_verification_requests")?.canonicalContent).toContain(verificationAddressLine);
      expect(portableSections.get("postgres.fractal.organization_verification_requests")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.get("postgres.fractal.organization_verification_requests")?.canonicalContent).not.toContain('"createdAt"');
      expect(portableSections.has("postgres.fractal.asset_application_evidence_documents")).toBe(false);
      expect(portableSections.has("postgres.fractal.asset_application_review_items")).toBe(false);
      expect(portableSections.has("postgres.fractal.approved_asset_application_versions")).toBe(false);
      expect(portableSections.has("postgres.fractal.asset_application_version_supersessions")).toBe(false);
      expect(portableSections.get("postgres.fractal.asset_application_requests")?.canonicalContent).toContain(assetApplicationReference);
      expect(portableSections.get("postgres.fractal.asset_application_requests")?.canonicalContent).toContain(assetMaterialChange);
      expect(portableSections.get("postgres.fractal.asset_application_requests")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.get("postgres.fractal.asset_application_requests")?.canonicalContent).not.toContain('"createdAt"');
      expect(portableSections.get("postgres.fractal.asset_application_requests")?.canonicalContent).not.toContain(otherAssetReferenceSecret);
      expect(portableSections.has("postgres.fractal.offering_publication_evidence_documents")).toBe(false);
      expect(portableSections.has("postgres.fractal.offering_products")).toBe(false);
      expect(portableSections.has("postgres.fractal.offering_publication_versions")).toBe(false);
      expect(portableSections.get("postgres.fractal.offering_publication_requests")?.canonicalContent).toContain(publicationTerms.name);
      expect(portableSections.get("postgres.fractal.offering_publication_requests")?.canonicalContent).toContain(publicationTerms.riskSummary);
      expect(portableSections.get("postgres.fractal.offering_publication_requests")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.get("postgres.fractal.offering_publication_requests")?.canonicalContent).not.toContain('"createdAt"');
      expect(portableSections.get("postgres.fractal.offering_publication_requests")?.canonicalContent).not.toContain(otherPublicationReferenceSecret);
      expect(portableSections.get("postgres.fractal.offering_chain_deployment_requests")?.canonicalContent).toContain(`Privacy Token ${marker}`);
      expect(portableSections.get("postgres.fractal.offering_chain_deployment_requests")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.get("postgres.fractal.offering_chain_deployment_requests")?.canonicalContent).not.toContain(otherChainTokenNameSecret);
      expect(portableSections.get("postgres.fractal.offering_issuance_term_requests")?.canonicalContent).toContain('"tokenUnitPriceMinor":"100"');
      expect(portableSections.get("postgres.fractal.offering_issuance_term_requests")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.has("postgres.fractal.offering_chain_operations")).toBe(false);
      expect(portableSections.has("postgres.fractal.offering_chain_operation_dispatch_claims")).toBe(false);
      expect(portableSections.get("postgres.fractal.investment_reservations")?.canonicalContent).toContain("123457");
      expect(portableSections.get("postgres.fractal.investment_reservations")?.canonicalContent).not.toContain("765431");
      expect(portableSections.get("postgres.fractal.investment_reservations")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.get("postgres.fractal.investment_reservations")?.canonicalContent).not.toContain('"expiresAt"');
      expect(portableSections.get("postgres.fractal.investor_wallets")?.canonicalContent).toContain(requesterWalletAddress);
      expect(portableSections.get("postgres.fractal.investor_wallets")?.canonicalContent).not.toContain(requesterWalletSignatureHashSecret);
      expect(portableSections.get("postgres.fractal.investor_wallets")?.canonicalContent).not.toContain(otherRequesterWalletAddress);
      expect(portableSections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportSubject);
      expect(portableSections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportDescription);
      expect(portableSections.get("postgres.fractal.support_cases")?.canonicalContent).toContain(supportRelatedReference);
      expect(portableSections.get("postgres.fractal.support_cases")?.canonicalContent).not.toContain(supportCase.case.reference);
      expect(portableSections.get("postgres.fractal.support_cases")?.canonicalContent).not.toContain('"status"');
      expect(portableSections.has("postgres.fractal.professional_payout_instructions")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_invoice_credit_notes")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_finance_exception_cases")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_work_order_conflicts")).toBe(true);
      expect(portableSections.has("postgres.fractal.professional_finance_exception_evidence")).toBe(true);
      expect(portableSections.has("postgres.fractal.professional_work_order_events")).toBe(false);
      expect(portableSections.has("postgres.fractal.governance_evidence_documents")).toBe(true);
      expect(portableSections.has("postgres.fractal.audit_events")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_payout_profile_versions")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_invoice_tax_treatments")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_finance_approval_policies")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_payout_recipient_recovery_cases")).toBe(false);
      expect(portableSections.has("postgres.fractal.professional_replacement_payout_requests")).toBe(false);

      const professionalPortableSections = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, otherRequesterId, "portability", contentProfile));
      const professionalPortableDeliverableCollection = professionalPortableSections.get("postgres.fractal.professional_deliverable_versions")?.canonicalContent ?? "";
      const professionalPortableEvidenceCollection = professionalPortableSections.get("postgres.fractal.professional_deliverable_evidence_documents")?.canonicalContent ?? "";
      const professionalPortableInvoiceCollection = professionalPortableSections.get("postgres.fractal.professional_invoices")?.canonicalContent ?? "";
      const professionalPortableConflictCollection = professionalPortableSections.get("postgres.fractal.professional_work_order_conflicts")?.canonicalContent ?? "";
      const professionalPortableFinanceEvidenceCollection = professionalPortableSections.get("postgres.fractal.professional_finance_exception_evidence")?.canonicalContent ?? "";
      const professionalPortableGovernanceEvidenceCollection = professionalPortableSections.get("postgres.fractal.governance_evidence_documents")?.canonicalContent ?? "";
      expect(professionalPortableSections.size).toBe(24);
      expect(professionalPortableSections.get("postgres.fractal.organization_beneficial_owner_declarations")?.canonicalContent).toContain('"records":[]');
      expect(professionalPortableDeliverableCollection).toContain(professionalWorkOrderReference);
      expect(professionalPortableDeliverableCollection).toContain(professionalDeliverableTitle);
      expect(professionalPortableDeliverableCollection).toContain(professionalDeliverableSummary);
      expect(professionalPortableEvidenceCollection).toContain(professionalEvidenceFilename);
      expect(professionalPortableEvidenceCollection).toContain(professionalEvidenceDigest);
      expect(professionalPortableEvidenceCollection).not.toContain(professionalEvidenceStorageSecret);
      expect(professionalPortableEvidenceCollection).not.toContain(otherProfessionalEvidenceFilenameSecret);
      expect(professionalPortableEvidenceCollection).not.toContain(otherProfessionalEvidenceDigestSecret);
      expect(professionalPortableEvidenceCollection).not.toContain(otherProfessionalEvidenceStorageSecret);
      expect(professionalPortableSections.has("postgres.fractal.professional_deliverable_version_documents")).toBe(false);
      expect(professionalPortableInvoiceCollection).toContain(professionalInvoiceReference);
      expect(professionalPortableInvoiceCollection).toContain(professionalWorkOrderReference);
      expect(professionalPortableInvoiceCollection).toContain(professionalDeliverableTitle);
      expect(professionalPortableInvoiceCollection).not.toContain('"grossMinor"');
      expect(professionalPortableInvoiceCollection).not.toContain('"taxMinor"');
      expect(professionalPortableInvoiceCollection).not.toContain('"withholdingTaxMinor"');
      expect(professionalPortableInvoiceCollection).not.toContain('"netPayableMinor"');
      expect(professionalPortableInvoiceCollection).not.toContain('"status"');
      expect(professionalPortableInvoiceCollection).not.toContain(professionalPayoutRecipientSecret);
      expect(professionalPortableInvoiceCollection).not.toContain(professionalTaxLegalSourceSecret);
      expect(professionalPortableConflictCollection).toContain(professionalWorkOrderReference);
      expect(professionalPortableConflictCollection).toContain('"declaration":"no_conflict"');
      expect(professionalPortableFinanceEvidenceCollection).not.toContain(professionalFinanceEvidenceFilenameSecret);
      expect(professionalPortableGovernanceEvidenceCollection).toContain("other-allocation-policy.pdf");
      expect(professionalPortableGovernanceEvidenceCollection).not.toContain(otherIssuancePolicyHashSecret);
      expect(professionalPortableSections.has("postgres.fractal.professional_payout_instructions")).toBe(false);
      expect(professionalPortableSections.has("postgres.fractal.professional_invoice_credit_notes")).toBe(false);
      expect(professionalPortableSections.has("postgres.fractal.professional_finance_exception_cases")).toBe(false);
      expect(professionalPortableSections.has("postgres.fractal.professional_work_order_events")).toBe(false);
      const checkerPortableSections = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, checkerId, "portability", contentProfile));
      const checkerPortableFinanceEvidenceCollection = checkerPortableSections.get("postgres.fractal.professional_finance_exception_evidence")?.canonicalContent ?? "";
      expect(checkerPortableFinanceEvidenceCollection).toContain(professionalFinanceEvidenceFilenameSecret);
      expect(checkerPortableFinanceEvidenceCollection).not.toContain(professionalFinanceEvidenceStorageSecret);
      expect(checkerPortableFinanceEvidenceCollection).not.toContain(professionalFinanceEvidenceDigestSecret);
      const governancePortableSections = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, makerId, "portability", contentProfile));
      const governancePortableEvidenceCollection = governancePortableSections.get("postgres.fractal.governance_evidence_documents")?.canonicalContent ?? "";
      expect(governancePortableEvidenceCollection).toContain("allocation-policy.pdf");
      expect(governancePortableEvidenceCollection).not.toContain(allocationPolicyStorageSecret);
      expect(governancePortableEvidenceCollection).not.toContain(allocationPolicyHashSecret);

      const packageAccess = await createPrivacyRightsRequest({
        actorIdentityId: requesterId, requestType: "access",
        details: "Please provide the eligible personal information connected to this account through the governed access process.", commandKey: randomUUID(),
      });
      await transitionAdministratorPrivacyRightsRequest({
        actorIdentityId: makerId, requestId: packageAccess.request.id, action: "begin_review",
        message: "Review the access scope against approved canonical collectors and all documented source gaps.", expectedVersion: 1,
      });
      const packageAccessDecision = await proposePrivacyRightsDecision({
        actorIdentityId: makerId, requestId: packageAccess.request.id, outcome: "approve",
        decisionSummary: "Provide eligible records only after canonical collection evidence and full delivery controls are proven.",
        lawfulBasis: "Authenticated access processing is approved while incomplete source coverage continues to block delivery.",
        scopeOutcomes: [{ category: "eligible_account_records", action: "provide", explanation: "Eligible account records may be canonically collected, subject to complete coverage and delivery controls." }],
        commandKey: randomUUID(),
      });
      await decidePrivacyRightsDecision({
        actorIdentityId: checkerId, decisionRequestId: packageAccessDecision.decision.id, decision: "approve",
        reviewReason: "The providing scope is precise and does not misrepresent incomplete collection as requester delivery.",
      });
      const preparationCommand = randomUUID();
      await expect(preparePrivacyRightsPackageEvidence({
        actorIdentityId: otherRequesterId, requestId: packageAccess.request.id, expectedVersion: 4, commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "forbidden" });
      const prepared = await preparePrivacyRightsPackageEvidence({
        actorIdentityId: makerId, requestId: packageAccess.request.id, expectedVersion: 4, commandKey: preparationCommand,
      });
      expect(prepared).toMatchObject({
        replayed: false,
        preparation: {
          requestType: "access", requestVersion: 4, outcome: "blocked_incomplete_coverage", deliverable: false,
          collectedSourceCount: 142, unavailableSourceCount: expect.any(Number), collectedRecordCount: expect.any(Number),
          policy: { reference: "PRIV-PACK-NG-001" },
          contentProfile: { reference: "PRIV-CONTENT-NG-001", schemaVersion: "privacy-content-profile-v1", fieldCatalogVersion: "privacy-safe-fields-v45", jurisdictionCode: "NG" },
        },
      });
      expect(prepared.preparation.unavailableSourceCount).toBe(11);
      expect(prepared.preparation.notApplicableSourceCount).toBe(8);
      const storedManifest = await postgresQuery<{ source_manifest: Array<{ status: string; recordCount: number; byteCount: number }> }>(
        "SELECT source_manifest FROM fractal.privacy_rights_package_preparations WHERE id=$1",
        [prepared.preparation.id],
      );
      expect(storedManifest.rows[0]!.source_manifest).toHaveLength(161);
      expect(storedManifest.rows[0]!.source_manifest.filter((source) => source.status === "collected")).toHaveLength(142);
      expect(storedManifest.rows[0]!.source_manifest.reduce((sum, source) => sum + source.recordCount, 0)).toBe(prepared.preparation.collectedRecordCount);
      expect(storedManifest.rows[0]!.source_manifest.reduce((sum, source) => sum + source.byteCount, 0)).toBe(prepared.preparation.collectedByteCount);
      const forgedAggregate = await postgresQuery<{ valid: boolean }>(
        `SELECT fractal.privacy_package_manifest_counts_match(
           source_manifest,collected_source_count,unavailable_source_count,not_applicable_source_count,
           collected_record_count,collected_byte_count+1
         ) AS valid
         FROM fractal.privacy_rights_package_preparations WHERE id=$1`,
        [prepared.preparation.id],
      );
      expect(forgedAggregate.rows).toEqual([{ valid: false }]);
      expect(JSON.stringify(prepared.preparation)).not.toContain("canonicalContent");
      expect(JSON.stringify(prepared.preparation)).not.toContain('"sourceManifest":');
      expect(JSON.stringify(prepared.preparation)).not.toContain("transactionSnapshot");
      expect(JSON.stringify(prepared.preparation)).not.toContain("preparedByIdentityId");
      const preparationInternals = await postgresQuery<{
        source_manifest_sha256: string; coverage_sha256: string; transaction_snapshot: string; command_key: string;
      }>(
        `SELECT source_manifest_sha256,coverage_sha256,transaction_snapshot,command_key
           FROM fractal.privacy_rights_package_preparations WHERE id=$1`,
        [prepared.preparation.id],
      );
      const subsequentCollection = await withPostgresTransaction((client) =>
        collectCanonicalPrivacySourceSections(client, requesterId, "access", contentProfile));
      const preparationSection = subsequentCollection.get("postgres.fractal.privacy_rights_package_preparations");
      expect(preparationSection?.records).toHaveLength(1);
      expect(preparationSection?.canonicalContent).toContain(prepared.preparation.reference);
      expect(preparationSection?.canonicalContent).toContain("blocked_incomplete_coverage");
      expect(preparationSection?.canonicalContent).not.toContain(preparationInternals.rows[0]!.source_manifest_sha256);
      expect(preparationSection?.canonicalContent).not.toContain(preparationInternals.rows[0]!.coverage_sha256);
      expect(preparationSection?.canonicalContent).not.toContain(preparationInternals.rows[0]!.transaction_snapshot);
      expect(preparationSection?.canonicalContent).not.toContain(preparationInternals.rows[0]!.command_key);
      expect(preparationSection?.canonicalContent).not.toContain(makerId);
      await expect(preparePrivacyRightsPackageEvidence({
        actorIdentityId: makerId, requestId: packageAccess.request.id, expectedVersion: 4, commandKey: preparationCommand,
      })).resolves.toMatchObject({ replayed: true, preparation: { id: prepared.preparation.id } });
      await expect(listPrivacyRightsPackagePreparations({
        actorIdentityId: requesterId, requestId: packageAccess.request.id, administrator: false,
      })).resolves.toEqual([expect.objectContaining({ id: prepared.preparation.id, deliverable: false })]);
      await expect(requestPrivacyPackageDelivery({
        actorIdentityId: requesterId, preparationId: prepared.preparation.id, commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "forbidden" });
      await expect(requestPrivacyPackageDelivery({
        actorIdentityId: checkerId, preparationId: prepared.preparation.id, commandKey: randomUUID(),
      })).rejects.toMatchObject({ code: "conflict", message: "This preparation has incomplete coverage and cannot be delivered." });
      const deliveryEvidence = await postgresQuery<{ deliveries: string; access_events: string }>(
        `SELECT
           (SELECT count(*)::text FROM fractal.privacy_rights_package_deliveries WHERE privacy_request_id=$1) AS deliveries,
           (SELECT count(*)::text FROM fractal.privacy_rights_package_access_events WHERE privacy_request_id=$1) AS access_events`,
        [packageAccess.request.id],
      );
      expect(deliveryEvidence.rows).toEqual([{ deliveries: "0", access_events: "0" }]);
      await expect(postgresQuery(
        "UPDATE fractal.privacy_rights_package_preparations SET deliverable=true WHERE id=$1",
        [prepared.preparation.id],
      )).rejects.toThrow("privacy rights evidence is immutable");
      await expect(postgresQuery(
        `INSERT INTO fractal.privacy_rights_package_preparations
         SELECT (jsonb_populate_record(
           NULL::fractal.privacy_rights_package_preparations,
           to_jsonb(source) || jsonb_build_object(
             'id',$2::uuid,'reference',$3::text,'command_key',$4::text,'prepared_by_identity_id',$5::uuid,
             'content_profile_value_sha256',NULL::text
           )
         )).*
         FROM fractal.privacy_rights_package_preparations source WHERE id=$1`,
        [prepared.preparation.id, randomUUID(), `PRP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, randomUUID(), checkerId],
      )).rejects.toThrow("exact active approved content profile");
      await expect(postgresQuery(
        `INSERT INTO fractal.privacy_rights_package_preparations
         SELECT (jsonb_populate_record(
           NULL::fractal.privacy_rights_package_preparations,
           to_jsonb(source) || jsonb_build_object(
             'id',$2::uuid,'reference',$3::text,'command_key',$4::text,'prepared_by_identity_id',$5::uuid,
             'source_manifest',source.source_manifest-0,
             'unavailable_source_count',source.unavailable_source_count-1
           )
         )).*
         FROM fractal.privacy_rights_package_preparations source WHERE id=$1`,
        [prepared.preparation.id, randomUUID(), `PRP-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`, randomUUID(), checkerId],
      )).rejects.toThrow("must exactly represent the migration-owned source inventory");

      // Exercise the otherwise dormant positive lifecycle against a reversible test-only
      // zero-gap inventory. Production keeps these sources unavailable until their owners
      // provide real adapters and attestations; the fixture never changes that product claim.
      const unavailableInventory = await postgresQuery<{
        source_key: string; authority_key: string; subject_linkage: string; inventory_status: string; access_status: string; portability_status: string;
        correction_status: string; erasure_status: string; restriction_status: string; objection_status: string;
        retention_policy_status: string; hold_coverage_status: string; blocker: string;
      }>(
        `SELECT source_key,authority_key,subject_linkage,inventory_status,access_status,portability_status,correction_status,erasure_status,
                restriction_status,objection_status,retention_policy_status,hold_coverage_status,blocker
           FROM fractal.privacy_data_sources WHERE contains_personal_data AND access_status='unavailable' ORDER BY source_key`,
      );
      expect(unavailableInventory.rows).toHaveLength(11);
      const unavailableSourceKeys = unavailableInventory.rows.map((row) => row.source_key);
      const affectedAuthorityKeys = [...new Set(unavailableInventory.rows.map((row) => row.authority_key))];
      const affectedAuthorities = await postgresQuery<{ authority_key: string; rights_applicability: string[]; blocker: string }>(
        "SELECT authority_key,rights_applicability,blocker FROM fractal.privacy_data_authorities WHERE authority_key=ANY($1::text[]) ORDER BY authority_key",
        [affectedAuthorityKeys],
      );
      await postgresQuery("ALTER TABLE fractal.privacy_data_sources DISABLE TRIGGER privacy_data_sources_immutable");
      await postgresQuery("ALTER TABLE fractal.privacy_data_authorities DISABLE TRIGGER privacy_data_authorities_immutable");
      try {
        await postgresQuery(`UPDATE fractal.privacy_data_sources SET contains_personal_data=false,subject_linkage='technical_no_subject',inventory_status='catalogued',
          access_status='not_applicable',portability_status='not_applicable',correction_status='not_applicable',erasure_status='not_applicable',
          restriction_status='not_applicable',objection_status='not_applicable',retention_policy_status='not_applicable',hold_coverage_status='not_applicable',blocker=NULL
          WHERE source_key=ANY($1::text[])`, [unavailableSourceKeys]);
        await postgresQuery("UPDATE fractal.privacy_data_authorities SET contains_personal_data=false,rights_applicability=ARRAY[]::text[],blocker=NULL WHERE authority_key=ANY($1::text[])", [affectedAuthorityKeys]);
        const completeAccess = await createPrivacyRightsRequest({
          actorIdentityId: otherRequesterId,
          requestType: "access",
          details: "Please provide the eligible personal information connected to this account under the current complete test inventory.",
          commandKey: randomUUID(),
        });
        await transitionAdministratorPrivacyRightsRequest({
          actorIdentityId: makerId,
          requestId: completeAccess.request.id,
          action: "begin_review",
          message: "Review the complete test inventory before any package preparation or delivery.",
          expectedVersion: 1,
        });
        const completeDecision = await proposePrivacyRightsDecision({
          actorIdentityId: makerId,
          requestId: completeAccess.request.id,
          outcome: "approve",
          decisionSummary: "Provide the eligible records because the exact current test inventory has complete collection coverage.",
          lawfulBasis: "Authenticated access processing is approved under the complete current test inventory and package controls.",
          scopeOutcomes: [{
            category: "eligible_account_records",
            action: "provide",
            explanation: "The exact current test inventory supports canonical collection and controlled package delivery.",
          }],
          commandKey: randomUUID(),
        });
        await decidePrivacyRightsDecision({
          actorIdentityId: checkerId,
          decisionRequestId: completeDecision.decision.id,
          decision: "approve",
          reviewReason: "The exact complete coverage snapshot supports the bounded providing decision.",
        });
        const completePreparation = await preparePrivacyRightsPackageEvidence({
          actorIdentityId: makerId, requestId: completeAccess.request.id, expectedVersion: 4, commandKey: randomUUID(),
        });
        expect(completePreparation.preparation).toMatchObject({
          outcome: "ready_for_delivery", deliverable: true, collectedSourceCount: 142, unavailableSourceCount: 0,
          notApplicableSourceCount: 19, coverageSnapshot: { complete: true, executionAvailable: true },
        });
        await expect(requestPrivacyPackageDelivery({
          actorIdentityId: makerId, preparationId: completePreparation.preparation.id, commandKey: randomUUID(),
        })).rejects.toMatchObject({ code: "conflict", message: "A different capable administrator must authorize package delivery." });
        const deliveryCommand = randomUUID();
        const queued = await requestPrivacyPackageDelivery({
          actorIdentityId: checkerId, preparationId: completePreparation.preparation.id, commandKey: deliveryCommand,
        });
        expect(queued).toMatchObject({ replayed: false, delivery: { status: "queued", preparationId: completePreparation.preparation.id } });
        await expect(requestPrivacyPackageDelivery({
          actorIdentityId: checkerId, preparationId: completePreparation.preparation.id, commandKey: deliveryCommand,
        })).resolves.toMatchObject({ replayed: true, delivery: { id: queued.delivery.id } });
        const completeManifest = await postgresQuery<{ source_manifest: Array<{ sourceKey: string; status: string; contentSha256: string | null; recordCount: number; byteCount: number }> }>(
          "SELECT source_manifest FROM fractal.privacy_rights_package_preparations WHERE id=$1",
          [completePreparation.preparation.id],
        );
        const deliveryRecollection = await withPostgresTransaction((client) => collectCanonicalPrivacySourceSections(
          client, otherRequesterId, "access", contentProfile, {
            excludePrivacyPackagePreparationId: completePreparation.preparation.id,
            excludePrivacyPackageDeliveryId: queued.delivery.id,
          },
        ));
        const mismatchedDeliverySources = completeManifest.rows[0]!.source_manifest.filter((source) => {
          if (source.status !== "collected") return false;
          const recollected = deliveryRecollection.get(source.sourceKey);
          return !recollected || recollected.contentSha256 !== source.contentSha256
            || recollected.records.length !== source.recordCount || recollected.byteCount !== source.byteCount;
        }).map((source) => source.sourceKey);
        expect(mismatchedDeliverySources).toEqual([]);
        await expect(materializeOnePrivacyPackage({ workerId: "privacy-package-test" })).resolves.toBe(true);
        await expect(listOwnPrivacyPackageDeliveries({ actorIdentityId: otherRequesterId, privacyRequestId: completeAccess.request.id }))
          .resolves.toContainEqual(expect.objectContaining({ id: queued.delivery.id, status: "available", contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }));
        await expect(downloadOwnPrivacyPackage({ actorIdentityId: requesterId, deliveryId: queued.delivery.id }))
          .rejects.toMatchObject({ code: "not_found" });
        const downloaded = await downloadOwnPrivacyPackage({ actorIdentityId: otherRequesterId, deliveryId: queued.delivery.id });
        expect(downloaded.buffer.byteLength).toBe(downloaded.delivery.byteCount);
        expect(createHash("sha256").update(downloaded.buffer).digest("hex")).toBe(downloaded.delivery.contentSha256);
        const packageDocument = parsePrivacyPackageArchiveV2(downloaded.buffer).packageDocument as {
          deliveryReference: string; sections: Array<{ sourceKey: string; records: Array<{ reference?: string }> }>;
        };
        expect(packageDocument.deliveryReference).toBe(queued.delivery.reference);
        expect(packageDocument.sections.find((section) => section.sourceKey === "postgres.fractal.privacy_rights_package_deliveries")?.records)
          .not.toContainEqual(expect.objectContaining({ reference: queued.delivery.reference }));
        const accessEvidence = await postgresQuery<{ count: string }>(
          "SELECT count(*)::text AS count FROM fractal.privacy_rights_package_access_events WHERE delivery_id=$1 AND requester_identity_id=$2 AND accessed_by_identity_id=$2",
          [queued.delivery.id, otherRequesterId],
        );
        expect(accessEvidence.rows).toEqual([{ count: "1" }]);
        const retrievalElapsed = new Date(new Date(queued.delivery.retrievalExpiresAt).getTime() + 1_000);
        await expect(expireAndQueuePrivacyPackageCleanup(retrievalElapsed)).resolves.toEqual({ expired: 1, cleanupQueued: 0 });
        await expect(listOwnPrivacyPackageDeliveries({ actorIdentityId: otherRequesterId, privacyRequestId: completeAccess.request.id }))
          .resolves.toContainEqual(expect.objectContaining({ id: queued.delivery.id, status: "expired", expiredAt: expect.any(String) }));
        await expect(downloadOwnPrivacyPackage({ actorIdentityId: otherRequesterId, deliveryId: queued.delivery.id }))
          .rejects.toMatchObject({ code: "conflict" });
        const retentionElapsed = new Date(new Date(queued.delivery.retainUntil).getTime() + 1_000);
        await expect(expireAndQueuePrivacyPackageCleanup(retentionElapsed)).resolves.toMatchObject({ cleanupQueued: 1 });
        await dispatchPendingStorageCleanupTasks({ workerId: "privacy-package-cleanup-test", logger: { info: () => undefined, error: () => undefined } });
        await expect(listOwnPrivacyPackageDeliveries({ actorIdentityId: otherRequesterId, privacyRequestId: completeAccess.request.id }))
          .resolves.toContainEqual(expect.objectContaining({ id: queued.delivery.id, status: "destroyed", destroyedAt: expect.any(String) }));
        await expect(downloadOwnPrivacyPackage({ actorIdentityId: otherRequesterId, deliveryId: queued.delivery.id }))
          .rejects.toMatchObject({ code: "conflict" });
        const deliveryAudit = await postgresQuery<{ action: string }>(
          "SELECT action FROM fractal.audit_events WHERE scope_key=$1 AND action LIKE 'privacy.request.package_%' ORDER BY sequence",
          [`privacy-request:${completeAccess.request.id}`],
        );
        expect(deliveryAudit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
          "privacy.request.package_delivery_requested", "privacy.request.package_delivery_available",
          "privacy.request.package_downloaded", "privacy.request.package_delivery_expired",
          "privacy.request.package_delivery_cleanup_requested", "privacy.request.package_delivery_destroyed",
        ]));
      } finally {
        for (const source of unavailableInventory.rows) {
          await postgresQuery(`UPDATE fractal.privacy_data_sources SET contains_personal_data=true,subject_linkage=$2,inventory_status=$3,access_status=$4,
            portability_status=$5,correction_status=$6,erasure_status=$7,restriction_status=$8,objection_status=$9,
            retention_policy_status=$10,hold_coverage_status=$11,blocker=$12 WHERE source_key=$1`,
          [source.source_key,source.subject_linkage,source.inventory_status,source.access_status,source.portability_status,source.correction_status,source.erasure_status,
            source.restriction_status,source.objection_status,source.retention_policy_status,source.hold_coverage_status,source.blocker]);
        }
        for (const authority of affectedAuthorities.rows) {
          await postgresQuery("UPDATE fractal.privacy_data_authorities SET contains_personal_data=true,rights_applicability=$2::text[],blocker=$3 WHERE authority_key=$1",
            [authority.authority_key,authority.rights_applicability,authority.blocker]);
        }
        await postgresQuery("ALTER TABLE fractal.privacy_data_sources ENABLE TRIGGER privacy_data_sources_immutable");
        await postgresQuery("ALTER TABLE fractal.privacy_data_authorities ENABLE TRIGGER privacy_data_authorities_immutable");
      }

      const correction = await createPrivacyRightsRequest({
        actorIdentityId: requesterId, requestType: "correction", details: "Please assess correction of an inaccurate contact detail attached to this verified account.", commandKey: randomUUID(),
      });
      expect(correction.request.policy).toMatchObject({ versionId: policyVersion.version.id, jurisdiction: "Nigeria", responseCalendarDays: 30 });
      await transitionAdministratorPrivacyRightsRequest({
        actorIdentityId: makerId, requestId: correction.request.id, action: "begin_review",
        message: "Review the claimed inaccuracy against the authoritative identity record before any correction.", expectedVersion: 1,
      });
      await expect(postgresQuery(
        `INSERT INTO fractal.privacy_rights_request_events
          (id,privacy_request_id,sequence,event_type,from_status,to_status,from_assignee_identity_id,assignee_identity_id,decision_request_id,actor_identity_id,visibility,message)
         VALUES ($1,$2,3,'decision_proposed','in_review','decision_pending',$3,$3,$4,$3,'internal','Cross-request decision evidence must be refused.')`,
        [randomUUID(), correction.request.id, makerId, proposed.decision.id],
      )).rejects.toThrow("belongs to a different request");
      await expect(postgresQuery(
        `INSERT INTO fractal.privacy_rights_decision_requests
          (id,reference,privacy_request_id,outcome,decision_summary,lawful_basis,scope_outcomes,fulfillment_coverage,command_key,requested_by_identity_id)
         VALUES ($1,$2,$3,'approve',$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), `PRD-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
          correction.request.id, "Malformed scope JSON must never become privacy decision evidence.",
          "The database must independently validate every structured category, action, and explanation.",
          JSON.stringify([{ category: "missing-required-fields" }]), JSON.stringify(proposed.decision.fulfillmentCoverage), randomUUID(), makerId],
      )).rejects.toThrow();
      await expect(postgresQuery(
        `INSERT INTO fractal.privacy_rights_decision_requests
          (id,reference,privacy_request_id,outcome,decision_summary,lawful_basis,scope_outcomes,fulfillment_coverage,command_key,requested_by_identity_id)
         VALUES ($1,$2,$3,'approve',$4,$5,$6,$7,$8,$9)`,
        [randomUUID(), `PRD-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}`,
          correction.request.id, "Overall approval must agree with every structured per-scope action.",
          "The database must reject semantically contradictory decision evidence independently of the service.",
          JSON.stringify([{ category: "regulated_evidence", action: "retain", explanation: "Retention cannot be represented beneath an overall approval outcome." }]),
          JSON.stringify(proposed.decision.fulfillmentCoverage), randomUUID(), makerId],
      )).rejects.toThrow();
      await expect(postgresQuery("UPDATE fractal.privacy_rights_requests SET status='fulfilled' WHERE id=$1", [opened.request.id])).rejects.toThrow();
      await expect(postgresQuery("UPDATE fractal.privacy_data_sources SET inventory_status='catalogued' WHERE source_key='external.postgres.backups'"))
        .rejects.toThrow("privacy data source inventory is migration-owned and immutable");

      await expect(postgresQuery(
        "UPDATE fractal.privacy_rights_requests SET version=version+1,last_activity_at=now()+interval '1 second' WHERE id=$1",
        [opened.request.id],
      )).rejects.toThrow("requires its immutable event");
      await expect(postgresQuery(
        "UPDATE fractal.privacy_rights_request_events SET message='tampered privacy evidence' WHERE privacy_request_id=$1 AND sequence=1",
        [opened.request.id],
      )).rejects.toThrow("privacy rights evidence is immutable");
      await expect(postgresQuery(
        "UPDATE fractal.privacy_rights_decision_requests SET decision_summary='tampered terminal decision evidence' WHERE id=$1",
        [proposed.decision.id],
      )).rejects.toThrow("terminal privacy decision evidence is immutable");
      await expect(postgresQuery(
        "UPDATE fractal.privacy_rights_policy_bindings SET due_at=due_at+interval '1 day' WHERE privacy_request_id=$1",
        [access.request.id],
      )).rejects.toThrow("privacy response-policy binding evidence is immutable");
    } finally {
      await postgresQuery("TRUNCATE fractal.privacy_rights_package_preparations, fractal.privacy_rights_policy_bindings, fractal.privacy_rights_request_events, fractal.privacy_rights_decision_requests, fractal.privacy_rights_requests, fractal.data_legal_holds, fractal.data_legal_hold_change_requests, fractal.support_case_attachment_access_events, fractal.support_case_attachments, fractal.support_case_notification_deliveries, fractal.support_case_service_events, fractal.support_case_service_obligations, fractal.support_case_events, fractal.support_cases, fractal.payment_reconciliation_cases, fractal.payment_receipts, fractal.payment_provider_instructions, fractal.payment_intents, fractal.journal_postings, fractal.journal_entries, fractal.ledger_accounts, fractal.investment_allocation_chain_dispatch_claims, fractal.investment_allocation_chain_operations, fractal.investment_allocation_requests, fractal.offering_issuance_term_requests, fractal.governance_evidence_documents, fractal.investment_reservations, fractal.investment_eligibility_snapshots, fractal.investment_commitments, fractal.investor_compliance_profile_reviews, fractal.investor_compliance_review_requests, fractal.investor_compliance_profiles, fractal.investor_wallets, fractal.investor_wallet_link_challenges, fractal.platform_content_events, fractal.platform_content_publications, fractal.platform_content_versions, fractal.platform_configuration_activation_attempts, fractal.platform_configuration_events, fractal.platform_configuration_active_versions, fractal.platform_configuration_versions, fractal.agreement_acceptances, fractal.offering_publication_versions, fractal.offering_products, fractal.organizations, fractal.provider_identity_verification_events, fractal.provider_identity_verification_applications, fractal.administrator_provider_incident_events, fractal.administrator_provider_incidents, fractal.administrator_audit_exports, fractal.administrator_recovery_requests, fractal.administrator_capability_assignments, fractal.administrator_capability_change_requests, fractal.identity_access_change_requests, fractal.auth_email_deliveries, fractal.totp_recovery_codes, fractal.totp_factors, fractal.audit_chain_heads, fractal.audit_events, fractal.outbox_events, fractal.auth_sessions, fractal.idempotency_commands CASCADE");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id=ANY($1::uuid[])", [identities]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id=ANY($1::uuid[])", [identities]);
    }
  });

  it("refuses a foreign migration ledger entry instead of applying against an unknown schema", async () => {
    const version = "test-foreign-migration";
    await postgresQuery(
      "INSERT INTO fractal.schema_migrations (version, checksum) VALUES ($1, $2)",
      [version, "0".repeat(64)],
    );

    try {
      await expect(applyPostgresMigrations()).rejects.toThrow(`unrecognized version: ${version}`);
    } finally {
      await postgresQuery("DELETE FROM fractal.schema_migrations WHERE version = $1", [version]);
    }
  });

  it("detects a dropped migration-owned index without trying to repair production schema drift", async () => {
    await expect(verifyPostgresSchema()).resolves.toMatchObject({
      missingTables: [],
      missingIndexes: [],
      missingConstraints: [],
      definitionDifferences: [],
    });

    try {
      await postgresQuery("DROP INDEX fractal.idempotency_commands_expires_at_idx");
      await expect(verifyPostgresSchema()).rejects.toBeInstanceOf(PostgresSchemaDriftError);
    } finally {
      await postgresQuery(
        "DROP INDEX IF EXISTS fractal.idempotency_commands_expires_at_idx",
      );
      await postgresQuery(
        "CREATE INDEX IF NOT EXISTS idempotency_commands_expires_at_idx ON fractal.idempotency_commands (expires_at)",
      );
    }
    await expect(verifyPostgresSchema()).resolves.toMatchObject({ missingIndexes: [], definitionDifferences: [] });
  });

  it("detects a changed migration-owned index definition without repairing it", async () => {
    try {
      await postgresQuery("DROP INDEX fractal.idempotency_commands_expires_at_idx");
      await postgresQuery(
        "CREATE INDEX idempotency_commands_expires_at_idx ON fractal.idempotency_commands (expires_at DESC)",
      );
      await expect(verifyPostgresSchema()).rejects.toThrow(
        "mismatch index:idempotency_commands:idempotency_commands_expires_at_idx",
      );
    } finally {
      await postgresQuery("DROP INDEX IF EXISTS fractal.idempotency_commands_expires_at_idx");
      await postgresQuery(
        "CREATE INDEX idempotency_commands_expires_at_idx ON fractal.idempotency_commands (expires_at)",
      );
    }
    await expect(verifyPostgresSchema()).resolves.toMatchObject({ definitionDifferences: [] });
  });

  it("serializes concurrent migration commands with a database advisory lock", async () => {
    const lockHolder = await requirePostgres().connect();
    await lockHolder.query("SELECT pg_advisory_lock($1::bigint)", [POSTGRES_MIGRATION_ADVISORY_LOCK]);

    let completed = false;
    const migration = applyPostgresMigrations().then(() => {
      completed = true;
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(completed).toBe(false);
    } finally {
      await lockHolder.query("SELECT pg_advisory_unlock($1::bigint)", [POSTGRES_MIGRATION_ADVISORY_LOCK]);
      lockHolder.release();
    }

    await expect(migration).resolves.toBeUndefined();
    expect(completed).toBe(true);
  });
});
