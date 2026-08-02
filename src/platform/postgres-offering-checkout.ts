import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { withPostgresTransaction } from "../db/postgres.js";
import { appendPostgresAuditEvent } from "./postgres-audit.js";
import { createPaymentCommitmentInTransaction, type CreatedPaymentIntent } from "./postgres-payments.js";
import { appendOutboxEvent } from "./postgres-outbox.js";

type InvestorClass = "retail" | "sophisticated" | "institutional";

export class CheckoutPolicyError extends Error {}

export interface EligibilityPolicy {
  allowedInvestorClasses: readonly InvestorClass[];
  allowedJurisdictions?: readonly string[];
  requiresAccreditation?: boolean;
}

export interface PublishOfferingInput {
  organizationId: string;
  publishedByIdentityId: string;
  publicReference: string;
  currency: string;
  capacityMinor: bigint | number;
  opensAt: Date;
  closesAt: Date;
  terms: Record<string, unknown>;
  eligibilityPolicy: EligibilityPolicy;
  agreementDocumentHash: string;
  disclosureBundleHash: string;
}

export interface PublishedOffering { offeringId: string; offeringVersionId: string; version: number }

export interface InvestorComplianceProfileInput {
  identityId: string;
  kycStatus: "pending" | "approved" | "rejected" | "expired";
  investorClass: InvestorClass;
  accreditationStatus: "not_required" | "pending" | "verified" | "expired";
  jurisdictionCode: string;
  reviewedAt: Date;
  expiresAt?: Date;
  evidence?: Record<string, unknown>;
}

export interface CreateCheckoutInput {
  publicReference: string;
  investorIdentityId: string;
  amountMinor: bigint | number;
  signatureName: string;
  agreementDocumentHash: string;
  provider: string;
  providerReference: string;
  paymentExpiresAt: Date;
  acceptedAt?: Date;
  ipHash?: string;
  userAgentHash?: string;
  commandKey?: string;
}

export interface CreatedCheckout extends CreatedPaymentIntent {
  offeringId: string;
  offeringVersionId: string;
  eligibilitySnapshotId: string;
  agreementAcceptanceId: string;
  reservationId: string;
}

type CheckoutTransactionResult = CreatedCheckout | { ineligible: true; reasons: string[] };

function required(value: string, field: string): string {
  const output = value.trim();
  if (!output) throw new CheckoutPolicyError(`${field} is required`);
  return output;
}

function code(value: string, field: string, expression: RegExp): string {
  const output = value.trim().toUpperCase();
  if (!expression.test(output)) throw new CheckoutPolicyError(`${field} is invalid`);
  return output;
}

function currency(value: string) { return code(value, "currency", /^[A-Z]{3}$/); }
function sha256(value: string, field: string) { return code(value, field, /^[A-F0-9]{64}$/); }

function amount(value: bigint | number): bigint {
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new CheckoutPolicyError("amountMinor must be a safe integer");
  const output = typeof value === "bigint" ? value : BigInt(value);
  if (output <= 0n) throw new CheckoutPolicyError("amountMinor must be positive");
  return output;
}

function policy(input: EligibilityPolicy): EligibilityPolicy {
  if (!Array.isArray(input.allowedInvestorClasses) || input.allowedInvestorClasses.length === 0 || input.allowedInvestorClasses.some((item) => !["retail", "sophisticated", "institutional"].includes(item))) {
    throw new CheckoutPolicyError("Eligibility policy requires one or more valid investor classes");
  }
  return {
    allowedInvestorClasses: [...new Set(input.allowedInvestorClasses)],
    allowedJurisdictions: input.allowedJurisdictions?.map((item) => code(item, "allowedJurisdiction", /^[A-Z]{2,3}$/)),
    requiresAccreditation: input.requiresAccreditation ?? false,
  };
}

/**
 * Creates the immutable offering/product pair. It is intentionally exposed for
 * the governed approval workflow; HTTP callers must never invoke it directly.
 */
