import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() => vi.fn(async (operation: (client: { query: typeof query }) => Promise<unknown>) => operation({ query })));
const capability = vi.hoisted(() => vi.fn(async () => undefined));
const audit = vi.hoisted(() => vi.fn(async () => ({ id: "audit-1" })));
const outbox = vi.hoisted(() => vi.fn(async () => undefined));
const configuration = vi.hoisted(() => vi.fn());
const coverage = vi.hoisted(() => vi.fn());

const profile = {
  profileReference: "PRIVACY-CONTENT-1", profileName: "Privacy content profile", schemaVersion: "privacy-content-profile-v1", fieldCatalogVersion: "privacy-safe-fields-v1", jurisdictionCode: "NG", legalBasisReference: "basis-1", effectiveScope: "platform",
  access: { sourceRules: [{ sourceKey: "postgres.fractal.identities", includedFields: ["email"] }] },
  portability: { sourceRules: [{ sourceKey: "postgres.fractal.identities", includedFields: ["email"] }] },
} as any;
const policy = { policyReference: "PRIVACY-PACKAGE-1", policyName: "Privacy package policy", canonicalFormat: "fractal-privacy-package-json-v1", identityAssurance: "authenticated_verified_email_session", deliveryChannel: "authenticated_register", allowInternalIncompletePreparation: false, maximumRecords: 1000, maximumBytes: 1_000_000, packageRetentionHours: 48, requesterRetrievalHours: 24 } as any;

vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: transaction }));
vi.mock("../../modules/privacy/domain/privacy-content-profile.js", () => ({ parsePrivacyContentProfile: () => profile }));
vi.mock("../../modules/privacy/domain/privacy-package-policy.js", () => ({ parsePrivacyPackagePolicy: () => policy }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ AdministratorCapabilityError: class AdministratorCapabilityError extends Error {}, requireAdministratorCapability: capability }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: outbox }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: configuration }));
vi.mock("../postgres-privacy-rights.js", async () => {
  const actual = await vi.importActual<typeof import("../postgres-privacy-rights.js")>("../postgres-privacy-rights.js");
  return { ...actual, readPrivacyFulfillmentCoverage: coverage };
});

import { PrivacyRightsError } from "../postgres-privacy-rights.js";
import { collectCanonicalPrivacySourceSections, listPrivacyRightsPackagePreparations, preparePrivacyRightsPackageEvidence } from "../postgres-privacy-package-preparations.js";

const now = new Date("2026-07-28T10:00:00.000Z");
const binding = (key: string) => ({ configurationKey: key, versionId: `${key}-version`, versionNumber: 2, projectionVersion: 3, valueSha256: "a".repeat(64), value: key.includes("content") ? profile : policy });
const fulfillmentCoverage = { complete: true, executionAvailable: true, sources: [] } as any;
const preparation = {
  id: "preparation-1", reference: "PRP-20260728-ABCDEFGH", privacy_request_id: "request-1", decision_request_id: "decision-1", requester_identity_id: "requester-1", request_type: "access", request_version: 4,
  policy_version_id: "policy-version", policy_version_number: 2, policy_projection_version: 3, policy_value_sha256: "a".repeat(64), policy_reference: policy.policyReference, policy_name: policy.policyName, canonical_format: policy.canonicalFormat, identity_assurance: policy.identityAssurance, delivery_channel: policy.deliveryChannel, maximum_records: 1000, maximum_bytes: 1_000_000, maximum_artifacts: 0, package_retention_hours: 48, requester_retrieval_hours: 24, coverage_snapshot: fulfillmentCoverage,
  content_profile_binding_status: "governed", content_profile_reference: profile.profileReference, content_profile_name: profile.profileName, content_profile_schema_version: profile.schemaVersion, content_profile_field_catalog_version: profile.fieldCatalogVersion, content_profile_jurisdiction_code: profile.jurisdictionCode, content_profile_value_sha256: "b".repeat(64), coverage_sha256: "c".repeat(64), transaction_snapshot: "1:1:", audit_sequence_high_watermark: "7", source_manifest: [], source_manifest_sha256: "d".repeat(64), external_snapshot_manifest: [], collected_source_count: 1, unavailable_source_count: 0, not_applicable_source_count: 0, collected_record_count: 1, collected_byte_count: 42, outcome: "ready_for_delivery", deliverable: true, prepared_by_identity_id: "admin-1", prepared_at: now,
} as any;

beforeEach(() => { query.mockReset(); transaction.mockClear(); capability.mockClear(); audit.mockClear(); outbox.mockClear(); configuration.mockReset(); coverage.mockReset(); });

