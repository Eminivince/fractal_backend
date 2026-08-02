import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { applyPostgresMigrations } from "../../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../../db/postgres.js";
import {
  consumePostgresEmailVerificationToken,
  consumePostgresPasswordResetToken,
  createPostgresAuthIdentity,
  getPostgresAuthIdentityById,
  PostgresIdentityProjectionError,
  projectLegacyIdentity,
  recordPostgresEmailVerificationToken,
  recordPostgresPasswordResetToken,
} from "../postgres-identities.js";
import {
  ProviderIdentityVerificationEvidenceConflictError,
  listIdentityVerificationEvidenceForReviewer,
  recordSumsubIdentityVerificationEvidence,
} from "../postgres-provider-identity-verification.js";
import {
  claimIdentityVerificationApplications,
  getIdentityVerificationApplication,
  recordIdentityVerificationAccessTokenIssued,
  requestIdentityVerificationApplication,
} from "../postgres-identity-verification-applications.js";
import { processIdentityVerificationApplication } from "../../services/identity-verification-application-dispatcher.js";
import type { EmailPayload } from "../../services/email.js";
import { SumsubApplicantNotFoundError } from "../../services/sumsub.js";
import { buildIdentityCutoverReport } from "../identity-cutover-verification.js";
import {
  dispatchPendingAuthEmailDeliveries,
  enqueueAdministratorActivationDelivery,
  getAuthEmailDeliveryHealth,
  requestAuthEmailDelivery,
} from "../postgres-auth-email-deliveries.js";

let createdIdentityIds: string[] = [];