export async function publishOfferingInTransaction(client: PoolClient, input: PublishOfferingInput): Promise<PublishedOffering> {
  const inputCurrency = currency(input.currency);
  const capacityMinor = amount(input.capacityMinor);
  const eligibility = policy(input.eligibilityPolicy);
  const publicReference = required(input.publicReference, "publicReference");
  if (input.opensAt >= input.closesAt) throw new CheckoutPolicyError("Offering close must follow open");
  const offeringId = randomUUID();
  const versionId = randomUUID();
  await client.query(
    `INSERT INTO fractal.offering_products
       (id, organization_id, public_reference, status, currency, capacity_minor, opens_at, closes_at)
     VALUES ($1, $2, $3, 'published', $4, $5, $6, $7)`,
    [offeringId, input.organizationId, publicReference, inputCurrency, capacityMinor.toString(), input.opensAt, input.closesAt],
  );
  await client.query(
    `INSERT INTO fractal.offering_publication_versions
       (id, offering_id, version, terms, eligibility_policy, agreement_document_hash, disclosure_bundle_hash, published_by_identity_id, published_at)
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, now())`,
    [versionId, offeringId, input.terms, eligibility, sha256(input.agreementDocumentHash, "agreementDocumentHash"), sha256(input.disclosureBundleHash, "disclosureBundleHash"), input.publishedByIdentityId],
  );
  const audit = await appendPostgresAuditEvent(client, {
    scopeKey: `organization:${input.organizationId}`,
    organizationId: input.organizationId,
    actorId: input.publishedByIdentityId,
    actorType: "user",
    action: "offering.published",
    entityType: "offering_product",
    entityId: offeringId,
    payload: { publicReference, version: 1, currency: inputCurrency, capacityMinor: capacityMinor.toString() },
  });
  await appendOutboxEvent(client, { aggregateType: "offering_product", aggregateId: offeringId, eventType: "offering.published", payload: { organizationId: input.organizationId, offeringVersionId: versionId, auditEventId: audit.id } });
  return { offeringId, offeringVersionId: versionId, version: 1 };
}

/** Test/bootstrap-only convenience. Production issuance goes through approval. */
export async function publishOffering(input: PublishOfferingInput): Promise<PublishedOffering> {
  return withPostgresTransaction((client) => publishOfferingInTransaction(client, input));
}

export async function upsertInvestorComplianceProfileInTransaction(client: PoolClient, input: InvestorComplianceProfileInput): Promise<void> {
  const jurisdictionCode = code(input.jurisdictionCode, "jurisdictionCode", /^[A-Z]{2,3}$/);
  await client.query(
    `INSERT INTO fractal.investor_compliance_profiles
       (identity_id, kyc_status, investor_class, accreditation_status, jurisdiction_code, reviewed_at, expires_at, evidence)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (identity_id) DO UPDATE SET
       kyc_status = EXCLUDED.kyc_status, investor_class = EXCLUDED.investor_class,
       accreditation_status = EXCLUDED.accreditation_status, jurisdiction_code = EXCLUDED.jurisdiction_code,
       reviewed_at = EXCLUDED.reviewed_at, expires_at = EXCLUDED.expires_at,
       evidence = EXCLUDED.evidence, updated_at = now()`,
    [input.identityId, input.kycStatus, input.investorClass, input.accreditationStatus, jurisdictionCode, input.reviewedAt, input.expiresAt ?? null, input.evidence ?? {}],
  );
}

/** Test/bootstrap-only convenience. Production changes go through approval. */
export async function upsertInvestorComplianceProfile(input: InvestorComplianceProfileInput): Promise<void> {
  await withPostgresTransaction((client) => upsertInvestorComplianceProfileInTransaction(client, input));
}

type OfferingRow = { id: string; organization_id: string; currency: string; capacity_minor: string; opens_at: Date; closes_at: Date; status: string };
type VersionRow = { id: string; eligibility_policy: EligibilityPolicy; agreement_document_hash: string };
type ProfileRow = { kyc_status: string; investor_class: InvestorClass; accreditation_status: string; jurisdiction_code: string; reviewed_at: Date; expires_at: Date | null; evidence: Record<string, unknown> };

/**
 * The checkout command is the only supported bridge from a published offering
 * to a payment intent. It uses one PostgreSQL transaction and locks capacity,
 * therefore a concurrent pair of investors cannot over-reserve an offering.
 */
