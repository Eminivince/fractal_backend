import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), capability: vi.fn(), retrieve: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability, AdministratorCapabilityError: class AdministratorCapabilityError extends Error {} }));
vi.mock("../../services/storage.js", () => ({ retrieveFile: mocks.retrieve, deleteStoredFile: vi.fn(), persistPrivacyPackageBinary: vi.fn() }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { PrivacyPackageDeliveryError, claimPrivacyPackageDelivery, downloadOwnPrivacyPackage, expireAndQueuePrivacyPackageCleanup, listAdministratorPrivacyPackageDeliveries, listOwnPrivacyPackageDeliveries, requestPrivacyPackageDelivery } from "../postgres-privacy-package-deliveries.js";

const timestamp = new Date("2026-07-01T10:00:00.000Z");
const delivery = (overrides: Record<string, unknown> = {}) => ({ id: "delivery-1", reference: "PRD-20260701-ABCD1234", preparation_id: "preparation-1", privacy_request_id: "privacy-request-1", requester_identity_id: "requester-1", status: "available", canonical_format: "fractal-privacy-package-v1", source_manifest_sha256: "a".repeat(64), content_sha256: "b".repeat(64), byte_count: 2, storage_key: "privacy/delivery-1.json", requested_at: timestamp, retrieval_expires_at: new Date("2030-07-01T10:00:00.000Z"), retain_until: new Date("2031-07-01T10:00:00.000Z"), generated_at: timestamp, available_at: timestamp, expired_at: null, destroyed_at: null, failure_category: null, attempts: 1, ...overrides });
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.retrieve.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("privacy package deliveries", () => {
  it("rejects a missing delivery command key", async () => {
    transactionWithResponses({});
    await expect(requestPrivacyPackageDelivery({ actorIdentityId: "admin-1", preparationId: "preparation-1", commandKey: " " })).rejects.toBeInstanceOf(PrivacyPackageDeliveryError);
  });

  it("replays the same privacy delivery request and rejects a different preparation", async () => {
    transactionWithResponses({}, { rows: [delivery()] });
    await expect(requestPrivacyPackageDelivery({ actorIdentityId: "admin-1", preparationId: "preparation-1", commandKey: "command-1" })).resolves.toMatchObject({ replayed: true, delivery: { id: "delivery-1" } });
    transactionWithResponses({}, { rows: [delivery()] });
    await expect(requestPrivacyPackageDelivery({ actorIdentityId: "admin-1", preparationId: "preparation-2", commandKey: "command-1" })).rejects.toThrow("another delivery");
  });

  it("requires a different capable administrator to authorize a complete current preparation", async () => {
    const preparation = { id: "preparation-1", privacy_request_id: "privacy-request-1", requester_identity_id: "requester-1", deliverable: true, canonical_format: "fractal-privacy-package-v1", source_manifest_sha256: "a".repeat(64), requester_retrieval_hours: 24, package_retention_hours: 72, current: true, prepared_by_identity_id: "maker-1" };
    transactionWithResponses({}, { rows: [] }, { rows: [preparation] }, { rows: [delivery({ status: "queued", content_sha256: null, byte_count: null, storage_key: null, generated_at: null, available_at: null })] });
    await expect(requestPrivacyPackageDelivery({ actorIdentityId: "approver-1", preparationId: "preparation-1", commandKey: "command-1" })).resolves.toMatchObject({ replayed: false, delivery: { id: "delivery-1", status: "queued" } });
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "approver-1", "privacy_request_manage");
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.package_delivery_requested" }));
    transactionWithResponses({}, { rows: [] }, { rows: [preparation] });
    await expect(requestPrivacyPackageDelivery({ actorIdentityId: "maker-1", preparationId: "preparation-1", commandKey: "command-1" })).rejects.toThrow("different capable administrator");
  });

  it("returns no delivery when a worker has no available package claim", async () => {
    transactionWithResponses({ rows: [] });
    await expect(claimPrivacyPackageDelivery("worker-1")).resolves.toBeNull();
  });

  it("keeps requester and administrator delivery views separate", async () => {
    transactionWithResponses({ rows: [delivery()] });
    await expect(listOwnPrivacyPackageDeliveries({ actorIdentityId: "requester-1", privacyRequestId: "privacy-request-1" })).resolves.toEqual([expect.objectContaining({ id: "delivery-1", byteCount: 2 })]);
    transactionWithResponses({ rows: [delivery()] });
    await expect(listAdministratorPrivacyPackageDeliveries({ actorIdentityId: "admin-1", privacyRequestId: "privacy-request-1" })).resolves.toHaveLength(1);
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "privacy_request_manage");
  });

  it("verifies stored package bytes before an owner can download them", async () => {
    mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("{}") });
    const query = transactionWithResponses({}, { rows: [delivery({ content_sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" })] }, {});
    await expect(downloadOwnPrivacyPackage({ actorIdentityId: "requester-1", deliveryId: "delivery-1" })).resolves.toMatchObject({ delivery: { id: "delivery-1" }, buffer: Buffer.from("{}") });
    expect(query).toHaveBeenCalledTimes(3); expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.package_downloaded" }));
  });

  it("blocks package download on byte-integrity failure or an expired retrieval window", async () => {
    transactionWithResponses({}, { rows: [delivery()] }); mocks.retrieve.mockResolvedValueOnce({ buffer: Buffer.from("bad") });
    await expect(downloadOwnPrivacyPackage({ actorIdentityId: "requester-1", deliveryId: "delivery-1" })).rejects.toThrow("integrity verification failed");
    transactionWithResponses({}, { rows: [delivery({ retrieval_expires_at: new Date("2020-07-01T10:00:00.000Z") })] });
    await expect(downloadOwnPrivacyPackage({ actorIdentityId: "requester-1", deliveryId: "delivery-1" })).rejects.toThrow("retrieval window");
  });

  it("validates cleanup batch limits and reports empty cleanup work", async () => {
    await expect(expireAndQueuePrivacyPackageCleanup(timestamp, 0)).rejects.toThrow("between 1 and 1000");
    transactionWithResponses({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    await expect(expireAndQueuePrivacyPackageCleanup(timestamp, 10)).resolves.toEqual({ expired: 0, cleanupQueued: 0 });
  });
});