describe("PostgreSQL identity projection", () => {
  beforeAll(async () => { await connectPostgres({ required: true }); await applyPostgresMigrations(); });
  // The dispatcher intentionally claims every pending delivery. Keep this file
  // hermetic even when a developer reuses an isolated test database after a
  // browser run; the Vitest config already refuses non-test database names.
  beforeEach(async () => { await postgresQuery("TRUNCATE fractal.auth_email_deliveries"); });
  afterEach(async () => {
    if (!createdIdentityIds.length) return;
    await postgresQuery("DELETE FROM fractal.auth_email_deliveries WHERE identity_id = ANY($1::uuid[])", [createdIdentityIds]);
    await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [createdIdentityIds]);
    await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [createdIdentityIds]);
    createdIdentityIds = [];
  });
  afterAll(async () => { await disconnectPostgres(); });

  it("creates, refreshes, and re-roles a legacy identity without a separate backfill", async () => {
    const legacyMongoId = `legacy-${randomUUID()}`;
    const email = `identity-${randomUUID()}@example.test`;
    const identityId = await projectLegacyIdentity({ legacyMongoId, email, legalName: "New Account", role: "investor", passwordHash: "hash-a" });
    createdIdentityIds.push(identityId);
    await projectLegacyIdentity({ legacyMongoId, email, legalName: "Updated Account", role: "issuer", passwordHash: "hash-b", emailVerified: true });
    const identity = await postgresQuery<{ legal_name: string; password_hash: string; email_verified_at: Date | null }>(
      "SELECT legal_name, password_hash, email_verified_at FROM fractal.identities WHERE id = $1", [identityId],
    );
    expect(identity.rows[0]?.legal_name).toBe("Updated Account");
    expect(identity.rows[0]?.password_hash).toBe("hash-b");
    expect(identity.rows[0]?.email_verified_at).toBeTruthy();
    const roles = await postgresQuery<{ role: string; revoked_at: Date | null }>(
      "SELECT role, revoked_at FROM fractal.identity_role_assignments WHERE identity_id = $1 ORDER BY role", [identityId],
    );
    expect(roles.rows).toEqual([{ role: "investor", revoked_at: expect.any(Date) }, { role: "issuer", revoked_at: null }]);
  });

  it("rejects binding an existing email to a different legacy identity", async () => {
    const email = `conflict-${randomUUID()}@example.test`;
    const firstIdentityId = await projectLegacyIdentity({ legacyMongoId: `first-${randomUUID()}`, email, legalName: "First", role: "investor" });
    createdIdentityIds.push(firstIdentityId);
    await expect(projectLegacyIdentity({ legacyMongoId: `second-${randomUUID()}`, email, legalName: "Second", role: "issuer" }))
      .rejects.toBeInstanceOf(PostgresIdentityProjectionError);
  });

  it("requires exact legacy identity facts and exactly one matching active global role for cutover", () => {
    const legacy = [{
      legacyMongoId: "legacy-cutover-source",
      email: "cutover@example.test",
      legalName: "Cutover source",
      status: "active" as const,
      passwordHash: "bcrypt-source-hash",
      emailVerified: true,
      credentialInvalidatedAt: null,
      role: "investor",
    }];
    const matching = buildIdentityCutoverReport({
      legacy,
      postgresLegacy: [{
        id: randomUUID(),
        legacyMongoId: "legacy-cutover-source",
        email: "cutover@example.test",
        legalName: "Cutover source",
        status: "active",
        passwordHash: "bcrypt-source-hash",
        emailVerified: true,
        credentialInvalidatedAt: null,
        activeGlobalRoles: ["investor"],
      }],
      unmappedActiveSessions: 0,
    });
    expect(matching).toMatchObject({ ok: true, mismatches: { fieldMismatch: 0, roleMismatch: 0 } });

    const duplicateRole = buildIdentityCutoverReport({
      legacy,
      postgresLegacy: [{
        id: randomUUID(),
        legacyMongoId: "legacy-cutover-source",
        email: "cutover@example.test",
        legalName: "Cutover source",
        status: "active",
        passwordHash: "bcrypt-source-hash",
        emailVerified: true,
        credentialInvalidatedAt: null,
        activeGlobalRoles: ["investor", "issuer"],
      }],
      unmappedActiveSessions: 1,
    });
    expect(duplicateRole).toMatchObject({
      ok: false,
      mismatches: { roleMismatch: 1, unmappedActiveSessions: 1 },
    });
  });

  it("owns native credentials and one-time email/reset tokens without a Mongo identity", async () => {
    const identity = await createPostgresAuthIdentity({
      email: `native-auth-${randomUUID()}@example.test`,
      legalName: "Native PostgreSQL account",
      role: "investor",
      passwordHash: "bcrypt-native-hash-a",
    });
    createdIdentityIds.push(identity.id);
    expect(identity).toMatchObject({ role: "investor", emailVerifiedAt: null, passwordHash: "bcrypt-native-hash-a" });
    const legacyReference = await postgresQuery<{ legacy_mongo_id: string | null }>(
      "SELECT legacy_mongo_id FROM fractal.identities WHERE id = $1",
      [identity.id],
    );
    expect(legacyReference.rows[0]?.legacy_mongo_id).toBeNull();

    const verificationTokenHash = `verify-${randomUUID()}`;
    await recordPostgresEmailVerificationToken({
      identityId: identity.id,
      tokenHash: verificationTokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(consumePostgresEmailVerificationToken({ email: `other-${randomUUID()}@example.test`, tokenHash: verificationTokenHash })).resolves.toBe(false);
    await expect(consumePostgresEmailVerificationToken({ email: identity.email, tokenHash: verificationTokenHash })).resolves.toBe(true);
    await expect(consumePostgresEmailVerificationToken({ email: identity.email, tokenHash: verificationTokenHash })).resolves.toBe(false);
    await expect(getPostgresAuthIdentityById(identity.id)).resolves.toMatchObject({ emailVerifiedAt: expect.any(Date) });

    const resetTokenHash = `reset-${randomUUID()}`;
    await recordPostgresPasswordResetToken({
      identityId: identity.id,
      tokenHash: resetTokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(consumePostgresPasswordResetToken({ tokenHash: resetTokenHash, passwordHash: "bcrypt-native-hash-b" }))
      .resolves.toBe(identity.id);
    await expect(consumePostgresPasswordResetToken({ tokenHash: resetTokenHash, passwordHash: "bcrypt-native-hash-c" }))
      .resolves.toBeNull();
    await expect(getPostgresAuthIdentityById(identity.id)).resolves.toMatchObject({
      passwordHash: "bcrypt-native-hash-b",
      credentialInvalidatedAt: expect.any(Date),
    });
  });

  it("keeps OTP as the only email-verification authority during an ordinary password reset", async () => {
    const identity = await createPostgresAuthIdentity({
      email: `unverified-reset-${randomUUID()}@example.test`,
      legalName: "Unverified reset account",
      role: "investor",
      passwordHash: "bcrypt-unverified-reset-a",
    });
    createdIdentityIds.push(identity.id);
    expect(identity.emailVerifiedAt).toBeNull();

    const resetTokenHash = `unverified-reset-${randomUUID()}`;
    await expect(recordPostgresPasswordResetToken({
      identityId: identity.id,
      tokenHash: resetTokenHash,
      expiresAt: new Date(Date.now() + 60_000),
    })).resolves.toMatchObject({
      id: identity.id,
      emailVerifiedAt: null,
    });
    const storedPurpose = await postgresQuery<{ password_reset_purpose: string | null }>(
      "SELECT password_reset_purpose FROM fractal.identities WHERE id = $1",
      [identity.id],
    );
    expect(storedPurpose.rows[0]?.password_reset_purpose).toBe("password_reset");

    await expect(consumePostgresPasswordResetToken({
      tokenHash: resetTokenHash,
      passwordHash: "bcrypt-unverified-reset-b",
    })).resolves.toBe(identity.id);
    await expect(getPostgresAuthIdentityById(identity.id)).resolves.toMatchObject({
      passwordHash: "bcrypt-unverified-reset-b",
      emailVerifiedAt: null,
      credentialInvalidatedAt: expect.any(Date),
    });
    const consumedPurpose = await postgresQuery<{
      password_reset_purpose: string | null;
      password_reset_token_hash: string | null;
    }>(
      "SELECT password_reset_purpose, password_reset_token_hash FROM fractal.identities WHERE id = $1",
      [identity.id],
    );
    expect(consumedPurpose.rows[0]).toEqual({
      password_reset_purpose: null,
      password_reset_token_hash: null,
    });
  });

  it("durably dispatches native verification and reset emails without persisting bearer tokens", async () => {
    const identity = await createPostgresAuthIdentity({
      email: `native-email-${randomUUID()}@example.test`,
      legalName: "Native email delivery account",
      role: "investor",
      passwordHash: "bcrypt-native-email-hash",
    });
    createdIdentityIds.push(identity.id);
    await expect(getAuthEmailDeliveryHealth({ identityId: identity.id })).resolves.toEqual({
      pendingCount: 1,
      terminalCount: 0,
      oldestPendingAgeSeconds: expect.any(Number),
    });
    const sent: Array<{ text: string; subject: string }> = [];
    const logger = { info: () => undefined, error: () => undefined };
    const send = async (payload: { text: string; subject: string; idempotencyKey?: string }) => {
      sent.push(payload);
      return {
        status: "sent" as const,
        provider: "resend" as const,
        providerMessageId: `resend-${payload.idempotencyKey}`,
      };
    };

    await expect(dispatchPendingAuthEmailDeliveries({ workerId: "email-verification-worker", send, logger })).resolves.toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("Your Fractal verification code");
    const verificationCode = sent[0]?.text.match(/\b(\d{6})\b/)?.[1];
    expect(verificationCode).toBeTruthy();
    const delivery = await postgresQuery<{ status: string; bearer_token_storage: boolean }>(
      `SELECT delivery.status,
              NOT EXISTS (
                SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'fractal' AND table_name = 'auth_email_deliveries'
                   AND column_name ILIKE '%token%'
              ) AS bearer_token_storage
         FROM fractal.auth_email_deliveries delivery
        WHERE delivery.identity_id = $1 AND delivery.delivery_type = 'email_verification'`,
      [identity.id],
    );
    expect(delivery.rows[0]).toEqual({ status: "sent", bearer_token_storage: true });
    const verificationHash = await postgresQuery<{ email_verification_token_hash: string | null }>(
      "SELECT email_verification_token_hash FROM fractal.identities WHERE id = $1",
      [identity.id],
    );
    expect(verificationHash.rows[0]?.email_verification_token_hash)
      .toBe(createHash("sha256").update(verificationCode!).digest("hex"));
    await expect(consumePostgresEmailVerificationToken({
      email: identity.email,
      tokenHash: createHash("sha256").update(verificationCode!).digest("hex"),
    }))
      .resolves.toBe(true);
    await expect(getAuthEmailDeliveryHealth({ identityId: identity.id })).resolves.toEqual({
      pendingCount: 0,
      terminalCount: 0,
      oldestPendingAgeSeconds: null,
    });

    await expect(requestAuthEmailDelivery({ identityId: identity.id, deliveryType: "password_reset" }))
      .resolves.toMatchObject({ queued: true });
    await expect(dispatchPendingAuthEmailDeliveries({ workerId: "password-reset-worker", send, logger })).resolves.toBe(1);
    const resetToken = sent[1]?.text.match(/token=([a-f0-9]{64})/)?.[1];
    expect(sent[1]?.subject).toBe("Reset your Fractal password");
    expect(resetToken).toBeTruthy();
    await expect(consumePostgresPasswordResetToken({
      tokenHash: createHash("sha256").update(resetToken!).digest("hex"),
      passwordHash: "bcrypt-native-email-reset-hash",
    })).resolves.toBe(identity.id);

    await postgresQuery(
      `UPDATE fractal.auth_email_deliveries
          SET requested_at = now() - interval '3 minutes'
        WHERE identity_id = $1 AND delivery_type = 'password_reset'`,
      [identity.id],
    );
    await postgresQuery(
      `INSERT INTO fractal.auth_email_deliveries (
         id, identity_id, delivery_type, status, requested_at, terminal_at, last_error
       ) VALUES ($1, $2, 'password_reset', 'terminal', now() - interval '2 minutes', now(), 'delivery could not be completed')`,
      [randomUUID(), identity.id],
    );
    await expect(getAuthEmailDeliveryHealth({ identityId: identity.id })).resolves.toEqual({
      pendingCount: 0,
      terminalCount: 1,
      oldestPendingAgeSeconds: null,
    });
    await expect(requestAuthEmailDelivery({ identityId: identity.id, deliveryType: "password_reset" }))
      .resolves.toMatchObject({ queued: true });
    await expect(getAuthEmailDeliveryHealth({ identityId: identity.id })).resolves.toEqual({
      pendingCount: 1,
      terminalCount: 0,
      oldestPendingAgeSeconds: expect.any(Number),
    });
  });

  it("delivers administrator activation as a one-time password link and verifies mailbox possession on consumption", async () => {
    const identityId = randomUUID();
    const email = `administrator-activation-${randomUUID()}@example.test`;
    createdIdentityIds.push(identityId);
    await withPostgresTransaction(async (client) => {
      await client.query(
        `INSERT INTO fractal.identities (id, email, legal_name, status, password_hash, email_verified_at)
         VALUES ($1, $2, 'Administrator activation', 'active', NULL, NULL)`,
        [identityId, email],
      );
      await client.query(
        `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
         VALUES ($1, $2, 'admin', 'global')`,
        [randomUUID(), identityId],
      );
      await enqueueAdministratorActivationDelivery(client, identityId);
    });

    const sent: Array<{ text: string; subject: string }> = [];
    await expect(dispatchPendingAuthEmailDeliveries({
      workerId: "administrator-activation-worker",
      logger: { info: () => undefined, error: () => undefined },
      send: async (payload) => {
        sent.push(payload);
        return {
          status: "sent" as const,
          provider: "resend" as const,
          providerMessageId: `resend-${payload.idempotencyKey}`,
        };
      },
    })).resolves.toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toBe("Activate your Fractal administrator account");
    const activationToken = sent[0]?.text.match(/token=([a-f0-9]{64})&activation=administrator/)?.[1];
    expect(activationToken).toBeTruthy();
    const stored = await postgresQuery<{
      password_reset_token_hash: string | null;
      password_reset_purpose: string | null;
      password_hash: string | null;
      email_verified_at: Date | null;
    }>("SELECT password_reset_token_hash, password_reset_purpose, password_hash, email_verified_at FROM fractal.identities WHERE id = $1", [identityId]);
    expect(stored.rows[0]).toMatchObject({
      password_hash: null,
      email_verified_at: null,
      password_reset_purpose: "administrator_activation",
    });
    expect(stored.rows[0]?.password_reset_token_hash)
      .toBe(createHash("sha256").update(activationToken!).digest("hex"));

    await expect(consumePostgresPasswordResetToken({
      tokenHash: createHash("sha256").update(activationToken!).digest("hex"),
      passwordHash: "bcrypt-administrator-activation-hash",
    })).resolves.toBe(identityId);
    await expect(getPostgresAuthIdentityById(identityId)).resolves.toMatchObject({
      role: "admin",
      passwordHash: "bcrypt-administrator-activation-hash",
      emailVerifiedAt: expect.any(Date),
      credentialInvalidatedAt: expect.any(Date),
    });
    await expect(consumePostgresPasswordResetToken({
      tokenHash: createHash("sha256").update(activationToken!).digest("hex"),
      passwordHash: "must-not-replay",
    })).resolves.toBeNull();
  });

  it("keeps one auth secret and provider command stable across a retry", async () => {
    const identity = await createPostgresAuthIdentity({
      email: `retry-safe-email-${randomUUID()}@example.test`,
      legalName: "Retry-safe email account",
      role: "investor",
      passwordHash: "bcrypt-retry-safe-email-hash",
    });
    createdIdentityIds.push(identity.id);
    const attempts: EmailPayload[] = [];
    const logger = { info: () => undefined, error: () => undefined };
    await expect(dispatchPendingAuthEmailDeliveries({
      workerId: "auth-retry-first",
      logger,
      send: async (payload) => {
        attempts.push(payload);
        return { status: "failed", error: "ambiguous provider timeout" };
      },
    })).resolves.toBe(1);
    await postgresQuery(
      `UPDATE fractal.auth_email_deliveries
          SET next_attempt_at = now()
        WHERE identity_id = $1 AND delivery_type = 'email_verification'`,
      [identity.id],
    );
    await expect(dispatchPendingAuthEmailDeliveries({
      workerId: "auth-retry-second",
      logger,
      send: async (payload) => {
        attempts.push(payload);
        return {
          status: "sent",
          provider: "resend",
          providerMessageId: "resend-auth-retry-1",
        };
      },
    })).resolves.toBe(1);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]).toEqual(attempts[0]);
    const stored = await postgresQuery<{
      status: string;
      attempts: number;
      provider: string | null;
      provider_message_id: string | null;
    }>(
      `SELECT status, attempts, provider, provider_message_id
         FROM fractal.auth_email_deliveries
        WHERE identity_id = $1 AND delivery_type = 'email_verification'`,
      [identity.id],
    );
    expect(stored.rows[0]).toEqual({
      status: "sent",
      attempts: 2,
      provider: "resend",
      provider_message_id: "resend-auth-retry-1",
    });
  });

  it("records immutable Sumsub evidence without auto-approving the governed compliance profile", async () => {
    const legacyMongoId = `sumsub-${randomUUID()}`;
    const identityId = await projectLegacyIdentity({
      legacyMongoId,
      email: `sumsub-${randomUUID()}@example.test`,
      legalName: "Verified evidence identity",
      role: "investor",
    });
    // This record is deliberately retained: immutable provider evidence must
    // keep its identity correlation rather than be silently deleted in test or
    // production cleanup code.
    const externalEventId = `sumsub-event-${randomUUID()}`;
    const rawPayload = JSON.stringify({ applicantId: "applicant-1", event: externalEventId, answer: "GREEN" });
    const first = await recordSumsubIdentityVerificationEvidence({
      externalEventId,
      externalUserId: legacyMongoId,
      applicantId: "applicant-1",
      eventType: "applicantReviewed",
      reviewStatus: "completed",
      reviewAnswer: "GREEN",
      rejectLabels: [],
      createdAtMs: "1800000000000",
      rawPayload,
    });
    expect(first).toMatchObject({ identityId, duplicate: false });

    const stored = await postgresQuery<{
      identity_id: string; review_answer: string; reject_labels: string[]; provider_created_at: Date | null;
    }>(
      `SELECT identity_id, review_answer, reject_labels, provider_created_at
         FROM fractal.provider_identity_verification_events WHERE id = $1`,
      [first.id],
    );
    expect(stored.rows[0]).toMatchObject({ identity_id: identityId, review_answer: "GREEN", reject_labels: [] });
    expect(stored.rows[0]?.provider_created_at).toBeInstanceOf(Date);
    const compliance = await postgresQuery<{ count: string }>(
      "SELECT count(*) FROM fractal.investor_compliance_profiles WHERE identity_id = $1",
      [identityId],
    );
    expect(Number(compliance.rows[0]?.count)).toBe(0);
    const audit = await postgresQuery<{ count: string }>(
      "SELECT count(*) FROM fractal.audit_events WHERE scope_key = $1 AND action = 'identity.verification_evidence.recorded'",
      [`identity:${identityId}`],
    );
    const outbox = await postgresQuery<{ count: string }>(
      "SELECT count(*) FROM fractal.outbox_events WHERE aggregate_id = $1 AND event_type = 'IdentityVerificationEvidenceRecorded'",
      [first.id],
    );
    expect(Number(audit.rows[0]?.count)).toBe(1);
    expect(Number(outbox.rows[0]?.count)).toBe(1);
    await expect(listIdentityVerificationEvidenceForReviewer({ identityId, accessedByIdentityId: identityId }))
      .resolves.toContainEqual(expect.objectContaining({ id: first.id, provider: "sumsub", reviewAnswer: "GREEN" }));
    const viewAudit = await postgresQuery<{ count: string }>(
      "SELECT count(*) FROM fractal.audit_events WHERE scope_key = $1 AND action = 'identity.verification_evidence.viewed'",
      [`identity:${identityId}`],
    );
    expect(Number(viewAudit.rows[0]?.count)).toBe(1);

    await expect(
      postgresQuery(
        "UPDATE fractal.provider_identity_verification_events SET review_answer = 'RED' WHERE id = $1",
        [first.id],
      ),
    ).rejects.toThrow("append-only");

    await expect(recordSumsubIdentityVerificationEvidence({
      externalEventId,
      externalUserId: legacyMongoId,
      applicantId: "applicant-1",
      eventType: "applicantReviewed",
      reviewAnswer: "GREEN",
      rawPayload,
    })).resolves.toMatchObject({ id: first.id, identityId, duplicate: true });
    await expect(recordSumsubIdentityVerificationEvidence({
      externalEventId,
      externalUserId: legacyMongoId,
      applicantId: "applicant-1",
      eventType: "applicantReviewed",
      reviewAnswer: "RED",
      rawPayload: JSON.stringify({ applicantId: "applicant-1", event: externalEventId, answer: "RED" }),
    })).rejects.toBeInstanceOf(ProviderIdentityVerificationEvidenceConflictError);

    const unmatched = await recordSumsubIdentityVerificationEvidence({
      externalEventId: `sumsub-unmatched-${randomUUID()}`,
      externalUserId: `unknown-${randomUUID()}`,
      applicantId: "applicant-unmatched",
      eventType: "applicantPending",
      rawPayload: JSON.stringify({ applicantId: "applicant-unmatched" }),
    });
    expect(unmatched).toMatchObject({ identityId: null, duplicate: false });
  });

  it("recovers a provider applicant by immutable identity ID before creating another one", async () => {
    const identityId = await projectLegacyIdentity({
      legacyMongoId: `verification-app-${randomUUID()}`,
      email: `verification-app-${randomUUID()}@example.test`,
      legalName: "Applicant recovery identity",
      role: "investor",
    });
    // This identity is deliberately retained alongside its durable provider
    // application. The test proves that the foreign key prevents casual
    // deletion of an audit-relevant identity-verification record.
    const first = await requestIdentityVerificationApplication({ identityId, commandKey: `request-${randomUUID()}` });
    expect(first).toMatchObject({ replayed: false, application: { status: "requested", externalUserId: identityId } });
    const replay = await requestIdentityVerificationApplication({ identityId, commandKey: first.application.id });
    expect(replay).toMatchObject({ replayed: false, application: { id: first.application.id, status: "requested" } });
    const idempotentReplay = await requestIdentityVerificationApplication({ identityId, commandKey: `request-${identityId}` });
    const idempotentReplayAgain = await requestIdentityVerificationApplication({ identityId, commandKey: `request-${identityId}` });
    expect(idempotentReplayAgain).toMatchObject({ replayed: true, application: { id: first.application.id } });

    const claimed = (await claimIdentityVerificationApplications({ workerId: "verification-worker", limit: 10, claimTimeoutSeconds: 30 }))
      .find((application) => application.id === first.application.id);
    expect(claimed).toMatchObject({ id: first.application.id, identityId, externalUserId: identityId, attempts: 1 });
    let createCalls = 0;
    await processIdentityVerificationApplication(
      claimed!,
      "verification-worker",
      async () => { throw new SumsubApplicantNotFoundError(); },
      async (externalUserId, email) => {
        createCalls += 1;
        expect(externalUserId).toBe(identityId);
        expect(email).toContain("@example.test");
        return { id: `sumsub-applicant-${randomUUID()}`, externalUserId, createdAt: "2026-07-19T00:00:00.000Z", inspectionId: "inspection-1" };
      },
    );
    expect(createCalls).toBe(1);
    const ready = await getIdentityVerificationApplication(identityId);
    expect(ready).toMatchObject({ id: first.application.id, status: "ready", applicantId: expect.any(String), attempts: 1 });
    const readyBinding = await postgresQuery<{ inspection_id: string }>(
      "SELECT inspection_id FROM fractal.provider_identity_verification_applications WHERE id = $1",
      [first.application.id],
    );
    expect(readyBinding.rows[0]?.inspection_id).toBe("inspection-1");
    await recordIdentityVerificationAccessTokenIssued({ applicationId: ready!.id, identityId, expiresAt: new Date("2026-07-19T00:10:00.000Z") });
    const tokenAudit = await postgresQuery<{ payload: { expiresAt: string } }>(
      `SELECT payload FROM fractal.audit_events
        WHERE entity_id = $1 AND action = 'identity.verification_access_token.issued'`,
      [ready!.id],
    );
    expect(tokenAudit.rows[0]?.payload).toEqual({ provider: "sumsub", expiresAt: "2026-07-19T00:10:00.000Z" });

    const recoveredIdentityId = await projectLegacyIdentity({
      legacyMongoId: `verification-recovery-${randomUUID()}`,
      email: `verification-recovery-${randomUUID()}@example.test`,
      legalName: "Existing provider applicant",
      role: "investor",
    });
    const recoveredRequest = await requestIdentityVerificationApplication({ identityId: recoveredIdentityId, commandKey: `request-${randomUUID()}` });
    const claimedRecovery = (await claimIdentityVerificationApplications({ workerId: "verification-recovery-worker", limit: 10, claimTimeoutSeconds: 30 }))
      .find((application) => application.id === recoveredRequest.application.id);
    expect(claimedRecovery).toBeTruthy();
    const recoveredApplicantId = `already-created-remotely-${randomUUID()}`;
    let unexpectedCreate = false;
    await processIdentityVerificationApplication(
      claimedRecovery!,
      "verification-recovery-worker",
      async (externalUserId) => ({ id: recoveredApplicantId, externalUserId, createdAt: "2026-07-19T00:00:00.000Z", inspectionId: "inspection-2" }),
      async () => {
        unexpectedCreate = true;
        throw new Error("Provider create should not run after remote recovery lookup");
      },
    );
    expect(unexpectedCreate).toBe(false);
    await expect(getIdentityVerificationApplication(recoveredIdentityId)).resolves.toMatchObject({ status: "ready", applicantId: recoveredApplicantId });
    const recoveredBinding = await postgresQuery<{ inspection_id: string }>(
      "SELECT inspection_id FROM fractal.provider_identity_verification_applications WHERE id = $1",
      [recoveredRequest.application.id],
    );
    expect(recoveredBinding.rows[0]?.inspection_id).toBe("inspection-2");
  });
});
