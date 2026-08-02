import { beforeEach, describe, expect, it, vi } from "vitest";

const withTransaction = vi.hoisted(() => vi.fn());
vi.mock("../../db/postgres.js", () => ({ withPostgresTransaction: withTransaction }));

import {
  InboxPayloadConflictError,
  claimInboxEvents,
  markInboxEventForRetry,
  markInboxEventProcessed,
  receiveInboxEvent,
} from "../postgres-inbox.js";

const identityA = "11111111-1111-4111-8111-111111111111";
const identityB = "22222222-2222-4222-8222-222222222222";

function queuedClient(...results: Array<unknown>) {
  const query = vi.fn<(sql: string, values?: unknown[]) => Promise<any>>();
  for (const result of results) query.mockResolvedValueOnce(result);
  return { query };
}

beforeEach(() => vi.clearAllMocks());

describe("Postgres inbox receipt", () => {
  it("receives a Sumsub event with attributed identity", async () => {
    const client = queuedClient({ rows: [{ identity_id: identityA }], rowCount: 1 }, { rows: [{ id: "inbox-1", processed_at: null }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: " event-1 ", payload: { event: { externalUserId: " user-1 ", applicantId: " applicant-1 " } } })).resolves.toEqual({ id: "inbox-1", duplicate: false, processed: false });
    expect(client.query.mock.calls[0]?.[1]).toEqual(["user-1", "applicant-1"]);
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["sumsub", "event-1", "subject_attributed", [identityA], "sumsub_application"]));
  });

  it("receives unlinked Sumsub evidence and rejects ambiguous provider identity", async () => {
    const unlinked = queuedClient({ rows: [], rowCount: 0 }, { rows: [{ id: "inbox-1", processed_at: null }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unlinked));
    await receiveInboxEvent({ provider: "sumsub", externalEventId: "event-1", payload: { event: "not-an-object" } });
    expect(unlinked.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining(["external_subject_unlinked", [], "known_provider_unlinked"]));

    const conflict = queuedClient({ rows: [{ identity_id: identityA }, { identity_id: identityB }], rowCount: 2 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(conflict));
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: "event-2", payload: {} })).rejects.toBeInstanceOf(InboxPayloadConflictError);
  });

  it("attributes Paystack payment, distribution, and professional transfer evidence", async () => {
    const payment = queuedClient({ rows: [{ identity_id: identityA }], rowCount: 1 }, { rows: [{ id: "payment", processed_at: null }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(payment));
    await receiveInboxEvent({ provider: "paystack", externalEventId: "payment", payload: { data: { reference: " ref-1 " } } });
    expect(payment.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([[identityA], "paystack_payment_reference"]));

    const distribution = queuedClient({ rows: [{ identity_id: identityA }], rowCount: 1 }, { rows: [], rowCount: 0 }, { rows: [{ id: "distribution", processed_at: null }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(distribution));
    await receiveInboxEvent({ provider: "paystack", externalEventId: "distribution", payload: { data: { transfer_code: "transfer-1" } } });
    expect(distribution.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([[identityA], "paystack_distribution_transfer"]));

    const professional = queuedClient({ rows: [], rowCount: 0 }, { rows: [{ identity_id: identityA }], rowCount: 1 }, { rows: [{ id: "professional", processed_at: null }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(professional));
    await receiveInboxEvent({ provider: "paystack", externalEventId: "professional", payload: { data: { transfer_code: "transfer-2" } } });
    expect(professional.query.mock.calls.at(-1)?.[1]).toEqual(expect.arrayContaining([[identityA], "paystack_professional_transfer"]));

    const unlinked = queuedClient({ rows: [{ id: "unlinked", processed_at: null }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(unlinked));
    await receiveInboxEvent({ provider: "paystack", externalEventId: "unlinked", payload: {} });
    expect(unlinked.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining(["external_subject_unlinked", [], "known_provider_unlinked"]));
  });

  it("rejects a Paystack event that maps to more than one identity", async () => {
    const client = queuedClient({ rows: [{ identity_id: identityA }], rowCount: 1 }, { rows: [{ identity_id: identityB }], rowCount: 1 }, { rows: [], rowCount: 0 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(receiveInboxEvent({ provider: "paystack", externalEventId: "conflict", payload: { data: { reference: "ref", transfer_code: "transfer" } } })).rejects.toBeInstanceOf(InboxPayloadConflictError);
  });

  it("resolves an immutable duplicate and rejects changed payload or attribution", async () => {
    const payload = { event: { applicantId: "applicant-1" } };
    let storedHash = "";
    const duplicate = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<any>>(async (sql, values) => {
      if (sql.includes("provider_identity_verification")) return { rows: [{ identity_id: identityA }], rowCount: 1 };
      if (sql.includes("INSERT INTO fractal.inbox_events")) { storedHash = String(values?.[4]); return { rows: [], rowCount: 0 }; }
      return { rows: [{ id: "inbox-1", payload_hash: storedHash, processed_at: new Date(), privacy_classification: "subject_attributed", privacy_subject_identity_ids: [identityA], privacy_attribution_basis: "sumsub_application" }], rowCount: 1 };
    }) };
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(duplicate));
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: "event-1", payload })).resolves.toEqual({ id: "inbox-1", duplicate: true, processed: true });

    const changed = queuedClient({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [{ id: "inbox-1", payload_hash: "other", processed_at: null, privacy_classification: "external_subject_unlinked", privacy_subject_identity_ids: [], privacy_attribution_basis: "known_provider_unlinked" }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(changed));
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: "event-1", payload: {} })).rejects.toBeInstanceOf(InboxPayloadConflictError);

    let changedStoredHash = "";
    const changedAttribution = { query: vi.fn<(sql: string, values?: unknown[]) => Promise<any>>(async (sql, values) => {
      if (sql.includes("provider_identity_verification")) return { rows: [{ identity_id: identityA }], rowCount: 1 };
      if (sql.includes("INSERT INTO fractal.inbox_events")) { changedStoredHash = String(values?.[4]); return { rows: [], rowCount: 0 }; }
      return { rows: [{ id: "inbox-1", payload_hash: changedStoredHash, processed_at: null, privacy_classification: "external_subject_unlinked", privacy_subject_identity_ids: [], privacy_attribution_basis: "known_provider_unlinked" }], rowCount: 1 };
    }) };
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(changedAttribution));
    // This branch checks attribution only after a matching payload hash. The stored record is intentionally incomplete.
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: "event-3", payload: {} })).rejects.toBeInstanceOf(InboxPayloadConflictError);
  });

  it("rejects invalid receipt input and a missing insert or duplicate record", async () => {
    await expect(receiveInboxEvent({ provider: "" as any, externalEventId: "event", payload: {} })).rejects.toThrow("provider is required");
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: " ", payload: {} })).rejects.toThrow("externalEventId is required");
    const missingInsert = queuedClient({ rows: [], rowCount: 0 }, { rows: [], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(missingInsert));
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: "event", payload: {} })).rejects.toThrow("insert did not return");
    const missingDuplicate = queuedClient({ rows: [], rowCount: 0 }, { rows: [], rowCount: 0 }, { rows: [], rowCount: 0 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(missingDuplicate));
    await expect(receiveInboxEvent({ provider: "sumsub", externalEventId: "event", payload: {} })).rejects.toThrow("disappeared during duplicate resolution");
  });
});

