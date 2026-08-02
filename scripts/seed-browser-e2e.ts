import bcrypt from "bcrypt";
import { randomUUID } from "node:crypto";
import { env } from "../src/config/env.js";
import { connectMongo, disconnectMongo } from "../src/db/mongo.js";
import { UserModel } from "../src/db/models.js";
import { connectPostgres, disconnectPostgres, postgresQuery, withPostgresTransaction } from "../src/db/postgres.js";
import { decideAssetApplicationRequest, recordAssetApplicationEvidence, submitAssetApplicationRequest } from "../src/platform/postgres-asset-applications.js";
import { recordOfferingPublicationEvidence } from "../src/platform/postgres-offering-publication-evidence.js";
import { decideOfferingPublicationRequest, submitOfferingPublicationRequest } from "../src/platform/postgres-offering-governance.js";
import { decidePlatformContentVersion, proposePlatformContentVersion, publishDuePlatformContent } from "../src/platform/postgres-platform-content.js";

const password = process.env.BROWSER_E2E_PASSWORD;
const actors = [
  { email: process.env.BROWSER_E2E_EMAIL?.trim().toLowerCase(), name: "Browser E2E Investor", role: "investor" },
  { email: process.env.BROWSER_E2E_ISSUER_EMAIL?.trim().toLowerCase(), name: "Browser E2E Issuer", role: "issuer" },
  { email: process.env.BROWSER_E2E_ORGANIZATION_ISSUER_EMAIL?.trim().toLowerCase(), name: "Browser E2E Organization Issuer", role: "issuer" },
  { email: process.env.BROWSER_E2E_PROFESSIONAL_EMAIL?.trim().toLowerCase(), name: "Browser E2E Professional", role: "professional" },
  { email: process.env.BROWSER_E2E_CONTROL_EMAIL?.trim().toLowerCase(), name: "Browser E2E Control", role: "operator" },
  { email: process.env.BROWSER_E2E_ADMIN_MAKER_EMAIL?.trim().toLowerCase(), name: "Browser E2E Access Maker", role: "admin" },
  { email: process.env.BROWSER_E2E_ADMIN_CHECKER_EMAIL?.trim().toLowerCase(), name: "Browser E2E Access Checker", role: "admin" },
  { email: process.env.BROWSER_E2E_ACCESS_TARGET_EMAIL?.trim().toLowerCase(), name: "Browser E2E Access Target", role: "investor" },
] as const;

if (env.NODE_ENV !== "test") {
  throw new Error("Browser E2E seed data may only be created with NODE_ENV=test");
}
if (!actors[0].email || !actors[0].email.endsWith(".test")) {
  throw new Error("BROWSER_E2E_EMAIL must use a reserved .test address");
}
if (actors.some((actor) => actor.email && !actor.email.endsWith(".test"))) {
  throw new Error("All optional BROWSER_E2E_*_EMAIL values must use reserved .test addresses");
}
if (!password || password.length < 12 || !/[A-Z]/.test(password) || !/[0-9]/.test(password)) {
  throw new Error("BROWSER_E2E_PASSWORD must satisfy the account password policy");
}

const passwordHash = await bcrypt.hash(password, 12);

