import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
} from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const releaseSha256 = createHash("sha256").update("privacy-snapshot-test-release").digest("hex");
const resendAdapterSha256 = createHash("sha256").update("privacy-snapshot-test-resend-adapter").digest("hex");
const chainAdapterSha256 = createHash("sha256").update("privacy-snapshot-test-chain-adapter").digest("hex");
const sumsubAdapterSha256 = createHash("sha256").update("privacy-snapshot-test-sumsub-adapter").digest("hex");
const signingKeys = generateKeyPairSync("ed25519");
const publicKeyPem = signingKeys.publicKey.export({ type: "spki", format: "pem" }).toString();

process.env.APPLICATION_RELEASE_SHA256 = releaseSha256;
process.env.PRIVACY_RESEND_ADAPTER_SHA256 = resendAdapterSha256;
process.env.PRIVACY_CHAIN_ADAPTER_SHA256 = chainAdapterSha256;
process.env.PRIVACY_SUMSUB_ADAPTER_SHA256 = sumsubAdapterSha256;
process.env.SUMSUB_PRIVACY_APP_TOKEN = "sumsub-privacy-test-app-token";
process.env.SUMSUB_PRIVACY_SECRET_KEY = "sumsub-privacy-test-secret-key";
process.env.PRIVACY_EXTERNAL_ATTESTATION_KEY_RING_JSON = JSON.stringify({
  "privacy-snapshot-test-key": { publicKeyPem, status: "active" },
});

const { applyPostgresMigrations } = await import("../../db/postgres-migrations/index.js");
const {
  connectPostgres,
  disconnectPostgres,
  postgresQuery,
  withPostgresTransaction,
} = await import("../../db/postgres.js");
const {
  privacyContentProfileSourceKeysForRight,
  privacySafeFieldCatalog,
} = await import("../../modules/privacy/domain/privacy-content-profile.js");
const { validPrivacyExternalAdapterPolicy } = await import(
  "../../testing/privacy-external-adapter-policy.fixture.js"
);
const { structurallyValidPrivacyExternalAttestationSet } = await import(
  "../../testing/privacy-external-attestation-set.fixture.js"
);
const { stableJsonStringify } = await import("../../utils/idempotency.js");
const {
  activateDuePlatformConfigurationVersions,
  decidePlatformConfigurationVersion,
  proposePlatformConfigurationVersion,
  readActivePlatformConfiguration,
} = await import("../postgres-platform-configuration.js");
const {
  createPrivacyRightsRequest,
  decidePrivacyRightsDecision,
  proposePrivacyRightsDecision,
  readPrivacyFulfillmentCoverage,
  transitionAdministratorPrivacyRightsRequest,
} = await import("../postgres-privacy-rights.js");
const {
  expireAndQueuePrivacyExternalSnapshotCleanup,
  listAdministratorPrivacyExternalSnapshots,
  loadPrivacyExternalSnapshotSections,
  materializeOnePrivacyExternalSnapshot,
  requestPrivacyExternalSnapshot,
} = await import("../postgres-privacy-external-snapshots.js");
const {
  preparePrivacyRightsPackageEvidence,
} = await import("../postgres-privacy-package-preparations.js");
const { dispatchPendingStorageCleanupTasks } = await import(
  "../../services/postgres-storage-cleanup-worker.js"
);
const {
  RESEND_PRIVACY_ADAPTER_KEY,
  RESEND_PRIVACY_ADAPTER_VERSION,
} = await import("../../services/privacy-external-resend-adapter.js");
const {
  CHAIN_PRIVACY_ADAPTER_KEY,
  CHAIN_PRIVACY_ADAPTER_VERSION,
  CHAIN_PRIVACY_OUTPUT_FIELDS,
} = await import("../../services/privacy-external-chain-adapter.js");
const {
  SUMSUB_PRIVACY_ADAPTER_KEY,
  SUMSUB_PRIVACY_ADAPTER_VERSION,
  SUMSUB_PRIVACY_OUTPUT_FIELDS,
} = await import("../../services/privacy-external-sumsub-adapter.js");
const {
  buildPrivacyPackageArchiveV2,
  parsePrivacyPackageArchiveV2,
} = await import("../../modules/privacy/domain/privacy-package-archive.js");
const {
  authorizeSumsubPrivacyExportUpload,
  recordSumsubPrivacyExportUpload,
  sumsubPrivacyScanEvidenceSha256,
} = await import("../postgres-sumsub-privacy-exports.js");