describe("Postgres inbox claim and result updates", () => {
  it("maps claimed events and skips empty provider or invalid-limit claims", async () => {
    await expect(claimInboxEvents({ workerId: "worker", providers: [], limit: 1, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    await expect(claimInboxEvents({ workerId: "worker", providers: ["paystack"], limit: 0, claimTimeoutSeconds: 60 })).resolves.toEqual([]);
    const client = queuedClient({ rows: [{ id: "inbox-1", provider: "paystack", external_event_id: "event-1", payload: {}, received_at: new Date(), attempts: 2 }], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(client));
    await expect(claimInboxEvents({ workerId: "worker", providers: ["paystack"], limit: 1, claimTimeoutSeconds: 60 })).resolves.toEqual([expect.objectContaining({ externalEventId: "event-1", attempts: 2 })]);
  });

  it("records processed and retry states only for the current worker claim", async () => {
    const client = queuedClient({ rows: [], rowCount: 1 }, { rows: [], rowCount: 0 });
    await expect(markInboxEventProcessed(client as any, "inbox-1", "worker")).resolves.toBeUndefined();
    await expect(markInboxEventProcessed(client as any, "inbox-1", "worker")).rejects.toThrow("no longer claimed");
    const retry = queuedClient({ rows: [], rowCount: 1 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(retry));
    await markInboxEventForRetry({ eventId: "inbox-1", workerId: "worker", retryAt: new Date(), error: "plain failure", terminal: true });
    expect(retry.query.mock.calls[0]?.[1]).toEqual(expect.arrayContaining([true, "plain failure"]));
    const lostRetry = queuedClient({ rows: [], rowCount: 0 });
    withTransaction.mockImplementation(async (work: (client: unknown) => Promise<unknown>) => work(lostRetry));
    await expect(markInboxEventForRetry({ eventId: "inbox-1", workerId: "worker", retryAt: new Date(), error: new Error("failure"), terminal: false })).rejects.toThrow("no longer claimed");
  });
});
