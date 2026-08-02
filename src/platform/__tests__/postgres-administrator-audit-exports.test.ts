import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePostgres: vi.fn(),
  withTransaction: vi.fn(),
  requireCapability: vi.fn(),
  idempotent: vi.fn(),
  appendAudit: vi.fn(),
  appendOutbox: vi.fn(),
}));
vi.mock("../../db/postgres.js", () => ({ requirePostgres: mocks.requirePostgres, withPostgresTransaction: mocks.withTransaction }));
vi.mock("../postgres-administrator-capabilities.js", () => ({ requireAdministratorCapability: mocks.requireCapability }));
vi.mock("../postgres-idempotency.js", () => ({ runPostgresIdempotentCommand: mocks.idempotent }));
vi.mock("../postgres-audit.js", () => ({ appendPostgresAuditEvent: mocks.appendAudit }));
vi.mock("../postgres-outbox.js", () => ({ appendOutboxEvent: mocks.appendOutbox }));

import {
  AdministratorAuditExportError,
  createAdministratorAuditExport,
  listAdministratorAuditExports,
  retrieveAdministratorAuditExport,
} from "../postgres-administrator-audit-exports.js";

type QueryResult = { rows?: unknown[]; rowCount?: number | null };
function clientWith(...results: QueryResult[]) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<QueryResult>>();
  for (const result of results) query.mockResolvedValueOnce({ rows: [], rowCount: 0, ...result });
  return { query };
}
function exportRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "export-1", requested_by_identity_id: "identity-1", requested_by_legal_name: "Operator One",
    filters: { query: null, action: null, scopeKey: null, actorId: null, from: null, to: null },
    sequence_high_watermark: "8", first_sequence: "7", last_sequence: "8", record_count: 2,
    content_sha256: "hash", content: { schemaVersion: "fractal.audit-export.v1", events: [] },
    created_at: new Date("2026-07-01T00:00:00.000Z"), ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work({ query: vi.fn() }));
  mocks.requireCapability.mockResolvedValue(undefined);
  mocks.appendAudit.mockResolvedValue({ id: "audit-1" });
  mocks.appendOutbox.mockResolvedValue(undefined);
  mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ status: number; body: unknown }> }) => {
    const result = await input.execute({ query: vi.fn() });
    return { body: result.body as any, replayed: false };
  });
});

