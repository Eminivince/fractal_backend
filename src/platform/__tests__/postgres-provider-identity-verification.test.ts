import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
import { listIdentityVerificationEvidenceForReviewer, ProviderIdentityVerificationEvidenceConflictError, recordSumsubIdentityVerificationEvidence } from "../postgres-provider-identity-verification.js";

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) { const query = vi.fn(); for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response }); mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query })); return query; }
beforeEach(() => { mocks.transaction.mockReset(); mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" }); mocks.outbox.mockReset().mockResolvedValue(undefined); });

describe("provider identity-verification evidence", () => {
  it("rejects a callback without required correlation fields", async () => {
    await expect(recordSumsubIdentityVerificationEvidence({ externalEventId: "", externalUserId: "user-1", applicantId: "applicant-1", eventType: "reviewCompleted", rawPayload: "{}" })).rejects.toThrow("missing its correlation fields");
  });

  it("returns an idempotent duplicate and rejects altered event evidence", async () => {
    transactionWithResponses({ rows: [{ id: "event-1", payload_hash: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a", identity_id: "identity-1" }] });
    await expect(recordSumsubIdentityVerificationEvidence({ externalEventId: "event-1", externalUserId: "user-1", applicantId: "applicant-1", eventType: "reviewCompleted", rawPayload: "{}" })).resolves.toEqual({ id: "event-1", identityId: "identity-1", duplicate: true });
    transactionWithResponses({ rows: [{ id: "event-1", payload_hash: "different", identity_id: null }] });
    await expect(recordSumsubIdentityVerificationEvidence({ externalEventId: "event-1", externalUserId: "user-1", applicantId: "applicant-1", eventType: "reviewCompleted", rawPayload: "{}" })).rejects.toBeInstanceOf(ProviderIdentityVerificationEvidenceConflictError);
  });

  it("records matched evidence with deduplicated labels and subject privacy", async () => {
    const query = transactionWithResponses({ rows: [] }, { rows: [{ id: "identity-1" }] }, { rowCount: 1 });
    await expect(recordSumsubIdentityVerificationEvidence({ externalEventId: "event-1", externalUserId: "user-1", applicantId: "applicant-1", eventType: "reviewCompleted", reviewStatus: " completed ", reviewAnswer: "GREEN", rejectLabels: [" document ", "document", ""], createdAtMs: "1780000000000", rawPayload: "{\"review\":true}", receivedAt: new Date("2026-07-01T00:00:00.000Z") })).resolves.toMatchObject({ identityId: "identity-1", duplicate: false });
    expect(query.mock.calls[2]![1]).toEqual(expect.arrayContaining([JSON.stringify(["document"])]));
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "identity.verification_evidence.recorded" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ privacy: { kind: "subjects", subjectIdentityIds: ["identity-1"] } }));
  });

  it("records unmatched evidence without a subject binding", async () => {
    transactionWithResponses({ rows: [] }, { rows: [] }, { rowCount: 1 });
    await expect(recordSumsubIdentityVerificationEvidence({ externalEventId: "event-1", externalUserId: "user-1", applicantId: "applicant-1", eventType: "reviewCompleted", rawPayload: "{}", createdAtMs: "not-a-time" })).resolves.toMatchObject({ identityId: null, duplicate: false });
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "identity.verification_evidence.unmatched" }));
    expect(mocks.outbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ privacy: { kind: "technical_no_subject" } }));
  });

  it("enforces evidence reader limits and records each reviewer view", async () => {
    await expect(listIdentityVerificationEvidenceForReviewer({ identityId: "identity-1", accessedByIdentityId: "admin-1", limit: 0 })).rejects.toThrow("between 1 and 100");
    transactionWithResponses({ rows: [{ id: "event-1", provider: "sumsub", external_event_id: "event-1", applicant_id: "applicant-1", event_type: "reviewCompleted", review_status: "completed", review_answer: "GREEN", reject_labels: [], provider_created_at: new Date("2026-07-01T00:00:00.000Z"), payload_hash: "a".repeat(64), received_at: new Date("2026-07-01T00:00:01.000Z"), recorded_at: new Date("2026-07-01T00:00:02.000Z") }] });
    await expect(listIdentityVerificationEvidenceForReviewer({ identityId: "identity-1", accessedByIdentityId: "admin-1" })).resolves.toEqual([expect.objectContaining({ externalEventId: "event-1", reviewAnswer: "GREEN", providerCreatedAt: "2026-07-01T00:00:00.000Z" })]);
    expect(mocks.audit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "identity.verification_evidence.viewed", actorId: "admin-1" }));
  });
});
