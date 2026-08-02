import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ postgres: vi.fn(), transaction: vi.fn(), audit: vi.fn(), outbox: vi.fn(), capability: vi.fn(), idempotent: vi.fn() }));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.postgres, withPostgresTransaction: mocks.transaction }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.audit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.outbox }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.capability }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));

import {
  getLegalConsentStatus,
  listPlatformContent,
  listPublishedLegalDocumentHistory,
  listPublishedLegalDocuments,
  PlatformContentError,
  readPublishedLegalDocument,
  readPublishedLegalDocumentBytes,
  publishDuePlatformContent,
  recordLegalAcceptancesInTransaction,
} from "../postgres-platform-content.js";

const publicRow = {
  document_key: "terms", slug: "terms", title: "Terms of Service", document_type: "terms", jurisdiction_code: "NG", audience: "all",
  required_at_registration: true, projection_version: 3, version_id: "version-1", semantic_version: "1.2.3",
  content: { title: "Terms of Service", eyebrow: "Legal document", lead: "These terms explain the current service conditions in detail.", keyPoints: ["Read these terms before you use the service."], sections: [{ id: "terms", title: "Terms", paragraphs: ["This section describes the terms in sufficient detail." ] }] },
  content_bytes: Buffer.from('{"content":"terms"}'), content_sha256: "a".repeat(64), effective_at: new Date("2026-07-01T00:00:00.000Z"), published_at: new Date("2026-07-02T00:00:00.000Z"), reacceptance_required: true,
};

function postgresWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  mocks.postgres.mockReturnValue({ query });
  return query;
}

function transactionClient(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = vi.fn();
  for (const response of responses) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...response });
  return query;
}

function transactionWithResponses(...responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const query = transactionClient(...responses);
  mocks.transaction.mockImplementationOnce(async (operation: (client: { query: typeof query }) => unknown) => operation({ query }));
  return query;
}

beforeEach(() => {
  mocks.postgres.mockReset(); mocks.transaction.mockReset();
  mocks.audit.mockReset().mockResolvedValue({ id: "audit-1" });
  mocks.outbox.mockReset().mockResolvedValue(undefined);
  mocks.capability.mockReset().mockResolvedValue(undefined);
  mocks.idempotent.mockReset();
});

