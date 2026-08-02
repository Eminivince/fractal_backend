import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => { class CapabilityError extends Error {}; return { postgres: vi.fn(), transaction: vi.fn(), capability: vi.fn(), audit: vi.fn(), outbox: vi.fn(), CapabilityError }; });
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ AdministratorCapabilityError: mocks.CapabilityError, requireAdministratorCapability: mocks.capability }));
vi.mock("../privacy-external-adapter-runtime.js", () => ({ readActiveExternalPrivacyAdapterPolicyForBinding: vi.fn().mockResolvedValue(null) }));
vi.mock("../postgres-platform-configuration.js", () => ({ readActivePlatformConfigurationForBinding: vi.fn().mockResolvedValue(null) }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));

import {
  decidePrivacyRightsDecision,
  createPrivacyRightsRequest,
  listAdministratorPrivacyRightsRequests,
  listOwnPrivacyRightsRequests,
  PrivacyRightsError,
  proposePrivacyRightsDecision,
  readPrivacyFulfillmentCoverage,
  transitionAdministratorPrivacyRightsRequest,
  withdrawPrivacyRightsRequest,
} from "../postgres-privacy-rights.js";

const requestRow = {
  id: "request-1", reference: "PRV-20260729-ABCD1234", requester_identity_id: "requester-1", requester_email: "requester@example.test", requester_legal_name: "Requester One", requester_role: "issuer",
  request_type: "access", details: "Please provide a detailed export of my personal data.", identity_assurance: "authenticated_verified_email_session", email_verified_at_snapshot: new Date("2026-07-01T00:00:00.000Z"),
  policy_version_id: null, due_at: null, status: "submitted", assigned_to_identity_id: null, assignee_legal_name: null, current_decision_request_id: null, version: 1, created_at: new Date("2026-07-01T00:00:00.000Z"), last_activity_at: new Date("2026-07-01T00:00:00.000Z"),
  bound_policy_version_id: null, bound_policy_version_number: null, bound_policy_projection_version: null, bound_policy_value_sha256: null, bound_policy_reference: null, bound_policy_name: null, bound_policy_jurisdiction: null, bound_controller_name: null, bound_communication_channel: null, bound_deadline_basis: null, bound_response_calendar_days: null, bound_due_at: null, policy_bound_at: null,
};
function postgresWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.postgres.mockReturnValue({ query }); return query; }
function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.postgres.mockReset(); mocks.transaction.mockReset(); mocks.capability.mockReset().mockResolvedValue(undefined); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("privacy rights", () => {
  it("lists a requester's own mapped requests", async () => {
    postgresWithResponses({ rows: [requestRow] });
    await expect(listOwnPrivacyRightsRequests({ actorIdentityId: "requester-1" })).resolves.toEqual({ requests: [expect.objectContaining({ id: "request-1", requestType: "access", requester: { id: "requester-1", email: "requester@example.test", legalName: "Requester One", role: "issuer" }, policy: null })] });
  });

  it("requires privacy management capability for administrator request listing", async () => {
    transactionWithResponses({ rows: [requestRow] });
    await expect(listAdministratorPrivacyRightsRequests({ actorIdentityId: "admin-1", status: "submitted", requestType: "access" })).resolves.toMatchObject({ requests: [{ id: "request-1", status: "submitted" }] });
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "privacy_request_manage");
  });

  it("propagates capability denials as privacy-rights errors", async () => {
    mocks.capability.mockRejectedValueOnce(new mocks.CapabilityError("missing"));
    transactionWithResponses();
    await expect(listAdministratorPrivacyRightsRequests({ actorIdentityId: "admin-1" })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("rejects invalid structured decision proposals before a decision is written", async () => {
    transactionWithResponses({ rowCount: 0 });
    await expect(proposePrivacyRightsDecision({ actorIdentityId: "admin-1", requestId: "request-1", outcome: "approve", decisionSummary: "too short", lawfulBasis: "This lawful basis explanation has enough detail.", scopeOutcomes: [], commandKey: "command" })).rejects.toMatchObject({ code: "invalid_input" });
    transactionWithResponses({ rowCount: 0 });
    await expect(proposePrivacyRightsDecision({ actorIdentityId: "admin-1", requestId: "request-1", outcome: "approve", decisionSummary: "This decision summary has enough detail for validation.", lawfulBasis: "This lawful basis explanation has enough detail.", scopeOutcomes: [{ category: "identity", action: "refuse", explanation: "This explanation has more than twenty characters." }], commandKey: "command" })).rejects.toMatchObject({ code: "invalid_input" });
    transactionWithResponses({ rowCount: 0 });
    await expect(proposePrivacyRightsDecision({ actorIdentityId: "admin-1", requestId: "request-1", outcome: "partially_approve", decisionSummary: "This decision summary has enough detail for validation.", lawfulBasis: "This lawful basis explanation has enough detail.", scopeOutcomes: [{ category: "identity", action: "provide", explanation: "This explanation has more than twenty characters." }], commandKey: "command" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("requires a sufficient independent-review reason before it reads a decision", async () => {
    transactionWithResponses({ rowCount: 0 });
    await expect(decidePrivacyRightsDecision({ actorIdentityId: "admin-2", decisionRequestId: "decision-1", decision: "approve", reviewReason: "short" })).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("replays an identical verified requester request without creating a second intake", async () => {
    const replay = { ...requestRow, command_key: "command-1" };
    transactionWithResponses(
      {},
      { rows: [{ email_verified_at: new Date("2026-07-01T00:00:00.000Z"), roles: ["issuer"] }] },
      { rows: [replay] },
    );
    await expect(createPrivacyRightsRequest({ actorIdentityId: "requester-1", requestType: "access", details: requestRow.details, commandKey: "command-1" })).resolves.toMatchObject({ replayed: true, request: { id: "request-1" } });
  });

  it("moves a submitted request into review and writes its event and audit", async () => {
    const reviewed = { ...requestRow, status: "in_review", assigned_to_identity_id: "admin-1", assignee_legal_name: "Admin One", version: 2 };
    transactionWithResponses({}, { rows: [requestRow] }, {}, {}, { rows: [reviewed] });
    await expect(transitionAdministratorPrivacyRightsRequest({ actorIdentityId: "admin-1", requestId: "request-1", action: "begin_review", message: "The privacy owner started a controlled review.", expectedVersion: 1 })).resolves.toMatchObject({ request: { status: "in_review", assignee: { id: "admin-1" } } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.review_started" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: "privacy.request.review_started" }));
  });

  it("does not let another administrator change an assigned request", async () => {
    transactionWithResponses({}, { rows: [{ ...requestRow, status: "in_review", assigned_to_identity_id: "owner-1", assignee_legal_name: "Owner One" }] });
    await expect(transitionAdministratorPrivacyRightsRequest({ actorIdentityId: "admin-2", requestId: "request-1", action: "note", message: "Internal note", expectedVersion: 1 })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets the requester withdraw an open request and records the controlled closure", async () => {
    const withdrawn = { ...requestRow, status: "withdrawn", version: 2 };
    transactionWithResponses({}, { rows: [requestRow] }, {}, {}, { rows: [withdrawn] });
    await expect(withdrawPrivacyRightsRequest({ actorIdentityId: "requester-1", requestId: "request-1", reason: "I no longer need this privacy request.", expectedVersion: 1 })).resolves.toMatchObject({ request: { status: "withdrawn" } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "privacy.request.withdrawn" }));
  });

  it("calculates complete fulfillment coverage only for catalogued available authorities", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ active: false, pending: false }] })
      .mockResolvedValueOnce({ rows: [
        { authority_key: "identity", label: "Identity", source_count: "2", inventory_status: "catalogued", right_status: "available", blocker: null },
        { authority_key: "public", label: "Public", source_count: "0", inventory_status: "catalogued", right_status: "not_applicable", blocker: null },
      ] });
    await expect(readPrivacyFulfillmentCoverage({ query } as never, "requester-1", "access", "request-1")).resolves.toMatchObject({ complete: true, executionAvailable: true, coveredAuthorities: ["identity"], uncoveredAuthorities: [] });
  });

  it("uses the privacy-rights error type", () => {
    expect(new PrivacyRightsError("message", "policy_unavailable")).toMatchObject({ name: "PrivacyRightsError", code: "policy_unavailable" });
  });
});
