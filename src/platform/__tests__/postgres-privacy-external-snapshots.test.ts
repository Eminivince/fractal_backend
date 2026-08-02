import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class CapabilityError extends Error {}
  return {
    transaction: vi.fn(), capability: vi.fn(), audit: vi.fn(), outbox: vi.fn(),
    adapterBinding: vi.fn(), configurationBinding: vi.fn(), parseAttestationSet: vi.fn(),
    readiness: vi.fn(), chainRecords: vi.fn(), CapabilityError,
  };
});

vi.mock("../../db/postgres.js", () => ({
  requirePostgres: vi.fn(),
  withPostgresTransaction: mocks.transaction,
}));
vi.mock("../postgres-administrator-capabilities.js", () => ({
  AdministratorCapabilityError: mocks.CapabilityError,
  requireAdministratorCapability: mocks.capability,
}));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../privacy-external-adapter-runtime.js", () => ({ readActiveExternalPrivacyAdapterPolicyForBinding: mocks.adapterBinding }));
vi.mock("../privacy-external-attestation-runtime.js", () => ({ EXTERNAL_PRIVACY_ATTESTATION_SET_KEY: "privacy.external_source.attestation_set", readActiveExternalPrivacyAttestationReadiness: mocks.readiness }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: mocks.configurationBinding }));
vi.mock("../../modules/privacy/domain/privacy-external-attestation-set.js", () => ({ parsePrivacyExternalAttestationSet: mocks.parseAttestationSet }));
vi.mock("../../modules/privacy/domain/privacy-package-policy.js", () => ({ parsePrivacyPackagePolicy: vi.fn((value) => value) }));
vi.mock("../postgres-chain-privacy-references.js", () => ({ queryChainPrivacyRecordsForIdentity: mocks.chainRecords }));

import {
  claimPrivacyExternalSnapshot,
  expireAndQueuePrivacyExternalSnapshotCleanup,
  listAdministratorPrivacyExternalSnapshots,
  listOwnPrivacyExternalSnapshots,
  loadPrivacyExternalSnapshotSections,
  materializeOnePrivacyExternalSnapshot,
  PrivacyExternalSnapshotError,
  requestPrivacyExternalSnapshot,
} from "../postgres-privacy-external-snapshots.js";

const snapshotRow = {
  id: "snapshot-1", reference: "PXS-20260729-ABCD1234", privacy_request_id: "request-1", requester_identity_id: "requester-1",
  request_type: "access", source_key: "external.resend.delivery", status: "queued", adapter_policy_version_id: "policy-1",
  adapter_policy_version_number: 1, adapter_policy_projection_version: 1, adapter_policy_value_sha256: "a".repeat(64), source_policy: {},
  attestation_version_id: "attestation-1", attestation_version_number: 1, attestation_projection_version: 1, attestation_value_sha256: "b".repeat(64), source_attestation: {},
  package_policy_version_id: "package-1", package_policy_version_number: 1, package_policy_projection_version: 1, package_policy_value_sha256: "c".repeat(64),
  requested_by_identity_id: "admin-1", requested_at: new Date("2026-07-29T10:00:00.000Z"), retain_until: new Date("2026-07-30T10:00:00.000Z"),
  claimed_by: null, claimed_at: null, attempts: 0, record_count: null, byte_count: null, content_sha256: null, storage_key: null,
  collected_at: null, expires_at: null, expired_at: null, destroyed_at: null, failure_category: null, provider_export_id: null,
  canonical_format: "application/vnd.fractal.privacy-external-snapshot+json;version=1", artifact_count: 0, artifact_manifest: [],
};

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.transaction.mockReset();
  mocks.capability.mockReset().mockResolvedValue(undefined);
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockReset().mockResolvedValue(undefined);
  mocks.adapterBinding.mockReset();
  mocks.configurationBinding.mockReset();
  mocks.parseAttestationSet.mockReset();
  mocks.readiness.mockReset();
  mocks.chainRecords.mockReset();
});

