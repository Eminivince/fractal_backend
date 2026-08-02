import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: vi.fn(), transaction: vi.fn(), capability: vi.fn(), idempotent: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));

import {
  activateDuePlatformConfigurationVersions,
  decidePlatformConfigurationVersion,
  getPlatformConfigurationVersion,
  listPlatformConfigurations,
  PlatformConfigurationError,
  proposePlatformConfigurationRollback,
  proposePlatformConfigurationVersion,
  readActivePlatformConfiguration,
  readActivePlatformConfigurationForBinding,
} from "../postgres-platform-configuration.js";

const versionRow = {
  id: "version-1", configuration_key: "support.case.service_policy", version_number: 2, state_version: 1, status: "active",
  proposed_value: { example: true }, value_sha256: "a".repeat(64), validation_output: { valid: true }, impact_preview: {}, reason: "A detailed approved configuration reason.",
  proposed_by_identity_id: "admin-1", proposer_legal_name: "Admin One", proposer_email: "admin@example.test", reviewed_by_identity_id: null, reviewer_legal_name: null, reviewer_email: null,
  decision_reason: null, effective_at: new Date("2026-07-01T00:00:00.000Z"), proposed_at: new Date("2026-06-30T00:00:00.000Z"), reviewed_at: null, activated_at: new Date("2026-07-01T00:00:00.000Z"), superseded_at: null, supersedes_version_id: null, rollback_of_version_id: null, failure_code: null, failure_detail: null,
};

function postgresWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.postgres.mockReturnValue({ query }); return query;
}
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query;
}
beforeEach(() => { mocks.postgres.mockReset(); mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.idempotent.mockReset(); });

describe("platform configuration", () => {
  it("lists definitions with mapped configuration versions", async () => {
    transactionWithResponses({ rows: [{ configuration_key: "support.case.service_policy", label: "Service policy", description: "Detailed policy", value_type: "json", validation_schema: {}, consumer_binding: "new_case", status: "active", projection_version: 3, active_version_id: "version-1" }] }, { rows: [versionRow] });
    await expect(listPlatformConfigurations({ actorIdentityId: "admin-1" })).resolves.toEqual({ definitions: [expect.objectContaining({ key: "support.case.service_policy", projectionVersion: 3, versions: [expect.objectContaining({ id: "version-1", proposedBy: { id: "admin-1", legalName: "Admin One", email: "admin@example.test" } })] })] });
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "platform_configuration_manage");
  });

  it("reads version events and activation attempts", async () => {
    transactionWithResponses({ rows: [versionRow] }, { rows: [{ id: "event-1", configuration_version_id: "version-1", sequence: 1, event_type: "proposed", from_status: null, to_status: "pending", actor_type: "user", actor_identity_id: "admin-1", actor_legal_name: "Admin One", reason: "Reason", evidence: {}, occurred_at: new Date("2026-06-30T00:00:00.000Z") }] }, { rows: [{ id: "attempt-1", outcome: "activated", due_at: new Date("2026-07-01T00:00:00.000Z"), attempted_at: new Date("2026-07-01T00:00:01.000Z"), lateness_ms: "1000", failure_code: null, failure_detail: null }] });
    await expect(getPlatformConfigurationVersion({ actorIdentityId: "admin-1", versionId: "version-1" })).resolves.toMatchObject({ version: { id: "version-1", status: "active" }, events: [expect.objectContaining({ eventType: "proposed", actor: { id: "admin-1", legalName: "Admin One" } })], activationAttempts: [{ id: "attempt-1", latenessMs: 1000 }] });
  });

  it("rejects invalid public proposal, decision, and rollback input before authority work", async () => {
    await expect(proposePlatformConfigurationVersion({ actorIdentityId: "admin-1", configurationKey: "key", proposedValue: true, expectedProjectionVersion: null, effectiveAt: new Date(), reason: "short", commandKey: "command" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(decidePlatformConfigurationVersion({ actorIdentityId: "admin-1", versionId: "version-1", action: "approve", expectedStateVersion: 0, decisionReason: "A valid decision reason", commandKey: "command" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(proposePlatformConfigurationRollback({ actorIdentityId: "admin-1", configurationKey: "key", targetVersionId: "version-1", expectedProjectionVersion: 1, effectiveAt: new Date(), reason: "short", commandKey: "command" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("reads an active public configuration and returns null when absent", async () => {
    postgresWithResponses({ rows: [{ active_version_id: "version-1", projection_version: 3, version_number: 2, proposed_value: { enabled: true }, value_sha256: "a".repeat(64), bound_at: new Date("2026-07-01T00:00:00.000Z") }] });
    await expect(readActivePlatformConfiguration("key")).resolves.toEqual({ configurationKey: "key", versionId: "version-1", versionNumber: 2, projectionVersion: 3, value: { enabled: true }, valueSha256: "a".repeat(64), boundAt: "2026-07-01T00:00:00.000Z" });
    postgresWithResponses({ rows: [] });
    await expect(readActivePlatformConfiguration("key")).resolves.toBeNull();
  });

  it("locks an active configuration binding for a consumer transaction", async () => {
    const client = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [{ active_version_id: "version-1", projection_version: 3, version_number: 2, proposed_value: { enabled: true }, value_sha256: "a".repeat(64) }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ bound_at: new Date("2026-07-01T00:00:00.000Z") }], rowCount: 1 }) };
    await expect(readActivePlatformConfigurationForBinding(client as never, "key")).resolves.toMatchObject({ configurationKey: "key", versionId: "version-1", projectionVersion: 3 });
  });

  it("returns no activation work when no scheduled configuration is due", async () => {
    postgresWithResponses({ rows: [] });
    await expect(activateDuePlatformConfigurationVersions(new Date("2026-07-29T10:00:00.000Z"), 500)).resolves.toEqual({ activated: 0, failed: 0, alreadyTerminal: 0 });
  });

  it("uses the configuration error type", () => {
    expect(new PlatformConfigurationError("message", "stale_version")).toMatchObject({ name: "PlatformConfigurationError", code: "stale_version" });
  });

  it("configures valid proposal and decision commands with attributed scopes", async () => {
    const mapped = { id: "version-1", status: "pending" };
    mocks.idempotent.mockResolvedValueOnce({ body: { version: mapped }, replayed: false });
    await expect(proposePlatformConfigurationVersion({ actorIdentityId: "admin-1", configurationKey: "support.case.service_policy", proposedValue: { enabled: true }, expectedProjectionVersion: 3, effectiveAt: new Date(Date.now() + 60 * 60_000), reason: "Enable the approved support case policy for new governed cases.", commandKey: "proposal-1" })).resolves.toEqual({ version: mapped, replayed: false });
    expect(mocks.idempotent).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "platform-configuration:admin-1", route: "POST:/v1/admin/platform-configuration/support.case.service_policy/versions", commandKey: "proposal-1" }));

    mocks.idempotent.mockResolvedValueOnce({ body: { version: { ...mapped, status: "scheduled" } }, replayed: true });
    await expect(decidePlatformConfigurationVersion({ actorIdentityId: "admin-2", versionId: "version-1", action: "approve", expectedStateVersion: 1, decisionReason: "The independent reviewer approves this governed configuration version.", commandKey: "decision-1" })).resolves.toEqual({ version: { ...mapped, status: "scheduled" }, replayed: true });
    expect(mocks.idempotent).toHaveBeenLastCalledWith(expect.objectContaining({ scopeKey: "platform-configuration:admin-2", route: "POST:/v1/admin/platform-configuration/versions/version-1/decision", commandKey: "decision-1" }));
  });
});