describe("platform legal content", () => {
  it("lists public document metadata and reports registration readiness", async () => {
    postgresWithResponses({ rows: [publicRow] }, { rows: [{ count: "1" }] });
    await expect(listPublishedLegalDocuments()).resolves.toMatchObject({
      documents: [expect.objectContaining({ documentKey: "terms", versionId: "version-1" })],
      registrationDocumentsAvailable: true,
    });

    postgresWithResponses({ rows: [publicRow] }, { rows: [{ count: "2" }] });
    await expect(listPublishedLegalDocuments()).resolves.toMatchObject({ registrationDocumentsAvailable: false });
  });

  it("reads a published document and refuses unavailable routes", async () => {
    const query = postgresWithResponses({ rows: [publicRow] });
    await expect(readPublishedLegalDocument("terms")).resolves.toMatchObject({ documentKey: "terms", content: publicRow.content, publishedAt: "2026-07-02T00:00:00.000Z" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("definition.slug=$1"), ["terms"]);

    postgresWithResponses({ rows: [] });
    await expect(readPublishedLegalDocument("missing")).rejects.toMatchObject({ code: "unavailable" });
  });

  it("reads history and immutable JSON evidence bytes", async () => {
    postgresWithResponses({ rows: [publicRow] });
    await expect(listPublishedLegalDocumentHistory("terms")).resolves.toMatchObject({ documents: [expect.objectContaining({ semanticVersion: "1.2.3" })] });
    postgresWithResponses({ rows: [] });
    await expect(listPublishedLegalDocumentHistory("missing")).rejects.toMatchObject({ code: "unavailable" });

    postgresWithResponses({ rows: [publicRow] });
    await expect(readPublishedLegalDocumentBytes("terms", "version-1")).resolves.toEqual({ bytes: publicRow.content_bytes, filename: "terms-1.2.3.json", contentSha256: "a".repeat(64) });
    postgresWithResponses({ rows: [] });
    await expect(readPublishedLegalDocumentBytes("terms", "missing")).rejects.toMatchObject({ code: "not_found" });
  });

  it("reports both required consent and accepted consent state", async () => {
    postgresWithResponses({ rows: [publicRow] }, { rows: [{ count: "1" }] });
    await expect(getLegalConsentStatus("identity-1")).resolves.toMatchObject({ available: true, required: [expect.objectContaining({ documentKey: "terms", content: undefined })], accepted: [] });

    postgresWithResponses({ rows: [{ ...publicRow, accepted_at: new Date("2026-07-03T00:00:00.000Z") }] }, { rows: [{ count: "1" }] });
    await expect(getLegalConsentStatus("identity-1")).resolves.toEqual({ available: true, required: [], accepted: [{ documentKey: "terms", versionId: "version-1", contentSha256: "a".repeat(64), acceptedAt: "2026-07-03T00:00:00.000Z" }] });
  });

  it("fails closed when required legal content is not all published", async () => {
    const client = { query: transactionClient({ rows: [] }, { rows: [{ count: "1" }] }) };
    await expect(recordLegalAcceptancesInTransaction(client as never, { identityId: "identity-1", references: [], context: "registration", affirmativeAction: "checkbox" })).rejects.toMatchObject({ code: "unavailable" });
  });

  it("requires exact current references before it writes legal acceptance evidence", async () => {
    const client = { query: transactionClient({ rows: [publicRow] }, { rows: [{ count: "1" }] }) };
    await expect(recordLegalAcceptancesInTransaction(client as never, { identityId: "identity-1", references: [], context: "registration", affirmativeAction: "checkbox" })).rejects.toMatchObject({ code: "invalid_input" });

    const staleClient = { query: transactionClient({ rows: [publicRow] }, { rows: [{ count: "1" }] }) };
    await expect(recordLegalAcceptancesInTransaction(staleClient as never, { identityId: "identity-1", references: [{ documentKey: "terms", versionId: "old-version", contentSha256: "a".repeat(64) }], context: "registration", affirmativeAction: "checkbox" })).rejects.toMatchObject({ code: "stale_version" });
  });

  it("records exact acceptance evidence with hashed request metadata", async () => {
    const query = transactionClient({ rows: [publicRow] }, { rows: [{ count: "1" }] }, { rowCount: 1 });
    const client = { query };
    await recordLegalAcceptancesInTransaction(client as never, {
      identityId: "identity-1", references: [{ documentKey: "terms", versionId: "version-1", contentSha256: "a".repeat(64) }], context: "registration", affirmativeAction: "checkbox", ip: "127.0.0.1", userAgent: "test-agent",
    });
    const parameters = query.mock.calls[2]![1] as unknown[];
    expect(parameters[8]).not.toBe("127.0.0.1");
    expect(parameters[9]).not.toBe("test-agent");
    expect(mocks.audit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "legal_document.accepted" }));
    expect(mocks.outbox).toHaveBeenCalledOnce();
  });

  it("uses the platform content error type", () => {
    expect(new PlatformContentError("missing", "not_found")).toMatchObject({ name: "PlatformContentError", code: "not_found" });
  });

  it("lists governed legal definitions with their current versions", async () => {
    transactionWithResponses(
      { rows: [{ document_key: "terms", slug: "terms", title: "Terms of Service", document_type: "terms", jurisdiction_code: "NG", audience: "all", required_at_registration: true, status: "active", projection_version: 3, published_version_id: "version-1" }] },
      { rows: [] },
    );
    await expect(listPlatformContent({ actorIdentityId: "admin-1" })).resolves.toEqual({ definitions: [expect.objectContaining({ key: "terms", projectionVersion: 3, publishedVersionId: "version-1", versions: [] })] });
    expect(mocks.capability).toHaveBeenCalledWith(expect.anything(), "admin-1", "platform_content_manage");
  });

  it("returns an empty scheduled-publication batch without opening a transaction", async () => {
    postgresWithResponses({ rows: [] });
    await expect(publishDuePlatformContent(new Date("2026-07-29T12:00:00.000Z"), 0)).resolves.toEqual({ published: 0, failed: 0, alreadyTerminal: 0 });
    expect(mocks.transaction).not.toHaveBeenCalled();
  });
});