describe("administrator audit exports", () => {
  it("validates export scope and record limits before it starts a command", async () => {
    await expect(createAdministratorAuditExport({ requestedByIdentityId: "identity-1", filters: {}, maxRecords: 0, commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createAdministratorAuditExport({ requestedByIdentityId: "identity-1", filters: { query: "x".repeat(201) }, maxRecords: 1, commandKey: "command-1" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(createAdministratorAuditExport({ requestedByIdentityId: "identity-1", filters: { from: new Date("2026-07-02"), to: new Date("2026-07-01") }, maxRecords: 1, commandKey: "command-1" })).rejects.toBeInstanceOf(AdministratorAuditExportError);
    expect(mocks.idempotent).not.toHaveBeenCalled();
  });

  it("creates a bounded canonical evidence export and emits an outbox event", async () => {
    const stored = exportRow();
    const client = clientWith(
      { rows: [{ sequence: "8" }], rowCount: 1 },
      { rows: [{ sequence: "7", id: "event-7", scope_key: "identity:1", organization_id: null, actor_id: "identity-1", actor_type: "user", actor_legal_name: "Operator One", actor_email: "operator@example.test", action: "identity.updated", entity_type: "identity", entity_id: "identity-1", reason: null, payload: { reason: "test" }, parent_hash: null, canonical_hash: "event-hash", occurred_at: new Date("2026-07-01T01:00:00.000Z") }], rowCount: 1 },
      {}, { rows: [stored], rowCount: 1 },
    );
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<{ status: number; body: any }> }) => {
      const result = await input.execute(client);
      return { body: result.body, replayed: false };
    });

    const result = await createAdministratorAuditExport({ requestedByIdentityId: "identity-1", filters: { query: "  operator  ", action: "identity.updated" }, maxRecords: 10, commandKey: "command-1" });
    expect(result).toMatchObject({ replayed: false, export: { id: "export-1", recordCount: 2, sequenceHighWatermark: "8" } });
    expect(mocks.requireCapability).toHaveBeenCalledWith(client, "identity-1", "audit_export");
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["8", "operator", "identity.updated", 11]));
    expect(mocks.appendAudit).toHaveBeenCalledWith(client, expect.objectContaining({ action: "administrator.audit_export.created" }));
    expect(mocks.appendOutbox).toHaveBeenCalledWith(client, expect.objectContaining({ eventType: "administrator.audit_export.created" }));
  });

  it("rejects an export that exceeds its selected record bound", async () => {
    const client = clientWith({ rows: [{ sequence: "8" }], rowCount: 1 }, { rows: [{}, {}], rowCount: 2 });
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(client));
    await expect(createAdministratorAuditExport({ requestedByIdentityId: "identity-1", filters: {}, maxRecords: 1, commandKey: "command-1" })).rejects.toMatchObject({ code: "too_broad" });
    expect(mocks.appendAudit).not.toHaveBeenCalled();
  });

  it("rejects a selected record whose canonical evidence exceeds the byte limit", async () => {
    const client = clientWith(
      { rows: [{ sequence: "8" }], rowCount: 1 },
      { rows: [{ sequence: "8", id: "event-8", scope_key: null, organization_id: null, actor_id: null, actor_type: "system", actor_legal_name: null, actor_email: null, action: "large.evidence", entity_type: "evidence", entity_id: "evidence-1", reason: null, payload: { retainedEvidence: "x".repeat(26 * 1024 * 1024) }, parent_hash: null, canonical_hash: "event-hash", occurred_at: new Date() }], rowCount: 1 },
    );
    mocks.idempotent.mockImplementation(async (input: { execute: (client: unknown) => Promise<unknown> }) => input.execute(client));
    await expect(createAdministratorAuditExport({ requestedByIdentityId: "identity-1", filters: {}, maxRecords: 1, commandKey: "command-1" })).rejects.toMatchObject({ code: "too_broad" });
  });

  it("lists exports only after the administrator capability check", async () => {
    const client = clientWith({ rows: [exportRow()], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(listAdministratorAuditExports({ requestedByIdentityId: "identity-1" })).resolves.toEqual({ exports: [expect.objectContaining({ id: "export-1", createdAt: "2026-07-01T00:00:00.000Z" })] });
    expect(mocks.requireCapability).toHaveBeenCalledWith(client, "identity-1", "audit_export");
  });

  it("retrieves only a present, integrity-valid canonical export", async () => {
    const content = { b: 2, a: 1 };
    const canonical = '{"a":1,"b":2}';
    const hash = createHash("sha256").update(canonical).digest("hex");
    const valid = clientWith({ rows: [exportRow({ content, content_sha256: hash })], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(valid));
    await expect(retrieveAdministratorAuditExport({ requestedByIdentityId: "identity-1", exportId: "export-1" })).resolves.toEqual(expect.objectContaining({ canonicalContent: canonical }));
    expect(mocks.appendAudit).toHaveBeenCalledWith(valid, expect.objectContaining({ action: "administrator.audit_export.retrieved" }));

    const missing = clientWith({ rows: [], rowCount: 0 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(missing));
    await expect(retrieveAdministratorAuditExport({ requestedByIdentityId: "identity-1", exportId: "missing" })).rejects.toMatchObject({ code: "not_found" });

    const corrupt = clientWith({ rows: [exportRow({ content, content_sha256: "wrong" })], rowCount: 1 });
    mocks.withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(corrupt));
    await expect(retrieveAdministratorAuditExport({ requestedByIdentityId: "identity-1", exportId: "export-1" })).rejects.toMatchObject({ code: "integrity" });
  });
});
