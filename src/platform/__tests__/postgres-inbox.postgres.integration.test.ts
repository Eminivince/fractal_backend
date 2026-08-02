import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import {
  InboxPayloadConflictError,
  claimInboxEvents,
  markInboxEventForRetry,
  markInboxEventProcessed,
  receiveInboxEvent,
} from "../postgres-inbox.js";
import { dispatchPendingInboxEvents } from "../../services/postgres-inbox-dispatcher.js";

describe("PostgreSQL provider inbox", () => {
  beforeAll(async () => {
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
  });

  beforeEach(async () => {
    await postgresQuery("TRUNCATE fractal.inbox_events");
  });

  afterAll(async () => {
    await disconnectPostgres();
  });

  it("stores one durable provider event and rejects a conflicting replay", async () => {
    const first = await receiveInboxEvent({
      provider: "paystack",
      externalEventId: "charge.success:reference-1",
      payload: { event: "charge.success", reference: "reference-1", amount: 10_000 },
    });
    const duplicate = await receiveInboxEvent({
      provider: "paystack",
      externalEventId: "charge.success:reference-1",
      payload: { event: "charge.success", reference: "reference-1", amount: 10_000 },
    });
    expect(first).toMatchObject({ duplicate: false, processed: false });
    expect(duplicate).toEqual({ id: first.id, duplicate: true, processed: false });
    await expect(receiveInboxEvent({
      provider: "paystack",
      externalEventId: "charge.success:reference-1",
      payload: { event: "charge.success", reference: "reference-1", amount: 10_001 },
    })).rejects.toBeInstanceOf(InboxPayloadConflictError);
  });

  it("persists exact provider attribution, rejects mutation, and keeps unmatched external subjects explicit", async () => {
    const identityId = randomUUID();
    const applicationId = randomUUID();
    const externalUserId = identityId;
    const applicantId = `sumsub-${randomUUID()}`;
    const inspectionId = `inspection-${randomUUID()}`;
    await postgresQuery(
      `INSERT INTO fractal.identities(id,email,legal_name,status)
       VALUES($1,$2,'Inbox attribution subject','active')`,
      [identityId, `inbox-${identityId}@example.test`],
    );
    await postgresQuery(
      `INSERT INTO fractal.provider_identity_verification_applications
         (id,identity_id,provider,external_user_id,applicant_id,inspection_id,status,ready_at)
       VALUES($1,$2,'sumsub',$3,$4,$5,'ready',now())`,
      [applicationId, identityId, externalUserId, applicantId, inspectionId],
    );

    const linked = await receiveInboxEvent({
      provider: "sumsub",
      externalEventId: `sumsub-linked-${randomUUID()}`,
      payload: { event: { type: "applicantReviewed", externalUserId, applicantId }, rawBody: "private-raw", signature: "private-signature" },
    });
    const linkedRow = await postgresQuery<{
      privacy_classification: string; privacy_subject_identity_ids: string[]; privacy_attribution_basis: string;
    }>(
      `SELECT privacy_classification,privacy_subject_identity_ids,privacy_attribution_basis
         FROM fractal.inbox_events WHERE id=$1`,
      [linked.id],
    );
    expect(linkedRow.rows[0]).toEqual({
      privacy_classification: "subject_attributed",
      privacy_subject_identity_ids: [identityId],
      privacy_attribution_basis: "sumsub_application",
    });

    const conflictingIdentityId = randomUUID();
    const conflictingApplicantId = `sumsub-${randomUUID()}`;
    const conflictingInspectionId = `inspection-${randomUUID()}`;
    await postgresQuery(
      `INSERT INTO fractal.identities(id,email,legal_name,status)
       VALUES($1,$2,'Conflicting inbox attribution subject','active')`,
      [conflictingIdentityId, `inbox-${conflictingIdentityId}@example.test`],
    );
    await postgresQuery(
      `INSERT INTO fractal.provider_identity_verification_applications
         (id,identity_id,provider,external_user_id,applicant_id,inspection_id,status,ready_at)
       VALUES($1,$2,'sumsub',$3,$4,$5,'ready',now())`,
      [randomUUID(), conflictingIdentityId, conflictingIdentityId, conflictingApplicantId, conflictingInspectionId],
    );
    await expect(receiveInboxEvent({
      provider: "sumsub",
      externalEventId: `sumsub-ambiguous-${randomUUID()}`,
      payload: { event: { type: "applicantReviewed", externalUserId, applicantId: conflictingApplicantId } },
    })).rejects.toThrow("Provider event references more than one internal identity");

    await expect(postgresQuery(
      "UPDATE fractal.inbox_events SET privacy_subject_identity_ids='{}'::uuid[] WHERE id=$1",
      [linked.id],
    )).rejects.toThrow("event privacy attribution is immutable");

    const unlinked = await receiveInboxEvent({
      provider: "sumsub",
      externalEventId: `sumsub-unlinked-${randomUUID()}`,
      payload: { event: { type: "applicantReviewed", externalUserId: randomUUID(), applicantId: `unlinked-${randomUUID()}` } },
    });
    const unlinkedRow = await postgresQuery<{ privacy_classification: string; privacy_subject_identity_ids: string[] }>(
      "SELECT privacy_classification,privacy_subject_identity_ids FROM fractal.inbox_events WHERE id=$1",
      [unlinked.id],
    );
    expect(unlinkedRow.rows[0]).toEqual({ privacy_classification: "external_subject_unlinked", privacy_subject_identity_ids: [] });
    await expect(postgresQuery(
      `INSERT INTO fractal.inbox_events(id,provider,external_event_id,payload,payload_hash)
       VALUES($1,'paystack',$2,'{}',repeat('0',64))`,
      [randomUUID(), `legacy-${randomUUID()}`],
    )).rejects.toThrow("new event writes require an explicit privacy classification");
  });

  it("leases, retries, and completes provider events without duplicate processing", async () => {
    const event = await receiveInboxEvent({
      provider: "paystack",
      externalEventId: "charge.success:reference-2",
      payload: { event: "charge.success", reference: "reference-2" },
    });
    const [claimed] = await claimInboxEvents({ workerId: "worker-a", providers: ["paystack"], limit: 10, claimTimeoutSeconds: 60 });
    expect(claimed?.id).toBe(event.id);
    expect(claimed?.attempts).toBe(1);
    expect(await claimInboxEvents({ workerId: "worker-b", providers: ["paystack"], limit: 10, claimTimeoutSeconds: 60 })).toEqual([]);

    await markInboxEventForRetry({ eventId: event.id, workerId: "worker-a", retryAt: new Date(Date.now() - 1_000), error: new Error("temporary"), terminal: false });
    const [reclaimed] = await claimInboxEvents({ workerId: "worker-b", providers: ["paystack"], limit: 10, claimTimeoutSeconds: 60 });
    expect(reclaimed?.attempts).toBe(2);
    await withPostgresTransaction((client) => markInboxEventProcessed(client, event.id, "worker-b"));
    expect(await claimInboxEvents({ workerId: "worker-c", providers: ["paystack"], limit: 10, claimTimeoutSeconds: 60 })).toEqual([]);
  });

  it("records a terminal failure so it cannot loop forever", async () => {
    const event = await receiveInboxEvent({ provider: "paystack", externalEventId: "bad:1", payload: { bad: true } });
    await claimInboxEvents({ workerId: "worker-a", providers: ["paystack"], limit: 1, claimTimeoutSeconds: 60 });
    await markInboxEventForRetry({ eventId: event.id, workerId: "worker-a", retryAt: new Date(), error: "permanent", terminal: true });
    const row = await postgresQuery<{ failed_at: Date | null; last_error: string | null }>(
      "SELECT failed_at, last_error FROM fractal.inbox_events WHERE id = $1", [event.id],
    );
    expect(row.rows[0]?.failed_at).toBeTruthy();
    expect(row.rows[0]?.last_error).toBe("permanent");
  });

  it("runs business handling only from the leased dispatcher and then marks the event processed", async () => {
    const event = await receiveInboxEvent({
      provider: "paystack",
      externalEventId: "charge.success:dispatcher-1",
      payload: { eventType: "charge.success", data: { reference: "dispatcher-1" } },
    });
    const processed: string[] = [];
    const logger = { info: () => undefined, error: () => undefined };
    const count = await dispatchPendingInboxEvents({
      workerId: "dispatcher-a",
      providers: ["paystack"],
      process: async (claimed) => { processed.push(claimed.id); },
      logger,
    });
    expect(count).toBe(1);
    expect(processed).toEqual([event.id]);
    const row = await postgresQuery<{ processed_at: Date | null; attempts: number }>(
      "SELECT processed_at, attempts FROM fractal.inbox_events WHERE id = $1", [event.id],
    );
    expect(row.rows[0]?.processed_at).toBeTruthy();
    expect(row.rows[0]?.attempts).toBe(1);
  });
});
