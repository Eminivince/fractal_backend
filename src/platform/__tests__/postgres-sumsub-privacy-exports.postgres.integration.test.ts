import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const { applyPostgresMigrations } = await import("../../db/postgres-migrations/index.js");
const {
  connectPostgres,
  disconnectPostgres,
  postgresQuery,
  withPostgresTransaction,
} = await import("../../db/postgres.js");
const {
  activateDuePlatformConfigurationVersions,
  decidePlatformConfigurationVersion,
  proposePlatformConfigurationVersion,
  readActivePlatformConfiguration,
} = await import("../postgres-platform-configuration.js");
const {
  createPrivacyRightsRequest,
  transitionAdministratorPrivacyRightsRequest,
} = await import("../postgres-privacy-rights.js");
const {
  collectCanonicalPrivacySourceSections,
} = await import("../postgres-privacy-package-preparations.js");
const {
  privacyContentProfileSourceKeysForRight,
  privacySafeFieldCatalog,
} = await import("../../modules/privacy/domain/privacy-content-profile.js");
const {
  authorizeSumsubPrivacyExportUpload,
  expireAndQueueSumsubPrivacyExportCleanup,
  recordSumsubPrivacyExportUpload,
  sumsubPrivacyScanEvidenceSha256,
} = await import("../postgres-sumsub-privacy-exports.js");
const {
  claimStorageCleanupTasks,
  markStorageCleanupTaskForRetry,
} = await import("../postgres-storage-cleanup.js");
const {
  dispatchPendingStorageCleanupTasks,
} = await import("../../services/postgres-storage-cleanup-worker.js");
const { stableJsonStringify } = await import("../../utils/idempotency.js");

