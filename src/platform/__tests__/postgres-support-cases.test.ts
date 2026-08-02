import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), idempotent: vi.fn(), capability: vi.fn(), configuration: vi.fn(), notification: vi.fn(), deliveries: vi.fn(), attachments: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: mocks.configuration }));
vi.mock("../postgres-support-notifications.js", () => ({ enqueueSupportNotification: mocks.notification, readSupportNotificationDeliveries: mocks.deliveries }));
vi.mock("../postgres-support-attachments.js", () => ({ readSupportCaseAttachments: mocks.attachments }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import { SupportCaseError, addRequesterSupportMessage, createSupportCase, getOwnSupportCase, listAdministratorSupportCases, listOwnSupportCases, transitionAdministratorSupportCase } from "../postgres-support-cases.js";

const openedAt = new Date("2026-07-01T10:00:00.000Z");
const supportCase = (overrides: Record<string, unknown> = {}) => ({
  id: "case-1", reference: "SUP-20260701-ABCD1234", requester_identity_id: "investor-1", requester_email: "investor@example.com", requester_legal_name: "Investor One", requester_role: "investor", category: "account_access", reported_impact: "blocked", subject: "I cannot access my investment account", description: "The sign-in flow cannot complete after the latest verification step.", related_reference: null, occurred_at: openedAt, status: "new", assigned_to_identity_id: null, assignee_email: null, assignee_legal_name: null, resolution_summary: null, version: 1, created_at: openedAt, last_activity_at: openedAt,
  service_obligation_id: null, service_cycle_number: null, service_priority: null, service_policy_version_id: null, service_policy_version_number: null, service_policy_projection_version: null, service_policy_value_sha256: null, service_policy_reference: null, service_policy_name: null, service_acknowledgement_due_at: null, service_escalation_due_at: null, service_resolution_due_at: null, service_acknowledged_at: null, service_escalated_at: null, service_resolution_met_at: null, service_acknowledgement_breached_at: null, service_resolution_breached_at: null, ...overrides,
});

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query;
}
function executeIdempotent(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.idempotent.mockImplementationOnce(async (options: { execute: (client: { query: typeof query }) => Promise<{ body: unknown }> }) => { const result = await options.execute({ query }); return { body: result.body, replayed: false }; }); return query;
}
beforeEach(() => { mocks.transaction.mockReset(); mocks.idempotent.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.configuration.mockReset().mockResolvedValue(null); mocks.notification.mockReset().mockResolvedValue(undefined); mocks.deliveries.mockReset().mockResolvedValue([]); mocks.attachments.mockReset().mockResolvedValue([]); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("support cases", () => {
  it("rejects unsafe case input before an idempotent command starts", async () => {
    await expect(createSupportCase({ actorIdentityId: "investor-1", actorRole: "investor", category: "account_access", reportedImpact: "blocked", subject: "short", description: "too short", occurredAt: openedAt, commandKey: "command-1" })).rejects.toBeInstanceOf(SupportCaseError);
    expect(mocks.idempotent).not.toHaveBeenCalled();
  });

  it("lists requester cases without staff-only details", async () => {
    const query = transactionWithResponses({ rows: [supportCase()] });
    const result = await listOwnSupportCases({ actorIdentityId: "investor-1", status: "new" });
    expect(result.cases[0]).toMatchObject({ id: "case-1", requester: { id: "investor-1", role: "investor" }, serviceLevel: null });
    expect(query.mock.calls[0]![1]).toEqual(["investor-1", "new"]);
  });

  it("does not disclose another requester's case", async () => {
    transactionWithResponses({ rows: [supportCase()] });
    await expect(getOwnSupportCase({ actorIdentityId: "investor-2", caseId: "case-1" })).rejects.toThrow("not found");
    expect(mocks.deliveries).not.toHaveBeenCalled();
  });

  it("configures case creation with a requester-only command scope", async () => {
    mocks.idempotent.mockResolvedValue({ body: { case: { id: "case-1" } }, replayed: true });
    await expect(createSupportCase({ actorIdentityId: "investor-1", actorRole: "investor", category: "account_access", reportedImpact: "blocked", subject: " I cannot access my investment account ", description: "The sign-in flow cannot complete after the latest verification step.", relatedReference: " ACC-1 ", occurredAt: openedAt, commandKey: "command-1" })).resolves.toEqual({ case: { id: "case-1" }, replayed: true });
    expect(mocks.idempotent).toHaveBeenCalledWith(expect.objectContaining({ scopeKey: "support-case:investor-1", route: "POST:/v1/support/cases", payload: expect.objectContaining({ relatedReference: "ACC-1" }) }));
  });

  it("creates a support case and sends the requester notification", async () => {
    const query = executeIdempotent({}, {}, { rows: [supportCase()] });
    await expect(createSupportCase({ actorIdentityId: "investor-1", actorRole: "investor", category: "account_access", reportedImpact: "blocked", subject: "I cannot access my investment account", description: "The sign-in flow cannot complete after the latest verification step.", occurredAt: openedAt, commandKey: "command-1" })).resolves.toMatchObject({ case: { id: "case-1", status: "new" }, replayed: false });
    expect(query).toHaveBeenCalledTimes(3); expect(mocks.notification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ notificationType: "opened", recipientIdentityId: "investor-1" }));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "support.case.opened" }));
  });

  it("rejects an out-of-date requester reply", async () => {
    const query = executeIdempotent({ rows: [supportCase({ version: 2 })] });
    await expect(addRequesterSupportMessage({ actorIdentityId: "investor-1", caseId: "case-1", message: "I can provide more information about this problem.", expectedVersion: 1, commandKey: "command-1" })).rejects.toThrow("changed after it was opened");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("requires administrator capability before it lists operational cases", async () => {
    transactionWithResponses({ rows: [supportCase()] });
    await expect(listAdministratorSupportCases({ actorIdentityId: "admin-1", status: "new", category: "account_access" })).resolves.toMatchObject({ cases: [expect.objectContaining({ id: "case-1" })] });
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "support_case_manage");
  });

  it("triages a new case, records the SLA acknowledgement, and increments its version", async () => {
    const current = supportCase(); const updated = supportCase({ status: "triaged", assigned_to_identity_id: "admin-1", assignee_email: "admin@example.com", assignee_legal_name: "Admin One", version: 2 });
    const query = executeIdempotent({ rows: [current] }, {}, {}, { rows: [] }, { rows: [updated] });
    await expect(transitionAdministratorSupportCase({ actorIdentityId: "admin-1", caseId: "case-1", action: "triage", expectedVersion: 1, message: "The support team accepted this case for review.", commandKey: "command-1" })).resolves.toMatchObject({ case: { status: "triaged", version: 2 }, replayed: false });
    expect(query).toHaveBeenCalledTimes(5); expect(mocks.capability).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "administrator.support_case.triaged" }));
  });
});
