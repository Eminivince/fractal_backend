import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), idempotent: vi.fn(), capability: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  AdministratorProviderIncidentError,
  createAdministratorProviderIncident,
  getAdministratorProviderIncident,
  listAdministratorProviderIncidents,
  transitionAdministratorProviderIncident,
} from "../postgres-administrator-provider-incidents.js";

const detectedAt = new Date("2026-07-01T10:00:00.000Z");
const dueAt = new Date("2026-07-01T10:15:00.000Z");
const resolutionAt = new Date("2026-07-01T14:00:00.000Z");
const row = (overrides: Record<string, unknown> = {}) => ({
  id: "incident-1", provider_key: "sumsub", source: "manual", external_reference: "case-1", severity: "sev1", status: "open",
  summary: "Sumsub review delivery is unavailable.", user_impact: "New investor reviews cannot complete.", detection_evidence: { monitor: "failed" },
  detected_at: detectedAt, acknowledgement_due_at: dueAt, resolution_due_at: resolutionAt, owner_identity_id: "admin-1",
  owner_legal_name: "Admin One", owner_email: "admin@example.com", created_by_identity_id: "admin-1", creator_legal_name: "Admin One", creator_email: "admin@example.com",
  acknowledged_at: null, contained_at: null, resolved_at: null, version: 1, created_at: detectedAt, updated_at: detectedAt, ...overrides,
});

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

function executeIdempotent(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.idempotent.mockImplementationOnce(async (options: { execute: (client: { query: typeof query }) => Promise<{ body: unknown }> }) => {
    const value = await options.execute({ query });
    return { body: value.body, replayed: false };
  });
  return query;
}

beforeEach(() => {
  mocks.transaction.mockReset(); mocks.idempotent.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined);
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined);
});

describe("administrator provider incidents", () => {
  it("rejects invalid incident input before a command runs", async () => {
    await expect(createAdministratorProviderIncident({ actorIdentityId: "admin-1", providerKey: "Not valid!", source: "manual", severity: "sev1", summary: "Sumsub review delivery is unavailable.", userImpact: "New investor reviews cannot complete.", detectionEvidence: {}, detectedAt, reason: "The provider monitoring check found a delivery failure.", commandKey: "command-1" })).rejects.toBeInstanceOf(AdministratorProviderIncidentError);
    await expect(createAdministratorProviderIncident({ actorIdentityId: "admin-1", providerKey: "sumsub", source: "manual", severity: "sev1", summary: "Sumsub review delivery is unavailable.", userImpact: "New investor reviews cannot complete.", detectionEvidence: {}, detectedAt: new Date(Date.now() + 120_000), reason: "The provider monitoring check found a delivery failure.", commandKey: "command-1" })).rejects.toThrow("cannot be in the future");
    expect(mocks.idempotent).not.toHaveBeenCalled();
  });

  it("lists filtered incidents with safe evidence handling", async () => {
    const query = transactionWithResponses({ rows: [row()] });
    const result = await listAdministratorProviderIncidents({ actorIdentityId: "admin-1", status: "open", severity: "sev1", providerKey: "sumsub" });
    expect(result).toMatchObject({ incidents: [expect.objectContaining({ id: "incident-1", acknowledgementSlaState: "breached" })] });
    expect(result.incidents[0]).not.toHaveProperty("detectionEvidence");
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "provider_incident_manage");
    expect(query.mock.calls[0]![1]).toEqual(["open", "sev1", "sumsub"]);
  });

  it("returns full incident history only to a capable administrator", async () => {
    transactionWithResponses(
      { rows: [row()] },
      { rows: [{ id: "event-1", sequence: 1, event_type: "created", from_status: null, to_status: "open", from_severity: null, severity: "sev1", from_owner_identity_id: null, owner_identity_id: "admin-1", owner_legal_name: "Admin One", actor_identity_id: "admin-1", actor_legal_name: "Admin One", actor_email: "admin@example.com", acknowledgement_due_at: dueAt, resolution_due_at: resolutionAt, acknowledged_at: null, contained_at: null, resolved_at: null, reason: "The provider monitoring check found a delivery failure.", evidence: { monitor: "failed" }, occurred_at: detectedAt }] },
    );
    await expect(getAdministratorProviderIncident({ actorIdentityId: "admin-1", incidentId: "incident-1" })).resolves.toEqual(expect.objectContaining({ incident: expect.objectContaining({ detectionEvidence: { monitor: "failed" } }), events: [expect.objectContaining({ eventType: "created", owner: { id: "admin-1", legalName: "Admin One" } })] }));
  });

  it("configures a create command with a private administrator scope", async () => {
    mocks.idempotent.mockResolvedValue({ body: { incident: { id: "incident-1" } }, replayed: true });
    await expect(createAdministratorProviderIncident({ actorIdentityId: "admin-1", providerKey: " SUMSUB ", source: "manual", externalReference: " case-1 ", severity: "sev2", summary: "Sumsub review delivery is unavailable.", userImpact: "New investor reviews cannot complete.", detectionEvidence: { monitor: "failed" }, detectedAt, reason: "The provider monitoring check found a delivery failure.", commandKey: "command-1" })).resolves.toEqual({ incident: { id: "incident-1" }, replayed: true });
    expect(mocks.idempotent).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "administrator-provider-incident:admin-1", route: "POST:/v1/admin/provider-incidents", commandKey: "command-1", payload: expect.objectContaining({ providerKey: "sumsub", externalReference: "case-1" }) }));
  });

  it("creates an incident with an audit record and outbox event", async () => {
    const query = executeIdempotent({}, {}, { rows: [row()] });
    await expect(createAdministratorProviderIncident({ actorIdentityId: "admin-1", providerKey: "sumsub", source: "system_health", severity: "sev1", summary: "Sumsub review delivery is unavailable.", userImpact: "New investor reviews cannot complete.", detectionEvidence: { monitor: "failed" }, detectedAt, reason: "The provider monitoring check found a delivery failure.", commandKey: "command-1" })).resolves.toMatchObject({ incident: { id: "incident-1", status: "open" }, replayed: false });
    expect(mocks.capability).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(3);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "administrator.provider_incident.created" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "administrator.provider_incident.created" }));
  });

  it("rejects stale incident transitions before it writes an event", async () => {
    await expect(transitionAdministratorProviderIncident({ actorIdentityId: "admin-1", incidentId: "incident-1", action: "acknowledge", expectedVersion: 0, reason: "The on-call administrator accepted the incident.", evidence: {}, commandKey: "command-1" })).rejects.toThrow("positive integer");
    expect(mocks.idempotent).not.toHaveBeenCalled();
  });

  it("acknowledges an open incident and records its versioned transition", async () => {
    const current = row();
    const updated = row({ status: "acknowledged", acknowledged_at: new Date("2026-07-01T10:01:00.000Z"), version: 2 });
    const query = executeIdempotent({ rows: [current] }, {}, {}, { rows: [updated] });
    await expect(transitionAdministratorProviderIncident({ actorIdentityId: "admin-1", incidentId: "incident-1", action: "acknowledge", expectedVersion: 1, reason: "The on-call administrator accepted the incident.", evidence: { ticket: "OPS-1" }, commandKey: "command-1" })).resolves.toMatchObject({ incident: { status: "acknowledged", version: 2 }, replayed: false });
    expect(query).toHaveBeenCalledTimes(4);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "administrator.provider_incident.acknowledged", payload: expect.objectContaining({ version: 2 }) }));
  });
});