describe("PostgreSQL external privacy snapshots", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("accepts only the exact component inventory for every external source", async () => {
    const policy = validPrivacyExternalAdapterPolicy();
    for (const source of policy.sources) {
      const valid = await postgresQuery<{ valid: boolean }>(
        "SELECT fractal.valid_privacy_external_source_coverage($1,$2::jsonb) AS valid",
        [source.sourceKey, JSON.stringify(source.coverage)],
      );
      expect(valid.rows).toEqual([{ valid: true }]);

      const incompleteCoverage = {
        ...source.coverage!,
        componentKeys: source.coverage!.componentKeys.slice(0, -1),
      };
      const incomplete = await postgresQuery<{ valid: boolean }>(
        "SELECT fractal.valid_privacy_external_source_coverage($1,$2::jsonb) AS valid",
        [source.sourceKey, JSON.stringify(incompleteCoverage)],
      );
      expect(incomplete.rows).toEqual([{ valid: false }]);
    }
  });

  it("binds Resend, public-chain, and Sumsub snapshots to exact package and cleanup evidence", async () => {
    const requesterId = randomUUID();
    const makerId = randomUUID();
    const checkerId = randomUUID();
    const marker = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.identities(id,email,legal_name,status,email_verified_at)
       VALUES($1,$2,'Snapshot requester','active',now()),
             ($3,$4,'Snapshot maker','active',now()),
             ($5,$6,'Snapshot checker','active',now())`,
      [
        requesterId,
        `snapshot-requester-${marker}@example.test`,
        makerId,
        `snapshot-maker-${marker}@example.test`,
        checkerId,
        `snapshot-checker-${marker}@example.test`,
      ],
    );
    await postgresQuery(
      `INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type)
       VALUES($1,$2,'issuer','global'),($3,$4,'admin','global'),($5,$6,'admin','global')`,
      [randomUUID(), requesterId, randomUUID(), makerId, randomUUID(), checkerId],
    );
    await postgresQuery(
      `INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key)
       VALUES
         ($1,$2,'platform_configuration_manage'),($3,$2,'privacy_source_manage'),
         ($4,$2,'privacy_request_manage'),
         ($5,$6,'platform_configuration_manage'),($7,$6,'privacy_source_manage'),
         ($8,$6,'privacy_request_manage')`,
      [randomUUID(), makerId, randomUUID(), randomUUID(), randomUUID(), checkerId, randomUUID(), randomUUID()],
    );

    const activate = async (configurationKey: string, proposedValue: unknown, reason: string) => {
      const current = await readActivePlatformConfiguration(configurationKey);
      if (current && stableJsonStringify(current.value) === stableJsonStringify(proposedValue)) {
        return current;
      }
      const proposed = await proposePlatformConfigurationVersion({
        actorIdentityId: makerId,
        configurationKey,
        proposedValue,
        expectedProjectionVersion: current?.projectionVersion ?? null,
        effectiveAt: new Date(Date.now() - 1_000),
        reason,
        commandKey: randomUUID(),
      });
      if (proposed.version.status !== "pending") {
        throw new Error(`Configuration validation failed: ${JSON.stringify(proposed.version.validationOutput)}`);
      }
      await decidePlatformConfigurationVersion({
        actorIdentityId: checkerId,
        versionId: proposed.version.id,
        action: "approve",
        expectedStateVersion: 1,
        decisionReason: `Independently approve ${configurationKey} for exact snapshot evidence.`,
        commandKey: randomUUID(),
      });
      const result = await activateDuePlatformConfigurationVersions(new Date());
      expect(result.failed).toBe(0);
      return readActivePlatformConfiguration(configurationKey);
    };

    const adapterPolicy = validPrivacyExternalAdapterPolicy();
    adapterPolicy.sources = adapterPolicy.sources.map((source) => {
      if (source.sourceKey === "external.resend.delivery") {
        return {
          ...source,
          implementation: {
            adapterKey: RESEND_PRIVACY_ADAPTER_KEY,
            version: RESEND_PRIVACY_ADAPTER_VERSION,
            sha256: resendAdapterSha256,
            releaseBinding: "exact_release_sha256",
          },
          correlation: {
            ...source.correlation,
            mode: "exact_provider_reference",
            referenceFields: ["providerMessageId"],
          },
          fields: [{
            sourceField: "created_at",
            outputField: "createdAt",
            classification: "personal_metadata",
            handling: "include",
            reason: "Delivery creation time is part of the requester-visible delivery lifecycle.",
          }, {
            sourceField: "last_event",
            outputField: "lastEvent",
            classification: "personal_metadata",
            handling: "include",
            reason: "The latest delivery event is part of the requester-visible delivery lifecycle.",
          }, {
            sourceField: "provider_payload",
            outputField: null,
            classification: "secret_or_internal",
            handling: "omit",
            reason: "Unapproved provider payload fields remain outside the requester package.",
          }],
        };
      }
      if (source.sourceKey === "external.chain.public_records") {
        return {
          ...source,
          implementation: {
            adapterKey: CHAIN_PRIVACY_ADAPTER_KEY,
            version: CHAIN_PRIVACY_ADAPTER_VERSION,
            sha256: chainAdapterSha256,
            releaseBinding: "exact_release_sha256" as const,
          },
          correlation: {
            ...source.correlation,
            mode: "exact_wallet_binding" as const,
            referenceFields: ["walletAddress", "transactionHash"],
          },
          fields: [
            ...CHAIN_PRIVACY_OUTPUT_FIELDS.map((field) => ({
              sourceField: field,
              outputField: field,
              classification: "public_record" as const,
              handling: "include" as const,
              reason: "This field is part of the bounded public-chain disclosure record.",
            })),
            {
              sourceField: "rpc_and_internal_execution",
              outputField: null,
              classification: "secret_or_internal" as const,
              handling: "omit" as const,
              reason: "RPC credentials and internal execution data are excluded.",
            },
          ],
        };
      }
      if (source.sourceKey === "external.identity_verification.provider") {
        return {
          ...source,
          implementation: {
            adapterKey: SUMSUB_PRIVACY_ADAPTER_KEY,
            version: SUMSUB_PRIVACY_ADAPTER_VERSION,
            sha256: sumsubAdapterSha256,
            releaseBinding: "exact_release_sha256" as const,
          },
          correlation: {
            ...source.correlation,
            mode: "exact_provider_reference" as const,
            referenceFields: [
              "applicantId",
              "externalUserId",
              "inspectionId",
              "reportReference",
            ],
          },
          fields: [
            ...SUMSUB_PRIVACY_OUTPUT_FIELDS.map((field) => ({
              sourceField: field,
              outputField: field,
              classification: "personal_metadata" as const,
              handling: "include" as const,
              reason: "This field is part of the bounded Sumsub privacy record.",
            })),
            {
              sourceField: "provider_credentials",
              outputField: null,
              classification: "secret_or_internal" as const,
              handling: "omit" as const,
              reason: "Provider credentials are excluded from the requester package.",
            },
          ],
        };
      }
      return source;
    });
    const activeAdapter = await activate(
      "privacy.external_source.adapter_policy",
      adapterPolicy,
      "Approve the exact Resend collector and retain fail-closed contracts for inactive external sources.",
    );
    expect(activeAdapter).not.toBeNull();

    const attestationSet = structurallyValidPrivacyExternalAttestationSet(adapterPolicy, {
      configurationKey: "privacy.external_source.adapter_policy",
      versionId: activeAdapter!.versionId,
      versionNumber: activeAdapter!.versionNumber,
      projectionVersion: activeAdapter!.projectionVersion,
      valueSha256: activeAdapter!.valueSha256,
    });
    attestationSet.setReference = "privacy-snapshot-signed-production-set";
    attestationSet.attestations = attestationSet.attestations.map((attestation) => {
      const payload = {
        ...attestation.payload,
        implementation: {
          ...attestation.payload.implementation,
          releaseSha256,
        },
      };
      return {
        payload,
        signature: {
          algorithm: "Ed25519" as const,
          keyId: "privacy-snapshot-test-key",
          valueBase64: sign(
            null,
            Buffer.from(stableJsonStringify(payload), "utf8"),
            signingKeys.privateKey,
          ).toString("base64"),
        },
      };
    });
    const activeAttestation = await activate(
      "privacy.external_source.attestation_set",
      attestationSet,
      "Approve trusted signed evidence for Resend while inactive sources remain unavailable.",
    );
    expect(activeAttestation).not.toBeNull();

    await activate("privacy.rights.package_policy", {
      policyReference: "PRIV-SNAPSHOT-PACKAGE-NG-001",
      policyName: "Nigeria external snapshot package policy",
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
    }, "Approve bounded private package retention for external snapshot evidence.");

    const fieldCatalogVersion = "privacy-safe-fields-v45" as const;
    const rules = (right: "access" | "portability") =>
      privacyContentProfileSourceKeysForRight(fieldCatalogVersion, right).map((sourceKey) => ({
        sourceKey,
        includedFields: [...privacySafeFieldCatalog[sourceKey]],
        excludedFields: [],
      }));
    await activate("privacy.rights.content_profile", {
      profileReference: "PRIV-SNAPSHOT-CONTENT-NG-001",
      profileName: "Nigeria external snapshot content profile",
      schemaVersion: "privacy-content-profile-v1",
      fieldCatalogVersion,
      jurisdictionCode: "NG",
      legalBasisReference: "Authenticated data-subject access under the approved Nigeria privacy register.",
      effectiveScope: "authenticated_data_subject_access_and_portability",
      access: { sourceRules: rules("access") },
      portability: { sourceRules: rules("portability") },
    }, "Approve the exact v44 safe-field profile for snapshot package evidence.");

    const request = await createPrivacyRightsRequest({
      actorIdentityId: requesterId,
      requestType: "access",
      details: "Please provide all eligible personal records, including the exact lifecycle of messages sent through Resend.",
      commandKey: randomUUID(),
    });
    await transitionAdministratorPrivacyRightsRequest({
      actorIdentityId: makerId,
      requestId: request.request.id,
      action: "begin_review",
      message: "Review exact external references before any provider collection starts.",
      expectedVersion: 1,
    });
    await expect(requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.resend.delivery",
      commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "forbidden" });
    await postgresQuery(
      `INSERT INTO fractal.administrator_capability_assignments(id,identity_id,capability_key)
       VALUES($1,$2,'privacy_external_collect')`,
      [randomUUID(), makerId],
    );

    const snapshotCommand = randomUUID();
    const requested = await requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.resend.delivery",
      commandKey: snapshotCommand,
    });
    expect(requested).toMatchObject({
      replayed: false,
      snapshot: { sourceKey: "external.resend.delivery", status: "queued" },
    });
    await expect(requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.resend.delivery",
      commandKey: snapshotCommand,
    })).resolves.toMatchObject({ replayed: true, snapshot: { id: requested.snapshot.id } });

    const providerMessageId = `resend-snapshot-${randomUUID()}`;
    await postgresQuery(
      `INSERT INTO fractal.auth_email_deliveries(
         id,identity_id,delivery_type,status,sent_at,provider,provider_message_id
       ) VALUES($1,$2,'password_reset','sent',now(),'resend',$3)`,
      [randomUUID(), requesterId, providerMessageId],
    );
    let persistedContent = "";
    await expect(materializeOnePrivacyExternalSnapshot({
      workerId: "privacy-external-snapshot-test",
      resendApiKey: "re_snapshot_test_key",
      collect: async ({ references }) => {
        expect(references).toEqual([{
          providerMessageId,
          recipientEmail: `snapshot-requester-${marker}@example.test`,
        }]);
        return [{ createdAt: new Date().toISOString(), lastEvent: "delivered" }];
      },
      store: async ({ snapshotId, content }) => {
        expect(snapshotId).toBe(requested.snapshot.id);
        persistedContent = content.toString("utf8");
        return {
          storageKey: `local://privacy-external-snapshots/${snapshotId}/snapshot.json`,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    })).resolves.toBe(true);
    expect(JSON.parse(persistedContent)).toMatchObject({
      sourceKey: "external.resend.delivery",
      records: [{ lastEvent: "delivered" }],
    });
    await expect(postgresQuery(
      `INSERT INTO fractal.privacy_external_collection_snapshots
       SELECT (jsonb_populate_record(
         NULL::fractal.privacy_external_collection_snapshots,
         to_jsonb(snapshot_row)
         || jsonb_build_object(
           'id',$2::text,
           'reference','PXS-20260727-BADC0DE1',
           'command_key',$3::text,
           'source_attestation',
             jsonb_set(
               source_attestation,
               '{payload,coverage,componentKeys}',
               '["authentication_delivery"]'::jsonb
             )
         )
       )).*
         FROM fractal.privacy_external_collection_snapshots snapshot_row
        WHERE id=$1`,
      [requested.snapshot.id, randomUUID(), randomUUID()],
    )).rejects.toThrow(
      "external snapshot requires exact policy, runtime, and attestation component coverage",
    );

    const walletAddress = `0x${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
    const walletChallengeId = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.investor_wallet_link_challenges(
         id,investor_identity_id,chain_id,wallet_address,message_hash,
         expires_at,status,consumed_at
       ) VALUES($1,$2,11155111,$3,$4,now()+interval '1 hour','consumed',now())`,
      [walletChallengeId, requesterId, walletAddress, "2".repeat(64)],
    );
    await postgresQuery(
      `INSERT INTO fractal.investor_wallets(
         id,investor_identity_id,chain_id,wallet_address,link_challenge_id,
         signature_hash,status,verified_at
       ) VALUES($1,$2,11155111,$3,$4,$5,'active',now())`,
      [randomUUID(), requesterId, walletAddress, walletChallengeId, "3".repeat(64)],
    );
    const requestedChain = await requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.chain.public_records",
      commandKey: randomUUID(),
    });
    let persistedChainContent = "";
    await expect(materializeOnePrivacyExternalSnapshot({
      workerId: "privacy-chain-snapshot-test",
      supportedSourceKeys: ["external.chain.public_records"],
      store: async ({ snapshotId, content }) => {
        expect(snapshotId).toBe(requestedChain.snapshot.id);
        persistedChainContent = content.toString("utf8");
        return {
          storageKey: `local://privacy-external-snapshots/${snapshotId}/snapshot.json`,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    })).resolves.toBe(true);
    expect(JSON.parse(persistedChainContent)).toEqual({
      sourceKey: "external.chain.public_records",
      records: [{
        chainId: 11155111,
        recordType: "wallet",
        walletAddress,
      }],
    });

    const sumsubApplicationId = randomUUID();
    const sumsubApplicantId = `snapshot-applicant-${marker}`;
    const sumsubInspectionId = `snapshot-inspection-${marker}`;
    await postgresQuery(
      `INSERT INTO fractal.provider_identity_verification_applications(
         id,identity_id,provider,external_user_id,applicant_id,inspection_id,
         status,ready_at
       ) VALUES($1,$2::uuid,'sumsub',($2::uuid)::text,$3,$4,'ready',now())`,
      [
        sumsubApplicationId,
        requesterId,
        sumsubApplicantId,
        sumsubInspectionId,
      ],
    );
    const sumsubNow = new Date();
    const sumsubSettingsSha256 = createHash("sha256")
      .update("snapshot-sumsub-settings")
      .digest("hex");
    const sumsubAuthorization = await authorizeSumsubPrivacyExportUpload({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      reportReference: `snapshot-sumsub-report-${marker}`,
      generatedAt: new Date(sumsubNow.getTime() - 60_000),
      downloadedAt: new Date(sumsubNow.getTime() - 30_000),
      settingsSha256: sumsubSettingsSha256,
      commandKey: randomUUID(),
      now: sumsubNow,
    });
    const sumsubProviderContent = Buffer.from(
      "PK\u0003\u0004integrity-bound-sumsub-provider-export",
      "utf8",
    );
    const sumsubProviderSha256 = createHash("sha256")
      .update(sumsubProviderContent)
      .digest("hex");
    const sumsubScannedAt = new Date(sumsubNow.getTime() + 1_000);
    const sumsubUploadedAt = new Date(sumsubNow.getTime() + 2_000);
    const stagedSumsub = await recordSumsubPrivacyExportUpload({
      authorization: sumsubAuthorization,
      storageKey:
        `local://privacy-provider-exports/${sumsubAuthorization.exportId}/sumsub-export.zip`,
      contentSha256: sumsubProviderSha256,
      byteCount: sumsubProviderContent.byteLength,
      scanner: "clamav_instream",
      scannedAt: sumsubScannedAt,
      malwareScanEvidenceSha256: sumsubPrivacyScanEvidenceSha256({
        scanner: "clamav_instream",
        scannedAt: sumsubScannedAt,
        contentSha256: sumsubProviderSha256,
        byteCount: sumsubProviderContent.byteLength,
      }),
      uploadedAt: sumsubUploadedAt,
    });
    await expect(requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.identity_verification.provider",
      commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.identity_verification.provider",
      providerExportId: randomUUID(),
      commandKey: randomUUID(),
    })).rejects.toMatchObject({ code: "conflict" });
    const requestedSumsub = await requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
      sourceKey: "external.identity_verification.provider",
      providerExportId: stagedSumsub.providerExport.id,
      commandKey: randomUUID(),
    });
    let persistedSumsubContent: Buffer = Buffer.alloc(0);
    const sumsubDocument = Buffer.from("sumsub-document-image", "utf8");
    const sumsubFinalizationErrors: unknown[] = [];
    await expect(materializeOnePrivacyExternalSnapshot({
      workerId: "privacy-sumsub-snapshot-test",
      supportedSourceKeys: ["external.identity_verification.provider"],
      sumsubAppToken: "sumsub-privacy-test-app-token",
      sumsubSecretKey: "sumsub-privacy-test-secret-key",
      retrieve: async (storageKey) => {
        expect(storageKey).toContain(stagedSumsub.providerExport.id);
        return { buffer: sumsubProviderContent };
      },
      collectSumsub: async (input) => {
        expect(input.reference).toEqual({
          applicantId: sumsubApplicantId,
          externalUserId: requesterId,
          inspectionId: sumsubInspectionId,
        });
        expect(input.providerExport.content).toEqual(sumsubProviderContent);
        return {
          records: SUMSUB_PRIVACY_OUTPUT_FIELDS.map((componentKey) => ({
            componentKey,
          })),
          artifacts: [{
            sourceKey: "external.identity_verification.provider",
            componentKey: "provider_export_artifacts",
            mediaType: "application/zip",
            content: sumsubProviderContent,
          }, {
            sourceKey: "external.identity_verification.provider",
            componentKey: "identity_documents",
            mediaType: "image/jpeg",
            content: sumsubDocument,
          }],
        };
      },
      store: async ({ snapshotId, content }) => {
        expect(snapshotId).toBe(requestedSumsub.snapshot.id);
        persistedSumsubContent = content;
        return {
          storageKey:
            `local://privacy-external-snapshots/${snapshotId}/snapshot.tar`,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
      logger: {
        error: (value) => {
          const error = (value as {
            err?: {
              message?: string;
              detail?: string;
              where?: string;
              routine?: string;
            };
          }).err;
          sumsubFinalizationErrors.push({
            message: error?.message,
            detail: error?.detail,
            where: error?.where,
            routine: error?.routine,
          });
        },
      },
    })).resolves.toBe(true);
    expect(sumsubFinalizationErrors).toEqual([]);
    const sumsubSnapshotEvidence = await postgresQuery<{
      status: string;
      canonical_format: string;
      artifact_count: number;
      artifact_manifest: Array<{ componentKey: string; sha256: string }>;
    }>(
      `SELECT status,canonical_format,artifact_count,artifact_manifest
         FROM fractal.privacy_external_collection_snapshots
        WHERE id=$1`,
      [requestedSumsub.snapshot.id],
    );
    expect(sumsubSnapshotEvidence.rows[0]).toMatchObject({
      status: "available",
      canonical_format:
        "application/vnd.fractal.privacy-external-snapshot+tar;version=2",
      artifact_count: 2,
    });
    expect(sumsubSnapshotEvidence.rows[0]!.artifact_manifest)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ componentKey: "provider_export_artifacts" }),
        expect.objectContaining({ componentKey: "identity_documents" }),
      ]));
    await expect(postgresQuery(
      `UPDATE fractal.privacy_external_collection_snapshots
          SET artifact_manifest='[]'::jsonb
        WHERE id=$1`,
      [requestedSumsub.snapshot.id],
    )).rejects.toThrow();
    const stagedExportLifecycle = await postgresQuery<{
      status: string;
      cleanup_task_count: number;
    }>(
      `SELECT provider_export.status,
              count(task.id)::integer AS cleanup_task_count
         FROM fractal.privacy_external_provider_exports provider_export
         LEFT JOIN fractal.storage_cleanup_tasks task
           ON task.privacy_external_provider_export_id=provider_export.id
        WHERE provider_export.id=$1
        GROUP BY provider_export.status`,
      [stagedSumsub.providerExport.id],
    );
    expect(stagedExportLifecycle.rows).toEqual([{
      status: "cleanup_requested",
      cleanup_task_count: 1,
    }]);

    const emptyRequesterId = randomUUID();
    await postgresQuery(
      `INSERT INTO fractal.identities(id,email,legal_name,status,email_verified_at)
       VALUES($1,$2,'Empty chain requester','active',now())`,
      [emptyRequesterId, `empty-chain-${marker}@example.test`],
    );
    await postgresQuery(
      `INSERT INTO fractal.identity_role_assignments(id,identity_id,role,scope_type)
       VALUES($1,$2,'issuer','global')`,
      [randomUUID(), emptyRequesterId],
    );
    const emptyRequest = await createPrivacyRightsRequest({
      actorIdentityId: emptyRequesterId,
      requestType: "access",
      details: "Please disclose any exact public-chain record that Fractal links to my identity.",
      commandKey: randomUUID(),
    });
    await transitionAdministratorPrivacyRightsRequest({
      actorIdentityId: makerId,
      requestId: emptyRequest.request.id,
      action: "begin_review",
      message: "Review the exact wallet index before public-chain disclosure.",
      expectedVersion: 1,
    });
    const emptyChain = await requestPrivacyExternalSnapshot({
      actorIdentityId: makerId,
      privacyRequestId: emptyRequest.request.id,
      sourceKey: "external.chain.public_records",
      commandKey: randomUUID(),
    });
    let emptyChainContent = "";
    await expect(materializeOnePrivacyExternalSnapshot({
      workerId: "privacy-chain-empty-snapshot-test",
      supportedSourceKeys: ["external.chain.public_records"],
      store: async ({ snapshotId, content }) => {
        expect(snapshotId).toBe(emptyChain.snapshot.id);
        emptyChainContent = content.toString("utf8");
        return {
          storageKey: `local://privacy-external-snapshots/${snapshotId}/snapshot.json`,
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
      },
    })).resolves.toBe(true);
    expect(JSON.parse(emptyChainContent)).toEqual({
      sourceKey: "external.chain.public_records",
      records: [],
    });
    await expect(listAdministratorPrivacyExternalSnapshots({
      actorIdentityId: makerId,
      privacyRequestId: emptyRequest.request.id,
    })).resolves.toContainEqual(expect.objectContaining({
      id: emptyChain.snapshot.id,
      status: "available",
      recordCount: 0,
    }));

    const snapshots = await listAdministratorPrivacyExternalSnapshots({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
    });
    expect(snapshots).toContainEqual(expect.objectContaining({
      id: requested.snapshot.id,
      status: "available",
      recordCount: 1,
      byteCount: Buffer.byteLength(persistedContent, "utf8"),
    }));
    expect(snapshots).toContainEqual(expect.objectContaining({
      id: requestedChain.snapshot.id,
      status: "available",
      recordCount: 1,
      byteCount: Buffer.byteLength(persistedChainContent, "utf8"),
    }));
    await expect(postgresQuery(
      `UPDATE fractal.privacy_external_collection_snapshots
          SET content_sha256=$2 WHERE id=$1`,
      [requested.snapshot.id, "0".repeat(64)],
    )).rejects.toThrow("origin and evidence are immutable");

    const sourceAuthority = await postgresQuery<{ authority_key: string }>(
      "SELECT authority_key FROM fractal.privacy_data_sources WHERE source_key='external.resend.delivery'",
    );
    const coverage = await withPostgresTransaction((client) =>
      readPrivacyFulfillmentCoverage(client, requesterId, "access", request.request.id));
    expect(coverage.coveredAuthorities).toContain(sourceAuthority.rows[0]!.authority_key);

    const decision = await proposePrivacyRightsDecision({
      actorIdentityId: makerId,
      requestId: request.request.id,
      outcome: "approve",
      decisionSummary: "Provide eligible records with the exact current Resend snapshot and disclose remaining unavailable sources.",
      lawfulBasis: "Authenticated access processing is approved under the current source coverage and controlled package policy.",
      scopeOutcomes: [{
        category: "eligible_account_records",
        action: "provide",
        explanation: "The exact current Resend snapshot can be included while remaining source gaps stay visible.",
      }],
      commandKey: randomUUID(),
    });
    await decidePrivacyRightsDecision({
      actorIdentityId: checkerId,
      decisionRequestId: decision.decision.id,
      decision: "approve",
      reviewReason: "The decision uses the exact current coverage and does not hide unavailable external sources.",
    });
    const preparation = await preparePrivacyRightsPackageEvidence({
      actorIdentityId: makerId,
      requestId: request.request.id,
      expectedVersion: 4,
      commandKey: randomUUID(),
    });
    expect(preparation.preparation).toMatchObject({
      deliverable: false,
      outcome: "blocked_incomplete_coverage",
      externalSnapshotSourceCount: 3,
    });
    const storedPreparation = await postgresQuery<{
      external_snapshot_manifest: Array<{
        snapshotId: string;
        snapshotReference: string;
        sourceKey: string;
        contentSha256: string;
        recordCount: number;
        byteCount: number;
        collectedAt: string;
        expiresAt: string;
      }>;
      source_manifest: Array<{ sourceKey: string; status: string; contentSha256: string | null }>;
    }>(
      `SELECT external_snapshot_manifest,source_manifest
         FROM fractal.privacy_rights_package_preparations WHERE id=$1`,
      [preparation.preparation.id],
    );
    expect(storedPreparation.rows[0]!.external_snapshot_manifest).toEqual(expect.arrayContaining([
      expect.objectContaining({
        snapshotId: requested.snapshot.id,
        sourceKey: "external.resend.delivery",
      }),
      expect.objectContaining({
        snapshotId: requestedChain.snapshot.id,
        sourceKey: "external.chain.public_records",
      }),
      expect.objectContaining({
        snapshotId: requestedSumsub.snapshot.id,
        sourceKey: "external.identity_verification.provider",
      }),
    ]));
    expect(storedPreparation.rows[0]!.source_manifest).toContainEqual(expect.objectContaining({
      sourceKey: "external.resend.delivery",
      status: "collected",
      contentSha256: storedPreparation.rows[0]!.external_snapshot_manifest.find(
        (item) => item.sourceKey === "external.resend.delivery",
      )!.contentSha256,
    }));
    expect(storedPreparation.rows[0]!.source_manifest).toContainEqual(expect.objectContaining({
      sourceKey: "external.chain.public_records",
      status: "collected",
      contentSha256: storedPreparation.rows[0]!.external_snapshot_manifest.find(
        (item) => item.sourceKey === "external.chain.public_records",
      )!.contentSha256,
    }));
    const externalSections = await loadPrivacyExternalSnapshotSections(
      storedPreparation.rows[0]!.external_snapshot_manifest,
      async (storageKey) => ({
        buffer: storageKey.includes(requestedSumsub.snapshot.id)
          ? persistedSumsubContent
          : Buffer.from(
              storageKey.includes(requestedChain.snapshot.id)
                ? persistedChainContent
                : persistedContent,
              "utf8",
            ),
      }),
    );
    expect(externalSections.get("external.resend.delivery")?.records)
      .toEqual([expect.objectContaining({ lastEvent: "delivered" })]);
    expect(externalSections.get("external.chain.public_records")?.records)
      .toEqual([expect.objectContaining({ walletAddress })]);
    expect(
      externalSections.get("external.identity_verification.provider")?.artifacts,
    ).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentKey: "provider_export_artifacts",
        content: sumsubProviderContent,
      }),
      expect.objectContaining({
        componentKey: "identity_documents",
        content: sumsubDocument,
      }),
    ]));
    const finalPackageArchive = buildPrivacyPackageArchiveV2({
      packageDocument: {
        schemaVersion: "fractal-privacy-package-v2",
        canonicalFormat:
          "application/vnd.fractal.privacy-package+tar;version=2",
        deliveryReference: "PDP-CP146C-TEST",
      },
      artifacts: [
        ...externalSections.values(),
      ].flatMap((section) => section.artifacts ?? []),
    });
    const parsedFinalPackage = parsePrivacyPackageArchiveV2(
      finalPackageArchive.buffer,
    );
    expect(parsedFinalPackage.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        componentKey: "provider_export_artifacts",
        content: sumsubProviderContent,
      }),
      expect.objectContaining({
        componentKey: "identity_documents",
        content: sumsubDocument,
      }),
    ]));
    await expect(loadPrivacyExternalSnapshotSections(
      storedPreparation.rows[0]!.external_snapshot_manifest,
      async (storageKey) => ({
        buffer: storageKey.includes(requestedSumsub.snapshot.id)
          ? persistedSumsubContent
          : Buffer.from(
              storageKey.includes(requestedChain.snapshot.id)
                ? persistedChainContent
                : `${persistedContent} `,
              "utf8",
            ),
      }),
    )).rejects.toMatchObject({ code: "unavailable" });

    const available = snapshots.find((snapshot) => snapshot.id === requested.snapshot.id)!;
    const expiredAt = new Date(new Date(available.expiresAt!).getTime() + 1_000);
    const expiryLifecycle = await expireAndQueuePrivacyExternalSnapshotCleanup(expiredAt);
    expect(expiryLifecycle.expired).toBeGreaterThanOrEqual(3);
    expect(expiryLifecycle.cleanupQueued).toBe(0);
    const retention = await postgresQuery<{ retain_until: Date }>(
      `SELECT max(retain_until) AS retain_until
         FROM fractal.privacy_external_collection_snapshots
        WHERE id=ANY($1::uuid[])`,
      [[
        requested.snapshot.id,
        requestedChain.snapshot.id,
        requestedSumsub.snapshot.id,
        emptyChain.snapshot.id,
      ]],
    );
    const cleanupLifecycle = await expireAndQueuePrivacyExternalSnapshotCleanup(
      new Date(retention.rows[0]!.retain_until.getTime() + 1_000),
    );
    expect(cleanupLifecycle.cleanupQueued).toBeGreaterThanOrEqual(3);
    await dispatchPendingStorageCleanupTasks({
      workerId: "privacy-external-cleanup-test",
      remove: async () => undefined,
      logger: { info: () => undefined, error: () => undefined },
    });
    await expect(listAdministratorPrivacyExternalSnapshots({
      actorIdentityId: makerId,
      privacyRequestId: request.request.id,
    })).resolves.toContainEqual(expect.objectContaining({
      id: requested.snapshot.id,
      status: "destroyed",
      destroyedAt: expect.any(String),
    }));
    const current = await postgresQuery<{ current: boolean }>(
      "SELECT fractal.privacy_package_preparation_is_current($1) AS current",
      [preparation.preparation.id],
    );
    expect(current.rows).toEqual([{ current: false }]);
  });
});