if (env.AUTH_IDENTITY_AUTHORITY === "postgres") {
  await connectPostgres({ required: true });
  try {
    // The release journey owns this isolated test database. Reset only its
    // governed configuration evidence so an interrupted prior run cannot
    // leave an open scheduled version that changes the next run's outcome.
    await postgresQuery("TRUNCATE fractal.platform_configuration_activation_attempts, fractal.platform_configuration_events, fractal.platform_configuration_active_versions, fractal.platform_configuration_versions");
    await postgresQuery("TRUNCATE fractal.legal_document_acceptances, fractal.platform_content_events, fractal.platform_content_publications, fractal.platform_content_versions");
    const seededIdentityIds = new Map<string, string>();
    for (const actor of actors) {
      if (!actor.email) continue;
      await withPostgresTransaction(async (client) => {
        const identity = await client.query<{ id: string }>(
          `INSERT INTO fractal.identities
             (id, email, legal_name, status, password_hash, email_verified_at, credential_invalidated_at, created_at, updated_at)
           VALUES ($1, $2, $3, 'active', $4, now(), NULL, now(), now())
           ON CONFLICT (email) DO UPDATE SET
             legal_name = EXCLUDED.legal_name,
             status = 'active',
             password_hash = EXCLUDED.password_hash,
             email_verified_at = COALESCE(fractal.identities.email_verified_at, now()),
             credential_invalidated_at = NULL,
             updated_at = now()
           RETURNING id`,
          [randomUUID(), actor.email, actor.name, passwordHash],
        );
        const identityId = identity.rows[0]!.id;
        seededIdentityIds.set(actor.email, identityId);
        // A browser release journey must be repeatable after a failed or
        // interrupted run. These are test-only identities in a test-only
        // process; clear their ephemeral security state before reseeding the
        // canonical role. Production identities can never enter this script.
        await client.query(
          `DELETE FROM fractal.identity_access_change_requests
            WHERE target_identity_id = $1
               OR requested_by_identity_id = $1
               OR reviewed_by_identity_id = $1`,
          [identityId],
        );
        await client.query("DELETE FROM fractal.totp_recovery_codes WHERE identity_id = $1", [identityId]);
        await client.query("DELETE FROM fractal.totp_factors WHERE identity_id = $1", [identityId]);
        await client.query("DELETE FROM fractal.auth_step_up_grants WHERE identity_id = $1", [identityId]);
        await client.query("DELETE FROM fractal.auth_sessions WHERE subject_id = $1::uuid::text OR identity_id = $1::uuid", [identityId]);
        await client.query(
          `UPDATE fractal.identity_role_assignments
              SET revoked_at = now()
            WHERE identity_id = $1
              AND scope_type = 'global'
              AND revoked_at IS NULL
              AND role <> $2`,
          [identityId, actor.role],
        );
        await client.query(
          `INSERT INTO fractal.identity_role_assignments (id, identity_id, role, scope_type)
           SELECT $1, $2, $3, 'global'
            WHERE NOT EXISTS (
              SELECT 1
                FROM fractal.identity_role_assignments
               WHERE identity_id = $2
                 AND scope_type = 'global'
                 AND role = $3
                 AND revoked_at IS NULL
            )`,
          [randomUUID(), identityId, actor.role],
        );
        if (actor.role === "admin") {
          await client.query(
            `INSERT INTO fractal.administrator_capability_assignments (id, identity_id, capability_key)
             SELECT md5($1::text || ':' || definition.capability_key)::uuid, $1::uuid, definition.capability_key
               FROM fractal.administrator_capability_definitions definition
              WHERE definition.status = 'active'
             ON CONFLICT DO NOTHING`,
            [identityId],
          );
        }
      });
      console.log(`Seeded verified browser E2E ${actor.role} in PostgreSQL: ${actor.email}`);
    }

    const makerEmail = actors.find((actor) => actor.name === "Browser E2E Access Maker")?.email;
    const checkerEmail = actors.find((actor) => actor.name === "Browser E2E Access Checker")?.email;
    const makerId = makerEmail ? seededIdentityIds.get(makerEmail) : undefined;
    const checkerId = checkerEmail ? seededIdentityIds.get(checkerEmail) : undefined;
    if (makerId && checkerId) {
      const legalContent = (title: string) => ({ title, eyebrow: "Test legal notice", lead: `This approved test-only ${title} controls the isolated browser publication journey.`, keyPoints: ["The exact immutable version is retained with each browser-test publication."], sections: ["Purpose and scope", "Audience", "Platform controls", "Participant duties", "Risk boundary", "Evidence", "Changes"].map((section, index) => ({ id: `section-${index + 1}`, title: `${index + 1}. ${section}`, paragraphs: [`This reserved ${section.toLowerCase()} section exists only to prove governed ${title} publication and cannot be used as production legal advice.`] })) });
      for (const [documentKey, title] of [["terms_global_public", "Terms of use"], ["privacy_global_public", "Privacy notice"], ["risk_global_public", "Risk disclosures"], ["cookies_global_public", "Cookie notice"], ["platform_disclosure_global_public", "Platform disclosure"]] as const) {
        const proposed = await proposePlatformContentVersion({ actorIdentityId: makerId, documentKey, semanticVersion: "1.0.0", content: legalContent(title), reacceptanceRequired: true, expectedProjectionVersion: null, effectiveAt: new Date(Date.now() - 1_000), changeSummary: `Approve the isolated ${title} fixture for browser consent evidence.`, commandKey: randomUUID() });
        await decidePlatformContentVersion({ actorIdentityId: checkerId, versionId: proposed.version.id, action: "approve", expectedStateVersion: 1, decisionReason: `Independently approve the bounded test-only ${title} content and effective boundary.`, commandKey: randomUUID() });
      }
      const publication = await publishDuePlatformContent();
      if (publication.published !== 5 || publication.failed !== 0) throw new Error("Browser E2E legal documents did not publish exactly once");
      const publicSlug = "browser-governed-infrastructure";
      const existing = await postgresQuery<{ id: string }>(
        `SELECT id
           FROM fractal.offering_publication_requests
          WHERE terms ->> 'publicSlug' = $1
            AND status = 'approved'
          LIMIT 1`,
        [publicSlug],
      );
      if (existing.rowCount) {
        console.log(`Browser E2E governed public offering already exists: ${publicSlug}`);
      } else {
        const organizationId = randomUUID();
        await postgresQuery(
          `INSERT INTO fractal.organizations
             (id, legal_name, status, verification_status, verification_version, verified_at,
              verified_by_identity_id, verification_updated_at, verification_expires_at)
           VALUES ($1, 'Browser Evidence Infrastructure Ltd', 'active', 'verified', 1, now(), $2, now(), now() + interval '30 days')`,
          [organizationId, checkerId],
        );
        const assetEvidence = await recordAssetApplicationEvidence({
          organizationId,
          uploadedByIdentityId: makerId,
          filename: "browser-governed-asset-dossier.pdf",
          mimeType: "application/pdf",
          storageKey: `local://browser-e2e/${randomUUID()}-asset.pdf`,
          contentSha256: "a".repeat(64),
          bytes: 128,
        });
        const application = await submitAssetApplicationRequest({
          organizationId,
          submittedByIdentityId: makerId,
          applicationReference: `BROWSER-ASSET-${randomUUID()}`,
          applicationVersion: 1,
          assetName: "Browser governed infrastructure asset",
          assetType: "infrastructure",
          countryCode: "NG",
          state: "Lagos",
          city: "Lagos",
          summary: "A test-only governed asset used to prove the complete public publication read path.",
          requestedCapacityMinor: 50_000_000,
          currency: "NGN",
          dossierEvidenceDocumentId: assetEvidence.evidenceDocumentId,
        });
        const origin = await decideAssetApplicationRequest({
          requestId: application.requestId,
          decidedByIdentityId: checkerId,
          approve: true,
        });
        if (!origin.approvedApplicationVersionId) throw new Error("Browser E2E asset approval did not create a source version");

        const agreement = await recordOfferingPublicationEvidence({
          organizationId,
          evidenceKind: "agreement",
          uploadedByIdentityId: makerId,
          filename: "browser-subscription-agreement.pdf",
          mimeType: "application/pdf",
          storageKey: `local://browser-e2e/${randomUUID()}-agreement.pdf`,
          contentSha256: "b".repeat(64),
          bytes: 128,
        });
        const disclosure = await recordOfferingPublicationEvidence({
          organizationId,
          evidenceKind: "disclosure_bundle",
          uploadedByIdentityId: makerId,
          filename: "browser-disclosure-bundle.pdf",
          mimeType: "application/pdf",
          storageKey: `local://browser-e2e/${randomUUID()}-disclosure.pdf`,
          contentSha256: "c".repeat(64),
          bytes: 128,
        });
        const publication = await submitOfferingPublicationRequest({
          organizationId,
          submittedByIdentityId: makerId,
          publicReference: `BROWSER-OFFERING-${randomUUID()}`,
          currency: "NGN",
          capacityMinor: 50_000_000,
          opensAt: new Date(Date.now() - 60_000),
          closesAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000),
          terms: {
            name: "Browser governed infrastructure",
            publicSlug,
            minimumTicketMinor: 100_000,
            assetClass: "infrastructure",
            summary: "A maker-checker-approved public record used only by the isolated browser release journey.",
            thesis: "The test proves that approved source evidence and immutable publication terms reach the public catalogue without fixture fallback.",
            targetReturnBps: 1_500,
            termMonths: 24,
            riskSummary: "Capital is at risk; operating, liquidity, counterparty, market, legal, and regulatory outcomes may differ materially.",
            incomeSource: "Governed infrastructure operating receipts represented by the approved source record.",
            structure: "A ring-fenced test investment vehicle represented by the approved publication record.",
            security: "Security terms are contained in the controlled test offering evidence.",
            feeSummary: "Fees follow the immutable controlled test publication terms.",
            nextMilestone: "Complete the browser catalogue and detail verification journey.",
          },
          eligibilityPolicy: { allowedInvestorClasses: ["retail"], allowedJurisdictions: ["NG"] },
          agreementEvidenceDocumentId: agreement.evidenceDocumentId,
          disclosureEvidenceDocumentId: disclosure.evidenceDocumentId,
          approvedAssetApplicationVersionId: origin.approvedApplicationVersionId,
        });
        await decideOfferingPublicationRequest({
          requestId: publication.requestId,
          decidedByIdentityId: checkerId,
          approve: true,
        });
        console.log(`Seeded governed browser E2E public offering: ${publicSlug}`);
      }
    }
  } finally {
    await disconnectPostgres();
  }
} else {
  await connectMongo();
  try {
  for (const actor of actors) {
    if (!actor.email) continue;
    await UserModel.findOneAndUpdate(
      { email: actor.email },
      {
        $set: {
          email: actor.email,
          name: actor.name,
          role: actor.role,
          status: "active",
          emailVerified: true,
          passwordHash,
        },
        $unset: {
          emailVerifyToken: "",
          emailVerifyExpires: "",
          passwordResetToken: "",
          passwordResetExpires: "",
          tokenInvalidatedAt: "",
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true },
    );
    console.log(`Seeded verified browser E2E ${actor.role}: ${actor.email}`);
  }
  } finally {
    await disconnectMongo();
  }
}