describe("PostgreSQL Sumsub privacy export staging", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("binds exact correlation, immutable scan evidence, and durable cleanup", async () => {
    const requesterId = randomUUID();
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const marker = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.identities(id,email,legal_name,status,email_verified_at)
       VALUES($1,$2,'Sumsub privacy requester','active',now()),
             ($3,$4,'Sumsub privacy maker','active',now()),
             ($5,$6,'Sumsub privacy checker','active',now())`,
      [
        requesterId,
        `sumsub-requester-${marker}@example.test`,
        makerId,
        `sumsub-maker-${marker}@example.test`,
        checkerId,
        `sumsub-checker-${marker}@example.test`,
      ],
    );
    await postgresQuery(
      `INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type)
       VALUES($1,$2,'investor','global'),($3,$4,'admin','global'),($5,$6,'admin','global')`,
      [randomUUID(), requesterId, randomUUID(), makerId, randomUUID(), checkerId],
    );
    await postgresQuery(
      `INSERT INTO fractal.administrator_capability_assignments(
         id,identity_id,capability_key
       ) VALUES
         ($1,$2,'platform_configuration_manage'),
         ($3,$2,'privacy_request_manage'),
         ($4,$5,'platform_configuration_manage'),
         ($6,$5,'privacy_request_manage')`,
      [randomUUID(), makerId, randomUUID(), randomUUID(), checkerId, randomUUID()],
    );

    const packagePolicy = {
      policyReference: "PRIV-SUMSUB-PACKAGE-NG-001",
      policyName: "Nigeria Sumsub privacy export package policy",
      schemaVersion: "privacy-package-policy-v2",
      canonicalFormat: "application/vnd.fractal.privacy-package+tar;version=2",
      identityAssurance: "authenticated_verified_email_session",
      deliveryChannel: "authenticated_register",
      allowInternalIncompletePreparation: true,
      maximumRecords: 100_000,
      maximumBytes: 100 * 1024 * 1024,
      maximumArtifacts: 100,
      packageRetentionHours: 24,
      requesterRetrievalHours: 1,
    } as const;
    const current = await readActivePlatformConfiguration("privacy.rights.package_policy");
    if (!current || stableJsonStringify(current.value) !== stableJsonStringify(packagePolicy)) {
      const proposal = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId,
        configurationKey: "privacy.rights.package_policy",
        proposedValue: packagePolicy,
        expectedProjectionVersion: current?.projectionVersion ?? null,
        effectiveAt: new Date(Date.now() - 1_000),
        reason: "Approve exact archive retention for Sumsub privacy export staging.",
        commandKey: randomUUID(),
      });
      expect(proposal.version.status).toBe("pending");
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId,
        versionId: proposal.version.id,
        action: "approve",
        expectedStateVersion: 1,
        decisionReason: "Independently approve exact Sumsub provider-export archive controls.",
        commandKey: randomUUID(),
      });
      const activation = await activateDuePlatformConfigurationVersions(new Date());
      expect(activation.failed).toBe(0);
    }

    const request = await createPrivacyRightsRequest({
      actorIdentityId: requesterId,
      requestType: "access",
      details: "Provide every eligible Sumsub record and the complete higher-sensitive single-applicant provider export.",
      commandKey: randomUUID(),
    });
    await transitionAdministratorPrivacyRightsRequest({
      actorIdentityId: makerId,
      requestId: request.request.id,
      action: "begin_review",
      message: "Collect only evidence with exact requester and provider correlation.",
      expectedVersion: 1,
    });

    const applicationId = randomUUID();
    await expect(postgresQuery(
      `INSERT INTO fractal.provider_identity_verification_applications(
         id,identity_id,provider,external_user_id,applicant_id,status,ready_at
       ) VALUES($1,$2::uuid,'sumsub',($2::uuid)::text,$3,'ready',now())`,
      [applicationId, requesterId, `applicant-${marker}`],
    )).rejects.toThrow();
    await postgresQuery(
      `INSERT INTO fractal.provider_identity_verification_applications(
         id,identity_id,provider,external_user_id,applicant_id,inspection_id,
         status,ready_at
       ) VALUES($1,$2::uuid,'sumsub',($2::uuid)::text,$3,$4,'ready',now())`,
      [
        applicationId,
        requesterId,
        `applicant-${marker}`,
        `inspection-${marker}`,
      ],
    );

    const commandKey = randomUUID();
    const now = new Date("2026-07-27T12:00:00.000Z");
    const generatedAt = new Date(now.getTime() - 60_000);
    const downloadedAt = new Date(now.getTime() - 30_000);
    const settingsSha256 = createHash("sha256").update("sumsub-export-settings").digest("hex");
    await expect(authorizeSumsubPrivacyExportUpload({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      reportReference: `sumsub-report-${marker}`,
      generatedAt,
      downloadedAt,
      settingsSha256,
      commandKey,
      now,
    })).rejects.toMatchObject({ code: "forbidden" });
    await postgresQuery(
      `INSERT INTO fractal.administrator_capability_assignments(
         id,identity_id,capability_key
       ) VALUES($1,$2,'privacy_external_collect')`,
      [randomUUID(), makerId],
    );

    const authorization = await authorizeSumsubPrivacyExportUpload({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      reportReference: `sumsub-report-${marker}`,
      generatedAt,
      downloadedAt,
      settingsSha256,
      commandKey,
      now,
    });
    expect(authorization).toMatchObject({
      requesterIdentityId: requesterId,
      applicantId: `applicant-${marker}`,
      externalUserId: requesterId,
      inspectionId: `inspection-${marker}`,
      existing: null,
    });

    const content = Buffer.from("PK\u0003\u0004governed-sumsub-export");
    const contentSha256 = createHash("sha256").update(content).digest("hex");
    const scannedAt = new Date(now.getTime() + 1_000);
    const uploadedAt = new Date(now.getTime() + 2_000);
    const scanEvidence = sumsubPrivacyScanEvidenceSha256({
      scanner: "clamav_instream",
      scannedAt,
      contentSha256,
      byteCount: content.length,
    });
    const recorded = await recordSumsubPrivacyExportUpload({
      authorization,
      storageKey: `local://privacy-provider-exports/${authorization.exportId}/sumsub-export.zip`,
      contentSha256,
      byteCount: content.length,
      scanner: "clamav_instream",
      scannedAt,
      malwareScanEvidenceSha256: scanEvidence,
      uploadedAt,
    });
    expect(recorded).toMatchObject({
      replayed: false,
      providerExport: {
        requestType: "access",
        entryCount: 1,
        sensitiveTier: "higher_sensitive_data",
        status: "staged",
        contentSha256,
        scan: { status: "clean", evidenceSha256: scanEvidence },
      },
    });
    const fieldCatalogVersion = "privacy-safe-fields-v45" as const;
    const rules = (right: "access" | "portability") =>
      privacyContentProfileSourceKeysForRight(fieldCatalogVersion, right).map(
        (sourceKey) => ({
          sourceKey,
          includedFields: [...privacySafeFieldCatalog[sourceKey]],
          excludedFields: [],
        }),
      );
    const sections = await withPostgresTransaction((client) =>
      collectCanonicalPrivacySourceSections(client, requesterId, "access", {
        profileReference: "PRIV-SUMSUB-STAGING-TEST-1",
        profileName: "Sumsub staging privacy collector test profile",
        schemaVersion: "privacy-content-profile-v1",
        fieldCatalogVersion,
        jurisdictionCode: "NG",
        legalBasisReference: "Authenticated data subject access test authority",
        effectiveScope: "authenticated_data_subject_access_and_portability",
        access: { sourceRules: rules("access") },
        portability: { sourceRules: rules("portability") },
      }),
    );
    const providerExportSection = sections.get(
      "postgres.fractal.privacy_external_provider_exports",
    )?.canonicalContent ?? "";
    expect(providerExportSection).toContain(recorded.providerExport.reference);
    expect(providerExportSection).toContain('"sensitiveTier":"higher_sensitive_data"');
    expect(providerExportSection).not.toContain(`applicant-${marker}`);
    expect(providerExportSection).not.toContain(`inspection-${marker}`);
    expect(providerExportSection).not.toContain(`sumsub-report-${marker}`);
    expect(providerExportSection).not.toContain(contentSha256);
    expect(providerExportSection).not.toContain("local://");

    const replay = await authorizeSumsubPrivacyExportUpload({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      reportReference: `sumsub-report-${marker}`,
      generatedAt,
      downloadedAt,
      settingsSha256,
      commandKey,
      now,
    });
    expect(replay.existing?.id).toBe(recorded.providerExport.id);
    await expect(authorizeSumsubPrivacyExportUpload({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      reportReference: `changed-report-${marker}`,
      generatedAt,
      downloadedAt,
      settingsSha256,
      commandKey,
      now,
    })).rejects.toMatchObject({ code: "conflict" });

    await expect(postgresQuery(
      `UPDATE fractal.privacy_external_provider_exports
          SET inspection_id='changed-inspection'
        WHERE id=$1`,
      [recorded.providerExport.id],
    )).rejects.toThrow(/immutable/);
    await expect(postgresQuery(
      `UPDATE fractal.privacy_external_provider_exports
          SET status='destroyed',destroyed_at=now()
        WHERE id=$1`,
      [recorded.providerExport.id],
    )).rejects.toThrow();

    const retainUntil = new Date(recorded.providerExport.retainUntil);
    await expect(expireAndQueueSumsubPrivacyExportCleanup(
      10,
      new Date(retainUntil.getTime() - 1),
    )).resolves.toBe(0);
    await expect(expireAndQueueSumsubPrivacyExportCleanup(
      10,
      new Date(retainUntil.getTime() + 1),
    )).resolves.toBe(1);
    const cleanupTask = await postgresQuery<{
      id: string;
      storage_key: string;
      privacy_external_provider_export_id: string;
    }>(
      `SELECT id,storage_key,privacy_external_provider_export_id
         FROM fractal.storage_cleanup_tasks
        WHERE privacy_external_provider_export_id=$1`,
      [recorded.providerExport.id],
    );
    expect(cleanupTask.rows[0]).toMatchObject({
      privacy_external_provider_export_id: recorded.providerExport.id,
    });
    const removed: string[] = [];
    await dispatchPendingStorageCleanupTasks({
      workerId: `sumsub-cleanup-${marker}`,
      logger: { info: () => undefined, error: () => undefined },
      remove: async (storageKey) => {
        removed.push(storageKey);
      },
    });
    expect(removed).toContain(cleanupTask.rows[0]!.storage_key);
    const destroyed = await postgresQuery<{
      status: string;
      destroyed_at: Date | null;
    }>(
      `SELECT status,destroyed_at
         FROM fractal.privacy_external_provider_exports
        WHERE id=$1`,
      [recorded.providerExport.id],
    );
    expect(destroyed.rows[0]).toMatchObject({
      status: "destroyed",
      destroyed_at: expect.any(Date),
    });

    const secondAuthorization = await authorizeSumsubPrivacyExportUpload({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      reportReference: `sumsub-report-failure-${marker}`,
      generatedAt,
      downloadedAt,
      settingsSha256,
      commandKey: randomUUID(),
      now,
    });
    const secondContentSha256 = createHash("sha256").update("second-export").digest("hex");
    const secondScanEvidence = sumsubPrivacyScanEvidenceSha256({
      scanner: "clamav_instream",
      scannedAt,
      contentSha256: secondContentSha256,
      byteCount: 13,
    });
    const second = await recordSumsubPrivacyExportUpload({
      authorization: secondAuthorization,
      storageKey: `local://privacy-provider-exports/${secondAuthorization.exportId}/sumsub-export.zip`,
      contentSha256: secondContentSha256,
      byteCount: 13,
      scanner: "clamav_instream",
      scannedAt,
      malwareScanEvidenceSha256: secondScanEvidence,
      uploadedAt,
    });
    await expireAndQueueSumsubPrivacyExportCleanup(
      10,
      new Date(new Date(second.providerExport.retainUntil).getTime() + 1),
    );
    const failureWorker = `sumsub-cleanup-failure-${marker}`;
    const claimed = await claimStorageCleanupTasks({
      workerId: failureWorker,
      limit: 100,
      claimTimeoutSeconds: 30,
    });
    const failedTask = claimed.find(
      (task) => task.privacyExternalProviderExportId === second.providerExport.id,
    );
    expect(failedTask).toBeTruthy();
    await markStorageCleanupTaskForRetry({
      taskId: failedTask!.id,
      workerId: failureWorker,
      retryAt: new Date(now.getTime() + 60_000),
      error: new Error("simulated private-object deletion failure"),
      terminal: true,
    });
    const failed = await postgresQuery<{ status: string; failure_category: string }>(
      `SELECT status,failure_category
         FROM fractal.privacy_external_provider_exports
        WHERE id=$1`,
      [second.providerExport.id],
    );
    expect(failed.rows).toEqual([{
      status: "cleanup_failed",
      failure_category: "cleanup_failed",
    }]);

    const audit = await postgresQuery<{ action: string }>(
      `SELECT action
         FROM fractal.audit_events
        WHERE entity_type='privacy_external_provider_export'
          AND entity_id IN($1,$2)
        ORDER BY sequence`,
      [recorded.providerExport.id, second.providerExport.id],
    );
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining([
      "privacy.request.sumsub_provider_export_staged",
      "privacy.request.sumsub_provider_export_cleanup_requested",
      "privacy.request.sumsub_provider_export_destroyed",
      "privacy.request.sumsub_provider_export_cleanup_failed",
    ]));
  });
});
