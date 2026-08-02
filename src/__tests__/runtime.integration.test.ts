import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import mongoose from "mongoose";
import { buildApp } from "../app.js";
import { connectMongo, disconnectMongo } from "../db/mongo.js";
import { UserModel } from "../db/models.js";
import { applyPostgresMigrations } from "../db/postgres-migrations/index.js";
import { connectPostgres, disconnectPostgres, postgresQuery } from "../db/postgres.js";
import { connectRedis, disconnectRedis, getRedis } from "../db/redis.js";
import { dispatchPendingOutboxEvents } from "../services/postgres-outbox-dispatcher.js";
import { projectSecurityEvent, securityEventTypes } from "../services/security-event-projection.js";
import { generateTotpCode } from "../platform/totp-factors.js";
import {
  getPostgresAuthIdentityByEmail,
  recordPostgresEmailVerificationToken,
  recordPostgresPasswordResetToken,
} from "../platform/postgres-identities.js";
import { env } from "../config/env.js";
import { decidePlatformContentVersion, listPublishedLegalDocuments, proposePlatformContentVersion, publishDuePlatformContent, type LegalAcceptanceReference } from "../platform/postgres-platform-content.js";

function configuredRedisDatabase() {
  if (!env.REDIS_URL) throw new Error("Runtime integration requires REDIS_URL");
  return Number.parseInt(new URL(env.REDIS_URL).pathname.replace(/^\//, "") || "0", 10);
}

describe("API runtime smoke", () => {
  let app: FastifyInstance;
  let registrationLegalAcceptances: LegalAcceptanceReference[];
  const runtimeLegalIdentityIds: string[] = [];

  beforeAll(async () => {
    await connectMongo();
    await connectRedis();
    const redis = getRedis();
    if (!redis) throw new Error("Runtime integration requires a real Redis connection");
    const redisDatabase = configuredRedisDatabase();
    if (redisDatabase > 0) await redis.flushdb();
    await connectPostgres({ required: true });
    await applyPostgresMigrations();
    const database = await postgresQuery<{ current_database: string }>("SELECT current_database()");
    if (!/(^|[_-])(test|ci)([_-]|$)/i.test(database.rows[0]!.current_database)) throw new Error("Runtime integration legal-content seed requires an isolated test or CI PostgreSQL database");
    await postgresQuery("TRUNCATE fractal.legal_document_acceptances, fractal.platform_content_events, fractal.platform_content_publications, fractal.platform_content_versions");
    await postgresQuery("TRUNCATE fractal.administrator_capability_assignments");
    await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id IN (SELECT id FROM fractal.identities WHERE email LIKE 'runtime-legal-%@example.test')");
    await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id IN (SELECT id FROM fractal.identities WHERE email LIKE 'runtime-legal-%@example.test')");
    await postgresQuery("DELETE FROM fractal.identities WHERE email LIKE 'runtime-legal-%@example.test'");
    const makerId = randomUUID(); const checkerId = randomUUID();
    runtimeLegalIdentityIds.push(makerId, checkerId);
    await postgresQuery(`INSERT INTO fractal.identities (id,email,legal_name,status,email_verified_at) VALUES ($1,$2,'Runtime legal maker','active',now()),($3,$4,'Runtime legal checker','active',now())`, [makerId, `runtime-legal-maker-${makerId}@example.test`, checkerId, `runtime-legal-checker-${checkerId}@example.test`]);
    await postgresQuery(`INSERT INTO fractal.identity_role_assignments (id,identity_id,role,scope_type) VALUES ($1,$2,'admin','global'),($3,$4,'admin','global')`, [randomUUID(), makerId, randomUUID(), checkerId]);
    await postgresQuery(`INSERT INTO fractal.administrator_capability_assignments (id,identity_id,capability_key) VALUES ($1,$2,'platform_content_manage'),($3,$4,'platform_content_manage')`, [randomUUID(), makerId, randomUUID(), checkerId]);
    const legalContent = (title: string) => ({ title, eyebrow: "Test legal notice", lead: `This approved test-only ${title} controls the isolated registration journey.`, keyPoints: ["The exact immutable version is recorded with each test account acceptance."], sections: [{ id: "scope", title: "1. Test scope", paragraphs: ["This reserved test document exists only to prove exact legal-version consent and cannot be used as production legal advice."] }] });
    for (const [documentKey, title] of [["terms_global_public", "Terms of use"], ["privacy_global_public", "Privacy notice"]] as const) {
      const proposal = await proposePlatformContentVersion({ actorIdentityId: makerId, documentKey, semanticVersion: "1.0.0", content: legalContent(title), reacceptanceRequired: true, expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000), changeSummary: `Approve the isolated ${title} fixture for runtime consent evidence.`, commandKey: randomUUID() });
      await decidePlatformContentVersion({ actorIdentityId: checkerId, versionId: proposal.version.id, action: "approve", expectedStateVersion: 1, decisionReason: `Independently approve the bounded test-only ${title} content and effective boundary.`, commandKey: randomUUID() });
    }
    expect(await publishDuePlatformContent()).toMatchObject({ published: 2, failed: 0 });
    const legal = await listPublishedLegalDocuments();
    registrationLegalAcceptances = legal.documents.filter((document) => document.requiredAtRegistration).map((document) => ({ documentKey: document.documentKey, versionId: document.versionId, contentSha256: document.contentSha256 }));
    expect(registrationLegalAcceptances).toHaveLength(2);
    app = await buildApp();
  });

  afterAll(async () => {
    await app?.close();
    if (runtimeLegalIdentityIds.length) {
      await postgresQuery("TRUNCATE fractal.legal_document_acceptances, fractal.platform_content_events, fractal.platform_content_publications, fractal.platform_content_versions");
      await postgresQuery("TRUNCATE fractal.administrator_capability_assignments");
      await postgresQuery("DELETE FROM fractal.identity_role_assignments WHERE identity_id = ANY($1::uuid[])", [runtimeLegalIdentityIds]);
      await postgresQuery("DELETE FROM fractal.idempotency_commands WHERE actor_identity_id = ANY($1::uuid[])", [runtimeLegalIdentityIds]);
      await postgresQuery("DELETE FROM fractal.identities WHERE id = ANY($1::uuid[])", [runtimeLegalIdentityIds]);
    }
    const redisDatabase = configuredRedisDatabase();
    if (redisDatabase > 0) await getRedis()?.flushdb();
    await disconnectRedis();
    await disconnectPostgres();
    await disconnectMongo();
  });

  it("reports live and ready only after MongoDB and Redis are reachable", async () => {
    const [live, ready] = await Promise.all([
      app.inject({ method: "GET", url: "/livez" }),
      app.inject({ method: "GET", url: "/readyz" }),
    ]);

    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ status: "ok" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({
      ready: true,
      checks: { mongo: { status: "ok" }, postgres: { status: "ok" } },
    });
    const configuredDatabaseName = decodeURIComponent(new URL(env.MONGODB_URI).pathname).replace(/^\//, "");
    expect(configuredDatabaseName).not.toBe("");
    expect(mongoose.connection.name).toBe(configuredDatabaseName);

    const uploadCsrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const uploadCsrfToken = uploadCsrf.json<{ csrfToken: string }>().csrfToken;
    const uploadCsrfCookie = requestCookie(setCookie(uploadCsrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const unauthenticatedUpload = await app.inject({
      method: "POST",
      url: "/v1/support/cases/00000000-0000-4000-8000-000000000001/attachments",
      headers: {
        "content-type": "application/octet-stream",
        cookie: uploadCsrfCookie,
        "x-csrf-token": uploadCsrfToken,
        "x-command-id": randomUUID(),
        "x-fractal-attachment-classification": "general",
        "x-fractal-attachment-filename": "evidence.pdf",
        "x-fractal-attachment-mime-type": "application/pdf",
      },
      payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(unauthenticatedUpload.statusCode).toBe(401);
    const unauthenticatedSumsubExport = await app.inject({
      method: "POST",
      url: "/v1/admin/privacy-requests/00000000-0000-4000-8000-000000000001/sumsub-provider-exports",
      headers: {
        "content-type": "application/octet-stream",
        cookie: uploadCsrfCookie,
        "x-csrf-token": uploadCsrfToken,
        "x-command-id": randomUUID(),
        "x-fractal-sumsub-report-reference": "unauthenticated-test-report",
        "x-fractal-sumsub-generated-at": new Date(Date.now() - 2_000).toISOString(),
        "x-fractal-sumsub-downloaded-at": new Date(Date.now() - 1_000).toISOString(),
        "x-fractal-sumsub-settings-sha256": "a".repeat(64),
      },
      payload: Buffer.alloc(2 * 1024 * 1024),
    });
    expect(unauthenticatedSumsubExport.statusCode).toBe(401);
  });

  it("returns a safe 400 validation response after a valid CSRF handshake", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));

    const invalidRegistration = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email: "not-an-email", name: "", password: "short", role: "not-a-role" },
    });

    expect(invalidRegistration.statusCode).toBe(400);
    expect(invalidRegistration.json()).toMatchObject({
      error: "Validation failed",
      code: "VALIDATION_ERROR",
    });
  });

  it("serves the authoritative public catalogue without session cookies", async () => {
    const catalogue = await app.inject({ method: "GET", url: "/v1/public/investment-offerings" });
    expect(catalogue.statusCode).toBe(200);
    expect(catalogue.headers["cache-control"]).toBe("no-store");
    expect(catalogue.json()).toMatchObject({ offerings: expect.any(Array) });

    const missing = await app.inject({ method: "GET", url: "/v1/public/investment-offerings/not-a-real-offering" });
    expect(missing.statusCode).toBe(404);

    const legalRegister = await app.inject({ method: "GET", url: "/v1/public/legal-documents" });
    expect(legalRegister.statusCode).toBe(200);
    const legal = legalRegister.json<{ registrationDocumentsAvailable: boolean; documents: Array<{ slug: string; versionId: string; contentSha256: string }> }>();
    expect(legal).toMatchObject({ registrationDocumentsAvailable: true, documents: expect.arrayContaining([expect.objectContaining({ slug: "terms" }), expect.objectContaining({ slug: "privacy" })]) });
    const terms = legal.documents.find((document) => document.slug === "terms")!;
    const [document, history, download] = await Promise.all([
      app.inject({ method: "GET", url: "/v1/public/legal-documents/terms" }),
      app.inject({ method: "GET", url: "/v1/public/legal-documents/terms/history" }),
      app.inject({ method: "GET", url: `/v1/public/legal-documents/terms/versions/${terms.versionId}/download` }),
    ]);
    expect(document.statusCode).toBe(200);
    expect(document.json()).toMatchObject({ versionId: terms.versionId, contentSha256: terms.contentSha256, content: { title: "Terms of use" } });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ documents: [expect.objectContaining({ versionId: terms.versionId })] });
    expect(download.statusCode).toBe(200);
    expect(download.headers["x-fractal-content-sha256"]).toBe(terms.contentSha256);
    expect(createHash("sha256").update(download.rawPayload).digest("hex")).toBe(terms.contentSha256);
  });

  it("labels CSRF failures so browser clients never retry unrelated 403 denials", async () => {
    const missing = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      payload: { email: "not-an-email", name: "", password: "short", role: "not-a-role" },
    });
    expect(missing.statusCode).toBe(403);
    expect(missing.json()).toMatchObject({ code: "CSRF_TOKEN_MISSING" });

    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const mismatch = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      headers: { cookie: csrfCookie, "x-csrf-token": "not-the-issued-token" },
      payload: { email: "not-an-email", name: "", password: "short", role: "not-a-role" },
    });
    expect(mismatch.statusCode).toBe(403);
    expect(mismatch.json()).toMatchObject({ code: "CSRF_TOKEN_MISMATCH" });
  });

  it("registers, rotates, and revokes a server-backed session", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));

    const email = `integration-${Date.now()}@example.test`;
    const password = "SecurePassw0rd";
    const register = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      headers: {
        cookie: csrfCookie,
        "x-csrf-token": csrfToken,
      },
      payload: {
        email,
        name: "Integration Investor",
        password,
        role: "investor",
        legalAcceptances: registrationLegalAcceptances,
      },
    });
    expect(register.statusCode).toBe(200);
    const accessSetCookie = setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access");
    const refreshSetCookie = setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_refresh");
    expect(accessSetCookie).toContain("HttpOnly");
    expect(refreshSetCookie).toContain("HttpOnly");
    const accessCookie = requestCookie(accessSetCookie);
    const refreshCookie = requestCookie(refreshSetCookie);

    const meBeforeVerification = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: accessCookie },
    });
    expect(meBeforeVerification.statusCode).toBe(403);
    const verificationCode = "482913";
    await UserModel.updateOne(
      { email },
      {
        $set: {
          emailVerifyToken: createHash("sha256").update(verificationCode).digest("hex"),
          emailVerifyExpires: new Date(Date.now() + 60_000),
        },
      },
    );
    const verify = await app.inject({
      method: "POST",
      url: "/v1/auth/verify-email",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, code: verificationCode },
    });
    expect(verify.statusCode).toBe(200);

    const legalConsentStatus = await app.inject({ method: "GET", url: "/v1/legal-consents/status", headers: { cookie: accessCookie } });
    expect(legalConsentStatus.statusCode).toBe(200);
    expect(legalConsentStatus.json()).toMatchObject({ available: true, required: [], accepted: [expect.objectContaining({ contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) }), expect.objectContaining({ contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) })] });

    const sessions = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { cookie: accessCookie },
    });
    expect(sessions.statusCode).toBe(200);
    expect(sessions.json<Array<{ id: string; current: boolean }>>()).toEqual([
      expect.objectContaining({ current: true }),
    ]);

    const secondLogin = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/login",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, password },
    });
    expect(secondLogin.statusCode).toBe(200);

    const sessionsWithSecondLogin = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { cookie: accessCookie },
    });
    const activeSessions = sessionsWithSecondLogin.json<Array<{ id: string; current: boolean }>>();
    expect(activeSessions).toHaveLength(2);
    const otherSession = activeSessions.find((session) => !session.current);
    expect(otherSession).toBeDefined();
    const revokeOtherSession = await app.inject({
      method: "POST",
      url: `/v1/auth/sessions/${otherSession!.id}/revoke`,
      headers: { cookie: csrfCookie + "; " + accessCookie, "x-csrf-token": csrfToken },
    });
    expect(revokeOtherSession.statusCode).toBe(200);
    const sessionsAfterRevoke = await app.inject({
      method: "GET",
      url: "/v1/auth/sessions",
      headers: { cookie: accessCookie },
    });
    expect(sessionsAfterRevoke.json<Array<{ id: string }>>()).toHaveLength(1);

    await dispatchPendingOutboxEvents({
      workerId: "runtime-integration-worker",
      eventTypes: securityEventTypes,
      project: projectSecurityEvent,
      logger: { info: () => undefined, error: () => undefined },
    });
    const securityEvents = await app.inject({
      method: "GET",
      url: "/v1/auth/security-events",
      headers: { cookie: accessCookie },
    });
    expect(securityEvents.statusCode).toBe(200);
    expect(securityEvents.json<Array<{ type: string }>>()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "auth.session.created" }),
        expect.objectContaining({ type: "auth.session.revoked" }),
      ]),
    );

    const refresh = await app.inject({
      method: "POST",
      url: "/v1/auth/refresh",
      headers: {
        cookie: `${csrfCookie}; ${refreshCookie}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(refresh.statusCode).toBe(200);
    const rotatedAccessCookie = requestCookie(setCookie(refresh.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));

    const logout = await app.inject({
      method: "POST",
      url: "/v1/auth/logout",
      headers: {
        cookie: `${csrfCookie}; ${rotatedAccessCookie}`,
        "x-csrf-token": csrfToken,
      },
    });
    expect(logout.statusCode).toBe(200);

    const me = await app.inject({
      method: "GET",
      url: "/v1/auth/me",
      headers: { cookie: rotatedAccessCookie },
    });
    expect(me.statusCode).toBe(401);
  });

  it("resets a password with the same policy and revokes every durable session", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const email = `reset-${Date.now()}@example.test`;
    const oldPassword = "SecurePassw0rd";
    const newPassword = "NewSecurePassw0rd";
    const register = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, name: "Password Reset Investor", password: oldPassword, role: "investor", legalAcceptances: registrationLegalAcceptances },
    });
    expect(register.statusCode).toBe(200);
    const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));
    const resetToken = "integration-password-reset-token";
    await UserModel.updateOne(
      { email },
      {
        $set: {
          emailVerified: true,
          passwordResetToken: createHash("sha256").update(resetToken).digest("hex"),
          passwordResetExpires: new Date(Date.now() + 60_000),
        },
      },
    );

    const reset = await app.inject({
      method: "POST",
      url: "/v1/auth/reset-password",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { token: resetToken, password: newPassword },
    });
    expect(reset.statusCode).toBe(200);

    const staleSession = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: { cookie: accessCookie } });
    expect(staleSession.statusCode).toBe(401);
    const oldLogin = await app.inject({
      method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/login", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken }, payload: { email, password: oldPassword },
    });
    expect(oldLogin.statusCode).toBe(401);
    const newLogin = await app.inject({
      method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/login", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken }, payload: { email, password: newPassword },
    });
    expect(newLogin.statusCode).toBe(200);
  });

  it("uses PostgreSQL only for a native account's registration, verification, reset, and session subject", async () => {
    const originalAuthority = env.AUTH_IDENTITY_AUTHORITY;
    env.AUTH_IDENTITY_AUTHORITY = "postgres";
    try {
      const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
      const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
      const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
      const email = `native-runtime-${Date.now()}@example.test`;
      const oldPassword = "SecurePassw0rd";
      const newPassword = "NewSecurePassw0rd";

      const register = await app.inject({
        method: "POST",
        remoteAddress: nextClientAddress(),
        url: "/v1/auth/register",
        headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
        payload: { email, name: "Native PostgreSQL Investor", password: oldPassword, role: "investor", legalAcceptances: registrationLegalAcceptances },
      });
      expect(register.statusCode).toBe(200);
      const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));
      const identity = await getPostgresAuthIdentityByEmail(email);
      expect(identity).toMatchObject({ email, role: "investor", emailVerifiedAt: null });
      const storedIdentity = await app.inject({ method: "GET", url: "/v1/auth/me", headers: { cookie: accessCookie } });
      expect(storedIdentity.statusCode).toBe(403);

      const verificationRequest = await app.inject({
        method: "POST",
        remoteAddress: nextClientAddress(),
        url: "/v1/auth/request-email-verification",
        headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
        payload: { email },
      });
      const unknownVerificationRequest = await app.inject({
        method: "POST",
        remoteAddress: nextClientAddress(),
        url: "/v1/auth/request-email-verification",
        headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
        payload: { email: `unknown-${Date.now()}@example.test` },
      });
      expect(verificationRequest.statusCode).toBe(200);
      expect(verificationRequest.json()).toEqual(unknownVerificationRequest.json());

      const verificationCode = "482914";
      await recordPostgresEmailVerificationToken({
        identityId: identity!.id,
        tokenHash: createHash("sha256").update(verificationCode).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const verify = await app.inject({
        method: "POST",
        url: "/v1/auth/verify-email",
        headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
        payload: { email, code: verificationCode },
      });
      expect(verify.statusCode).toBe(200);
      const session = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: { cookie: accessCookie } });
      expect(session.statusCode).toBe(200);

      const resetToken = "native-runtime-password-reset-token";
      await recordPostgresPasswordResetToken({
        identityId: identity!.id,
        tokenHash: createHash("sha256").update(resetToken).digest("hex"),
        expiresAt: new Date(Date.now() + 60_000),
      });
      const reset = await app.inject({
        method: "POST",
        url: "/v1/auth/reset-password",
        headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
        payload: { token: resetToken, password: newPassword },
      });
      expect(reset.statusCode).toBe(200);
      const staleSession = await app.inject({ method: "GET", url: "/v1/auth/sessions", headers: { cookie: accessCookie } });
      expect(staleSession.statusCode).toBe(401);
      const oldLogin = await app.inject({
        method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/login", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken }, payload: { email, password: oldPassword },
      });
      expect(oldLogin.statusCode).toBe(401);
      const newLogin = await app.inject({
        method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/login", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken }, payload: { email, password: newPassword },
      });
      expect(newLogin.statusCode).toBe(200);
    } finally {
      env.AUTH_IDENTITY_AUTHORITY = originalAuthority;
    }
  });

  it("does not let an issuer session invoke professional workspace APIs", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const email = `issuer-boundary-${Date.now()}@example.test`;
    const register = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, name: "Issuer Role Boundary", password: "SecurePassw0rd", role: "issuer", legalAcceptances: registrationLegalAcceptances },
    });
    expect(register.statusCode).toBe(200);
    const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));

    // The route must deny on actor role before it attempts a professional
    // membership lookup, so this remains a meaningful regression check even
    // for an account with no professional firm identity.
    await UserModel.updateOne({ email }, { $set: { emailVerified: true } });
    const workOrders = await app.inject({
      method: "GET",
      url: "/v1/professional/work-orders",
      headers: { cookie: accessCookie },
    });
    expect(workOrders.statusCode).toBe(403);
    expect(workOrders.json()).toMatchObject({ message: "Professional role required" });
  });

  it("does not let an investor session enumerate issuer-governance organizations", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const email = `investor-governance-boundary-${Date.now()}@example.test`;
    const register = await app.inject({
      method: "POST",
      remoteAddress: nextClientAddress(),
      url: "/v1/auth/register",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, name: "Investor Governance Boundary", password: "SecurePassw0rd", role: "investor", legalAcceptances: registrationLegalAcceptances },
    });
    expect(register.statusCode).toBe(200);
    const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));

    await UserModel.updateOne({ email }, { $set: { emailVerified: true } });
    const organizations = await app.inject({
      method: "GET",
      url: "/v1/governance/organizations",
      headers: { cookie: accessCookie },
    });
    expect(organizations.statusCode).toBe(403);
    expect(organizations.json()).toMatchObject({ message: "Issuer, operator, or admin role required" });
    const issuerOverview = await app.inject({
      method: "GET",
      url: "/v1/issuer/overview",
      headers: { cookie: accessCookie },
    });
    expect(issuerOverview.statusCode).toBe(403);
    expect(issuerOverview.json()).toMatchObject({ message: "Issuer role required" });
    const issuerDocuments = await app.inject({
      method: "GET",
      url: `/v1/governance/organizations/${randomUUID()}/documents`,
      headers: { cookie: accessCookie },
    });
    expect(issuerDocuments.statusCode).toBe(403);
    expect(issuerDocuments.json()).toMatchObject({ message: "Issuer, operator, or admin role required" });
  });

  it("creates and reopens the authoritative issuer organization while protecting team changes with step-up", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const email = `issuer-organization-${Date.now()}@example.test`;
    const register = await app.inject({
      method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/register",
      headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, name: "Issuer Organization Runtime", password: "SecurePassw0rd", role: "issuer", legalAcceptances: registrationLegalAcceptances },
    });
    expect(register.statusCode).toBe(200);
    const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));
    await UserModel.updateOne({ email }, { $set: { emailVerified: true } });
    const identity = await getPostgresAuthIdentityByEmail(email);
    expect(identity).not.toBeNull();
    await postgresQuery("UPDATE fractal.identities SET email_verified_at = now() WHERE id = $1", [identity!.id]);

    const create = await app.inject({
      method: "POST", url: "/v1/governance/organizations",
      headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken, "x-command-id": randomUUID() },
      payload: {
        legalName: `Runtime Authority ${randomUUID()}`, registrationNumber: `RC-${randomUUID()}`,
        jurisdictionCode: "NG", entityType: "private_company", primaryActivity: "Infrastructure investment operations",
        registeredAddress: { line1: "14 Runtime Avenue", city: "Lagos", stateOrProvince: "Lagos", countryCode: "NG" },
      },
    });
    expect(create.statusCode).toBe(201);
    const organizationId = create.json<{ organizationId: string }>().organizationId;
    const authority = await app.inject({
      method: "GET", url: `/v1/governance/organizations/${organizationId}/authority`, headers: { cookie: accessCookie },
    });
    expect(authority.statusCode).toBe(200);
    expect(authority.json()).toMatchObject({
      currentIdentityId: identity!.id,
      organization: { id: organizationId, verificationStatus: "not_started" },
      memberships: [expect.objectContaining({ identityId: identity!.id, role: "owner", status: "active" })],
    });
    const overview = await app.inject({ method: "GET", url: "/v1/issuer/overview", headers: { cookie: accessCookie } });
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({
      summary: { organizationCount: 1, actionRequiredCount: 1, submittedApplications: 0, publishedOfferings: 0 },
      organizations: [{
        id: organizationId, role: "owner", verification: { status: "not_started", expiresAt: null },
        team: { activeMembers: 1, pendingInvitations: 0 },
        applications: { submitted: 0, approved: 0, rejected: 0, unresolvedDiligenceItems: 0 },
        offerings: { pendingPublicationRequests: 0, published: 0, paused: 0, closed: 0 },
        actionRequiredCount: 1,
      }],
    });
    const documents = await app.inject({
      method: "GET", url: `/v1/governance/organizations/${organizationId}/documents`, headers: { cookie: accessCookie },
    });
    expect(documents.statusCode).toBe(200);
    expect(documents.json()).toEqual({ documents: [] });
    const protectedInvitation = await app.inject({
      method: "POST", url: `/v1/governance/organizations/${organizationId}/invitations`,
      headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken, "x-command-id": randomUUID() },
      payload: { email: `collaborator-${randomUUID()}@example.test`, role: "viewer", expiresAt: new Date(Date.now() + 86_400_000).toISOString() },
    });
    expect(protectedInvitation.statusCode).toBe(403);
    expect(protectedInvitation.json()).toMatchObject({ message: expect.stringContaining("Complete authenticator-app step-up") });
  });

  it("enrolls TOTP over the authenticated CSRF-protected API and rejects code replay", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const email = `mfa-runtime-${Date.now()}@example.test`;
    const password = "SecurePassw0rd";
    const register = await app.inject({
      method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/register", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, name: "MFA Runtime Investor", password, role: "investor", legalAcceptances: registrationLegalAcceptances },
    });
    expect(register.statusCode).toBe(200);
    const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));

    // Registration sends verification asynchronously. Wait for its durable
    // code write before substituting a deterministic fixture code.
    await expect.poll(async () => Boolean((await UserModel.findOne({ email }).select("emailVerifyToken").lean())?.emailVerifyToken), { interval: 10, timeout: 1_000 }).toBe(true);
    const verificationCode = "482915";
    await UserModel.updateOne({ email }, { $set: { emailVerifyToken: createHash("sha256").update(verificationCode).digest("hex"), emailVerifyExpires: new Date(Date.now() + 60_000) } });
    const verify = await app.inject({ method: "POST", url: "/v1/auth/verify-email", headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken }, payload: { email, code: verificationCode } });
    expect(verify.statusCode).toBe(200);

    const portfolio = await app.inject({ method: "GET", url: "/v1/investor/portfolio", headers: { cookie: accessCookie } });
    expect(portfolio.statusCode).toBe(200);
    expect(portfolio.json()).toEqual({ positions: [] });

    const documents = await app.inject({ method: "GET", url: "/v1/investor/documents", headers: { cookie: accessCookie } });
    expect(documents.statusCode).toBe(200);
    expect(documents.json()).toEqual({ documents: [] });

    const before = await app.inject({ method: "GET", url: "/v1/auth/mfa/totp", headers: { cookie: accessCookie } });
    expect(before.statusCode).toBe(200);
    expect(before.json()).toMatchObject({ enabled: true, enrolled: false, confirmed: false });

    const enroll = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/enroll", headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken }, payload: {} });
    expect(enroll.statusCode).toBe(200);
    const enrollment = enroll.json<{ secret: string; otpauthUri: string }>();
    expect(enrollment.otpauthUri).toContain(`secret=${enrollment.secret}`);
    const code = generateTotpCode(enrollment.secret, Math.floor(Date.now() / 30_000));

    const confirm = await app.inject({ method: "POST", url: "/v1/auth/mfa/totp/confirm", headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken }, payload: { code } });
    expect(confirm.statusCode).toBe(200);
    expect(confirm.json()).toMatchObject({ confirmed: true, stepUpExpiresAt: expect.any(String) });
    const after = await app.inject({ method: "GET", url: "/v1/auth/mfa/totp", headers: { cookie: accessCookie } });
    expect(after.json()).toMatchObject({ enabled: true, enrolled: true, confirmed: true });

    const freshLogin = await app.inject({
      method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/login", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken }, payload: { email, password },
    });
    expect(freshLogin.statusCode).toBe(200);
    const freshAccessCookie = requestCookie(setCookie(freshLogin.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));
    const deniedCheckout = await app.inject({
      method: "POST", url: "/v1/offerings/no-such-offering/checkout", headers: { cookie: `${csrfCookie}; ${freshAccessCookie}`, "x-csrf-token": csrfToken, "x-command-id": randomUUID() },
      payload: { amountMinor: 10_000, signatureName: "MFA Runtime Investor", agreementDocumentHash: "a".repeat(64) },
    });
    expect(deniedCheckout.statusCode).toBe(403);
    expect(deniedCheckout.json()).toMatchObject({ message: expect.stringContaining("Complete authenticator-app step-up") });
    const walletChallenge = await app.inject({
      method: "POST", url: "/v1/investor/wallet-link-challenges", headers: { cookie: `${csrfCookie}; ${freshAccessCookie}`, "x-csrf-token": csrfToken },
      payload: { chainId: 11155111, walletAddress: "0x0000000000000000000000000000000000000001" },
    });
    expect(walletChallenge.statusCode).toBe(200);
    const deniedWalletBinding = await app.inject({
      method: "POST", url: "/v1/investor/wallet-link-challenges/confirm", headers: { cookie: `${csrfCookie}; ${freshAccessCookie}`, "x-csrf-token": csrfToken },
      payload: { challengeId: walletChallenge.json<{ challengeId: string }>().challengeId, signature: `0x${"00".repeat(65)}` },
    });
    expect(deniedWalletBinding.statusCode).toBe(403);
    expect(deniedWalletBinding.json()).toMatchObject({ message: expect.stringContaining("Complete authenticator-app step-up") });

    const replay = await app.inject({ method: "POST", url: "/v1/auth/mfa/step-up", headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken }, payload: { code } });
    expect(replay.statusCode).toBe(422);
  });

  it("requires a fresh session-bound MFA grant before a professional can replace a payout profile", async () => {
    const csrf = await app.inject({ method: "GET", url: "/v1/auth/csrf-token" });
    const csrfToken = csrf.json<{ csrfToken: string }>().csrfToken;
    const csrfCookie = requestCookie(setCookie(csrf.headers["set-cookie"] as string | string[] | undefined, "fractal_csrf"));
    const email = `mfa-payout-profile-${Date.now()}@example.test`;
    const register = await app.inject({
      method: "POST", remoteAddress: nextClientAddress(), url: "/v1/auth/register", headers: { cookie: csrfCookie, "x-csrf-token": csrfToken },
      payload: { email, name: "Payout Profile MFA", password: "SecurePassw0rd", role: "professional", professionalCategory: "valuer", legalAcceptances: registrationLegalAcceptances },
    });
    expect(register.statusCode).toBe(200);
    const accessCookie = requestCookie(setCookie(register.headers["set-cookie"] as string | string[] | undefined, "fractal_access"));
    await UserModel.updateOne({ email }, { $set: { emailVerified: true } });

    const payoutProfile = await app.inject({
      method: "POST", url: `/v1/professional/firms/${randomUUID()}/payout-profile`, headers: { cookie: `${csrfCookie}; ${accessCookie}`, "x-csrf-token": csrfToken },
      payload: { bankCode: "058", accountNumber: "0123456789" },
    });
    expect(payoutProfile.statusCode).toBe(403);
    expect(payoutProfile.json()).toMatchObject({ message: expect.stringContaining("Complete authenticator-app step-up") });
  });
});

function setCookie(header: string | string[] | undefined, name: string): string {
  const source = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = source.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`Missing ${name} cookie`);
  return cookie;
}

function requestCookie(setCookieHeader: string): string {
  return setCookieHeader.split(";")[0]!;
}

let nextClientOctet = 10;
function nextClientAddress(): string {
  return `127.0.0.${nextClientOctet++}`;
}