export async function createCheckout(input: CreateCheckoutInput): Promise<CreatedCheckout> {
  const investmentAmount = amount(input.amountMinor);
  const acceptedAt = input.acceptedAt ?? new Date();
  const result: CheckoutTransactionResult = await withPostgresTransaction(async (client) => {
    const offeringResult = await client.query<OfferingRow>(
      `SELECT id, organization_id, currency, capacity_minor, opens_at, closes_at, status
         FROM fractal.offering_products WHERE public_reference = $1 FOR UPDATE`,
      [required(input.publicReference, "publicReference")],
    );
    const offering = offeringResult.rows[0];
    if (!offering || offering.status !== "published" || acceptedAt < offering.opens_at || acceptedAt >= offering.closes_at) {
      throw new CheckoutPolicyError("Offering is not open for investment");
    }
    if (input.paymentExpiresAt <= acceptedAt || input.paymentExpiresAt > offering.closes_at) throw new CheckoutPolicyError("Payment expiry is outside the offering window");
    const commandKey = input.commandKey?.trim();
    if (input.commandKey !== undefined && !commandKey) throw new CheckoutPolicyError("commandKey must not be blank");
    if (commandKey) {
      const existing = await client.query<{
        id: string; offering_version_id: string; eligibility_snapshot_id: string; agreement_acceptance_id: string;
        commitment_id: string; payment_intent_id: string;
      }>(
        `SELECT reservation.id, reservation.offering_version_id, reservation.eligibility_snapshot_id,
                reservation.agreement_acceptance_id, reservation.commitment_id, intent.id AS payment_intent_id
           FROM fractal.investment_reservations reservation
           JOIN fractal.payment_intents intent ON intent.commitment_id = reservation.commitment_id
          WHERE reservation.offering_id = $1 AND reservation.investor_identity_id = $2 AND reservation.command_key = $3`,
        [offering.id, input.investorIdentityId, commandKey],
      );
      const replay = existing.rows[0];
      if (replay) {
        if (!replay.eligibility_snapshot_id || !replay.agreement_acceptance_id) throw new Error("Checkout idempotency record is incomplete");
        return {
          offeringId: offering.id, offeringVersionId: replay.offering_version_id,
          eligibilitySnapshotId: replay.eligibility_snapshot_id, agreementAcceptanceId: replay.agreement_acceptance_id,
          reservationId: replay.id, commitmentId: replay.commitment_id, paymentIntentId: replay.payment_intent_id,
        };
      }
    }
    const versionResult = await client.query<VersionRow>(
      `SELECT id, eligibility_policy, agreement_document_hash
         FROM fractal.offering_publication_versions WHERE offering_id = $1 ORDER BY version DESC LIMIT 1`,
      [offering.id],
    );
    const version = versionResult.rows[0];
    if (!version) throw new CheckoutPolicyError("Offering has no publication version");
    const eligibility = policy(version.eligibility_policy);
    const profileResult = await client.query<ProfileRow>(
      "SELECT kyc_status, investor_class, accreditation_status, jurisdiction_code, reviewed_at, expires_at, evidence FROM fractal.investor_compliance_profiles WHERE identity_id = $1 FOR SHARE",
      [input.investorIdentityId],
    );
    const profile = profileResult.rows[0];
    const reasons: string[] = [];
    if (!profile || profile.kyc_status !== "approved") reasons.push("kyc_not_approved");
    if (profile?.expires_at && profile.expires_at <= acceptedAt) reasons.push("compliance_profile_expired");
    if (profile && !eligibility.allowedInvestorClasses.includes(profile.investor_class)) reasons.push("investor_class_not_allowed");
    if (profile && eligibility.allowedJurisdictions?.length && !eligibility.allowedJurisdictions.includes(profile.jurisdiction_code)) reasons.push("jurisdiction_not_allowed");
    if (profile && eligibility.requiresAccreditation && profile.accreditation_status !== "verified") reasons.push("accreditation_not_verified");
    const snapshotId = randomUUID();
    const snapshotExpiresAt = profile?.expires_at && profile.expires_at < input.paymentExpiresAt ? profile.expires_at : input.paymentExpiresAt;
    await client.query(
      `INSERT INTO fractal.investment_eligibility_snapshots
         (id, offering_version_id, investor_identity_id, status, reason_codes, policy_snapshot, evidence_snapshot, evaluated_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [snapshotId, version.id, input.investorIdentityId, reasons.length === 0 ? "eligible" : "ineligible", JSON.stringify(reasons), eligibility, profile ? { kycStatus: profile.kyc_status, investorClass: profile.investor_class, accreditationStatus: profile.accreditation_status, jurisdictionCode: profile.jurisdiction_code, reviewedAt: profile.reviewed_at.toISOString(), expiresAt: profile.expires_at?.toISOString() ?? null, evidence: profile.evidence } : {}, acceptedAt, snapshotExpiresAt],
    );
    // Commit the denial snapshot as regulated decision evidence. The caller is
    // rejected only after this transaction commits, so an ineligible attempt is
    // not silently erased by a rollback.
    if (reasons.length) return { ineligible: true as const, reasons };
    if (sha256(input.agreementDocumentHash, "agreementDocumentHash") !== version.agreement_document_hash) throw new CheckoutPolicyError("Agreement document does not match published offering version");
    const reserved = await client.query<{ total: string }>(
      `SELECT COALESCE(sum(amount_minor), 0)::text AS total
         FROM fractal.investment_reservations
        WHERE offering_id = $1
          AND (status = 'confirmed' OR (status = 'pending_payment' AND expires_at > $2))`,
      [offering.id, acceptedAt],
    );
    if (BigInt(reserved.rows[0]?.total ?? "0") + investmentAmount > BigInt(offering.capacity_minor)) throw new CheckoutPolicyError("Offering capacity is unavailable");
    const agreementAcceptanceId = randomUUID();
    const executionHash = createHash("sha256").update(JSON.stringify({ offeringVersionId: version.id, investorIdentityId: input.investorIdentityId, agreementDocumentHash: version.agreement_document_hash, signatureName: required(input.signatureName, "signatureName"), acceptedAt: acceptedAt.toISOString() })).digest("hex");
    await client.query(
      `INSERT INTO fractal.agreement_acceptances
         (id, offering_version_id, investor_identity_id, agreement_document_hash, signature_name, execution_hash, accepted_at, ip_hash, user_agent_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [agreementAcceptanceId, version.id, input.investorIdentityId, version.agreement_document_hash, required(input.signatureName, "signatureName"), executionHash, acceptedAt, input.ipHash ?? null, input.userAgentHash ?? null],
    );
    const payment = await createPaymentCommitmentInTransaction(client, {
      organizationId: offering.organization_id,
      investorIdentityId: input.investorIdentityId,
      offeringReference: input.publicReference,
      currency: offering.currency,
      committedMinor: investmentAmount,
      provider: required(input.provider, "provider"),
      providerReference: required(input.providerReference, "providerReference"),
      expiresAt: input.paymentExpiresAt,
      metadata: { offeringId: offering.id, offeringVersionId: version.id, eligibilitySnapshotId: snapshotId, agreementAcceptanceId },
    });
    const reservationId = randomUUID();
    await client.query(
      `INSERT INTO fractal.investment_reservations
         (id, offering_id, offering_version_id, investor_identity_id, amount_minor, currency, status, expires_at,
          commitment_id, command_key, eligibility_snapshot_id, agreement_acceptance_id)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending_payment', $7, $8, $9, $10, $11)`,
      [reservationId, offering.id, version.id, input.investorIdentityId, investmentAmount.toString(), offering.currency, input.paymentExpiresAt, payment.commitmentId, commandKey ?? null, snapshotId, agreementAcceptanceId],
    );
    const audit = await appendPostgresAuditEvent(client, {
      scopeKey: `organization:${offering.organization_id}`,
      organizationId: offering.organization_id,
      actorId: input.investorIdentityId,
      actorType: "user",
      action: "investment.checkout.created",
      entityType: "investment_reservation",
      entityId: reservationId,
      payload: { offeringId: offering.id, offeringVersionId: version.id, eligibilitySnapshotId: snapshotId, agreementAcceptanceId, commitmentId: payment.commitmentId, paymentIntentId: payment.paymentIntentId, amountMinor: investmentAmount.toString(), currency: offering.currency },
    });
    await appendOutboxEvent(client, { aggregateType: "investment_reservation", aggregateId: reservationId, eventType: "investment.checkout.created", payload: { organizationId: offering.organization_id, paymentIntentId: payment.paymentIntentId, auditEventId: audit.id } });
    return { ...payment, offeringId: offering.id, offeringVersionId: version.id, eligibilitySnapshotId: snapshotId, agreementAcceptanceId, reservationId };
  });
  if ("ineligible" in result) throw new CheckoutPolicyError(`Investor is not eligible: ${result.reasons.join(", ")}`);
  return result;
}