describe("PostgreSQL privacy package preparations", () => {
  it("collects only profile-approved safe fields and detects profile collector drift", async () => {
    const client = { query } as any;
    query.mockResolvedValueOnce({ rows: [{ record: { email: "person@example.com", passwordHash: "secret" } }] });
    const sections = await collectCanonicalPrivacySourceSections(client, "requester-1", "access", profile);
    expect(sections.get("postgres.fractal.identities")).toEqual(expect.objectContaining({ records: [{ email: "person@example.com" }], contentSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }));
    expect(query).toHaveBeenCalledWith(expect.stringContaining("FROM fractal.identities"), ["requester-1"]);
    query.mockResolvedValueOnce({ rows: [{ record: { wrong: "value" } }] });
    await expect(collectCanonicalPrivacySourceSections(client, "requester-1", "access", profile)).rejects.toBeInstanceOf(PrivacyRightsError);
  });

  it("records a governed complete preparation under an exact policy, content profile, and coverage snapshot", async () => {
    configuration.mockResolvedValueOnce(binding("privacy.rights.package_policy")).mockResolvedValueOnce(binding("privacy.rights.content_profile")); coverage.mockResolvedValueOnce(fulfillmentCoverage);
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "request-1", requester_identity_id: "requester-1", request_type: "access", status: "approved", version: 4, current_decision_request_id: "decision-1" }] })
      .mockResolvedValueOnce({ rows: [{ id: "decision-1", status: "applied", scope_outcomes: [{ action: "provide" }], fulfillment_coverage: fulfillmentCoverage }] })
      .mockResolvedValueOnce({ rows: [{ record: { email: "person@example.com" } }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ source_key: "postgres.fractal.identities", authority_key: "identity", source_kind: "postgres_relation", contains_personal_data: true, access_status: "available", portability_status: "available", blocker: null }] })
      .mockResolvedValueOnce({ rows: [{ snapshot: "1:1:" }] }).mockResolvedValueOnce({ rows: [{ sequence: "7" }] }).mockResolvedValueOnce({ rows: [preparation] });
    await expect(preparePrivacyRightsPackageEvidence({ actorIdentityId: "admin-1", requestId: "request-1", expectedVersion: 4, commandKey: " command-1 " })).resolves.toEqual({ preparation: expect.objectContaining({ id: "preparation-1", deliverable: true, contentProfile: expect.objectContaining({ reference: profile.profileReference }) }), replayed: false });
    expect(capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "privacy_request_manage");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO fractal.privacy_rights_package_preparations"), expect.arrayContaining(["request-1", "decision-1", "requester-1", "access", 4, "command-1"]));
    expect(audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.package_preparation_recorded" }));
    expect(outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "privacy.request.package_preparation_recorded" }));
  });

  it("replays only the same command and fails closed for stale or invalid preparation state", async () => {
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [preparation] });
    await expect(preparePrivacyRightsPackageEvidence({ actorIdentityId: "admin-1", requestId: "request-1", expectedVersion: 4, commandKey: "command-1" })).resolves.toEqual({ preparation: expect.objectContaining({ id: "preparation-1" }), replayed: true });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ ...preparation, request_version: 3 }] });
    await expect(preparePrivacyRightsPackageEvidence({ actorIdentityId: "admin-1", requestId: "request-1", expectedVersion: 4, commandKey: "command-1" })).rejects.toThrow("different package preparation");
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(preparePrivacyRightsPackageEvidence({ actorIdentityId: "admin-1", requestId: "missing", expectedVersion: 1, commandKey: "command-1" })).rejects.toThrow("not found");
    await expect(preparePrivacyRightsPackageEvidence({ actorIdentityId: "admin-1", requestId: "request-1", expectedVersion: 4, commandKey: " " })).rejects.toThrow("Command key");
  });

  it("lists preparations only for a capable administrator or the owning requester", async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }).mockResolvedValueOnce({ rows: [preparation] });
    await expect(listPrivacyRightsPackagePreparations({ actorIdentityId: "requester-1", requestId: "request-1", administrator: false })).resolves.toEqual([expect.objectContaining({ reference: preparation.reference })]);
    query.mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(listPrivacyRightsPackagePreparations({ actorIdentityId: "other", requestId: "request-1", administrator: false })).rejects.toThrow("not found");
    query.mockResolvedValueOnce({ rows: [preparation] });
    await expect(listPrivacyRightsPackagePreparations({ actorIdentityId: "admin-1", requestId: "request-1", administrator: true })).resolves.toHaveLength(1);
    expect(capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "privacy_request_manage");
  });
});