describe("external privacy snapshots", () => {
  it("rejects invalid source and provider-export combinations before it starts a transaction", async () => {
    await expect(requestPrivacyExternalSnapshot({ actorIdentityId: "admin-1", privacyRequestId: "request-1", sourceKey: "unknown" as never, commandKey: "command-key-1" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(requestPrivacyExternalSnapshot({ actorIdentityId: "admin-1", privacyRequestId: "request-1", sourceKey: "external.resend.delivery", providerExportId: "a1d92c4f-b50a-42d5-8a95-b0737ae22a11", commandKey: "command-key-1" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(requestPrivacyExternalSnapshot({ actorIdentityId: "admin-1", privacyRequestId: "request-1", sourceKey: "external.identity_verification.provider", commandKey: "command-key-1" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });

  it("lists only snapshots for a privacy request owned by the actor", async () => {
    const query = transactionWithResponses({ rowCount: 1 }, { rows: [snapshotRow] });
    await expect(listOwnPrivacyExternalSnapshots({ actorIdentityId: "requester-1", privacyRequestId: "request-1" })).resolves.toEqual([
      expect.objectContaining({ id: "snapshot-1", status: "queued", requestedAt: "2026-07-29T10:00:00.000Z" }),
    ]);
    expect(query).toHaveBeenCalledTimes(2);

    transactionWithResponses({ rowCount: 0 });
    await expect(listOwnPrivacyExternalSnapshots({ actorIdentityId: "other-identity", privacyRequestId: "request-1" })).rejects.toMatchObject({ code: "not_found" });
  });

  it("requires the privacy management capability for administrator listing", async () => {
    mocks.capability.mockRejectedValueOnce(new mocks.CapabilityError("missing"));
    transactionWithResponses();
    await expect(listAdministratorPrivacyExternalSnapshots({ actorIdentityId: "admin-1", privacyRequestId: "request-1" })).rejects.toMatchObject({ code: "forbidden" });

    transactionWithResponses({ rows: [snapshotRow] });
    await expect(listAdministratorPrivacyExternalSnapshots({ actorIdentityId: "admin-1", privacyRequestId: "request-1" })).resolves.toHaveLength(1);
    expect(mocks.capability).toHaveBeenLastCalledWith(expect.anything(), "admin-1", "privacy_request_manage");
  });

  it("propagates an unexpected administrator capability failure", async () => {
    mocks.capability.mockRejectedValueOnce(new Error("database connection lost"));
    transactionWithResponses();
    await expect(listAdministratorPrivacyExternalSnapshots({ actorIdentityId: "admin-1", privacyRequestId: "request-1" })).rejects.toThrow("database connection lost");
  });

  it("validates privacy snapshot worker identifiers, timeouts, and source support", async () => {
    await expect(claimPrivacyExternalSnapshot(" ")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(claimPrivacyExternalSnapshot("worker-1", 29)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(claimPrivacyExternalSnapshot("worker-1", 3601)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(claimPrivacyExternalSnapshot("worker-1", 300, [])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(claimPrivacyExternalSnapshot("worker-1", 300, ["external.resend.delivery", "external.resend.delivery"])).rejects.toMatchObject({ code: "invalid_input" });
    await expect(claimPrivacyExternalSnapshot("worker-1", 300, ["unknown" as never])).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("claims the next supported snapshot or returns no work", async () => {
    const query = transactionWithResponses({ rows: [snapshotRow] });
    await expect(claimPrivacyExternalSnapshot("worker-1", 120, ["external.resend.delivery"])).resolves.toEqual(expect.objectContaining({ id: "snapshot-1", claimed_by: null }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("WITH candidate"), [120, "worker-1", ["external.resend.delivery"]]);

    transactionWithResponses({ rows: [] });
    await expect(claimPrivacyExternalSnapshot("worker-1")).resolves.toBeNull();
  });

  it("uses a typed error for public validation failures", () => {
    const error = new PrivacyExternalSnapshotError("message", "conflict");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PrivacyExternalSnapshotError");
    expect(error.code).toBe("conflict");
  });

  it("does not materialize when no supported snapshot is available", async () => {
    transactionWithResponses({ rows: [] });
    await expect(materializeOnePrivacyExternalSnapshot({ workerId: "worker-1" })).resolves.toBe(false);
  });

  it("materializes governed public-chain records into a verified canonical snapshot", async () => {
    const now = new Date("2026-07-29T10:00:00.000Z");
    const sourcePolicy = {
      sourceKey: "external.chain.public_records", collectionMode: "public_immutable_disclosure",
      correlation: { mode: "exact_wallet_binding", referenceFields: ["walletAddress"] },
      coverage: { inventoryVersion: "privacy-external-coverage-v1", componentKeys: ["verified_wallet_links", "allocation_chain_transactions", "approved_ownership_snapshots"] },
      rights: { access: { mode: "immutable_disclosure" }, portability: { mode: "collect" } },
      fields: ["balanceUnits", "blockHash", "blockNumber", "chainId", "operationType", "recordType", "tokenContractAddress", "transactionHash", "walletAddress"].map((outputField) => ({ handling: "include", outputField })),
      execution: { timeoutMs: 5000, maximumRecords: 50, maximumBytes: 100_000, evidenceMaximumAgeSeconds: 3600 },
    };
    const sourceAttestation = { payload: { sourceKey: "external.chain.public_records", observedAt: "2026-07-29T09:00:00.000Z", expiresAt: "2026-07-30T09:00:00.000Z" } };
    const materializingSnapshot = { ...snapshotRow, source_key: "external.chain.public_records", source_policy: sourcePolicy, source_attestation: sourceAttestation, claimed_by: "worker-1", status: "collecting" };
    mocks.adapterBinding.mockResolvedValue({ binding: { versionId: "policy-1", versionNumber: 1, projectionVersion: 1, valueSha256: "a".repeat(64) }, policy: { sources: [sourcePolicy] }, runtime: { sources: [{ sourceKey: "external.chain.public_records", status: "runtime_compatible" }] } });
    mocks.configurationBinding.mockResolvedValueOnce({ versionId: "attestation-1", versionNumber: 1, projectionVersion: 1, valueSha256: "b".repeat(64), value: {} }).mockResolvedValueOnce({ versionId: "package-1", versionNumber: 1, projectionVersion: 1, valueSha256: "c".repeat(64), value: { packageRetentionHours: 24 } });
    mocks.parseAttestationSet.mockReturnValue({ attestations: [sourceAttestation] });
    mocks.readiness.mockResolvedValue({ sources: [{ sourceKey: "external.chain.public_records", status: "valid" }] });
    mocks.chainRecords.mockResolvedValue([{ walletAddress: "0xabc" }]);
    transactionWithResponses({ rows: [materializingSnapshot] });
    transactionWithResponses();
    transactionWithResponses({ rowCount: 1 });
    const finalizationQuery = transactionWithResponses({ rows: [{ privacy_request_id: "request-1" }], rowCount: 1 });
    const store = vi.fn(async ({ content }: { content: Buffer }) => ({ storageKey: "private/snapshot.json", bytes: content.byteLength, sha256: createHash("sha256").update(content).digest("hex") }));
    await expect(materializeOnePrivacyExternalSnapshot({ workerId: "worker-1", supportedSourceKeys: ["external.chain.public_records"], runtimeOptions: { now }, collectChain: () => [{ recordType: "wallet" as const, chainId: 1, walletAddress: `0x${"a".repeat(40)}` }], store })).resolves.toBe(true);
    expect(store).toHaveBeenCalledWith(expect.objectContaining({ snapshotId: "snapshot-1" }));
    expect(finalizationQuery).toHaveBeenCalledWith(expect.stringContaining("SET status='available'"), expect.arrayContaining(["snapshot-1", "worker-1", 1]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.external_snapshot_available" }));
  });

  it("fails closed when a claimed snapshot loses its governed binding", async () => {
    const claimed = { ...snapshotRow, claimed_by: "worker-1", status: "collecting" };
    transactionWithResponses({ rows: [claimed] });
    transactionWithResponses();
    const failedQuery = transactionWithResponses({ rows: [{ privacy_request_id: "request-1", source_key: "external.resend.delivery" }], rowCount: 1 });
    mocks.adapterBinding.mockResolvedValue(null);
    await expect(materializeOnePrivacyExternalSnapshot({ workerId: "worker-1" })).resolves.toBe(true);
    expect(failedQuery).toHaveBeenCalledWith(expect.stringContaining("SET status='failed'"), ["snapshot-1", "worker-1", "attestation_changed"]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.external_snapshot_failed", payload: expect.objectContaining({ failureCategory: "attestation_changed" }) }));
  });

  it("validates expiry limits and returns zero counts when no snapshot has reached retention", async () => {
    await expect(expireAndQueuePrivacyExternalSnapshotCleanup(new Date(), 0)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(expireAndQueuePrivacyExternalSnapshotCleanup(new Date(), 1_001)).rejects.toMatchObject({ code: "invalid_input" });
    const query = transactionWithResponses({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await expect(expireAndQueuePrivacyExternalSnapshotCleanup(new Date("2026-07-29T10:00:00.000Z"), 25)).resolves.toEqual({ expired: 0, cleanupQueued: 0 });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("expires snapshots and queues durable cleanup after retention", async () => {
    const now = new Date("2026-07-29T10:00:00.000Z");
    const query = transactionWithResponses(
      { rows: [{ id: "snapshot-expired", privacy_request_id: "request-1", source_key: "external.resend.delivery" }], rowCount: 1 },
      { rows: [{ id: "snapshot-cleanup", storage_key: "private/snapshot.json", privacy_request_id: "request-1", source_key: "external.resend.delivery" }], rowCount: 1 },
      { rowCount: 1 },
      { rowCount: 1 },
    );
    await expect(expireAndQueuePrivacyExternalSnapshotCleanup(now, 10)).resolves.toEqual({ expired: 1, cleanupQueued: 1 });
    expect(query).toHaveBeenCalledTimes(4);
    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.outbox).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenNthCalledWith(1, expect.anything(), expect.objectContaining({ action: "privacy.request.external_snapshot_expired", entityId: "snapshot-expired" }));
    expect(mocks.audit).toHaveBeenNthCalledWith(2, expect.anything(), expect.objectContaining({ action: "privacy.request.external_snapshot_cleanup_requested", entityId: "snapshot-cleanup" }));
  });

  it("loads a current canonical JSON snapshot and rejects stale records", async () => {
    const content = Buffer.from('{"records":[{"id":"record-1"}],"sourceKey":"external.resend.delivery"}', "utf8");
    const manifest = [{
      snapshotId: "snapshot-1", snapshotReference: "PXS-20260729-ABCD1234", sourceKey: "external.resend.delivery" as const,
      contentSha256: createHash("sha256").update(content).digest("hex"), recordCount: 1, byteCount: content.byteLength,
      collectedAt: "2026-07-29T10:00:00.000Z", expiresAt: "2026-07-30T10:00:00.000Z",
    }];
    transactionWithResponses({ rows: [{ storage_key: "private/snapshot.json", canonical_format: "application/vnd.fractal.privacy-external-snapshot+json;version=1", artifact_count: 0, artifact_manifest: [] }] });
    const sections = await loadPrivacyExternalSnapshotSections(manifest, vi.fn().mockResolvedValue({ buffer: content }));
    expect(sections.get("external.resend.delivery")).toEqual(expect.objectContaining({ records: [{ id: "record-1" }], canonicalContent: content.toString("utf8") }));

    transactionWithResponses({ rows: [] });
    await expect(loadPrivacyExternalSnapshotSections(manifest, vi.fn())).rejects.toMatchObject({ code: "conflict" });
  });

  it("returns an empty section map for an empty package manifest", async () => {
    await expect(loadPrivacyExternalSnapshotSections([])).resolves.toEqual(new Map());
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
